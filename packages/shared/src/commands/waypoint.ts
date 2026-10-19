import { WAYPOINT_FLAG, waypointName } from '../rail/waypoint.ts';
import { Piece } from '../rail/track.ts';
import { TileType } from '../world/constants.ts';
import { CROSSING_FLAG } from './track.ts';
import { fail, isInt, type CommandHandler, type PlanResult } from './types.ts';

/** Make plain straight track a waypoint. */
export interface BuildWaypointCommand {
  type: 'buildWaypoint';
  x: number;
  y: number;
}

/** Remove a waypoint (the track stays). */
export interface RemoveWaypointCommand {
  type: 'removeWaypoint';
  x: number;
  y: number;
}

const WAYPOINT_COST = 1_500;
const noEffects = () => ({ dirtyChunks: new Set<number>() });

export const buildWaypointHandler: CommandHandler<BuildWaypointCommand> = {
  needsCompany: true,
  plan(state, ctx, cmd): PlanResult {
    const { x, y } = cmd;
    const map = state.map;
    if (!isInt(x) || !isInt(y) || !map.inBounds(x, y)) return fail('Out of bounds');
    const i = map.tileIndex(x, y);
    if (map.layers.type[i] !== TileType.Rail) return fail('Waypoints go on plain track');
    if (map.layers.owner[i] !== ctx.companyId) return fail('Track belongs to another company');
    const data = map.layers.data[i]!;
    if (data & WAYPOINT_FLAG) return fail('Already a waypoint');
    const track = map.layers.track[i]!;
    if ((track !== 1 << Piece.X && track !== 1 << Piece.Y) || data & (CROSSING_FLAG | 0x600) || map.layers.signals[i]) {
      return fail('Waypoints need plain straight track without signals or junctions');
    }
    return {
      ok: true,
      cost: state.cost(WAYPOINT_COST),
      commit() {
        const id = state.nextWaypointId++;
        const name = waypointName(x, y, state.towns.values(), state.waypoints.values());
        state.waypoints.set(id, { id, name, owner: ctx.companyId!, tile: i });
        map.layers.data[i] = data | WAYPOINT_FLAG;
        const dirtyChunks = new Set<number>();
        map.touchTile(x, y, dirtyChunks);
        return { dirtyChunks };
      },
    };
  },
};

export const removeWaypointHandler: CommandHandler<RemoveWaypointCommand> = {
  needsCompany: true,
  plan(state, ctx, cmd): PlanResult {
    const { x, y } = cmd;
    const map = state.map;
    if (!isInt(x) || !isInt(y) || !map.inBounds(x, y)) return fail('Out of bounds');
    const i = map.tileIndex(x, y);
    const wp = [...state.waypoints.values()].find((w) => w.tile === i);
    if (!wp) return fail('No waypoint here');
    if (wp.owner !== ctx.companyId) return fail('That waypoint belongs to another company');
    return {
      ok: true,
      cost: 0,
      commit() {
        state.deleteWaypoint(wp.id);
        map.touchTile(x, y);
        return noEffects();
      },
    };
  },
};
