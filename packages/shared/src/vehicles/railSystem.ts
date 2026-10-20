import {
  depotExitSegment,
  isTrackTile,
  nextSegments,
  seg,
  pieceKey,
  segLength,
  segReverse,
  segTd,
  segTile,
  segPiece,
  segmentExists,
  segmentsConnect,
} from '../rail/network.ts';
import { depotGoal, extendThroughPlatform, findPath, findTurnaround, stationGoal, type PathGoal } from '../rail/pathfinder.ts';
import { BRIDGE_TYPES, headInfo, otherHead, segHeights, spanOver } from '../rail/structures.ts';
import { EDGE_PIECES, isLinked } from '../rail/links.ts';
import {
  EDGE_DX,
  EDGE_DY,
  OPPOSITE_EDGE,
  PIECE_EDGES,
  TD_HEADING,
  hasPiece,
  isSpanTd,
  pieceLength,
  tdEntry,
  tdExit,
  tdPiece,
  turnSteps,
} from '../rail/track.ts';
import { TICKS_PER_DAY, TICKS_PER_SECOND } from '../sim/date.ts';
import type { GameState } from '../sim/state.ts';
import { TileType } from '../world/constants.ts';
import { signalKindOf, type SignalKind } from '../commands/signals.ts';
import { CROSSING_FLAG } from '../commands/track.ts';
import { RAIL_TYPE_SPEED, isElectrified } from '../rail/railTypes.ts';
import { cargoMass, isRailVehicle, routeKey, targetCode, trainStats, type Order, type Train, type TrainMotion, type TrainStats } from './train.ts';
import { foundRoute, noRoute } from './lost.ts';
import { advanceOrder, needsService, peekNextOrder } from './orders.ts';
import { DERAIL_OVERSPEED } from '../incidents/rail.ts';

/** km/h corresponding to 1 tile per second. Sets the game's sense of scale. */
export const KMH_PER_TILE_PER_S = 28;
/** Acceleration is scaled up from real physics so trains reach speed in seconds, not minutes. */
export const ACCEL_SCALE = 6;
/** Service braking, km/h per second. */
export const BRAKE_KMH_PER_S = 40;
/** Gradient of a one-level climb over one tile. */
export const GRADE_PER_LEVEL = 0.025;
/** Ticks spent at a platform per stop. */
export const DWELL_TICKS = Math.round(TICKS_PER_DAY * 1.2);
/** Stop this far (tiles) behind an obstacle. */
const SAFETY_MARGIN = 0.3;
const REPLAN_DELAY = 45;
/** Ticks between attempts to find another way past a signal whose way ahead is taken. */
const REROUTE_DELAY = TICKS_PER_DAY;
/** Minimum approach speed for the final metres to a stop point. */
const CREEP_KMH = 4;

const DT = 1 / TICKS_PER_SECOND;
/** Crossings close this far (tiles) ahead of a train, plus its braking distance. */
const CROSSING_WARNING = 3;
/** Pseudo train id for wreckage occupying track. */
const WRECK = -2;
/** Deceleration of a train coasting without brakes, km/h per second. */
const COAST_KMH_PER_S = 2;
/** The parallel (non-touching) partner of each corner piece. */
const PARALLEL_PIECE = [-1, -1, 4, 5, 2, 3];

/** Curve speed (km/h) is CURVE_K × √radius, radius in tiles. */
export const CURVE_K = 57;
/** Turns farther apart than this (tiles) don't limit speed. */
const CURVE_FREE_DISTANCE = 30;

/**
 * Speed limits from curvature along a sequence of segments (back to front). Track turns in 45°
 * steps; the distance between two turns gives the radius (distance / (π/4)), and the arc from
 * the segment before the first turn to the segment after the second gets the limit
 * √radius × CURVE_K. Diagonal staircases don't turn.
 */
export function curveLimits(seq: readonly number[]): number[] {
  const out = new Array<number>(seq.length).fill(Infinity);
  let since = CURVE_FREE_DISTANCE;
  let lastTurn = -1;
  for (let i = 1; i < seq.length; i++) {
    const prev = seq[i - 1]!;
    since += segLength(prev);
    if (turnSteps(TD_HEADING[segTd(prev)]!, TD_HEADING[segTd(seq[i]!)]!) === 0) continue;
    if (since < CURVE_FREE_DISTANCE && lastTurn >= 0) {
      const lim = CURVE_K * Math.sqrt(since / (Math.PI / 4));
      for (let k = lastTurn - 1; k <= i; k++) out[k] = Math.min(out[k]!, lim);
    }
    since = 0;
    lastTurn = i;
  }
  return out;
}

/** Distance (tiles) needed to stop from `kmh`. */
export function brakingDistance(kmh: number): number {
  const v = kmh / KMH_PER_TILE_PER_S;
  const a = BRAKE_KMH_PER_S / KMH_PER_TILE_PER_S;
  return (v * v) / (2 * a);
}

/** Highest speed (km/h) from which the train can still stop within `d` tiles. */
export function speedForDistance(d: number): number {
  if (d <= 0) return 0;
  const a = BRAKE_KMH_PER_S / KMH_PER_TILE_PER_S;
  return Math.sqrt(2 * a * d) * KMH_PER_TILE_PER_S;
}

/**
 * Owns train movement: occupancy of track pieces, route planning, physics, stopping at
 * stations, entering and leaving depots, and reversing at termini.
 */
export class RailSystem {
  /** pieceKey → ids of trains on that piece. */
  private occ = new Map<number, Set<number>>();
  private stats = new Map<number, TrainStats>();
  /** Signal blocks: pieceKey → block id, rebuilt when track or signals change. */
  private blocksFor = -1;
  private blockOf = new Map<number, number>();
  /** block → (train → pieces of that train in the block) */
  private blockUse = new Map<number, Map<number, number>>();
  /** block → train that has committed to entering it past a green signal */
  private claims = new Map<number, number>();
  /** Path reservations: pieceKey → train. */
  private reserved = new Map<number, number>();
  /** block → (train → reserved pieces in the block) */
  private blockRes = new Map<number, Map<number, number>>();
  /** block → segments leaving it through an exit or combo signal (for entry signals). */
  private blockExits = new Map<number, number[]>();
  /** Blocks with a path signal at their edge: trains leaving a depot into them reserve a path. */
  private pathBlocks = new Set<number>();
  /** Called when a train arrives at a platform (cargo handling hooks in here). */
  onArrive: ((t: Train, station: number) => void) | null = null;
  /** Called every tick while loading; return true to keep waiting (e.g. full load). */
  onLoading: ((t: Train, station: number) => boolean) | null = null;

  constructor(private readonly state: GameState) {}

  statsOf(t: Train): TrainStats {
    let s = this.stats.get(t.id);
    if (!s) this.stats.set(t.id, (s = trainStats(t.units)));
    return s;
  }

  /** Whose track (and which track types) this train may use. */
  accessOf(t: Train) {
    return this.state.accessFor(t.owner, this.statsOf(t).electric);
  }

  /** Speed limit (km/h) of the track under a segment: its track type, or the bridge it is on. */
  segLimit(s: number): number {
    const map = this.state.map;
    const tile = segTile(s);
    const td = segTd(s);
    if (isSpanTd(td)) return this.spanLimit(tile, td < 14 ? 0 : 1);
    const lim = RAIL_TYPE_SPEED[map.layers.railType[tile]!] ?? Infinity;
    const head = headInfo(map, tile);
    return head?.kind === 'bridge' ? Math.min(lim, BRIDGE_TYPES[head.bridgeType]!.maxSpeed) : lim;
  }

