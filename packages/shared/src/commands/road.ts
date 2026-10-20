import { COSTS, clearCost } from '../economy/costs.ts';
import { findJoinStation, recomputeStationExtent, stationName } from '../rail/station.ts';
import { structuresAt } from '../rail/structures.ts';
import { EDGE_DX, EDGE_DY, Edge, OPPOSITE_EDGE, Piece, edgeHeight } from '../rail/track.ts';
import { WAYPOINT_FLAG } from '../rail/waypoint.ts';
import type { GameState } from '../sim/state.ts';
import { REPUTATION_ROAD_LOSS, applyDemolition, demolitionVerdict, stationRefusal } from '../town/reputation.ts';
import { ROADSTOP_TRUCK, ROAD_EDGE_BITS, ROAD_ONE_WAY, ROAD_ONE_WAY_REVERSED, isStraightRoad } from '../town/road.ts';
import { Ground, OWNER_NONE, TileType } from '../world/constants.ts';
import type { GameMap } from '../world/map.ts';
import { CROSSING_FLAG } from './track.ts';
import { fail, isInt, type CommandHandler, type PlanResult } from './types.ts';

/** Build a straight road from one tile to another (crossing own railway as level crossings). */
export interface BuildRoadCommand {
  type: 'buildRoad';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Remove the road between consecutive tiles of a straight line (own roads, and towns' streets with the council's leave). */
export interface RemoveRoadCommand {
  type: 'removeRoad';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Cycle a straight own road through two-way, one-way, one-way the other way. */
export interface SetOneWayCommand {
  type: 'setOneWay';
  x: number;
  y: number;
}

export interface BuildRoadDepotCommand {
  type: 'buildRoadDepot';
  x: number;
  y: number;
  exit: number;
}

/** Make a straight road tile a drive-through stop, joining a station of ours next to it. */
export interface BuildRoadStopCommand {
  type: 'buildRoadStop';
  x: number;
  y: number;
  kind: 'bus' | 'truck';
}

const MAX_ROAD = 128;

/** Could a straight road run along `axis` over this tile (flat, or a gentle slope along it)? */
export function roadFitsTile(map: GameMap, x: number, y: number, axis: 0 | 1): boolean {
  if (map.isFlat(x, y)) return true;
  const c = map.tileCorners(x, y);
  const [e1, e2] = axis === 0 ? [Edge.W, Edge.E] : [Edge.N, Edge.S];
  const h1 = edgeHeight(c, e1);
  const h2 = edgeHeight(c, e2);
  return h1 >= 0 && h2 >= 0 && Math.abs(h1 - h2) <= 1;
}

/** Tiles of a straight line and the edge pointing along it. */
function line(map: GameMap, x0: unknown, y0: unknown, x1: unknown, y1: unknown): { tiles: number[]; edge: Edge } | string {
  if (![x0, y0, x1, y1].every(isInt)) return 'Invalid road';
  const [ax, ay, bx, by] = [x0, y0, x1, y1] as number[];
  if (!map.inBounds(ax!, ay!) || !map.inBounds(bx!, by!)) return 'Out of bounds';
  if (ax !== bx && ay !== by) return 'Roads run straight';
  const n = Math.abs(bx! - ax!) + Math.abs(by! - ay!) + 1;
  if (n < 2) return 'Drag to build a road';
  if (n > MAX_ROAD) return 'Too long';
  const edge = bx! > ax! ? Edge.E : bx! < ax! ? Edge.W : by! > ay! ? Edge.S : Edge.N;
  const tiles: number[] = [];
  for (let k = 0; k < n; k++) tiles.push(map.tileIndex(ax! + EDGE_DX[edge] * k, ay! + EDGE_DY[edge] * k));
  return { tiles, edge };
}

const at = (map: GameMap, i: number) => `(${i % map.width},${Math.floor(i / map.width)})`;

export const buildRoadHandler: CommandHandler<BuildRoadCommand> = {
  needsCompany: true,
  mode: 'road',
  plan(state, ctx, cmd): PlanResult {
    const map = state.map;
    const l = line(map, cmd.x0, cmd.y0, cmd.x1, cmd.y1);
    if (typeof l === 'string') return fail(l);
    const { tiles, edge } = l;
    const axis = edge === Edge.E || edge === Edge.W ? 0 : 1;
    const axisBits = axis === 0 ? ROAD_EDGE_BITS[Edge.E] | ROAD_EDGE_BITS[Edge.W] : ROAD_EDGE_BITS[Edge.N] | ROAD_EDGE_BITS[Edge.S];
    const jobs: { i: number; bits: number; kind: 'new' | 'add' | 'crossing' | 'none' }[] = [];
    let cost = 0;
    for (let k = 0; k < tiles.length; k++) {
      const i = tiles[k]!;
      const x = i % map.width;
      const y = (i - x) / map.width;
      const bits = (k > 0 ? ROAD_EDGE_BITS[OPPOSITE_EDGE[edge]]! : 0) | (k < tiles.length - 1 ? ROAD_EDGE_BITS[edge]! : 0);
      const type = map.layers.type[i];
      const where = at(map, i);
      if (type === TileType.Clear) {
        if (map.tileMinHeight(x, y) < 1 || !roadFitsTile(map, x, y, axis)) return fail(`Roads can't go on that slope ${where}`);
        cost += COSTS.road + clearCost(map, x, y);
        jobs.push({ i, bits, kind: 'new' });
      } else if (type === TileType.Road) {
        if ((map.layers.data[i]! & bits) === bits) jobs.push({ i, bits, kind: 'none' });
        else {
          if (!map.isFlat(x, y)) return fail(`Junctions need flat land ${where}`);
          cost += COSTS.road / 2;
          jobs.push({ i, bits, kind: 'add' });
        }
      } else if (type === TileType.Rail && map.layers.data[i]! & CROSSING_FLAG) {
        if ((map.layers.data[i]! & 0xf) !== axisBits) return fail(`The road there runs the other way ${where}`);
        jobs.push({ i, bits, kind: 'none' });
      } else if (type === TileType.Rail) {
        const across = axis === 0 ? 1 << Piece.Y : 1 << Piece.X;
        const data = map.layers.data[i]!;
        if (map.layers.owner[i] !== ctx.companyId) return fail(`Roads can only cross your own railway ${where}`);
        if (map.layers.track[i] !== across || data & (0x600 | WAYPOINT_FLAG) || map.layers.signals[i] || !map.isFlat(x, y)) {
          return fail(`Level crossings need flat, straight track across the road ${where}`);
        }
        if (state.isPieceOccupied(i, axis === 0 ? Piece.Y : Piece.X)) return fail(`A train is in the way ${where}`);
        cost += COSTS.levelCrossing;
        jobs.push({ i, bits: axisBits, kind: 'crossing' });
      } else if (type === TileType.RoadStop) {
        if ((map.layers.track[i]! & 0xf) !== axisBits) return fail(`The stop there faces the other way ${where}`);
        jobs.push({ i, bits, kind: 'none' });
      } else {
        return fail(`Object in the way ${where}`);
      }
    }
    if (jobs.every((j) => j.kind === 'none')) return fail('Already built');
    return {
      ok: true,
      cost: state.cost(cost),
      commit() {
        const dirtyChunks = new Set<number>();
        for (const { i, bits, kind } of jobs) {
          if (kind === 'new') {
            map.layers.type[i] = TileType.Road;
            map.layers.owner[i] = ctx.companyId!;
            map.layers.data[i] = bits;
            map.layers.track[i] = 0;
            map.layers.town[i] = 0;
          } else if (kind === 'add') {
            // A junction can't be one-way.
            const data = (map.layers.data[i]! | bits) & ~(ROAD_ONE_WAY | ROAD_ONE_WAY_REVERSED);
            map.layers.data[i] = isStraightRoad(data) ? (map.layers.data[i]! | bits) : data;
          } else if (kind === 'crossing') {
            map.layers.data[i] = (map.layers.data[i]! & ~0xf) | CROSSING_FLAG | bits;
          }
          if (kind !== 'none') {
            const x = i % map.width;
            map.touchTile(x, (i - x) / map.width, dirtyChunks);
          }
        }
        if (jobs.some((j) => j.kind === 'crossing')) state.onTrackChanged();
        return { dirtyChunks };
      },
    };
  },
};

export const removeRoadHandler: CommandHandler<RemoveRoadCommand> = {
  needsCompany: true,
  mode: 'road',
  plan(state, ctx, cmd): PlanResult {
    const map = state.map;
    const l = line(map, cmd.x0, cmd.y0, cmd.x1, cmd.y1);
    if (typeof l === 'string') return fail(l);
    const { tiles, edge } = l;
    const remove = new Map<number, number>();
    const losses = new Map<number, number>();
    let cost = 0;
    for (let k = 0; k < tiles.length; k++) {
      const i = tiles[k]!;
      const bits = (k > 0 ? ROAD_EDGE_BITS[OPPOSITE_EDGE[edge]]! : 0) | (k < tiles.length - 1 ? ROAD_EDGE_BITS[edge]! : 0);
      const type = map.layers.type[i];
      const crossing = type === TileType.Rail && (map.layers.data[i]! & CROSSING_FLAG) !== 0;
      if (type !== TileType.Road && !crossing) continue;
      const have = map.layers.data[i]! & 0xf & bits;
      if (!have) continue;
      const owner = map.layers.owner[i];
      if (type === TileType.Road && owner !== ctx.companyId && owner !== OWNER_NONE) return fail(`Other companies' roads can't be removed ${at(map, i)}`);
      if (crossing && map.layers.owner[i] !== ctx.companyId) return fail(`That crossing belongs to another company ${at(map, i)}`);
      if (state.roadBusy(i)) return fail(`A road vehicle is in the way ${at(map, i)}`);
      remove.set(i, have);
      cost += COSTS.roadRemove;
      const town = map.layers.town[i]! - 1;
      if (type === TileType.Road && owner === OWNER_NONE && state.towns.has(town)) losses.set(town, (losses.get(town) ?? 0) + REPUTATION_ROAD_LOSS);
    }
    if (remove.size === 0) return fail('No road to remove there');
    const verdict = demolitionVerdict(state, ctx.companyId!, losses);
    if ('error' in verdict) return fail(verdict.error);
    return {
      ok: true,
      cost: state.cost(cost),
      note: verdict.note,
      commit() {
        const dirtyChunks = new Set<number>();
        applyDemolition(state, ctx.companyId!, losses);
        let crossings = false;
        for (const [i, bits] of remove) {
          const data = map.layers.data[i]! & ~bits;
          if (map.layers.type[i] === TileType.Rail) {
            // A crossing loses its road only as a whole (the road runs straight across).
            map.layers.data[i] = data & ~(0xf | CROSSING_FLAG);
            crossings = true;
          } else if ((data & 0xf) === 0) map.setClear(i, Ground.Rough, 0);
          else map.layers.data[i] = isStraightRoad(data) ? data : data & ~(ROAD_ONE_WAY | ROAD_ONE_WAY_REVERSED);
          const x = i % map.width;
          map.touchTile(x, (i - x) / map.width, dirtyChunks);
        }
        if (crossings) state.onTrackChanged();
        state.onRoadsChanged();
        return { dirtyChunks };
      },
    };
  },
};

export const setOneWayHandler: CommandHandler<SetOneWayCommand> = {
  needsCompany: true,
  mode: 'road',
  plan(state, ctx, cmd): PlanResult {
    const map = state.map;
    if (!isInt(cmd.x) || !isInt(cmd.y) || !map.inBounds(cmd.x, cmd.y)) return fail('Out of bounds');
    const i = map.tileIndex(cmd.x, cmd.y);
    if (map.layers.type[i] !== TileType.Road) return fail('One-way works on plain road');
    if (map.layers.owner[i] !== ctx.companyId) return fail('Only your own roads can be one-way');
    const data = map.layers.data[i]!;
    if (!isStraightRoad(data)) return fail('Only straight road can be one-way');
    const next = !(data & ROAD_ONE_WAY) ? ROAD_ONE_WAY : !(data & ROAD_ONE_WAY_REVERSED) ? ROAD_ONE_WAY | ROAD_ONE_WAY_REVERSED : 0;
    return {
      ok: true,
      cost: 0,
      commit() {
        map.layers.data[i] = (data & ~(ROAD_ONE_WAY | ROAD_ONE_WAY_REVERSED)) | next;
        const dirtyChunks = new Set<number>();
        map.touchTile(cmd.x, cmd.y, dirtyChunks);
        state.onRoadsChanged();
        return { dirtyChunks };
      },
    };
  },
};

export const buildRoadDepotHandler: CommandHandler<BuildRoadDepotCommand> = {
  needsCompany: true,
  mode: 'road',
  plan(state, ctx, cmd): PlanResult {
    const { x, y, exit } = cmd;
    const map = state.map;
    if (![x, y, exit].every(isInt) || exit < 0 || exit > 3 || !map.inBounds(x, y)) return fail('Invalid depot');
    const i = map.tileIndex(x, y);
    if (map.layers.type[i] !== TileType.Clear || !map.isFlat(x, y) || map.tileMinHeight(x, y) < 1) return fail('Road depots need clear, flat land');
    if (structuresAt(map, i).some((s) => s.kind === 'bridge')) return fail("Depots can't go under a bridge");
    const nx = x + EDGE_DX[exit as Edge];
    const ny = y + EDGE_DY[exit as Edge];
    const n = map.inBounds(nx, ny) ? map.tileIndex(nx, ny) : -1;
    const connect = n >= 0 && map.layers.type[n] === TileType.Road;
    return {
      ok: true,
      cost: state.cost(COSTS.roadDepot + clearCost(map, x, y)),
      commit() {
        map.layers.type[i] = TileType.RoadDepot;
        map.layers.owner[i] = ctx.companyId!;
        map.layers.data[i] = exit;
        map.layers.track[i] = 0;
        map.layers.town[i] = 0;
        state.roadDepots.add(i);
        const dirtyChunks = new Set<number>();
        map.touchTile(x, y, dirtyChunks);
        if (connect) {
          // The road in front of the door gets a branch to it.
          map.layers.data[n] = (map.layers.data[n]! | ROAD_EDGE_BITS[OPPOSITE_EDGE[exit as Edge]]!) & ~(ROAD_ONE_WAY | ROAD_ONE_WAY_REVERSED);
          map.touchTile(nx, ny, dirtyChunks);
        }
        state.onRoadsChanged();
        return { dirtyChunks };
      },
    };
  },
};

export const buildRoadStopHandler: CommandHandler<BuildRoadStopCommand> = {
  needsCompany: true,
  mode: 'road',
  plan(state, ctx, cmd): PlanResult {
    const { x, y, kind } = cmd;
    const map = state.map;
    if (!isInt(x) || !isInt(y) || !map.inBounds(x, y) || (kind !== 'bus' && kind !== 'truck')) return fail('Invalid stop');
    const i = map.tileIndex(x, y);
    if (map.layers.type[i] !== TileType.Road) return fail('Road stops go on a straight road');
    const owner = map.layers.owner[i]!;
    if (owner !== OWNER_NONE && owner !== ctx.companyId) return fail('That road belongs to another company');
    const data = map.layers.data[i]!;
    if (!isStraightRoad(data) || data & ROAD_ONE_WAY || !map.isFlat(x, y)) return fail('Road stops need a flat, straight two-way road');
    if (state.roadBusy(i)) return fail('A road vehicle is in the way');
    const company = ctx.companyId!;
    const join = findJoinStation(map, state.stations, company, x, y, x, y);
    const refusal = join ? null : stationRefusal(state, company, x, y);
    if (refusal) return fail(refusal);
    return {
      ok: true,
      cost: state.cost(COSTS.roadStop),
      commit() {
        let st = join;
        if (!st) {
          const { name, townId } = stationName(x, y, state.towns.values(), state.stations.values());
          st = { id: state.nextStationId++, name, owner: company, x, y, x0: x, y0: y, x1: x, y1: y, tiles: 0, townId, builtDays: state.date, waiting: {}, waitingTotal: 0, rating: 175 };
          state.stations.set(st.id, st);
        }
        map.layers.type[i] = TileType.RoadStop;
        map.layers.owner[i] = company;
        map.layers.track[i] = (data & 0xf) | (kind === 'truck' ? ROADSTOP_TRUCK : 0);
        map.layers.data[i] = st.id;
        st.x0 = Math.min(st.x0, x);
        st.y0 = Math.min(st.y0, y);
        st.x1 = Math.max(st.x1, x);
        st.y1 = Math.max(st.y1, y);
        recomputeStationExtent(map, st);
        state.markStationDirty(st.id);
        const dirtyChunks = new Set<number>();
        map.touchTile(x, y, dirtyChunks);
        state.onRoadsChanged();
        return { dirtyChunks };
      },
    };
  },
};

/** Turn a road stop back into plain road (town road if the town built it). Returns its station. */
export function removeRoadStop(map: GameMap, i: number): number {
  const station = map.layers.data[i]!;
  const bits = map.layers.track[i]! & 0xf;
  map.layers.type[i] = TileType.Road;
  map.layers.data[i] = bits;
  map.layers.track[i] = 0;
  if (map.layers.town[i]) map.layers.owner[i] = OWNER_NONE;
  return station;
}

/** Bulldozing: what a company's road-related tile costs to remove (or null if it isn't one). */
export function roadTileClearCost(state: GameState, i: number, company: number): number | string | null {
  const map = state.map;
  const type = map.layers.type[i];
  if (type === TileType.RoadDepot && map.layers.owner[i] === company) return state.roadDepotHasVehicles(i) ? 'The road depot still has vehicles' : COSTS.depotRemove;
  if (type === TileType.RoadStop && map.layers.owner[i] === company) return state.roadBusy(i) ? 'A road vehicle is in the way' : COSTS.stationRemove;
  if (type === TileType.Road && map.layers.owner[i] === company) return state.roadBusy(i) ? 'A road vehicle is in the way' : COSTS.roadRemove * 2;
  return null;
}
