import { COSTS } from '../economy/costs.ts';
import { nextSegments, pieceKey, seg, segLength, segPiece, segTd, segTile } from '../rail/network.ts';
import { PIECE_COUNT, hasPiece, isSpanTd, trackdir } from '../rail/track.ts';
import { TileType } from '../world/constants.ts';
import type { GameMap } from '../world/map.ts';
import { CROSSING_FLAG } from './track.ts';
import { fail, isInt, type CommandHandler, type CommandEffects, type PlanResult } from './types.ts';

/**
 * Signals layer: bit `trackdir` (0-11) = a signal facing trains on that trackdir.
 * Bit 12 = the tile's signals are one-way: trains may not pass them from behind.
 * Bits 13-15 = the kind of the tile's signals (see SIGNAL_KINDS).
 * A signal only acts on trains travelling its way; trains from behind pass freely unless it is one-way.
 */
export const SIGNAL_ONE_WAY = 0x1000;
export const SIGNAL_BITS = 0x0fff;
const KIND_SHIFT = 13;

/**
 * - block: green when the block beyond is free.
 * - entry: like block, but also needs a green exit (or combo) signal out of that block, if it has any.
 * - exit: a block signal that entry signals look at.
 * - combo: both entry and exit.
 * - path: green when the train can reserve its route up to the next signal; several trains
 *   may then use one block on paths that don't cross.
 */
export const SIGNAL_KINDS = ['block', 'entry', 'exit', 'combo', 'path'] as const;
export type SignalKind = (typeof SIGNAL_KINDS)[number];

export const signalKindOf = (sig: number): SignalKind => SIGNAL_KINDS[(sig >> KIND_SHIFT) & 7] ?? 'block';
const withKind = (sig: number, kind: SignalKind) => (sig & ~(7 << KIND_SHIFT)) | (SIGNAL_KINDS.indexOf(kind) << KIND_SHIFT);

/**
 * Set the signal on one track piece. `dirs`: 0 = none, 1 = facing trains travelling the
 * piece forwards (trackdir piece*2), 2 = facing backwards (piece*2+1).
 */
export interface SetSignalCommand {
  type: 'setSignal';
  x: number;
  y: number;
  piece: number;
  dirs: number;
  oneWay?: boolean;
  /** Kind of signal; all signals on a tile share it. Default block. */
  kind?: SignalKind;
}

/** Parallel corner pieces that don't touch (NE+SW, SE+NW) may both carry signals. */
const PARALLEL = [0, 0, 1 << 4, 1 << 5, 1 << 2, 1 << 3];

export const setSignalHandler: CommandHandler<SetSignalCommand> = {
  needsCompany: true,
  mode: 'rail',
  plan(state, ctx, cmd): PlanResult {
    const { x, y, piece, dirs } = cmd;
    const oneWay = cmd.oneWay === true;
    const kind = cmd.kind ?? 'block';
    if (!SIGNAL_KINDS.includes(kind)) return fail('Invalid signal kind');
    if (![x, y, piece, dirs].every(isInt) || piece < 0 || piece >= PIECE_COUNT || dirs < 0 || dirs > 3) {
      return fail('Invalid signal');
    }
    if (dirs === 3) return fail('A signal faces one way; trains coming from behind pass a normal signal freely');
    const map = state.map;
    if (!map.inBounds(x, y)) return fail('Out of bounds');
    const i = map.tileIndex(x, y);
    if (map.layers.type[i] !== TileType.Rail) return fail('Signals go on plain track');
    if (map.layers.owner[i] !== ctx.companyId) return fail('Track belongs to another company');
    if (map.layers.data[i]! & CROSSING_FLAG) return fail("Signals can't go on a level crossing");
    if (map.layers.data[i]! & 0x600) return fail("Signals can't go on a bridge or tunnel end");
    if (map.layers.data[i]! & 0x800) return fail("Signals can't go on a waypoint");
    const bits = map.layers.track[i]!;
    if (!hasPiece(bits, piece)) return fail('No track there');
    if (dirs !== 0 && (bits & ~(1 << piece) & ~PARALLEL[piece]!) !== 0) {
      return fail('Signals need a tile without junctions');
    }
    const sig = map.layers.signals[i]!;
    const current = (sig >> (piece * 2)) & 3;
    const currentOneWay = (sig & SIGNAL_ONE_WAY) !== 0;
    const same = currentOneWay === oneWay && signalKindOf(sig) === kind;
    if (current === dirs && (dirs === 0 || same)) return fail(dirs ? 'Already there' : 'No signal there');
    const cost = current === 0 && dirs !== 0 ? COSTS.signal : dirs !== 0 ? Math.round(COSTS.signal * 0.25) : 0;
    return {
      ok: true,
      cost: state.cost(cost),
      commit() {
        let next = (sig & ~(3 << (piece * 2))) | (dirs << (piece * 2));
        if (dirs !== 0) next = withKind(oneWay ? next | SIGNAL_ONE_WAY : next & ~SIGNAL_ONE_WAY, kind);
        if (!(next & SIGNAL_BITS)) next = 0;
        map.layers.signals[i] = next;
        if (next) state.signalTiles.add(i);
        else state.signalTiles.delete(i);
        const dirtyChunks = new Set<number>();
        map.touchTile(x, y, dirtyChunks);
        state.onTrackChanged();
        return { dirtyChunks };
      },
    };
  },
};