  private spanLimits = new Map<number, number>();
  private spanLimitsFor = -1;

  /** Bridge speed over a middle tile (tunnels have none). A bridge over a tunnel limits both. */
  private spanLimit(tile: number, axis: 0 | 1): number {
    if (this.spanLimitsFor !== this.state.trackVersion) {
      this.spanLimits.clear();
      this.spanLimitsFor = this.state.trackVersion;
    }
    const key = tile * 2 + axis;
    let lim = this.spanLimits.get(key);
    if (lim === undefined) {
      const span = spanOver(this.state.map, tile, axis, 'bridge');
      lim = span ? BRIDGE_TYPES[span.bridgeType]!.maxSpeed : Infinity;
      this.spanLimits.set(key, lim);
    }
    return lim;
  }

  /**
   * Highest speed allowed now by track, bridge and curve limits under the train, and by
   * braking for lower limits ahead of it.
   */
  private trackLimit(t: Train): number {
    const c = this.limitsOf(t);
    let lim = c.under;
    let d = segLength(t.path[0]!) - t.pos;
    const horizon = brakingDistance(t.speed) + 1;
    for (let i = 0; i < c.ahead.length && d <= horizon; i++) {
      const l = c.ahead[i]!;
      if (l < t.speed) lim = Math.min(lim, Math.hypot(l, speedForDistance(d)));
      d += c.lengths[i]!;
    }
    return lim;
  }

  /**
   * Speed limits for the track under a train (lowest) and for each segment of the route ahead
   * as far as it could need to brake from top speed. They only change when the train enters a
   * segment, replans or the track changes, so they are kept between ticks.
   */
  private limitCache = new Map<number, { key: number[]; under: number; ahead: number[]; lengths: number[] }>();

  private limitsOf(t: Train): { under: number; ahead: number[]; lengths: number[] } {
    const hit = this.limitCache.get(t.id);
    const k = hit?.key;
    if (
      k &&
      k[0] === t.path[0] &&
      k[1] === t.path.length &&
      k[2] === t.route.length &&
      k[3] === (t.route[0] ?? -1) &&
      k[4] === t.routeFor &&
      k[5] === this.state.trackVersion
    ) {
      return hit;
    }
    const key = [t.path[0]!, t.path.length, t.route.length, t.route[0] ?? -1, t.routeFor, this.state.trackVersion];
    const horizon = brakingDistance(this.statsOf(t).maxSpeed) + 2;
    // Segments from the tail to the head, then the route ahead up to the braking horizon.
    const seq = t.path.slice().reverse();
    const behind = seq.length;
    let d = 0;
    for (const s of t.route) {
      if (d > horizon) break;
      seq.push(s);
      d += segLength(s);
    }
    const limits = curveLimits(seq);
    let under = Infinity;
    for (let i = 0; i < behind; i++) under = Math.min(under, limits[i]!, this.segLimit(seq[i]!));
    const ahead: number[] = [];
    const lengths: number[] = [];
    for (let i = behind; i < seq.length; i++) {
      ahead.push(Math.min(limits[i]!, this.segLimit(seq[i]!)));
      lengths.push(segLength(seq[i]!));
    }
    const out = { key, under, ahead, lengths };
    this.limitCache.set(t.id, out);
    return out;
  }

  /**
   * Curve limit on the track under a train. The route just ahead counts too, since the arc of
   * a curve can be longer than the train.
   */
  curveLimitUnder(t: Train): number {
    const seq = t.path.slice().reverse();
    const n = seq.length;
    seq.push(...t.route.slice(0, 6));
    return Math.min(...curveLimits(seq).slice(0, n));
  }

  /** The consist changed: recompute length, power and so on. */
  invalidateStats(t: Train): void {
    this.stats.delete(t.id);
    this.limitCache.delete(t.id);
  }

  forget(t: Train): void {
    this.limitCache.delete(t.id);
    this.reroutes.delete(t.id);
    this.releaseAll(t);
    this.dropClaims(t);
    this.dropReservations(t);
    this.stats.delete(t.id);
  }

  // ---- occupancy -------------------------------------------------------------

  isOccupied(tile: number, piece: number, except = -1): boolean {
    const set = this.occ.get(tile * 8 + piece);
    if (!set) return false;
    for (const id of set) if (id !== except) return true;
    return false;
  }

  /**
   * Is this piece — or a piece crossing it on the same tile — occupied by another train?
   * Tracks that cross or touch on one tile can't both carry trains at once.
   */
  private occupiedByOther(s: number, id: number): boolean {
    const tile = segTile(s);
    const p = segPiece(s);
    if (p >= 6) return this.pieceBusy(tile * 8 + p, id);
    const bits = this.state.map.layers.track[tile]!;
    for (let q = 0; q < 6; q++) {
      if (!hasPiece(bits, q) || (q !== p && q === PARALLEL_PIECE[p])) continue;
      if (this.pieceBusy(tile * 8 + q, id)) return true;
    }
    return false;
  }

  private pieceBusy(key: number, id: number): boolean {
    const set = this.occ.get(key);
    if (!set) return false;
    for (const o of set) if (o !== id) return true;
    return false;
  }

  private occupy(t: Train, s: number): void {
    this.markOccupied(pieceKey(s), t.id);
  }

  private release(t: Train, s: number): void {
    const k = pieceKey(s);
    const set = this.occ.get(k);
    if (!set) return;
    // Another segment of the same train may still be on this piece (it can't, pieces are
    // traversed once per pass, but be safe if a train is tightly looped).
    if (t.path.some((p) => pieceKey(p) === k) || !set.delete(t.id)) return;
    if (set.size === 0) this.occ.delete(k);
    this.leaveBlockPiece(t, k);
    if (this.reserved.get(k) === t.id) this.unreserve(k);
  }

  private leaveBlockPiece(t: Train, k: number): void {
    const b = this.blockOf.get(k);
    if (b === undefined) return;
    const use = this.blockUse.get(b);
    const n = (use?.get(t.id) ?? 1) - 1;
    if (use && n > 0) {
      use.set(t.id, n);
      return;
    }
    use?.delete(t.id);
    if (use && use.size === 0) this.blockUse.delete(b);
    if (this.claims.get(b) === t.id) this.claims.delete(b);
  }

  private dropClaims(t: Train): void {
    for (const [b, id] of this.claims) if (id === t.id) this.claims.delete(b);
  }

  private releaseAll(t: Train): void {
    for (const s of t.path) {
      const k = pieceKey(s);
      const set = this.occ.get(k);
      if (!set?.delete(t.id)) continue;
      if (set.size === 0) this.occ.delete(k);
      this.leaveBlockPiece(t, k);
    }
  }

  // ---- wreckage ------------------------------------------------------------------

  /** pieceKey → tick the wreckage is cleared. Wreckage occupies its piece like a train (id WRECK). */
  private wrecks = new Map<number, number>();

  addWreck(k: number, until: number): void {
    this.wrecks.set(k, Math.max(until, this.wrecks.get(k) ?? 0));
    this.markOccupied(k, WRECK);
  }

  /** Clear wreckage whose cleanup time has passed. */
  clearWrecks(): void {
    for (const [k, until] of [...this.wrecks]) {
      if (until > this.state.tick) continue;
      this.wrecks.delete(k);
      const set = this.occ.get(k);
      if (!set?.delete(WRECK)) continue;
      if (set.size === 0) this.occ.delete(k);
      const b = this.blockOf.get(k);
      const use = b === undefined ? undefined : this.blockUse.get(b);
      if (use) {
        use.delete(WRECK);
        if (use.size === 0) this.blockUse.delete(b!);
      }
    }
  }

