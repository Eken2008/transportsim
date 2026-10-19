import { COSTS } from '../economy/costs.ts';
import { RAIL_TYPES, isElectrified, railTypeError } from '../rail/railTypes.ts';
import { segTile } from '../rail/network.ts';
import { TileType } from '../world/constants.ts';
import { fail, isInt, type CommandHandler, type PlanResult } from './types.ts';

/** Convert own track, stations and depots in a rectangle to another track type. */
export interface ConvertRailCommand {
  type: 'convertRail';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  railType: number;
}

const MAX_CONVERT = 32;
/** Cost per piece when converting to a cheaper type (fraction of a standard piece). */
const DOWNGRADE_FACTOR = 0.2;

export const convertRailHandler: CommandHandler<ConvertRailCommand> = {
  needsCompany: true,
  plan(state, ctx, cmd): PlanResult {
    const { x0, y0, x1, y1, railType } = cmd;
    if (![x0, y0, x1, y1].every(isInt)) return fail('Invalid area');
    const typeErr = railTypeError(state, railType);
    if (typeErr) return fail(typeErr);
    const map = state.map;
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
    const ay = Math.min(y0, y1), by = Math.max(y0, y1);
    if (!map.inBounds(ax, ay) || !map.inBounds(bx, by)) return fail('Out of bounds');
    if (bx - ax >= MAX_CONVERT || by - ay >= MAX_CONVERT) return fail('Area too large');
    const to = RAIL_TYPES[railType]!;
    // Tiles under electric trains can't lose their wires.
    const powered = new Set<number>();
    if (!to.electrified) {
      for (const t of state.trains.values()) {
        if (t.path.length && state.rail.statsOf(t).electric) for (const s of t.path) powered.add(segTile(s));
      }
    }
    const tiles: number[] = [];
    let cost = 0;
    let blocked: string | null = null;
    for (let y = ay; y <= by; y++) {
      for (let x = ax; x <= bx; x++) {
        const i = map.tileIndex(x, y);
        const type = map.layers.type[i];
        if (type !== TileType.Rail && type !== TileType.Station && type !== TileType.Depot) continue;
        if (map.layers.owner[i] !== ctx.companyId) continue;
        const from = map.layers.railType[i]!;
        if (from === railType) continue;
        if (powered.has(i) && isElectrified(from)) {
          blocked = `An electric train is on the track (${x},${y})`;
          continue;
        }
        if (type === TileType.Depot && !to.electrified && isElectrified(from)) {
          const parked = [...state.trains.values()].some((t) => t.status === 'depot' && t.depot === i && state.rail.statsOf(t).electric);
          if (parked) {
            blocked = `An electric train is parked in the depot (${x},${y})`;
            continue;
          }
        }
        let pieces = 0;
        for (let bits = map.layers.track[i]!; bits; bits >>= 1) pieces += bits & 1;
        const diff = to.costFactor - RAIL_TYPES[from]!.costFactor;
        cost += Math.max(1, pieces) * COSTS.railPiece * (diff > 0 ? diff : DOWNGRADE_FACTOR);
        tiles.push(i);
      }
    }
    if (tiles.length === 0) return fail(blocked ?? `Nothing here to convert to ${to.name.toLowerCase()} track`);
    return {
      ok: true,
      cost: state.cost(Math.round(cost)),
      commit() {
        const dirtyChunks = new Set<number>();
        for (const i of tiles) {
          map.layers.railType[i] = railType;
          const x = i % map.width;
          map.touchTile(x, (i - x) / map.width, dirtyChunks);
        }
        state.onTrackChanged();
        return { dirtyChunks };
      },
    };
  },
};
