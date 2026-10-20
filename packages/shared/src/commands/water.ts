import { COSTS, clearCost } from '../economy/costs.ts';
import { findJoinStation, recomputeStationExtent, stationName } from '../rail/station.ts';
import { structuresAt } from '../rail/structures.ts';
import { EDGE_DX, EDGE_DY } from '../rail/track.ts';
import { waypointName } from '../rail/waypoint.ts';
import type { GameState } from '../sim/state.ts';
import { stationRefusal } from '../town/reputation.ts';
import { hasBuoy, isCanal, isRapids, isRiver, lockAxisFor, navigable } from '../water/waterways.ts';
import { reclassifyTile } from '../world/terrain.ts';
import { Ground, TileType, WATER_BUOY, WATER_CANAL, WATER_RAPIDS, WATER_RIVER } from '../world/constants.ts';
import { fail, isInt, type CommandHandler, type PlanResult } from './types.ts';

/** Dig canals over an area of flat land (a line or a rectangle). */
export interface BuildCanalCommand {
  type: 'buildCanal';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** A lock on a straight slope (bare land or river rapids), linking water at two levels. */
export interface BuildLockCommand {
  type: 'buildLock';
  x: number;
  y: number;
}

/** A dock on the shore; `edge` faces the water (picked automatically if left out). */
export interface BuildDockCommand {
  type: 'buildDock';
  x: number;
  y: number;
  edge?: number;
}

/** A ship depot on water; `axis` 0 = ships enter from east/west, 1 = north/south. */
export interface BuildShipDepotCommand {
  type: 'buildShipDepot';
  x: number;
  y: number;
  axis?: number;
}

/** A buoy (a waypoint for ships) on water. */
export interface BuildBuoyCommand {
  type: 'buildBuoy';
  x: number;
  y: number;
}

const MAX_CANAL = 64;

export const WATER_COSTS = {
  canal: 650,
  canalRemove: 120,
  lock: 4_500,
  lockRemove: 600,
  dock: 2_200,
  shipDepot: 2_600,
  buoy: 500,
} as const;

/** Water another company dug can't be built on. */
const foreignCanal = (state: GameState, i: number, company: number) => isCanal(state.map, i) && state.map.layers.owner[i] !== company;

export const buildCanalHandler: CommandHandler<BuildCanalCommand> = {
  needsCompany: true,
  mode: 'water',
  plan(state, ctx, cmd): PlanResult {
    const { x0, y0, x1, y1 } = cmd;
    const map = state.map;
    if (![x0, y0, x1, y1].every(isInt)) return fail('Invalid area');
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
    const ay = Math.min(y0, y1), by = Math.max(y0, y1);
    if (!map.inBounds(ax, ay) || !map.inBounds(bx, by)) return fail('Out of bounds');
    if (bx - ax >= MAX_CANAL || by - ay >= MAX_CANAL) return fail('Area too large');
    const tiles: number[] = [];
    let cost = 0;
    for (let y = ay; y <= by; y++) {
      for (let x = ax; x <= bx; x++) {
        const i = map.tileIndex(x, y);
        const type = map.layers.type[i];
        if (type === TileType.Water || type === TileType.Lock || type === TileType.ShipDepot) continue;
        if (type !== TileType.Clear) return fail(`Object in the way at ${x},${y}`);
        if (!map.isFlat(x, y)) return fail(`Canals need flat land (${x},${y})`);
        if (structuresAt(map, i).some((s) => s.kind === 'tunnel' && s.level <= map.cornerHeight(x, y))) return fail(`A tunnel is in the way (${x},${y})`);
        tiles.push(i);
        cost += WATER_COSTS.canal + clearCost(map, x, y);
      }
    }
    if (tiles.length === 0) return fail('Already water');
    return {
      ok: true,
      cost: state.cost(cost),
      commit() {
        const dirtyChunks = new Set<number>();
        for (const i of tiles) {
          map.setWater(i);
          map.layers.data[i] = WATER_CANAL;
          map.layers.owner[i] = ctx.companyId!;
          const x = i % map.width;
          map.touchTile(x, (i - x) / map.width, dirtyChunks);
        }
        state.onWaterChanged();
        return { dirtyChunks };
      },
    };
  },
};

export const buildLockHandler: CommandHandler<BuildLockCommand> = {
  needsCompany: true,
  mode: 'water',
  plan(state, ctx, cmd): PlanResult {
    const { x, y } = cmd;
    const map = state.map;
    if (!isInt(x) || !isInt(y) || !map.inBounds(x, y)) return fail('Out of bounds');
    const i = map.tileIndex(x, y);
    const rapids = isRapids(map, i);
    if (map.layers.type[i] !== TileType.Clear && !rapids) return fail('Locks go on bare land or river rapids');
    const axis = lockAxisFor(map, x, y);
    if (axis < 0) return fail('Locks go on a straight slope, one level high');
    return {
      ok: true,
      cost: state.cost(WATER_COSTS.lock + clearCost(map, x, y)),
      commit() {
        map.setClear(i, Ground.Grass, 0);
        map.layers.type[i] = TileType.Lock;
        map.layers.owner[i] = ctx.companyId!;
        // Bit 1: built on rapids (they come back when the lock goes).
        map.layers.data[i] = axis | (rapids ? 2 : 0);
        const dirtyChunks = new Set<number>();
        map.touchTile(x, y, dirtyChunks);
        state.onWaterChanged();
        return { dirtyChunks };
      },
    };
  },
};

/** Edges of a land tile that face plain water (a berth for a dock). */
function waterEdges(state: GameState, x: number, y: number, company: number): number[] {
  const map = state.map;
  const out: number[] = [];
  for (let e = 0; e < 4; e++) {
    const nx = x + EDGE_DX[e as 0]!;
    const ny = y + EDGE_DY[e as 0]!;
    if (!map.inBounds(nx, ny)) continue;
    const n = map.tileIndex(nx, ny);
    if (map.layers.type[n] === TileType.Water && !hasBuoy(map, n) && !isRapids(map, n) && !foreignCanal(state, n, company)) out.push(e);
  }
  return out;
}

export const buildDockHandler: CommandHandler<BuildDockCommand> = {
  needsCompany: true,
  mode: 'water',
  plan(state, ctx, cmd): PlanResult {
    const { x, y } = cmd;
    const map = state.map;
    if (!isInt(x) || !isInt(y) || !map.inBounds(x, y)) return fail('Out of bounds');
    const i = map.tileIndex(x, y);
    if (map.layers.type[i] !== TileType.Clear) return fail('Docks go on bare land by the water');
    const company = ctx.companyId!;
    const edges = waterEdges(state, x, y, company);
    if (edges.length === 0) return fail('Docks need water next to them');
    const edge = isInt(cmd.edge) ? cmd.edge : edges[0]!;
    if (!edges.includes(edge)) return fail('There is no open water on that side');
    const join = findJoinStation(map, state.stations, company, x, y, x, y);
    const refusal = join ? null : stationRefusal(state, company, x, y);
    if (refusal) return fail(refusal);
    return {
      ok: true,
      cost: state.cost(WATER_COSTS.dock + clearCost(map, x, y)),
      commit() {
        let st = join;
        if (!st) {
          const { name, townId } = stationName(x, y, state.towns.values(), state.stations.values());
          st = { id: state.nextStationId++, name: `${name} Docks`, owner: company, x, y, x0: x, y0: y, x1: x, y1: y, tiles: 0, townId, builtDays: state.date, waiting: {}, waitingTotal: 0, rating: 175 };
          state.stations.set(st.id, st);
        }
        map.setClear(i, Ground.Grass, 0);
        map.layers.type[i] = TileType.Dock;
        map.layers.owner[i] = company;
        map.layers.data[i] = st.id;
        map.layers.track[i] = edge;
        st.x0 = Math.min(st.x0, x);
        st.y0 = Math.min(st.y0, y);
        st.x1 = Math.max(st.x1, x);
        st.y1 = Math.max(st.y1, y);
        recomputeStationExtent(map, st);
        state.markStationDirty(st.id);
        const dirtyChunks = new Set<number>();
        map.touchTile(x, y, dirtyChunks);
        state.onWaterChanged();
        return { dirtyChunks };
      },
    };
  },
};

export const buildShipDepotHandler: CommandHandler<BuildShipDepotCommand> = {
  needsCompany: true,
  mode: 'water',
  plan(state, ctx, cmd): PlanResult {
    const { x, y } = cmd;
    const map = state.map;
    if (!isInt(x) || !isInt(y) || !map.inBounds(x, y)) return fail('Out of bounds');
    const i = map.tileIndex(x, y);
    const company = ctx.companyId!;
    if (map.layers.type[i] !== TileType.Water) return fail('Ship depots go on water');
    if (isRapids(map, i)) return fail('Ship depots need calm water, not rapids');
    if (hasBuoy(map, i)) return fail('A buoy is in the way');
    if (foreignCanal(state, i, company)) return fail('That canal belongs to another company');
    if (state.ships.busy(i)) return fail('A ship is in the way');
    // Ships come and go along the axis: prefer one with water at both ends.
    const open = (axis: number) =>
      (axis === 0 ? [1, 3] : [0, 2]).filter((e) => {
        const nx = x + EDGE_DX[e as 0]!;
        const ny = y + EDGE_DY[e as 0]!;
        return map.inBounds(nx, ny) && navigable(map, map.tileIndex(nx, ny)) && map.layers.type[map.tileIndex(nx, ny)] !== TileType.ShipDepot;
      }).length;
    let axis: number;
    if (cmd.axis === 0 || cmd.axis === 1) axis = cmd.axis;
    else axis = open(1) > open(0) ? 1 : 0;
    if (open(axis) === 0) return fail('Ships could not get in or out of a depot there');
    const canal = isCanal(map, i);
    const river = isRiver(map, i);
    return {
      ok: true,
      cost: state.cost(WATER_COSTS.shipDepot),
      commit() {
        map.layers.type[i] = TileType.ShipDepot;
        map.layers.owner[i] = company;
        map.layers.data[i] = axis | (canal ? 2 : 0) | (river ? 4 : 0);
        state.shipDepots.add(i);
        const dirtyChunks = new Set<number>();
        map.touchTile(x, y, dirtyChunks);
        state.onWaterChanged();
        return { dirtyChunks };
      },
    };
  },
};

export const buildBuoyHandler: CommandHandler<BuildBuoyCommand> = {
  needsCompany: true,
  mode: 'water',
  plan(state, ctx, cmd): PlanResult {
    const { x, y } = cmd;
    const map = state.map;
    if (!isInt(x) || !isInt(y) || !map.inBounds(x, y)) return fail('Out of bounds');
    const i = map.tileIndex(x, y);
    const company = ctx.companyId!;
    if (map.layers.type[i] !== TileType.Water) return fail('Buoys go on water');
    if (isRapids(map, i)) return fail('Buoys need calm water, not rapids');
    if (hasBuoy(map, i)) return fail('There is a buoy here already');
    if (foreignCanal(state, i, company)) return fail('That canal belongs to another company');
    return {
      ok: true,
      cost: state.cost(WATER_COSTS.buoy),
      commit() {
        const id = state.nextWaypointId++;
        const name = waypointName(x, y, state.towns.values(), state.waypoints.values(), 'Buoy');
        state.waypoints.set(id, { id, name, owner: company, tile: i, buoy: true });
        map.layers.data[i] = map.layers.data[i]! | WATER_BUOY;
        const dirtyChunks = new Set<number>();
        map.touchTile(x, y, dirtyChunks);
        return { dirtyChunks };
      },
    };
  },
};

/**
 * Bulldozing: what a company's water tile (canal, lock, ship depot, dock or buoy) costs to
 * remove, an error, or null if there is nothing of the company's here.
 */
export function waterClearCost(state: GameState, i: number, company: number): number | string | null {
  const map = state.map;
  const type = map.layers.type[i];
  const own = map.layers.owner[i] === company;
  const buoy = hasBuoy(map, i) ? [...state.waypoints.values()].find((w) => w.tile === i) : undefined;
  if (type === TileType.Water) {
    const canal = isCanal(map, i) && own;
    const ownBuoy = buoy?.owner === company;
    if (!canal && !ownBuoy) return null;
    if (canal && state.ships.busy(i)) return 'A ship is in the way';
    return (canal ? WATER_COSTS.canalRemove : 0) + (ownBuoy ? COSTS.stationRemove : 0);
  }
  if (!own) return null;
  if (type === TileType.Lock) return state.ships.busy(i) ? 'A ship is in the lock' : WATER_COSTS.lockRemove;
  if (type === TileType.ShipDepot) return state.ships.busy(i) || state.ships.inDepot(i) ? 'The ship depot still has ships' : COSTS.depotRemove;
  if (type === TileType.Dock) return COSTS.stationRemove;
  return null;
}

/** Remove a company's water tile (see `waterClearCost`). Returns the station id for docks. */
export function removeWaterTile(state: GameState, i: number, company: number, dirtyChunks?: Set<number>): number | null {
  const map = state.map;
  const type = map.layers.type[i];
  const x = i % map.width;
  const y = (i - x) / map.width;
  let station: number | null = null;
  if (type === TileType.Water) {
    const buoy = hasBuoy(map, i) ? [...state.waypoints.values()].find((w) => w.tile === i) : undefined;
    if (buoy && buoy.owner === company) state.deleteWaypoint(buoy.id);
    if (isCanal(map, i) && map.layers.owner[i] === company) {
      // A buoy someone else put on our canal goes with it.
      const other = [...state.waypoints.values()].find((w) => w.tile === i);
      if (other) state.deleteWaypoint(other.id);
      map.setClear(i, Ground.Rough, 0);
      reclassifyTile(map, x, y);
    }
  } else if (type === TileType.Lock) {
    if (map.layers.data[i]! & 2) {
      map.setWater(i);
      map.layers.data[i] = WATER_RIVER | WATER_RAPIDS;
    } else map.setClear(i, Ground.Rough, 0);
  } else if (type === TileType.ShipDepot) {
    const canal = (map.layers.data[i]! & 2) !== 0;
    const river = (map.layers.data[i]! & 4) !== 0;
    const owner = map.layers.owner[i]!;
    state.shipDepots.delete(i);
    map.setWater(i);
    if (canal) {
      map.layers.data[i] = WATER_CANAL;
      map.layers.owner[i] = owner;
    } else if (river) map.layers.data[i] = WATER_RIVER;
  } else if (type === TileType.Dock) {
    station = map.layers.data[i]!;
    map.setClear(i, Ground.Rough, 0);
  }
  map.touchTile(x, y, dirtyChunks);
  state.onWaterChanged();
  return station;
}
