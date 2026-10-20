import { COSTS, clearCost } from '../economy/costs.ts';
import {
  MAX_PLATFORMS,
  MAX_PLATFORM_LENGTH,
  findJoinStation,
  recomputeStationExtent,
  stationName,
} from '../rail/station.ts';
import { headInfo, otherHead, structuresAt } from '../rail/structures.ts';
import { linkPlaced, unlinkPieces } from '../rail/links.ts';
import { EDGE_DX, EDGE_DY, Piece, hasPiece } from '../rail/track.ts';
import { Ground, OWNER_NONE, TileType } from '../world/constants.ts';
import { CROSSING_FLAG } from './track.ts';
import type { GameState } from '../sim/state.ts';
import { removeRoadStop, roadTileClearCost } from './road.ts';
import { airportClearCost, removeAirport } from './airport.ts';
import { removeWaterTile, waterClearCost } from './water.ts';
import { RAIL_TYPES, railTypeError } from '../rail/railTypes.ts';
import { fail, isInt, type CommandHandler, type PlanResult } from './types.ts';

/** Build a rectangular rail station: `length` tiles along `axis`, `platforms` tracks side by side. */
export interface BuildStationCommand {
  type: 'buildStation';
  x: number;
  y: number;
  /** 0 = platforms run along X, 1 = along Y */
  axis: 0 | 1;
  platforms: number;
  length: number;
  /** Track type of new platform tiles (track turned into platforms keeps its type). */
  railType?: number;
}

/** Build a train depot whose open end faces `exit` (Edge N/E/S/W). */
export interface BuildDepotCommand {
  type: 'buildDepot';
  x: number;
  y: number;
  exit: number;
  railType?: number;
}