  wreckTiles(): number[] {
    return [...new Set([...this.wrecks.keys()].map((k) => Math.floor(k / 8)))];
  }

  private markOccupied(k: number, id: number): void {
    let set = this.occ.get(k);
    if (!set) this.occ.set(k, (set = new Set()));
    if (set.has(id)) return;
    set.add(id);
    const b = this.blockOf.get(k);
    if (b === undefined) return;
    let use = this.blockUse.get(b);
    if (!use) this.blockUse.set(b, (use = new Map()));
    use.set(id, (use.get(id) ?? 0) + 1);
  }

  /** Ids of trains on the piece of `s`, or on pieces crossing it (not `except`, not wreckage). */
  trainsOn(s: number, except: number): number[] {
    const tile = segTile(s);
    const p = segPiece(s);
    const out = new Set<number>();
    const add = (k: number) => {
      for (const id of this.occ.get(k) ?? []) if (id !== except && id !== WRECK) out.add(id);
    };
    if (p >= 6) add(tile * 8 + p);
    else {
      const bits = this.state.map.layers.track[tile]!;
      for (let q = 0; q < 6; q++) if (hasPiece(bits, q) && (q === p || q !== PARALLEL_PIECE[p])) add(tile * 8 + q);
    }
    return [...out];
  }

  /** Rebuild occupancy from scratch (after loading a save, or when blocks change). */
  rebuildOccupancy(): void {
    this.occ.clear();
    this.blockUse.clear();
    this.claims.clear();
    for (const t of this.state.trains.values()) if (isRailVehicle(t)) for (const s of t.path) this.occupy(t, s);
    for (const k of this.wrecks.keys()) this.markOccupied(k, WRECK);
    this.blockRes.clear();
    for (const [k, id] of this.reserved) this.countReservation(k, id, 1);
  }

  // ---- path reservations -------------------------------------------------------

  private countReservation(k: number, id: number, delta: number): void {
    const b = this.blockOf.get(k);
    if (b === undefined) return;
    let use = this.blockRes.get(b);
    if (!use) this.blockRes.set(b, (use = new Map()));
    const n = (use.get(id) ?? 0) + delta;
    if (n > 0) use.set(id, n);
    else use.delete(id);
    if (use.size === 0) this.blockRes.delete(b);
  }

  private unreserve(k: number): void {
    const id = this.reserved.get(k);
    if (id === undefined) return;
    this.reserved.delete(k);
    this.countReservation(k, id, -1);
  }

  /** Drop a train's reservations, except (with `keepPath`) those under the train. */
  private dropReservations(t: Train, keepPath = false): void {
    const keep = keepPath ? new Set(t.path.map(pieceKey)) : null;
    for (const [k, id] of [...this.reserved]) if (id === t.id && !keep?.has(k)) this.unreserve(k);
  }

  reservedBy(s: number): number | undefined {
    return this.reserved.get(pieceKey(s));
  }

  /** Reserved piece keys (tile * 8 + piece), for the reservation overlay. */
  reservedPieces(): IterableIterator<number> {
    return this.reserved.keys();
  }

  /** Is the piece of `s` (or a piece crossing it) occupied or reserved by another train? */
  private pieceConflict(s: number, id: number): boolean {
    if (this.occupiedByOther(s, id)) return true;
    const tile = segTile(s);
    const p = segPiece(s);
    if (p >= 6) {
      const r = this.reserved.get(tile * 8 + p);
      return r !== undefined && r !== id;
    }
    const bits = this.state.map.layers.track[tile]!;
    for (let q = 0; q < 6; q++) {
      if (!hasPiece(bits, q) || (q !== p && q === PARALLEL_PIECE[p])) continue;
      const r = this.reserved.get(tile * 8 + q);
      if (r !== undefined && r !== id) return true;
    }
    return false;
  }

  /**
   * The stretch of route a path signal (or a train inside a path-signalled area) must reserve
   * from route index `i`: up to and including the next segment with a signal facing the train,
   * or to the end of the route.
   */
  private runFrom(t: Train, i: number): number[] {
    const run: number[] = [];
    for (let k = i; k < t.route.length; k++) {
      const s = t.route[k]!;
      run.push(s);
      if (this.signalFacing(s)) break;
    }
    return run;
  }

  private canReserve(run: readonly number[], id: number): boolean {
    for (const s of run) {
      if (this.pieceConflict(s, id)) return false;
      const b = this.blockOf.get(pieceKey(s));
      // A train that entered past a block signal may go anywhere in its block.
      const c = b === undefined ? undefined : this.claims.get(b);
      if (c !== undefined && c !== id) return false;
    }
    return true;
  }

  private reserve(run: readonly number[], t: Train): void {
    for (const s of run) {
      const k = pieceKey(s);
      if (this.reserved.get(k) === t.id) continue;
      this.reserved.set(k, t.id);
      this.countReservation(k, t.id, 1);
    }
  }

  /** Reserve the run from route index `i` if possible (`commit`), or just test it. */
  private tryReserve(t: Train, i: number, commit: boolean): boolean {
    const run = this.runFrom(t, i);
    if (run.length === 0 || !this.canReserve(run, t.id)) return false;
    if (commit) this.reserve(run, t);
    return true;
  }

  // ---- signal blocks -------------------------------------------------------------

  private ensureBlocks(): void {
    if (this.blocksFor !== this.state.trackVersion) this.rebuildBlocks();
  }

  /** Is there a signal at the exit edge of this segment, facing trains on it? */
  signalFacing(s: number): boolean {
    return ((this.state.map.layers.signals[segTile(s)]! >> segTd(s)) & 1) === 1;
  }

  /** Is there a signal (on either side) at edge `e` between piece p of `tile` and piece q of `ntile`? */
  private boundary(tile: number, p: number, e: number, ntile: number, q: number): boolean {
    const sig = this.state.map.layers.signals;
    const [a0, a1] = PIECE_EDGES[p]!;
    const mine = e === a1 ? p * 2 : e === a0 ? p * 2 + 1 : -1;
    if (mine >= 0 && (sig[tile]! >> mine) & 1) return true;
    const opp = OPPOSITE_EDGE[e as 0];
    const [b0, b1] = PIECE_EDGES[q]!;
    const theirs = opp === b1 ? q * 2 : opp === b0 ? q * 2 + 1 : -1;
    return theirs >= 0 && ((sig[ntile]! >> theirs) & 1) === 1;
  }

