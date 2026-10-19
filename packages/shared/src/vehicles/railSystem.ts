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
import { depotGoal, extendThroughPlatform, findPath, stationGoal, type PathGoal } from '../rail/pathfinder.ts';
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
  tdPiece,
  turnSteps,
} from '../rail/track.ts';
import { TICKS_PER_DAY, TICKS_PER_SECOND } from '../sim/date.ts';
import type { GameState } from '../sim/state.ts';
import { TileType } from '../world/constants.ts';
import { signalKindOf, type SignalKind } from '../commands/signals.ts';
import { RAIL_TYPE_SPEED, isElectrified } from '../rail/railTypes.ts';
import { PASSENGER_MASS, cargoCount, trainStats, type Train, type TrainMotion, type TrainStats } from './train.ts';

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
/** Minimum approach speed for the final metres to a stop point. */
const CREEP_KMH = 4;

const DT = 1 / TICKS_PER_SECOND;
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
    const horizon = brakingDistance(t.speed) + 1;
    // Segments from the tail to the head, then the route ahead up to the braking horizon.
    const seq = t.path.slice().reverse();
    const behind = seq.length;
    let d = segLength(t.path[0]!) - t.pos;
    for (const s of t.route) {
      if (d > horizon) break;
      seq.push(s);
      d += segLength(s);
    }
    const limits = curveLimits(seq);
    let lim = Infinity;
    for (let i = 0; i < behind; i++) lim = Math.min(lim, limits[i]!, this.segLimit(seq[i]!));
    d = segLength(t.path[0]!) - t.pos;
    for (let i = behind; i < seq.length; i++) {
      const l = Math.min(limits[i]!, this.segLimit(seq[i]!));
      if (l < t.speed) lim = Math.min(lim, Math.hypot(l, speedForDistance(d)));
      d += segLength(seq[i]!);
    }
    return lim;
  }

  /** Speed limit of the curves along a train's path and route (for the train window and accidents). */
  curveLimitUnder(t: Train): number {
    const limits = curveLimits(t.path.slice().reverse());
    return Math.min(...limits);
  }

  /** The consist changed: recompute length, power and so on. */
  invalidateStats(t: Train): void {
    this.stats.delete(t.id);
  }

  forget(t: Train): void {
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
    const k = pieceKey(s);
    let set = this.occ.get(k);
    if (!set) this.occ.set(k, (set = new Set()));
    if (set.has(t.id)) return;
    set.add(t.id);
    const b = this.blockOf.get(k);
    if (b === undefined) return;
    let use = this.blockUse.get(b);
    if (!use) this.blockUse.set(b, (use = new Map()));
    use.set(t.id, (use.get(t.id) ?? 0) + 1);
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

  /** Rebuild occupancy from scratch (after loading a save, or when blocks change). */
  rebuildOccupancy(): void {
    this.occ.clear();
    this.blockUse.clear();
    this.claims.clear();
    for (const t of this.state.trains.values()) for (const s of t.path) this.occupy(t, s);
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
    return exits.some((e) => this.exitGreen(e, depth + 1));
  }

  /** Is the exit (or combo) signal at the end of segment `e` green for an unknown train? */
  private exitGreen(e: number, depth: number): boolean {
    const kind = this.signalKind(e);
    return nextSegments(this.state.map, e, this.state.blockAccess).every((n) =>
      this.blockGreen(this.blockOf.get(pieceKey(n)), -1, kind === 'combo' ? 'combo' : 'block', depth),
    );
  }

  /** Red if the block beyond the signal on this tile/trackdir is occupied or claimed. */
  signalRed(tile: number, td: number): boolean {
    this.ensureBlocks();
    const s = seg(tile, td);
    const next = nextSegments(this.state.map, s, this.state.blockAccess);
    const kind = this.signalKind(s);
    // Path signals show red until a train reserves a path through them.
    if (kind === 'path') return !next.some((n) => this.reserved.has(pieceKey(n)));
    return !next.every((n) => this.blockGreen(this.blockOf.get(pieceKey(n)), -1, kind));
  }

  depotHasVehicles(tile: number): boolean {
    for (const t of this.state.trains.values()) {
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
      t.routeFor = '';
      t.speed = 0;
    } else if (t.status === 'stopped') {
      t.status = 'running';
    }
  }

  /** Move a train waiting inside its depot onto the line if the block beyond the door is free. */
  private tryLeaveDepot(t: Train): void {
    const map = this.state.map;
    const s = depotExitSegment(map, t.depot);
    if (this.occupiedByOther(s, t.id)) return;
    const beyond = nextSegments(map, s, this.accessOf(t)).map((n) => this.blockOf.get(pieceKey(n)));
    if (beyond.some((b) => b !== undefined && this.blockBusy(b, t.id))) return;
    for (const b of beyond) if (b !== undefined) this.claims.set(b, t.id);
    t.path = [s];
    t.pos = 0;
    t.depot = -1;
    t.pbs = false;
    this.occupy(t, s);
    this.state.dirtyTrains.add(t.id);
  }

  stop(t: Train): void {
    if (t.status === 'running' || t.status === 'loading') t.status = 'stopped';
  }

  /** Toggle heading for the nearest depot. */
  sendToDepot(t: Train): void {
    t.toDepot = !t.toDepot;
    t.routeFor = '';
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
    t.routeFor = '';
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
    for (const t of this.state.trains.values()) {
      if (t.status === 'depot') continue;
      this.stepTrain(t);
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
    if (target !== null && t.routeFor !== `${this.state.trackVersion}:${target}` && this.state.tick >= t.replanAt) {
      this.plan(t);
    }

    // Look ahead for the nearest place we must stop.
    const stats = this.statsOf(t);
    const stopAt = this.stopDistance(t, brakingDistance(t.speed) + 2);
    // Brake for the stop point, but creep the last bit so trains reach it exactly.
    let limit = Math.min(stats.maxSpeed, this.trackLimit(t), Math.max(speedForDistance(stopAt), stopAt > 0.01 ? CREEP_KMH : 0));
    if (t.status === 'stopped') limit = 0;

    if (t.speed > limit) {
      t.speed = Math.max(limit, t.speed - BRAKE_KMH_PER_S * DT);
    } else {
      const a = this.acceleration(t, stats);
      t.speed = Math.max(0, Math.min(limit, t.speed + a * DT));
    }
    if (t.speed < 0.05 && limit < 0.5) t.speed = 0;

    this.advance(t, (t.speed / KMH_PER_TILE_PER_S) * DT);

    if (t.speed === 0 && t.status === 'running') this.whenStopped(t);
  }

  /** Acceleration in km/h per second from tractive effort, resistance and gradient. */
  private acceleration(t: Train, s: TrainStats): number {
    const mass = s.mass + cargoCount(t) * PASSENGER_MASS;
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
    let pbs = t.pbs === true;
    for (let i = 0; i < t.route.length; i++) {
      const s = t.route[i]!;
      if (d > horizon) return d;
      if (!segmentsConnect(map, prev, s, this.accessOf(t))) return d; // route went stale
      if (this.signalFacing(prev)) {
        const kind = this.signalKind(prev);
        pbs = kind === 'path';
        if (pbs) {
          // Close enough that we will pass: reserve the path to the next signal.
          if (this.reservedBy(s) !== t.id && !this.tryReserve(t, i, d <= commit && running)) return d - SAFETY_MARGIN;
        } else {
          const b = this.blockOf.get(pieceKey(s));
          if (b !== undefined && this.claims.get(b) !== t.id) {
            if (!this.blockGreen(b, t.id, kind)) return d - SAFETY_MARGIN;
            // Close enough that we will pass: claim the block so nobody else enters.
            if (d <= commit && running) this.claims.set(b, t.id);
          }
        }
      } else if (pbs && this.reservedBy(s) !== t.id) {
        // Inside a path-signalled area: keep the way ahead reserved.
        if (!this.tryReserve(t, i, d <= commit && running)) return d - SAFETY_MARGIN;
      }
      if (this.occupiedByOther(s, t.id)) return d - SAFETY_MARGIN;
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
    }
    this.trimTail(t);
  }

  /** May the head move from `head` onto `next` (route[0])? Signals and reservations decide. */
  private mayEnter(t: Train, head: number, next: number): boolean {
    if (this.signalFacing(head)) {
      const kind = this.signalKind(head);
      if (kind === 'path') return this.reservedBy(next) === t.id || this.tryReserve(t, 0, true);
      const b = this.blockOf.get(pieceKey(next));
      return b === undefined || this.claims.get(b) === t.id || this.blockGreen(b, t.id, kind);
    }
    if (t.pbs && this.reservedBy(next) !== t.id) return this.tryReserve(t, 0, true);
    return true;
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
    if (t.toDepot && map.layers.type[tile] === TileType.Depot) {
      this.enterDepot(t, tile);
      return;
    }
    const order = t.orders[t.orderIndex];
    if (!t.toDepot && order?.kind === 'station' && map.layers.type[tile] === TileType.Station && map.layers.data[tile] === order.station) {
      t.status = 'loading';
      // A train longer than its platform takes longer to load (up to three times as long).
      let covered = 0;
      for (const s of t.path) {
        const st = segTile(s);
        if (map.layers.type[st] === TileType.Station && map.layers.data[st] === order.station) covered += segLength(s);
      }
      const length = this.statsOf(t).length;
      t.loadTicks = Math.round(DWELL_TICKS * Math.min(3, Math.max(1, length / Math.max(0.5, covered))));
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
    t.routeFor = '';
    this.state.dirtyTrains.add(t.id);
  }

  private depart(t: Train): void {
    t.status = 'running';
    this.state.dirtyTrains.add(t.id);
    if (t.orders.length > 0) t.orderIndex = (t.orderIndex + 1) % t.orders.length;
    t.routeFor = '';
    t.replanAt = 0;
    this.plan(t);
  }

  private targetKey(t: Train): string | null {
    if (t.toDepot) return 'depot';
    const o = t.orders[t.orderIndex];
    if (!o) return null;
    return o.kind === 'station' ? `s${o.station}` : 'depot';
  }

  private goalFor(t: Train): PathGoal | null {
    const map = this.state.map;
    const o = t.orders[t.orderIndex];
    if (t.toDepot || o?.kind === 'depot') {
      const depots = [...this.state.depots].filter((d) => map.layers.owner[d] === t.owner);
      return depots.length ? depotGoal(map, depots) : null;
    }
    if (o?.kind === 'station') {
      const st = this.state.stations.get(o.station);
      return st ? stationGoal(map, st.id, st) : null;
    }
    return null;
  }

  /** Plan a route to the current target; reverse if only the way back leads there. */
  plan(t: Train): void {
    const key = this.targetKey(t);
    const goal = this.goalFor(t);
    t.routeFor = `${this.state.trackVersion}:${key}`;
    if (!goal) {
      t.route = [];
      t.replanAt = this.state.tick + REPLAN_DELAY;
      return;
    }
    const map = this.state.map;
    this.dropReservations(t, true);
    const penalty = (s: number) => {
      if (this.occupiedByOther(s, t.id)) return 6;
      const r = this.reserved.get(pieceKey(s));
      return r !== undefined && r !== t.id ? 4 : 0;
    };
    const access = this.accessOf(t);
    let path = findPath(map, t.path[0]!, goal, { access, penalty });
    if (!path && t.speed < 0.5) {
      // Try the other way round: plan from the tail segment, reversed.
      const tail = segReverse(t.path[t.path.length - 1]!);
      const back = findPath(map, tail, goal, { access, penalty });
      if (back && this.reverse(t)) {
        path = back;
        t.routeFor = `${this.state.trackVersion}:${key}`;
      }
    }
    if (!path) {
      t.route = [];
      t.replanAt = this.state.tick + REPLAN_DELAY;
      return;
    }
    extendThroughPlatform(map, path, access);
    t.route = path;
  }

  motion(t: Train): TrainMotion {
    return { id: t.id, path: t.path.slice(), pos: t.pos, speed: t.speed, ahead: t.route.slice(0, 6) };
  }
}
