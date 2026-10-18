import { COSTS } from '../economy/costs.ts';
import { PIECE_COUNT, hasPiece } from '../rail/track.ts';
import { TileType } from '../world/constants.ts';
import { CROSSING_FLAG } from './track.ts';
import { fail, isInt, type CommandHandler, type PlanResult } from './types.ts';

/**
 * Set the signals on one track piece. `dirs` bit 0 = signal for trains travelling the piece
 * forwards (trackdir piece*2), bit 1 = backwards (piece*2+1). 0 removes them.
 */
export interface SetSignalCommand {
  type: 'setSignal';
  x: number;
  y: number;
  piece: number;
  dirs: number;
}

/** Parallel corner pieces that don't touch (NE+SW, SE+NW) may both carry signals. */
const PARALLEL = [0, 0, 1 << 4, 1 << 5, 1 << 2, 1 << 3];

export const setSignalHandler: CommandHandler<SetSignalCommand> = {
  needsCompany: true,
  plan(state, ctx, cmd): PlanResult {
    const { x, y, piece, dirs } = cmd;
    if (![x, y, piece, dirs].every(isInt) || piece < 0 || piece >= PIECE_COUNT || dirs < 0 || dirs > 3) {
      return fail('Invalid signal');
    }
    const map = state.map;
    if (!map.inBounds(x, y)) return fail('Out of bounds');
    const i = map.tileIndex(x, y);
    if (map.layers.type[i] !== TileType.Rail) return fail('Signals go on plain track');
    if (map.layers.owner[i] !== ctx.companyId) return fail('Track belongs to another company');
    if (map.layers.data[i]! & CROSSING_FLAG) return fail("Signals can't go on a level crossing");
    const bits = map.layers.track[i]!;
    if (!hasPiece(bits, piece)) return fail('No track there');
    if (dirs !== 0 && (bits & ~(1 << piece) & ~PARALLEL[piece]!) !== 0) {
      return fail('Signals need a tile without junctions');
    }
    const current = (map.layers.signals[i]! >> (piece * 2)) & 3;
    if (current === dirs) return fail(dirs ? 'Already there' : 'No signal there');
    const added = (dirs & ~current & 1 ? 1 : 0) + (dirs & ~current & 2 ? 1 : 0);
    return {
      ok: true,
      cost: state.cost(added * COSTS.signal),
      commit() {
        map.layers.signals[i] = (map.layers.signals[i]! & ~(3 << (piece * 2))) | (dirs << (piece * 2));
        if (map.layers.signals[i]) state.signalTiles.add(i);
        else state.signalTiles.delete(i);
        const dirtyChunks = new Set<number>();
        map.touchTile(x, y, dirtyChunks);
        state.onTrackChanged();
        return { dirtyChunks };
      },
    };
  },
};