  /** Flood-fill track pieces into blocks separated by signals. */
  private rebuildBlocks(): void {
    const map = this.state.map;
    const { type, track, owner } = map.layers;
    const w = map.width;
    this.blockOf.clear();
    let next = 0;
    const stack: number[] = [];
    // Parallel corner pieces (NE+SW, SE+NW) don't touch; every other pair touches or crosses.
    const PARALLEL = [-1, -1, 4, 5, 2, 3];
    for (let tile = 0; tile < type.length; tile++) {
      if (!isTrackTile(type[tile]!)) continue;
      for (let p = 0; p < 6; p++) {
        if (!hasPiece(track[tile]!, p) || this.blockOf.has(tile * 8 + p)) continue;
        const id = next++;
        this.blockOf.set(tile * 8 + p, id);
        stack.push(tile * 8 + p);
        while (stack.length) {
          const k = stack.pop()!;
          const ct = Math.floor(k / 8);
          const cp = k % 8;
          if (cp >= 6) continue; // span pieces only carry the block id; heads link them
          const visit = (key: number) => {
            if (this.blockOf.has(key)) return;
            this.blockOf.set(key, id);
            stack.push(key);
          };
          for (let q = 0; q < 6; q++) if (q !== cp && q !== PARALLEL[cp] && hasPiece(track[ct]!, q)) visit(ct * 8 + q);
          const x = ct % w;
          const y = (ct - x) / w;
          const head = headInfo(map, ct);
          for (const e of PIECE_EDGES[cp]!) {
            if (head && e === head.dir) {
              // Across a bridge/tunnel: the span pieces and the far head share this block.
              const far = otherHead(map, ct, head);
              if (far < 0) continue;
              const spanPiece = e === 1 || e === 3 ? 6 : 7;
              for (let k = 1; ; k++) {
                const mt = ct + (EDGE_DX[e] + EDGE_DY[e] * w) * k;
                if (mt === far) break;
                visit(mt * 8 + spanPiece);
              }
              visit(far * 8 + (hasPiece(track[far]!, 0) ? 0 : 1));
              continue;
            }
            const nx = x + EDGE_DX[e];
            const ny = y + EDGE_DY[e];
            if (nx < 0 || ny < 0 || nx >= w || ny >= map.height) continue;
            const nt = ny * w + nx;
            if (!isTrackTile(type[nt]!) || !this.state.joined(owner[ct]!, owner[nt]!)) continue;
            // Depot doors behave like signals: a depot is always its own block.
            if (type[nt] === TileType.Depot || type[ct] === TileType.Depot) continue;
            const entry = OPPOSITE_EDGE[e];
            const nHead = headInfo(map, nt);
            if (nHead && nHead.dir === entry) continue; // bridge head seen from below
            for (const q of EDGE_PIECES[entry]!) {
              if (!hasPiece(track[nt]!, q) || !isLinked(map, ct, cp, e, q)) continue;
              if (this.boundary(ct, cp, e, nt, q)) continue;
              visit(nt * 8 + q);
            }
          }
        }
      }
    }
    this.blockExits.clear();
    const sigs = map.layers.signals;
    for (const tile of this.state.signalTiles) {
      const kind = signalKindOf(sigs[tile]!);
      if (kind !== 'exit' && kind !== 'combo') continue;
      for (let td = 0; td < 12; td++) {
        if (!((sigs[tile]! >> td) & 1)) continue;
        const b = this.blockOf.get(tile * 8 + (td >> 1));
        if (b === undefined) continue;
        const list = this.blockExits.get(b);
        if (list) list.push(seg(tile, td));
        else this.blockExits.set(b, [seg(tile, td)]);
      }
    }
    this.pathBlocks.clear();
    for (const tile of this.state.signalTiles) {
      if (signalKindOf(sigs[tile]!) !== 'path') continue;
      for (let td = 0; td < 12; td++) {
        if (!((sigs[tile]! >> td) & 1)) continue;
        // Both the block before the signal and the block beyond it.
        const s = seg(tile, td);
        for (const n of [s, ...nextSegments(map, s, this.state.blockAccess)]) {
          const b = this.blockOf.get(pieceKey(n));
          if (b !== undefined) this.pathBlocks.add(b);
        }
      }
    }
    this.blocksFor = this.state.trackVersion;
    this.rebuildOccupancy();
  }

  /** Signal block id of a piece (tile * 8 + piece), for diagnostics and tests. */
  blockOfPiece(key: number): number | undefined {
    this.ensureBlocks();
    return this.blockOf.get(key);
  }

  /** Block occupied or claimed by a train other than `except`. */
  private blockBusy(b: number, except: number): boolean {
    const use = this.blockUse.get(b);
    if (use) for (const id of use.keys()) if (id !== except) return true;
    const c = this.claims.get(b);
    if (c !== undefined && c !== except) return true;
    const res = this.blockRes.get(b);
    if (res) for (const id of res.keys()) if (id !== except) return true;
    return false;
  }

  signalKind(s: number): SignalKind {
    return signalKindOf(this.state.map.layers.signals[segTile(s)]!);
  }

  /**
   * Would a non-path signal of `kind` let a train (`except`) into block `b`? Entry and combo
   * signals also need a green exit (or combo) signal out of the block, if it has any.
   */
  private blockGreen(b: number | undefined, except: number, kind: SignalKind, depth = 0): boolean {
    if (b === undefined) return true;
    if (this.blockBusy(b, except)) return false;
    if (kind !== 'entry' && kind !== 'combo') return true;
    const exits = this.blockExits.get(b);
    if (!exits?.length || depth > 8) return true;
    return exits.some((e) => this.exitGreen(e, except, depth + 1));
  }

  /** Is the exit (or combo) signal at the end of segment `e` green (ignoring train `except`)? */
  private exitGreen(e: number, except: number, depth: number): boolean {
    return this.wayClear(e, this.signalKind(e) === 'combo' ? 'combo' : 'block', except, depth);
  }

  /**
   * A signal protects the track up to the next signal facing the same way: one facing the
   * other way splits blocks, but doesn't stop a train. Is there a way on from the non-path
   * signal at the end of `s` through blocks free of trains (but `except`) to such a signal
   * (or a dead end)?
   */
  private wayClear(s: number, kind: SignalKind, except = -1, depth = 0): boolean {
    const map = this.state.map;
    const access = this.state.blockAccess;
    const free = new Map<number, boolean>();
    const isFree = (n: number, first: boolean) => {
      const b = this.blockOf.get(pieceKey(n));
      if (b === undefined) return true;
      let f = free.get(b);
      if (f === undefined) free.set(b, (f = first ? this.blockGreen(b, except, kind, depth) : !this.blockBusy(b, except)));
      return f;
    };
    const stack = nextSegments(map, s, access).filter((n) => isFree(n, true));
    const seen = new Set<number>();
    while (stack.length) {
      const c = stack.pop()!;
      if (seen.has(c)) continue;
      seen.add(c);
      if (this.signalFacing(c) || seen.size > 512) return true;
      const next = nextSegments(map, c, access);
      if (next.length === 0) return true;
      for (const n of next) if (isFree(n, false)) stack.push(n);
    }
    return false;
  }

  /** Signal blocks on a train's route from index `i` up to the next signal facing it. */
  private blocksFrom(t: Train, i: number): number[] {
    const out: number[] = [];
    for (const s of this.runFrom(t, i)) {
      const b = this.blockOf.get(pieceKey(s));
      if (b !== undefined && !out.includes(b)) out.push(b);
    }
    return out;
  }

  /** Would the non-path signal before route index `i` let this train on along its route? */
  private signalClear(t: Train, i: number, kind: SignalKind): boolean {
    let last = -1;
    for (let k = i; k < t.route.length; k++) {
      const s = t.route[k]!;
      const b = this.blockOf.get(pieceKey(s));
      if (b !== undefined && b !== last) {
        if (this.claims.get(b) !== t.id && !this.blockGreen(b, t.id, last < 0 ? kind : 'block')) return false;
        last = b;
      }
      if (this.signalFacing(s)) break;
    }
    return true;
  }

  /** Claim the blocks up to the next signal so nobody else enters them. */
  private claimFrom(t: Train, i: number): void {
    for (const b of this.blocksFrom(t, i)) this.claims.set(b, t.id);
  }

  /** Drop claims on blocks the train's route no longer leads through (after it changed). */
  private pruneClaims(t: Train): void {
    const keep = new Set<number>();
    for (const s of t.path) keep.add(this.blockOf.get(pieceKey(s))!);
    for (const s of t.route) keep.add(this.blockOf.get(pieceKey(s))!);
    for (const [b, id] of [...this.claims]) if (id === t.id && !keep.has(b)) this.claims.delete(b);
  }

