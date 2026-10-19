import { stationHas } from '../rail/station.ts';
import {
  findRoadPath,
  isJunction,
  isUTurn,
  roadDepotExit,
  roadNext,
  roadSegExists,
  rsExit,
  rsLength,
  rsReverse,
  rsTile,
} from '../road/roadNetwork.ts';
import { TICKS_PER_DAY, TICKS_PER_SECOND } from '../sim/date.ts';
import type { GameState } from '../sim/state.ts';
import { TileType } from '../world/constants.ts';
import { ROADSTOP_TRUCK } from '../town/road.ts';
import { isBus } from './catalog.ts';
import { advanceOrder, needsService } from './orders.ts';
import { BRAKE_KMH_PER_S, DWELL_TICKS, KMH_PER_TILE_PER_S, brakingDistance, speedForDistance } from './railSystem.ts';
import { cargoMass, type Order, type Train, type TrainMotion } from './train.ts';

const DT = 1 / TICKS_PER_SECOND;
/** Road vehicles stop this far (tiles) behind the vehicle in front. */
const GAP = 0.15;
const REPLAN_DELAY = 45;
const CREEP_KMH = 4;
/** Acceleration scale (as for trains, road vehicles reach speed in seconds). */
const ACCEL_SCALE = 6;

/**
 * Moves buses and trucks (Trains with mode 'road'). Each road segment belongs to a lane: one
 * per direction of travel on plain road, and a single one for a whole junction tile, U-turns
 * and depots, so vehicles queue behind each other and cross junctions one at a time.
 */
export class RoadSystem {
  /** lane key → vehicles using that lane. */
  private occ = new Map<number, Set<number>>();
  /** Called when a road vehicle stops at a station (cargo handling). */
  onArrive: ((t: Train, station: number) => void) | null = null;
  onLoading: ((t: Train, station: number) => boolean) | null = null;
  onService: ((t: Train) => void) | null = null;
  /** Is a level crossing closed to road traffic? (Set by the rail system.) */
  crossingClosed: ((tile: number) => boolean) | null = null;

  constructor(private readonly state: GameState) {}

  private laneKey(s: number): number {
    const tile = rsTile(s);
    const map = this.state.map;
    if (isUTurn(s) || isJunction(map, tile) || map.layers.type[tile] === TileType.RoadDepot) return tile * 8 + 7;
    return tile * 8 + rsExit(s);
  }

  private occupiedByOther(s: number, id: number): boolean {
    const set = this.occ.get(this.laneKey(s));
    if (set) for (const o of set) if (o !== id) return true;
    // A vehicle in a junction blocks every lane through it, and vice versa.
    const tile = rsTile(s);
    if (this.laneKey(s) % 8 !== 7) {
      const j = this.occ.get(tile * 8 + 7);
      if (j) for (const o of j) if (o !== id) return true;
    } else {
      for (let k = 0; k < 4; k++) {
        const lane = this.occ.get(tile * 8 + k);
        if (lane) for (const o of lane) if (o !== id) return true;
      }
    }
    return false;
  }

  private occupy(t: Train, s: number): void {
    const k = this.laneKey(s);
    let set = this.occ.get(k);
    if (!set) this.occ.set(k, (set = new Set()));
    set.add(t.id);
  }

  private release(t: Train, s: number): void {
    const k = this.laneKey(s);
    if (t.path.some((p) => this.laneKey(p) === k)) return;
    const set = this.occ.get(k);
    set?.delete(t.id);
    if (set?.size === 0) this.occ.delete(k);
  }

  private releaseAll(t: Train): void {
    for (const s of t.path) {
      const set = this.occ.get(this.laneKey(s));
      set?.delete(t.id);
      if (set?.size === 0) this.occ.delete(this.laneKey(s));
    }
  }

  /** Road vehicles on a tile. */
  vehiclesOn(tile: number): number[] {
    const out = new Set<number>();
    for (let k = 0; k < 8; k++) for (const id of this.occ.get(tile * 8 + k) ?? []) out.add(id);
    return [...out];
  }

  /** Is a road vehicle on this tile? */
  busy(tile: number): boolean {
    for (let k = 0; k < 8; k++) if (this.occ.get(tile * 8 + k)?.size) return true;
    return false;
  }

  rebuildOccupancy(): void {
    this.occ.clear();
    for (const t of this.state.trains.values()) if (t.mode === 'road') for (const s of t.path) this.occupy(t, s);
  }

  removeFromWorld(t: Train): void {
    this.releaseAll(t);
    this.state.rail.invalidateStats(t);
  }

  // ---- control -------------------------------------------------------------------

  canStart(t: Train): string | null {
    if (t.status === 'depot') return t.orders.length === 0 ? 'Give the vehicle some orders first' : null;
    return t.status === 'stopped' ? null : 'Already running';
  }

  start(t: Train): void {
    if (t.status === 'depot') {
      t.status = 'running';
      t.route = [];
      t.routeFor = '';
      t.speed = 0;
    } else if (t.status === 'stopped') t.status = 'running';
  }

