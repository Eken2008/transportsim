import { COSTS } from '../economy/costs.ts';
import { PIECE_COUNT, hasPiece } from '../rail/track.ts';
import { TileType } from '../world/constants.ts';
import { CROSSING_FLAG } from './track.ts';
import { fail, isInt, type CommandHandler, type PlanResult } from './types.ts';

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