  /** Red if no way beyond the signal on this tile/trackdir is free up to the next signal. */
  signalRed(tile: number, td: number): boolean {
    this.ensureBlocks();
    const s = seg(tile, td);
    const kind = this.signalKind(s);
    // Path signals show red until a train reserves a path through them.
    if (kind === 'path') return !nextSegments(this.state.map, s, this.state.blockAccess).some((n) => this.reserved.has(pieceKey(n)));
    return !this.wayClear(s, kind);
  }

  depotHasVehicles(tile: number): boolean {
    for (const t of this.state.trains.values()) {
      if (!isRailVehicle(t)) continue;
      if (t.status === 'depot' && t.depot === tile) return true;
      if (t.path.some((s) => segTile(s) === tile)) return true;
    }
    return false;
  }

  // ---- control -----------------------------------------------------------------

  canStart(t: Train): string | null {
    if (t.status === 'depot') {
      if (t.orders.length === 0) return 'Give the train some orders first';
      if (this.statsOf(t).electric && !isElectrified(this.state.map.layers.railType[t.depot]!)) return 'Electric engines need an electrified depot';
      return null;
    }
    return t.status === 'stopped' ? null : 'Already running';
  }

  /**
   * Leave the depot (or resume after a player stop). Call canStart() first. A train leaving
   * a depot waits inside until the line beyond the door is clear: the door acts as a signal.
   */
  start(t: Train): void {
    if (t.status === 'depot') {
      t.status = 'running';
      t.route = [];
      t.routeFor = -1;
      t.speed = 0;
    } else if (t.status === 'stopped') {
      t.status = 'running';
    }
  }

  /**
   * Move a train waiting inside its depot onto the line if the block beyond the door is free.
   * Into a path-signalled block the door acts as a path signal instead: it opens once the train
   * has reserved its way to the next signal, wherever else in the block other trains are.
   */
  private tryLeaveDepot(t: Train): void {
    const map = this.state.map;
    const s = depotExitSegment(map, t.depot);
    if (this.occupiedByOther(s, t.id)) return;
    const beyond = nextSegments(map, s, this.accessOf(t)).map((n) => this.blockOf.get(pieceKey(n)));
    const pbs = beyond.some((b) => b !== undefined && this.pathBlocks.has(b));
    if (pbs) {
      const target = this.targetKey(t);
      if (target >= 0 && t.routeFor !== routeKey(this.state.trackVersion, target) && this.state.tick >= t.replanAt) this.plan(t);
      if (!t.route.length || !segmentsConnect(map, s, t.route[0]!, this.accessOf(t))) return;
      if (!this.tryReserve(t, 0, true)) {
        // The way is taken: wait, and look for another way with the traffic in a while.
        if (this.state.tick >= t.replanAt) {
          t.routeFor = -1;
          t.replanAt = this.state.tick + REPLAN_DELAY;
        }
        return;
      }
    } else {
      if (beyond.some((b) => b !== undefined && this.blockBusy(b, t.id))) return;
      for (const b of beyond) if (b !== undefined) this.claims.set(b, t.id);
    }
    t.path = [s];
    t.pos = 0;
    t.depot = -1;
    t.pbs = pbs;
    t.departedAt = this.state.tick;
    this.occupy(t, s);
    this.state.dirtyTrains.add(t.id);
  }

  stop(t: Train): void {
    if (t.status === 'running' || t.status === 'loading') t.status = 'stopped';
  }

  /** Toggle heading for the nearest depot. */
  sendToDepot(t: Train): void {
    t.toDepot = !t.toDepot;
    t.routeFor = -1;
  }

  /** Turn the train around (only when stopped and fully out of the depot). */
  reverse(t: Train): boolean {
    if (t.path.length === 0 || t.speed > 0.5) return false;
    const len = this.statsOf(t).length;
    let covered = t.pos;
    for (let i = 1; i < t.path.length; i++) covered += segLength(t.path[i]!);
    if (covered + 1e-6 < len) return false; // tail still inside a depot
    const last = t.path[t.path.length - 1]!;
    const newPath = t.path.map(segReverse).reverse();
    t.pos = segLength(last) - (covered - len);
    t.path = newPath;
    t.route = [];
    t.routeFor = -1;
    t.speed = 0;
    this.dropClaims(t);
    this.dropReservations(t, true);
    return true;
  }

  /** Remove a parked train completely. */
  removeFromWorld(t: Train): void {
    this.forget(t);
  }

  // ---- simulation --------------------------------------------------------------

  step(): void {
    this.ensureBlocks();
    this.updateCrossings();
    for (const t of this.state.trains.values()) {
      if (t.status === 'depot' || !isRailVehicle(t)) continue;
      this.stepTrain(t);
    }
  }

  /** Level crossings closed to road traffic: a train is on them or about to arrive. */
  readonly closedCrossings = new Set<number>();

  private isCrossing(tile: number): boolean {
    const map = this.state.map;
    return map.layers.type[tile] === TileType.Rail && (map.layers.data[tile]! & CROSSING_FLAG) !== 0;
  }

  /** Level crossing tiles, found again whenever track or roads change. */
  private crossingTiles = new Set<number>();
  private crossingsFor = '';

  private updateCrossings(): void {
    const ver = `${this.state.trackVersion}:${this.state.roadVersion}`;
    if (ver !== this.crossingsFor) {
      this.crossingsFor = ver;
      this.crossingTiles.clear();
      const { type, data } = this.state.map.layers;
      for (let i = 0; i < type.length; i++) if (type[i] === TileType.Rail && data[i]! & CROSSING_FLAG) this.crossingTiles.add(i);
    }
    this.closedCrossings.clear();
    if (this.crossingTiles.size === 0) return;
    for (const t of this.state.trains.values()) {
      if (!isRailVehicle(t) || t.path.length === 0) continue;
      for (const s of t.path) if (this.isCrossing(segTile(s))) this.closedCrossings.add(segTile(s));
      let d = segLength(t.path[0]!) - t.pos;
      for (const s of t.route) {
        if (d > CROSSING_WARNING + brakingDistance(t.speed)) break;
        if (this.isCrossing(segTile(s))) this.closedCrossings.add(segTile(s));
        d += segLength(s);
      }
    }
  }

  private stepTrain(t: Train): void {
    const map = this.state.map;
    if (t.path.length === 0) {
      if (t.depot >= 0 && t.status === 'running') this.tryLeaveDepot(t);
      return;
    }
    // Track under the train may have been removed (only possible for tiles not occupied when
    // the command ran, so this is a safety net for saves/edge cases).
    if (!t.path.every((s) => segmentExists(map, s))) {
      t.route = [];
      t.speed = 0;
      return;
    }

    if (t.status === 'loading') {
      if (t.loadTicks > 0) t.loadTicks--;
      const keep = this.onLoading?.(t, t.lastStation) ?? false;
      if (t.loadTicks <= 0 && !keep) this.depart(t);
      return;
    }

    const target = this.targetKey(t);
    if (target >= 0 && t.routeFor !== routeKey(this.state.trackVersion, target) && this.state.tick >= t.replanAt) {
      this.plan(t);
    }

    if (t.brakeFail) {
      // Brake failure: no traction, no brakes; the train rolls on, slowing only by resistance.
      t.brakeFail--;
      t.speed = Math.max(0, t.speed - COAST_KMH_PER_S * DT);
      this.advance(t, (t.speed / KMH_PER_TILE_PER_S) * DT);
      if (!this.state.trains.has(t.id)) return;
      this.checkDerail(t);
      if (!t.brakeFail) this.state.dirtyTrains.add(t.id);
      return;
    }

    // Look ahead for the nearest place we must stop.
    const stats = this.statsOf(t);
    const stopAt = this.stopDistance(t, brakingDistance(t.speed) + 2);
    // Brake for the stop point, but creep the last bit so trains reach it exactly.
    let limit = Math.min(stats.maxSpeed, this.trackLimit(t), Math.max(speedForDistance(stopAt), stopAt > 0.01 ? CREEP_KMH : 0));
    if (t.brokenDown) {
      if (--t.brokenDown <= 0) {
        t.brokenDown = 0;
        this.state.dirtyTrains.add(t.id);
      }
      limit = 0;
    }
    if (t.status === 'stopped') limit = 0;

    if (t.speed > limit) {
      t.speed = Math.max(limit, t.speed - BRAKE_KMH_PER_S * DT);
    } else {
      const a = this.acceleration(t, stats);
      t.speed = Math.max(0, Math.min(limit, t.speed + a * DT));
    }
    if (t.speed < 0.05 && limit < 0.5) t.speed = 0;

    this.advance(t, (t.speed / KMH_PER_TILE_PER_S) * DT);
    if (!this.state.trains.has(t.id)) return; // crashed
    this.checkDerail(t);
    if (!this.state.trains.has(t.id)) return;
    this.passWaypoint(t);

    if (t.speed === 0 && t.status === 'running') this.whenStopped(t);
  }