  stop(t: Train): void {
    if (t.status === 'running' || t.status === 'loading') t.status = 'stopped';
  }

  sendToDepot(t: Train): void {
    t.toDepot = !t.toDepot;
    t.routeFor = '';
  }

  /** Turn round where it stands (road vehicles can always turn). */
  reverse(t: Train): boolean {
    if (t.path.length === 0 || t.speed > 0.5) return false;
    this.releaseAll(t);
    const last = t.path[t.path.length - 1]!;
    let covered = t.pos;
    for (let i = 1; i < t.path.length; i++) covered += rsLength(t.path[i]!);
    const len = this.state.rail.statsOf(t).length;
    t.path = t.path.map(rsReverse).reverse();
    t.pos = Math.max(0, rsLength(last) - Math.max(0, covered - len));
    t.route = [];
    t.routeFor = '';
    for (const s of t.path) this.occupy(t, s);
    return true;
  }

  enterDepot(t: Train, tile: number): void {
    this.releaseAll(t);
    t.path = [];
    t.route = [];
    t.pos = 0;
    t.speed = 0;
    t.status = 'depot';
    t.depot = tile;
    t.toDepot = false;
    t.routeFor = '';
    t.lastService = this.state.date;
    this.onService?.(t);
    this.state.dirtyTrains.add(t.id);
  }

  // ---- simulation ------------------------------------------------------------------

  step(): void {
    for (const t of this.state.trains.values()) {
      if (t.mode !== 'road' || t.status === 'depot') continue;
      this.stepVehicle(t);
    }
  }

