import { AIRPORT_TYPES, airportKindError, airportRole, hangarTile, type AirportKind } from '../air/airports.ts';
import { COSTS } from '../economy/costs.ts';
import { findJoinStation, recomputeStationExtent, stationName } from '../rail/station.ts';
import { structuresAt } from '../rail/structures.ts';
import type { GameState } from '../sim/state.ts';
import { Ground, TileType } from '../world/constants.ts';
import { fail, isInt, type CommandHandler, type PlanResult } from './types.ts';

/** Build an airport with its north-west corner at (x, y), joining a station of ours next to it. */
export interface BuildAirportCommand {
  type: 'buildAirport';
  x: number;
  y: number;
  kind: AirportKind;
}

export const buildAirportHandler: CommandHandler<BuildAirportCommand> = {
  needsCompany: true,
  plan(state, ctx, cmd): PlanResult {
    const { x, y, kind } = cmd;
    const map = state.map;
    const err = airportKindError(state, kind);
    if (err) return fail(err);
    if (!isInt(x) || !isInt(y)) return fail('Invalid airport');
    const t = AIRPORT_TYPES[kind];
    if (!map.inBounds(x, y) || !map.inBounds(x + t.w - 1, y + t.h - 1)) return fail('Out of bounds');
    const level = map.cornerHeight(x, y);
    let cost = t.cost;
    for (let ty = y; ty < y + t.h; ty++) {
      for (let tx = x; tx < x + t.w; tx++) {
        const i = map.tileIndex(tx, ty);
        if (map.layers.type[i] !== TileType.Clear) return fail(`Object in the way (${tx},${ty})`);
        if (!map.isFlat(tx, ty) || map.cornerHeight(tx, ty) !== level || level < 1) return fail(`Airports need flat, level land (${tx},${ty})`);
        if (structuresAt(map, i).some((s) => s.kind === 'bridge')) return fail(`A bridge is in the way (${tx},${ty})`);
        cost += map.treeCount(tx, ty) * COSTS.clearTree;
      }
    }
    const company = ctx.companyId!;
    const join = findJoinStation(map, state.stations, company, x, y, x + t.w - 1, y + t.h - 1);
    if (join?.airport) return fail(`${join.name} already has an airport`);
    return {
      ok: true,
      cost: state.cost(cost),
      commit() {
        let st = join;
        if (!st) {
          const { name, townId } = stationName(x, y, state.towns.values(), state.stations.values());
          st = { id: state.nextStationId++, name: `${name} Airport`, owner: company, x, y, x0: x, y0: y, x1: x, y1: y, tiles: 0, townId, builtDays: state.date, waiting: {}, waitingTotal: 0, rating: 175 };
          state.stations.set(st.id, st);
        }
        st.airport = { kind, x, y };
        const dirtyChunks = new Set<number>();
        for (let ty = y; ty < y + t.h; ty++) {
          for (let tx = x; tx < x + t.w; tx++) {
            const i = map.tileIndex(tx, ty);
            map.layers.type[i] = TileType.Airport;
            map.layers.owner[i] = company;
            map.layers.data[i] = st.id;
            map.layers.track[i] = airportRole(kind, tx - x, ty - y);
            map.layers.town[i] = 0;
            map.touchTile(tx, ty, dirtyChunks);
          }
        }
        st.x0 = Math.min(st.x0, x);
        st.y0 = Math.min(st.y0, y);
        st.x1 = Math.max(st.x1, x + t.w - 1);
        st.y1 = Math.max(st.y1, y + t.h - 1);
        recomputeStationExtent(map, st);
        state.markStationDirty(st.id);
        return { dirtyChunks };
      },
    };
  },
};

/**
 * Bulldozing an airport tile removes the whole airport. Returns the cost, an error, or null
 * if the tile isn't an airport of this company.
 */
export function airportClearCost(state: GameState, i: number, company: number): number | string | null {
  const map = state.map;
  if (map.layers.type[i] !== TileType.Airport || map.layers.owner[i] !== company) return null;
  const st = state.stations.get(map.layers.data[i]!);
  if (!st?.airport) return null;
  for (const t of state.trains.values()) {
    if (t.mode !== 'air') continue;
    const home = hangarTile(map, st.airport);
    if ((t.status === 'depot' && t.depot === home) || (t.air?.airport === st.id && t.air.phase !== 'flying' && t.air.phase !== 'holding')) return `Aircraft are at ${st.name}`;
  }
  return COSTS.stationRemove * AIRPORT_TYPES[st.airport.kind].w * AIRPORT_TYPES[st.airport.kind].h;
}

/** Remove a whole airport (its station keeps any other parts). Returns the station id. */
export function removeAirport(state: GameState, stationId: number): void {
  const st = state.stations.get(stationId);
  if (!st?.airport) return;
  const { kind, x, y } = st.airport;
  const t = AIRPORT_TYPES[kind];
  for (let ty = y; ty < y + t.h; ty++) {
    for (let tx = x; tx < x + t.w; tx++) {
      const i = state.map.tileIndex(tx, ty);
      if (state.map.layers.type[i] === TileType.Airport) state.map.setClear(i, Ground.Rough, 0);
      state.map.touchTile(tx, ty);
    }
  }
  st.airport = undefined;
}