  /** Realistic accidents: a train far over the curve limit under it derails. */
  private checkDerail(t: Train): void {
    if (!this.state.incidents.rules?.derail || t.speed < 40) return;
    const curve = this.curveLimitUnder(t);
    if (t.speed <= curve * DERAIL_OVERSPEED) return;
    const why = t.brakeFail ? ': its brakes had failed' : '';
    this.state.incidents.derail(t, `It took a curve for ${Math.round(curve)} km/h at ${Math.round(t.speed)} km/h${why}.`);
  }

  /** Acceleration in km/h per second from tractive effort, resistance and gradient. */
  private acceleration(t: Train, s: TrainStats): number {
    const mass = s.mass + cargoMass(t);
    if (mass <= 0) return 0;
    const vms = Math.max(t.speed / 3.6, 1);
    const tractive = Math.min(s.tractiveEffort, s.power / vms); // kN
    const resist = mass * (0.012 + 0.00015 * t.speed) + 0.0005 * t.speed * t.speed; // kN
    const grade = this.gradeUnder(t) * GRADE_PER_LEVEL * 9.81 * mass; // kN
    const a = ((tractive - resist - grade) / mass) * ACCEL_SCALE; // m/s²
    return a * 3.6;
  }

  /** Average climb (levels per tile) under the whole train, weighted by segment length. */
  private gradeUnder(t: Train): number {
    const map = this.state.map;
    let sum = 0;
    let len = 0;
    for (const s of t.path) {
      const td = segTd(s);
      const [h0, h1] = segHeights(map, segTile(s), td);
      sum += h1 - h0;
      len += pieceLength(tdPiece(td));
    }
    return len > 0 ? sum / len : 0;
  }

  /** Distance (tiles) from the head to the first place the train must stop, up to `horizon`. */
  private stopDistance(t: Train, horizon: number): number {
    const map = this.state.map;
    let d = segLength(t.path[0]!) - t.pos;
    let prev = t.path[0]!;
    const commit = brakingDistance(t.speed) + 1;
    const running = t.status === 'running';
    const rules = this.state.incidents.rules;
    const access = this.accessOf(t);
    let pbs = t.pbs === true;
    for (let i = 0; i < t.route.length; i++) {
      let s = t.route[i]!;
      if (d > horizon) return d;
      if (!segmentsConnect(map, prev, s, access)) return d; // route went stale
      if (this.signalFacing(prev)) {
        const kind = this.signalKind(prev);
        pbs = kind === 'path';
        const held = pbs ? this.reservedBy(s) === t.id : this.claims.get(this.blockOf.get(pieceKey(s)) ?? -1) === t.id;
        // Close enough that we will pass: if the way beyond is taken, look for another.
        if (!held && d <= commit && running && this.rerouteAtSignal(t, i, prev)) s = t.route[i]!;
        if (held) {
          // Already reserved or claimed the way past this signal.
        } else if (pbs) {
          // Close enough that we will pass: reserve the path to the next signal.
          if (!this.tryReserve(t, i, d <= commit && running)) return d - SAFETY_MARGIN;
        } else {
          if (!this.signalClear(t, i, kind)) return d - SAFETY_MARGIN;
          // Close enough that we will pass: claim the way to the next signal.
          if (d <= commit && running) this.claimFrom(t, i);
        }
      } else if (pbs && this.reservedBy(s) !== t.id) {
        // Inside a path-signalled area: keep the way ahead reserved.
        if (!this.tryReserve(t, i, d <= commit && running)) return d - SAFETY_MARGIN;
      }
      // With accidents on, drivers only see trains ahead within sight; signals must do the rest.
      if (this.occupiedByOther(s, t.id) && (!rules || d <= rules.sight)) return d - SAFETY_MARGIN;
      d += segLength(s);
      prev = s;
    }
    return d; // end of route: destination platform end, depot, or dead end
  }

  private advance(t: Train, dist: number): void {
    const map = this.state.map;
    while (dist > 0) {
      const head = t.path[0]!;
      const room = segLength(head) - t.pos;
      if (dist <= room) {
        t.pos += dist;
        break;
      }
      const next = t.route[0];
      const rules = this.state.incidents.rules;
      if (
        rules &&
        next !== undefined &&
        t.speed > rules.collideAbove &&
        this.occupiedByOther(next, t.id) &&
        segmentsConnect(map, head, next, this.accessOf(t))
      ) {
        this.state.incidents.collide(t, next, this.collisionCause(t, next));
        return;
      }
      if (
        next === undefined ||
        !segmentsConnect(map, head, next, this.accessOf(t)) ||
        this.occupiedByOther(next, t.id) ||
        !this.mayEnter(t, head, next)
      ) {
        t.pos = segLength(head);
        t.speed = 0;
        break;
      }
      if (this.signalFacing(head)) t.pbs = this.signalKind(head) === 'path';
      t.route.shift();
      t.path.unshift(next);
      this.occupy(t, next);
      t.pos = 0;
      dist -= room;
      // A road vehicle still on a level crossing is hit (with accidents on).
      if (this.isCrossing(segTile(next)) && this.state.incidents.rules) {
        const hit = this.state.road.vehiclesOn(segTile(next));
        if (hit.length) this.state.incidents.crossingCollision(t, hit, segTile(next));
      }
    }
    this.trimTail(t);
  }

  /** May the head move from `head` onto `next` (route[0])? Signals and reservations decide. */
  private mayEnter(t: Train, head: number, next: number): boolean {
    if (this.signalsLetIn(t, head, next)) return true;
    if (!t.brakeFail) return false;
    // No brakes: past the signal regardless.
    if (this.signalFacing(head)) t.ranRedAt = this.state.tick;
    return true;
  }

  private signalsLetIn(t: Train, head: number, next: number): boolean {
    if (this.signalFacing(head)) {
      const kind = this.signalKind(head);
      if (kind === 'path') return this.reservedBy(next) === t.id || this.tryReserve(t, 0, true);
      if (!this.signalClear(t, 0, kind)) return false;
      this.claimFrom(t, 0);
      return true;
    }
    if (t.pbs && this.reservedBy(next) !== t.id) return this.tryReserve(t, 0, true);
    return true;
  }