  private stepVehicle(t: Train): void {
    const map = this.state.map;
    if (t.path.length === 0) {
      if (t.depot >= 0 && t.status === 'running') this.tryLeaveDepot(t);
      return;
    }
    if (!t.path.every((s) => roadSegExists(map, s))) {
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
    const key = this.targetKey(t);
    if (key !== null && t.routeFor !== `${this.state.roadVersion}:${key}` && this.state.tick >= t.replanAt) this.plan(t);

    const stats = this.state.rail.statsOf(t);
    const stopAt = this.stopDistance(t, brakingDistance(t.speed) + 2);
    let limit = Math.min(stats.maxSpeed, Math.max(speedForDistance(stopAt), stopAt > 0.01 ? CREEP_KMH : 0));
    if (t.brokenDown) {
      if (--t.brokenDown <= 0) {
        t.brokenDown = 0;
        this.state.dirtyTrains.add(t.id);
      }
      limit = 0;
    }
    if (t.status === 'stopped') limit = 0;
    if (t.speed > limit) t.speed = Math.max(limit, t.speed - BRAKE_KMH_PER_S * DT);
    else {
      const mass = stats.mass + cargoMass(t);
      const v = Math.max(t.speed / 3.6, 1);
      const pull = Math.min(stats.tractiveEffort, stats.power / v);
      const resist = mass * (0.015 + 0.0002 * t.speed);
      const a = mass > 0 ? ((pull - resist) / mass) * ACCEL_SCALE * 3.6 : 0;
      t.speed = Math.max(0, Math.min(limit, t.speed + a * DT));
    }
    if (t.speed < 0.05 && limit < 0.5) t.speed = 0;
    this.advance(t, (t.speed / KMH_PER_TILE_PER_S) * DT);
    if (t.speed === 0 && t.status === 'running') this.whenStopped(t);
  }

  private tryLeaveDepot(t: Train): void {
    const s = roadDepotExit(this.state.map, t.depot);
    if (this.occupiedByOther(s, t.id)) return;
    t.path = [s];
    t.pos = 0;
    t.depot = -1;
    t.departedAt = this.state.tick;
    this.occupy(t, s);
    this.state.dirtyTrains.add(t.id);
  }

  /** Distance to the first place the vehicle must stop: a vehicle ahead, a closed crossing, or the end of its route. */
  private stopDistance(t: Train, horizon: number): number {
    let d = rsLength(t.path[0]!) - t.pos;
    for (const s of t.route) {
      if (d > horizon) return d;
      if (this.occupiedByOther(s, t.id)) return d - GAP;
      if (this.crossingClosed?.(rsTile(s)) && !t.path.some((p) => rsTile(p) === rsTile(s))) return d - GAP;
      d += rsLength(s);
    }
    return d;
  }

  private advance(t: Train, dist: number): void {
    while (dist > 0) {
      const head = t.path[0]!;
      const room = rsLength(head) - t.pos;
      if (dist <= room) {
        t.pos += dist;
        break;
      }
      const next = t.route[0];
      if (next === undefined || !roadNext(this.state.map, head).includes(next) || this.occupiedByOther(next, t.id)) {
        t.pos = rsLength(head);
        t.speed = 0;
        break;
      }
      t.route.shift();
      t.path.unshift(next);
      this.occupy(t, next);
      t.pos = 0;
      dist -= room;
    }
    // Trim the tail to the vehicle's length.
    const len = this.state.rail.statsOf(t).length;
    let covered = t.pos;
    let keep = 1;
    while (keep < t.path.length && covered < len) covered += rsLength(t.path[keep++]!);
    while (t.path.length > keep) this.release(t, t.path.pop()!);
  }

  private whenStopped(t: Train): void {
    const map = this.state.map;
    const head = t.path[0]!;
    if (t.pos < rsLength(head) - 0.01 || t.route.length > 0) return;
    const tile = rsTile(head);
    const order = t.orders[t.orderIndex];
    if (map.layers.type[tile] === TileType.RoadDepot && (t.toDepot || t.serviceTrip || order?.kind === 'depot')) {
      const park = t.toDepot;
      const detour = t.serviceTrip && order?.kind !== 'depot';
      t.serviceTrip = false;
      this.enterDepot(t, tile);
      if (detour) t.status = 'running';
      else if (!park && order) {
        advanceOrder(this.state, t);
        t.status = 'running';
      }
      return;
    }
    if (!t.toDepot && order?.kind === 'station' && map.layers.type[tile] === TileType.RoadStop && map.layers.data[tile] === order.station) {
      t.status = 'loading';
      t.loadTicks = DWELL_TICKS;
      if (order.wait) t.loadTicks = Math.max(t.loadTicks, Math.round(order.wait * TICKS_PER_DAY));
      t.lastStation = order.station;
      this.state.dirtyTrains.add(t.id);
      this.onArrive?.(t, order.station);
      return;
    }
    if (this.state.tick >= t.replanAt) this.plan(t);
  }

  private depart(t: Train): void {
    t.status = 'running';
    advanceOrder(this.state, t);
    t.departedAt = this.state.tick;
    t.replanAt = 0;
    if (this.state.settings.breakdowns && needsService(this.state, t) && !t.orders.some((o) => o.kind === 'depot')) t.serviceTrip = true;
    this.state.dirtyTrains.add(t.id);
    this.plan(t);
  }

  private targetKey(t: Train): string | null {
    if (t.toDepot || t.serviceTrip) return 'depot';
    const o = t.orders[t.orderIndex];
    if (!o) return null;
    if (o.kind === 'station') return `s${o.station}`;
    return o.kind === 'depot' ? 'depot' : null;
  }

  /** Tiles a vehicle may finish its route on for an order. */
  goalTiles(t: Train, o: Order | 'depot'): Set<number> {
    const map = this.state.map;
    const out = new Set<number>();
    if (o === 'depot' || o.kind === 'depot') {
      for (const d of this.state.roadDepots) if (map.layers.owner[d] === t.owner) out.add(d);
      return out;
    }
    if (o.kind !== 'station') return out;
    const st = this.state.stations.get(o.station);
    if (!st) return out;
    const truck = !isBus(t.units[0]!);
    for (let y = st.y0; y <= st.y1; y++) {
      for (let x = st.x0; x <= st.x1; x++) {
        const i = map.tileIndex(x, y);
        if (map.layers.type[i] === TileType.RoadStop && map.layers.data[i] === st.id && ((map.layers.track[i]! & ROADSTOP_TRUCK) !== 0) === truck) out.add(i);
      }
    }
    return out;
  }

  plan(t: Train): void {
    const key = this.targetKey(t);
    t.routeFor = `${this.state.roadVersion}:${key}`;
    const o = t.orders[t.orderIndex];
    const goals = t.toDepot || t.serviceTrip ? this.goalTiles(t, 'depot') : o ? this.goalTiles(t, o) : new Set<number>();
    const penalty = (s: number) => (this.occupiedByOther(s, t.id) ? 3 : 0);
    let path = goals.size ? findRoadPath(this.state.map, t.path[0]!, goals, penalty) : null;
    if (!path && goals.size && t.speed < 0.5) {
      // Turn round where it stands and try the other way.
      const back = findRoadPath(this.state.map, rsReverse(t.path[t.path.length - 1]!), goals, penalty);
      if (back && this.reverse(t)) {
        path = back;
        t.routeFor = `${this.state.roadVersion}:${key}`;
      }
    }
    if (!path) {
      t.route = [];
      t.replanAt = this.state.tick + REPLAN_DELAY;
      if (t.serviceTrip) {
        t.serviceTrip = false;
        t.routeFor = '';
        t.replanAt = 0;
      }
      return;
    }
    t.route = path;
  }

  motion(t: Train): TrainMotion {
    return { id: t.id, path: t.path.slice(), pos: t.pos, speed: t.speed, ahead: t.route.slice(0, 6) };
  }
}

/** Can a road vehicle of this kind call at the station? */
export function roadStationOk(state: GameState, t: Train, stationId: number): boolean {
  const st = state.stations.get(stationId);
  return !!st && stationHas(state.map, st, isBus(t.units[0]!) ? 'bus' : 'truck');
}