/**
 * Signals along a stretch of track: from a piece, walking one way, up to the next junction,
 * station, depot or end of track. Places a signal facing that way every `interval` tiles of
 * track (the first on the start piece), or with `remove` clears every signal on the stretch.
 */
export interface SetSignalRunCommand {
  type: 'setSignalRun';
  x: number;
  y: number;
  piece: number;
  /** Walk the piece backwards (trackdir piece*2+1) rather than forwards. */
  reverse: number;
  /** Tiles of track from one signal to the next. */
  interval: number;
  remove?: boolean;
  oneWay?: boolean;
  kind?: SignalKind;
}

export const MAX_SIGNAL_INTERVAL = 64;
const MAX_RUN = 4096;

/** Whether a piece on a tile with these track bits shares it with no junction. */
const noJunction = (bits: number, piece: number) => (bits & ~(1 << piece) & ~PARALLEL[piece]!) === 0;

/**
 * The stretch a signal run covers (segments in walking order) and the segments that get a
 * signal (or lose theirs). An error message if it can't start there.
 */
export function planSignalRun(map: GameMap, cmd: SetSignalRunCommand, owner: number): { run: number[]; picks: number[] } | string {
  const { x, y, piece, reverse, interval } = cmd;
  if (![x, y, piece, reverse, interval].every(isInt) || piece < 0 || piece >= PIECE_COUNT || (reverse !== 0 && reverse !== 1)) return 'Invalid signal';
  if (interval < 1 || interval > MAX_SIGNAL_INTERVAL) return `Signal spacing must be 1 to ${MAX_SIGNAL_INTERVAL} tiles`;
  if (!map.inBounds(x, y)) return 'Out of bounds';
  const { type, owner: owners, track, data, signals } = map.layers;
  const start = map.tileIndex(x, y);
  if (type[start] !== TileType.Rail) return 'Signals go on plain track';
  if (owners[start] !== owner) return 'Track belongs to another company';
  if (!hasPiece(track[start]!, piece)) return 'No track there';
  if (!noJunction(track[start]!, piece)) return 'Signals need a tile without junctions';

  const run: number[] = [];
  const seen = new Set<number>();
  const next: number[] = [];
  let s = seg(start, trackdir(piece, reverse));
  while (run.length < MAX_RUN) {
    run.push(s);
    seen.add(pieceKey(s));
    if (nextSegments(map, s, owner, next).length !== 1) break; // end of track, or a switch splitting off
    const n = next[0]!;
    if (seen.has(pieceKey(n))) break; // round a loop with no junction
    const t = segTile(n);
    if (!isSpanTd(segTd(n)) && (type[t] !== TileType.Rail || !noJunction(track[t]!, segPiece(n)))) break;
    s = n;
  }

  const picks: number[] = [];
  if (cmd.remove) {
    for (const r of run) if (!isSpanTd(segTd(r)) && (signals[segTile(r)]! >> (segPiece(r) * 2)) & 3) picks.push(r);
    return { run, picks };
  }
  // Bridge and tunnel ends, level crossings and waypoints take no signal; the next piece that can gets it.
  const blocked = CROSSING_FLAG | 0x600 | 0x800;
  let since = Infinity;
  for (let k = 0; k < run.length; k++) {
    const r = run[k]!;
    if (k > 0) since += segLength(run[k - 1]!);
    if (since < interval - 1e-6 || isSpanTd(segTd(r)) || data[segTile(r)]! & blocked) continue;
    picks.push(r);
    since = 0;
  }
  return { run, picks };
}

export const setSignalRunHandler: CommandHandler<SetSignalRunCommand> = {
  needsCompany: true,
  mode: 'rail',
  plan(state, ctx, cmd): PlanResult {
    const map = state.map;
    const kind = cmd.kind ?? 'block';
    const oneWay = cmd.oneWay === true;
    if (!SIGNAL_KINDS.includes(kind)) return fail('Invalid signal kind');
    const p = planSignalRun(map, cmd, ctx.companyId!);
    if (typeof p === 'string') return fail(p);
    const plans: Extract<PlanResult, { ok: true }>[] = [];
    const tiles = new Set<number>();
    let cost = 0;
    for (const s of p.picks) {
      const tile = segTile(s);
      if (tiles.has(tile)) continue; // a loop back past the parallel piece: one change per tile
      tiles.add(tile);
      const piece = segPiece(s);
      const dirs = cmd.remove ? 0 : (segTd(s) & 1) + 1;
      const sig = map.layers.signals[tile]!;
      const same = ((sig & SIGNAL_ONE_WAY) !== 0) === oneWay && signalKindOf(sig) === kind;
      if (!cmd.remove && ((sig >> (piece * 2)) & 3) === dirs && same) continue;
      const x = tile % map.width;
      const r = setSignalHandler.plan(state, ctx, { type: 'setSignal', x, y: (tile - x) / map.width, piece, dirs, oneWay, kind });
      if (!r.ok) return r;
      plans.push(r);
      cost += r.cost;
    }
    if (plans.length === 0) return fail(cmd.remove ? 'No signals there' : 'Already there');
    return {
      ok: true,
      cost,
      commit(): CommandEffects {
        const dirtyChunks = new Set<number>();
        for (const r of plans) for (const c of r.commit().dirtyChunks) dirtyChunks.add(c);
        return { dirtyChunks };
      },
    };
  },
};