/** Bulldoze own track, stations and depots, and trees, in a rectangle. */
export interface ClearAreaCommand {
  type: 'clearArea';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

const MAX_CLEAR = 32;

export const buildStationHandler: CommandHandler<BuildStationCommand> = {
  needsCompany: true,
  mode: 'rail',
  plan(state, ctx, cmd): PlanResult {
    const { x, y, axis, platforms, length } = cmd;
    if (![x, y, platforms, length].every(isInt) || (axis !== 0 && axis !== 1)) return fail('Invalid station');
    if (platforms < 1 || platforms > MAX_PLATFORMS) return fail(`1–${MAX_PLATFORMS} platforms`);
    if (length < 1 || length > MAX_PLATFORM_LENGTH) return fail(`Platforms can be 1–${MAX_PLATFORM_LENGTH} tiles long`);
    const map = state.map;
    const company = ctx.companyId!;
    const railType = cmd.railType ?? 0;
    const typeErr = railTypeError(state, railType);
    if (typeErr) return fail(typeErr);
    const w = axis === 0 ? length : platforms;
    const h = axis === 0 ? platforms : length;
    if (!map.inBounds(x, y) || !map.inBounds(x + w - 1, y + h - 1)) return fail('Out of bounds');
    const piece = axis === 0 ? Piece.X : Piece.Y;
    const height = map.cornerHeight(x, y);
    const tiles: number[] = [];
    let cost = 0;
    for (let ty = y; ty < y + h; ty++) {
      for (let tx = x; tx < x + w; tx++) {
        const i = map.tileIndex(tx, ty);
        const type = map.layers.type[i];
        if (!map.isFlat(tx, ty) || map.cornerHeight(tx, ty) !== height) return fail(`Stations need flat, level ground (${tx},${ty})`);
        if (structuresAt(map, i).some((s) => s.kind === 'bridge')) return fail(`Stations can't go under a bridge (${tx},${ty})`);
        if (type === TileType.Rail && map.layers.data[i]! & 0x600) return fail(`Object in the way (${tx},${ty})`);
        if (type === TileType.Clear) {
          cost += clearCost(map, tx, ty);
        } else if (type === TileType.Rail) {
          if (map.layers.owner[i] !== company) return fail(`Track belongs to another company (${tx},${ty})`);
          if (map.layers.track[i] !== 1 << piece || map.layers.data[i]! & CROSSING_FLAG) {
            return fail(`Only straight track along the platform can become a station (${tx},${ty})`);
          }
          if (state.isPieceOccupied(i, piece)) return fail(`A train is in the way (${tx},${ty})`);
        } else if (type === TileType.Station && map.layers.owner[i] === company && map.layers.track[i] === 1 << piece) {
          continue; // already part of a station along this axis
        } else {
          return fail(`Object in the way (${tx},${ty})`);
        }
        tiles.push(i);
        cost += COSTS.stationTile;
      }
    }
    if (tiles.length === 0) return fail('Already built');

    // Join an adjacent station of ours, if any.
    const join = findJoinStation(map, state.stations, company, x, y, x + w - 1, y + h - 1);

    return {
      ok: true,
      cost: state.cost(cost),
      commit() {
        let st = join;
        if (!st) {
          const { name, townId } = stationName(x, y, state.towns.values(), state.stations.values());
          st = {
            id: state.nextStationId++,
            name,
            owner: company,
            x, y, x0: x, y0: y, x1: x + w - 1, y1: y + h - 1,
            tiles: 0,
            townId,
            builtDays: state.date,
            waiting: {},
            waitingTotal: 0,
            rating: 175,
          };
          state.stations.set(st.id, st);
        }
        const dirtyChunks = new Set<number>();
        for (const i of tiles) {
          if (map.layers.type[i] !== TileType.Rail) map.layers.railType[i] = railType;
          map.layers.type[i] = TileType.Station;
          map.layers.owner[i] = company;
          map.layers.data[i] = st.id;
          map.layers.track[i] = 1 << piece;
          map.layers.town[i] = 0;
          const tx = i % map.width;
          map.touchTile(tx, (i - tx) / map.width, dirtyChunks);
        }
        for (const t of linkPlaced(map, tiles, tiles.map(() => piece))) {
          const tx = t % map.width;
          map.touchTile(tx, (t - tx) / map.width, dirtyChunks);
        }
        st.x0 = Math.min(st.x0, x);
        st.y0 = Math.min(st.y0, y);
        st.x1 = Math.max(st.x1, x + w - 1);
        st.y1 = Math.max(st.y1, y + h - 1);
        recomputeStationExtent(map, st);
        state.markStationDirty(st.id);
        state.onTrackChanged();
        return { dirtyChunks };
      },
    };
  },
};

export const buildDepotHandler: CommandHandler<BuildDepotCommand> = {
  needsCompany: true,
  mode: 'rail',
  plan(state, ctx, cmd): PlanResult {
    const { x, y, exit } = cmd;
    if (![x, y, exit].every(isInt) || exit < 0 || exit > 3) return fail('Invalid depot');
    const map = state.map;
    if (!map.inBounds(x, y)) return fail('Out of bounds');
    const i = map.tileIndex(x, y);
    if (map.layers.type[i] !== TileType.Clear) return fail('Object in the way');
    if (!map.isFlat(x, y)) return fail('Depots need flat ground');
    if (structuresAt(map, i).some((s) => s.kind === 'bridge')) return fail("Depots can't go under a bridge");
    const railType = cmd.railType ?? 0;
    const typeErr = railTypeError(state, railType);
    if (typeErr) return fail(typeErr);
    const cost = Math.round(COSTS.depot * RAIL_TYPES[railType]!.costFactor) + clearCost(map, x, y);
    return {
      ok: true,
      cost: state.cost(cost),
      commit() {
        map.layers.type[i] = TileType.Depot;
        map.layers.railType[i] = railType;
        map.layers.owner[i] = ctx.companyId!;
        map.layers.data[i] = exit;
        map.layers.track[i] = 1 << (exit === 1 || exit === 3 ? Piece.X : Piece.Y);
        state.depots.add(i);
        const dirtyChunks = new Set<number>();
        map.touchTile(x, y, dirtyChunks);
        for (const t of linkPlaced(map, [i], [exit === 1 || exit === 3 ? Piece.X : Piece.Y])) {
          const tx = t % map.width;
          map.touchTile(tx, (t - tx) / map.width, dirtyChunks);
        }
        state.onTrackChanged();
        return { dirtyChunks };
      },
    };
  },
};

/**
 * Remove the track, station, depot or bridge/tunnel head on a tile, leaving rough land (or the
 * road of a level crossing). Callers check ownership and trains, call `refreshStations` with the
 * returned station ids and `state.onTrackChanged()` afterwards. Returns the station id if the
 * tile was part of a station.
 */
export function demolishTile(state: GameState, i: number, dirtyChunks: Set<number>): number | null {
  const map = state.map;
  const touch = (t: number) => {
    const tx = t % map.width;
    map.touchTile(tx, (t - tx) / map.width, dirtyChunks);
  };
  for (const t of unlinkPieces(map, i, map.layers.track[i]!)) touch(t);
  const type = map.layers.type[i];
  let station: number | null = null;
  const info = type === TileType.Rail ? headInfo(map, i) : null;
  if (info) {
    // Touch the span so chunks under/over it rebuild too.
    const far = otherHead(map, i, info);
    const step = EDGE_DX[info.dir] + EDGE_DY[info.dir] * map.width;
    for (let t = i + step; far >= 0 && t !== far; t += step) touch(t);
    map.setClear(i, Ground.Rough, 0);
  } else if (type === TileType.Rail) {
    state.removeSignalsOn(i, map.layers.track[i]!);
    const data = map.layers.data[i]!;
    if (data & CROSSING_FLAG) {
      map.layers.type[i] = TileType.Road;
      map.layers.owner[i] = OWNER_NONE;
      map.layers.data[i] = data & 0xf;
      map.layers.track[i] = 0;
      map.layers.railType[i] = 0;
      state.onRoadsChanged();
    } else {
      map.setClear(i, Ground.Rough, 0);
    }
  } else if (type === TileType.RoadStop) {
    station = removeRoadStop(map, i);
    state.onRoadsChanged();
  } else if (type === TileType.Road) {
    map.setClear(i, Ground.Rough, 0);
    state.onRoadsChanged();
  } else {
    if (type === TileType.Station) station = map.layers.data[i]!;
    if (type === TileType.Depot) state.depots.delete(i);
    if (type === TileType.RoadDepot) {
      state.roadDepots.delete(i);
      state.onRoadsChanged();
    }
    map.setClear(i, Ground.Rough, 0);
  }
  touch(i);
  return station;
}

/** After demolishing station tiles: shrink the stations, deleting those with no tiles left. */
export function refreshStations(state: GameState, ids: Iterable<number>): void {
  for (const id of ids) {
    const st = state.stations.get(id);
    if (!st) continue;
    recomputeStationExtent(state.map, st);
    if (st.tiles === 0) state.deleteStation(id);
    else state.markStationDirty(id);
  }
}

export const clearAreaHandler: CommandHandler<ClearAreaCommand> = {
  needsCompany: true,
  plan(state, ctx, cmd): PlanResult {
    const { x0, y0, x1, y1 } = cmd;
    if (![x0, y0, x1, y1].every(isInt)) return fail('Invalid area');
    const map = state.map;
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
    const ay = Math.min(y0, y1), by = Math.max(y0, y1);
    if (!map.inBounds(ax, ay) || !map.inBounds(bx, by)) return fail('Out of bounds');
    if (bx - ax >= MAX_CLEAR || by - ay >= MAX_CLEAR) return fail('Area too large');
    const company = ctx.companyId!;
    const jobs: { i: number; kind: 'trees' | 'rail' | 'station' | 'depot' | 'structure' | 'airport' | 'water' }[] = [];
    const queued = new Set<number>();
    let cost = 0;
    let blocked: string | null = null;
    for (let y = ay; y <= by; y++) {
      for (let x = ax; x <= bx; x++) {
        const i = map.tileIndex(x, y);
        const type = map.layers.type[i];
        const own = map.layers.owner[i] === company;
        if (type === TileType.Clear && map.treeCount(x, y) > 0) {
          jobs.push({ i, kind: 'trees' });
          cost += map.treeCount(x, y) * COSTS.clearTree;
        } else if (type === TileType.Rail && own && headInfo(map, i)) {
          if (queued.has(i)) continue;
          const info = headInfo(map, i)!;
          const far = otherHead(map, i, info);
          // Both heads and every span piece must be free of trains.
          let busy = false;
          const spanPiece = info.dir === 1 || info.dir === 3 ? 6 : 7;
          const step = EDGE_DX[info.dir] + EDGE_DY[info.dir] * map.width;
          for (let t = i + step; far >= 0 && t !== far; t += step) if (state.isPieceOccupied(t, spanPiece)) busy = true;
          for (const h of [i, far]) if (h >= 0 && state.isPieceOccupied(h, map.layers.track[h] === 1 ? 0 : 1)) busy = true;
          if (busy) {
            blocked = `A train is on the ${info.kind} (${x},${y})`;
            continue;
          }
          for (const h of [i, far]) {
            if (h < 0) continue;
            queued.add(h);
            jobs.push({ i: h, kind: 'structure' });
          }
          cost += COSTS.structureRemove;
        } else if (type === TileType.Rail && own) {
          const bits = map.layers.track[i]!;
          let busy = false;
          for (let p = 0; p < 6; p++) if (hasPiece(bits, p) && state.isPieceOccupied(i, p)) busy = true;
          if (busy) {
            blocked = `A train is in the way (${x},${y})`;
            continue;
          }
          jobs.push({ i, kind: 'rail' });
          for (let p = 0; p < 6; p++) if (hasPiece(bits, p)) cost += COSTS.railRemove;
        } else if (type === TileType.Station && own) {
          const p = map.layers.track[i] === 1 << Piece.X ? Piece.X : Piece.Y;
          if (state.isPieceOccupied(i, p)) {
            blocked = `A train is in the way (${x},${y})`;
            continue;
          }
          jobs.push({ i, kind: 'station' });
          cost += COSTS.stationRemove;
        } else if ((type === TileType.RoadStop || type === TileType.RoadDepot || type === TileType.Road) && own) {
          const c = roadTileClearCost(state, i, company);
          if (typeof c === 'string') {
            blocked = `${c} (${x},${y})`;
            continue;
          }
          if (c !== null) {
            jobs.push({ i, kind: type === TileType.RoadDepot ? 'depot' : 'station' });
            cost += c;
          }
        } else if (type === TileType.Airport && own) {
          const c = airportClearCost(state, i, company);
          if (typeof c === 'string') {
            blocked = `${c} (${x},${y})`;
            continue;
          }
          const st = map.layers.data[i]!;
          if (c !== null && !jobs.some((j) => j.kind === 'airport' && map.layers.data[j.i] === st)) {
            jobs.push({ i, kind: 'airport' });
            cost += c;
          }
        } else if (type === TileType.Water || ((type === TileType.Lock || type === TileType.ShipDepot || type === TileType.Dock) && own)) {
          const c = waterClearCost(state, i, company);
          if (typeof c === 'string') {
            blocked = `${c} (${x},${y})`;
            continue;
          }
          if (c !== null) {
            jobs.push({ i, kind: 'water' });
            cost += c;
          }
        } else if (type === TileType.Depot && own) {
          if (state.depotHasVehicles(i)) {
            blocked = `The depot at ${x},${y} still has vehicles`;
            continue;
          }
          jobs.push({ i, kind: 'depot' });
          cost += COSTS.depotRemove;
        }
      }
    }
    if (jobs.length === 0) return fail(blocked ?? 'Nothing here to clear');

    return {
      ok: true,
      cost: state.cost(cost),
      commit() {
        const dirtyChunks = new Set<number>();
        const stations = new Set<number>();
        for (const { i, kind } of jobs) {
          if (kind === 'airport') {
            const st = map.layers.data[i]!;
            removeAirport(state, st);
            stations.add(st);
            continue;
          }
          if (kind === 'water') {
            const st = removeWaterTile(state, i, company, dirtyChunks);
            if (st !== null) stations.add(st);
            continue;
          }
          if (kind === 'trees') {
            const ground = (map.layers.data[i]! >> 3) & 7;
            map.setClear(i, ground as Ground, 0);
            const x = i % map.width;
            map.touchTile(x, (i - x) / map.width, dirtyChunks);
          } else {
            const st = demolishTile(state, i, dirtyChunks);
            if (st !== null) stations.add(st);
          }
        }
        refreshStations(state, stations);
        if (jobs.some((j) => j.kind !== 'trees')) state.onTrackChanged();
        return { dirtyChunks };
      },
    };
  },
};