  /** Why `t`, about to move onto `next`, runs into what is there (for the accident report). */
  collisionCause(t: Train, next: number): string {
    const head = t.path[0]!;
    const recent = (x: Train) => x.ranRedAt !== undefined && this.state.tick - x.ranRedAt < 2 * TICKS_PER_DAY;
    if (t.brakeFail) {
      const red = this.signalFacing(head) || recent(t);
      return `${t.name}'s brakes had failed, so it could not stop${red ? ' and ran past a red signal' : ''}.`;
    }
    const others = this.trainsOn(next, t.id).map((id) => this.state.trains.get(id)!);
    const red = others.find(recent);
    if (red) return `${red.name} had run past a red signal after its brakes failed, into ${t.name}'s way.`;
    const sight = this.state.incidents.rules?.sight ?? 0;
    const need = brakingDistance(t.speed);
    const tooFast = `At ${Math.round(t.speed)} km/h it needed ${Math.max(1, Math.round(need))} tiles to stop, but drivers only see ${sight} tiles ahead.`;
    const other = others[0];
    if (!other) return `${t.name} came upon the wreckage of an earlier accident with no signal before it. ${tooFast}`;
    const stop = need > sight ? tooFast : `${other.name} got in its way too close for it to stop.`;
    const theirs = other.path.find((s) => pieceKey(s) === pieceKey(next));
    const way = theirs === next ? 'same' : theirs === segReverse(next) ? 'opposite' : 'across';
    // A signal (or path reservation) gave `t` this stretch: the other train got in where no signal faces it.
    const block = this.blockOf.get(pieceKey(next));
    const cleared = (block !== undefined && this.claims.get(block) === t.id) || this.reservedBy(next) === t.id;
    if (cleared && way === 'opposite')
      return `A signal let ${t.name} onto the line, but ${other.name} came the other way with no signal facing it. Signal both directions, or make the line one-way.`;
    if (cleared) return `A signal let ${t.name} onto the line, but ${other.name} joined it at a junction with no signal facing it.`;
    if (way === 'same') return `${t.name} ran into the back of ${other.name}: no signal stood between them. ${stop}`;
    if (way === 'opposite') {
      // Head-on, both trains' stopping distances count.
      const both = need + brakingDistance(other.speed);
      const closing =
        both > sight
          ? `At ${Math.round(t.speed)} and ${Math.round(other.speed)} km/h they needed ${Math.max(1, Math.round(both))} tiles to stop, but drivers only see ${sight} tiles ahead.`
          : `${other.name} got in its way too close for it to stop.`;
      return `${t.name} and ${other.name} met head-on: no signal kept them apart. ${closing} Signal both directions, or make the line one-way.`;
    }
    return `${t.name} hit ${other.name} where their tracks cross or join, with no signal before it. ${stop}`;
  }

  private trimTail(t: Train): void {
    const len = this.statsOf(t).length;
    let covered = t.pos;
    let keep = 1;
    while (keep < t.path.length && covered < len) covered += segLength(t.path[keep++]!);
    while (t.path.length > keep) this.release(t, t.path.pop()!);
  }

  /** Train has come to a halt while running: arrived, blocked, or at a dead end. */
  private whenStopped(t: Train): void {
    const map = this.state.map;
    const head = t.path[0]!;
    const atEnd = t.pos >= segLength(head) - 0.01 && t.route.length === 0;
    if (!atEnd) return; // waiting behind something; keep the route

    const tile = segTile(head);
    const order = t.orders[t.orderIndex];
    if (map.layers.type[tile] === TileType.Depot && (t.toDepot || t.serviceTrip || order?.kind === 'depot')) {
      const parkHere = t.toDepot;
      const detour = t.serviceTrip && order?.kind !== 'depot';
      t.serviceTrip = false;
      this.enterDepot(t, tile);
      if (detour) {
        // A service detour: carry on with the same order.
        t.status = 'running';
      } else if (!parkHere && order) {
        // A depot order: get serviced and carry on with the next order.
        this.recordArrival(t, order);
        advanceOrder(this.state, t);
        t.status = 'running';
      }
      return;
    }
    if (!t.toDepot && order?.kind === 'station' && map.layers.type[tile] === TileType.Station && map.layers.data[tile] === order.station) {
      t.status = 'loading';
      this.recordArrival(t, order);
      // A train longer than its platform takes longer to load (up to three times as long).
      let covered = 0;
      for (const s of t.path) {
        const st = segTile(s);
        if (map.layers.type[st] === TileType.Station && map.layers.data[st] === order.station) covered += segLength(s);
      }
      const length = this.statsOf(t).length;
      t.loadTicks = Math.round(DWELL_TICKS * Math.min(3, Math.max(1, length / Math.max(0.5, covered))));
      // Timetabled wait: stay at least this long.
      if (order.wait) t.loadTicks = Math.max(t.loadTicks, Math.round(order.wait * TICKS_PER_DAY));
      t.lastStation = order.station;
      this.state.dirtyTrains.add(t.id);
      this.onArrive?.(t, order.station);
      return;
    }
    // Dead end or nowhere to go: try again (possibly reversing) after a short delay.
    if (this.state.tick >= t.replanAt) this.plan(t);
  }

  /** Park the train inside the depot on `tile` (also used to tow trains home). */
  enterDepot(t: Train, tile: number): void {
    this.releaseAll(t);
    this.dropClaims(t);
    this.dropReservations(t);
    t.pbs = false;
    t.path = [];
    t.route = [];
    t.pos = 0;
    t.speed = 0;
    t.status = 'depot';
    t.depot = tile;
    t.toDepot = false;
    t.routeFor = -1;
    t.lastService = this.state.date;
    this.onService?.(t);
    this.state.dirtyTrains.add(t.id);
  }

  /** Called when a train is serviced in a depot (reliability is restored there). */
  onService: ((t: Train) => void) | null = null;

  private depart(t: Train): void {
    t.status = 'running';
    this.state.dirtyTrains.add(t.id);
    advanceOrder(this.state, t);
    t.departedAt = this.state.tick;
    t.replanAt = 0;
    // A service due: detour to the nearest depot first (unless the orders visit one anyway).
    if (this.state.settings.breakdowns && needsService(this.state, t) && !t.orders.some((o) => o.kind === 'depot')) t.serviceTrip = true;
    this.plan(t);
  }

  /** Timetable bookkeeping on reaching an order: autofill its travel time, or note lateness. */
  private recordArrival(t: Train, o: Order): void {
    if (o.kind === 'jump' || t.departedAt === undefined) return;
    const actual = Math.round(((this.state.tick - t.departedAt) / TICKS_PER_DAY) * 10) / 10;
    if (t.autofill) {
      o.travel = Math.max(0.1, actual);
      if (t.line !== undefined) this.state.dirtyLines.add(t.line);
    } else if (o.travel) t.lateness = Math.round((actual - o.travel) * 10) / 10;
    this.state.dirtyTrains.add(t.id);
  }

  /** Waypoints are passed without stopping: the next order starts as the head reaches one. */
  private passWaypoint(t: Train): void {
    const o = t.orders[t.orderIndex];
    if (o?.kind !== 'waypoint' || t.toDepot || t.path.length === 0) return;
    const wp = this.state.waypoints.get(o.waypoint);
    if (!wp || segTile(t.path[0]!) !== wp.tile) return;
    this.recordArrival(t, o);
    advanceOrder(this.state, t);
    t.departedAt = this.state.tick;
  }

  private targetKey(t: Train): number {
    return targetCode(t);
  }

  private goalFor(t: Train): PathGoal | null {
    // Sent to a depot: the nearest. A service detour: the one most on the way to the current order.
    if (t.toDepot) return this.depotGoalFor(t);
    if (t.serviceTrip) return this.depotGoalFor(t, t.orders[t.orderIndex]);
    const o = t.orders[t.orderIndex];
    return o ? this.goalForOrder(t, o) : null;
  }

  /**
   * Goal: any of the company's depots. Given the order to carry on with afterwards, a depot
   * also costs the distance from it on to that order, so trains get serviced on their line
   * rather than at a depot that happens to be closer but leads them away from it.
   */
  private depotGoalFor(t: Train, after?: Order): PathGoal | null {
    const map = this.state.map;
    const depots = [...this.state.depots].filter((d) => map.layers.owner[d] === t.owner);
    if (!depots.length) return null;
    const next = after && after.kind !== 'depot' ? this.goalForOrder(t, after) : null;
    if (!next) return depotGoal(map, depots);
    const w = map.width;
    return depotGoal(map, depots, (d) => next.estimate(d % w, Math.floor(d / w)));
  }

  private goalForOrder(t: Train, o: Order): PathGoal | null {
    const map = this.state.map;
    if (o.kind === 'depot') return this.depotGoalFor(t, t.orders[peekNextOrder(this.state, t)]);
    if (o.kind === 'station') {
      const st = this.state.stations.get(o.station);
      return st ? stationGoal(map, st.id, st) : null;
    }
    if (o.kind === 'waypoint') {
      const wp = this.state.waypoints.get(o.waypoint);
      return wp ? depotGoal(map, [wp.tile]) : null;
    }
    return null;
  }

  /** Plan a route to the current target; reverse if only the way back leads there. */
  plan(t: Train): void {
    this.planRoute(t);
    this.pruneClaims(t);
  }

  private planRoute(t: Train): void {
    const key = this.targetKey(t);
    const goal = this.goalFor(t);
    t.routeFor = routeKey(this.state.trackVersion, key);
    if (!goal) {
      t.route = [];
      t.replanAt = this.state.tick + REPLAN_DELAY;
      noRoute(this.state, t);
      return;
    }
    this.dropReservations(t, true);
    // A train still waiting inside its depot plans from the door.
    const head = t.path[0] ?? depotExitSegment(this.state.map, t.depot);
    let path = this.findRoute(t, head, goal);
    if (!path && t.speed < 0.5 && t.path.length) {
      // Try the other way round: plan from the tail segment, reversed.
      const tail = segReverse(t.path[t.path.length - 1]!);
      const back = this.findRoute(t, tail, goal);
      if (back && this.reverse(t)) {
        path = back;
        t.routeFor = routeKey(this.state.trackVersion, key);
      }
    }
    if (!path && t.speed < 0.5) {
      // Neither way leads there from here (say, the train is coming out of a depot facing away
      // from it): drive on until the whole train is clear, stop, and reverse there.
      const penalty = (s: number) => this.routePenalty(s, t.id);
      const out = findTurnaround(this.state.map, head, goal, this.statsOf(t).length, { access: this.accessOf(t), penalty });
      if (out) {
        foundRoute(this.state, t);
        t.route = out;
        return;
      }
    }
    if (!path) {
      t.route = [];
      t.replanAt = this.state.tick + REPLAN_DELAY;
      // No depot in reach: skip the service rather than wait for one.
      if (t.serviceTrip) {
        t.serviceTrip = false;
        t.routeFor = -1;
        t.replanAt = 0;
      } else noRoute(this.state, t);
      return;
    }
    foundRoute(this.state, t);
    t.route = this.continueRoute(t, path);
  }

  /** A* from `start` to `goal` for this train, avoiding occupied and reserved track if it can. */
  private findRoute(t: Train, start: number, goal: PathGoal): number[] | null {
    const penalty = (s: number) => this.routePenalty(s, t.id);
    return findPath(this.state.map, start, goal, { access: this.accessOf(t), penalty });
  }

  /**
   * Extra path cost of a segment taken by another train. A platform is costed as a whole where
   * the route enters it: the search ends there, but the train will run on to its far end.
   */
  private routePenalty(s: number, id: number): number {
    const { type, data, track } = this.state.map.layers;
    const tile = segTile(s);
    if (type[tile] !== TileType.Station) return this.takenPenalty(s, id);
    const w = this.state.map.width;
    const td = segTd(s);
    const platform = (n: number) => type[n] === TileType.Station && data[n] === data[tile] && track[n] === track[tile];
    const back = tdEntry(td);
    if (platform(tile + EDGE_DX[back] + EDGE_DY[back] * w)) return 0; // costed on entry
    const ahead = tdExit(td);
    const step = EDGE_DX[ahead] + EDGE_DY[ahead] * w;
    let sum = 0;
    for (let n = tile, k = 0; k < 64 && platform(n); n += step, k++) sum += this.takenPenalty(seg(n, td), id);
    return sum;
  }

  private takenPenalty(s: number, id: number): number {
    if (this.occupiedByOther(s, id)) return 6;
    const r = this.reserved.get(pieceKey(s));
    return r !== undefined && r !== id ? 4 : 0;
  }

  /** Finish a path to the current order: run on through waypoints and to the platform's end. */
  private continueRoute(t: Train, path: number[]): number[] {
    // Run on through waypoints to the order after them, so trains don't brake for waypoints.
    let o = t.toDepot ? undefined : t.orders[t.orderIndex];
    const saved = t.orderIndex;
    for (let k = 0; k < 4 && o?.kind === 'waypoint' && path.length > 0; k++) {
      t.orderIndex = peekNextOrder(this.state, t);
      const next = t.orders[t.orderIndex];
      const g = next ? this.goalForOrder(t, next) : null;
      const more = g ? this.findRoute(t, path[path.length - 1]!, g) : null;
      if (!more) break;
      path.push(...more);
      o = next;
    }
    t.orderIndex = saved;
    extendThroughPlatform(this.state.map, path, this.accessOf(t));
    return path;
  }

  /** Signal each train last re-routed at, and the tick it may try again there. */
  private reroutes = new Map<number, { signal: number; until: number }>();

  /**
   * The train is about to pass the signal at the end of `prev` (route index `i` lies beyond
   * it). Routes are planned at departure, so if the way to the next signal is now occupied or
   * reserved, plan again from here with the current traffic: another platform or a parallel
   * track may be free. Returns true if the route changed.
   */
  private rerouteAtSignal(t: Train, i: number, prev: number): boolean {
    const last = this.reroutes.get(t.id);
    if (last?.signal === prev && this.state.tick < last.until) return false;
    const kind = this.signalKind(prev);
    if (kind === 'path' ? this.canReserve(this.runFrom(t, i), t.id) : this.signalClear(t, i, kind)) return false;
    this.reroutes.set(t.id, { signal: prev, until: this.state.tick + REROUTE_DELAY });
    const goal = this.goalFor(t);
    // Already at (or committed to) the goal: nothing to choose.
    if (!goal || goal.isGoal(t.path[0]!) || t.route.slice(0, i).some((s) => goal.isGoal(s))) return false;
    const found = this.findRoute(t, prev, goal);
    if (!found) return false;
    const path = this.continueRoute(t, found);
    const old = t.route.slice(i);
    if (path.length === old.length && path.every((s, k) => s === old[k])) return false;
    t.route = t.route.slice(0, i).concat(path);
    this.limitCache.delete(t.id);
    this.pruneClaims(t);
    // Reservations only reach the next signal, but drop any left on the old way just in case.
    const keep = new Set([...t.path, ...t.route.slice(0, i)].map(pieceKey));
    for (const [k, id] of [...this.reserved]) if (id === t.id && !keep.has(k)) this.unreserve(k);
    return true;
  }

  motion(t: Train): TrainMotion {
    return { id: t.id, path: t.path.slice(), pos: t.pos, speed: t.speed, ahead: t.route.slice(0, 6) };
  }
}
