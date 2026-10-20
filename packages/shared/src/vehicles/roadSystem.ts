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
import { cargoMass, routeKey, targetCode, type Order, type Train, type TrainMotion } from './train.ts';

const DT = 1 / TICKS_PER_SECOND;
/** Road vehicles stop this far (tiles) behind the vehicle in front. */
const GAP = 0.15;
const REPLAN_DELAY = 45;
const CREEP_KMH = 4;
/** Acceleration scale (as for trains, road vehicles reach speed in seconds). */
const ACCEL_SCALE = 6;
/** A held-up vehicle looks for another way round this often. */
const REROUTE_TICKS = Math.round(TICKS_PER_DAY / 2);
/** A vehicle held up this long in a gridlock squeezes past the vehicle in its way. */
const GRIDLOCK_TICKS = TICKS_PER_DAY;

/**
 * Moves buses and trucks (Trains with mode 'road'). Each road segment belongs to a lane: one
 * per direction of travel on plain road, and a single one for a whole junction tile, U-turns
 * and depots, so vehicles queue behind each other and cross junctions one at a time. A vehicle
 * only enters a junction when it can get out the other side, so queues don't lock up.
 */
export class RoadSystem {
  /** lane key → vehicles using that lane. */
  private occ = new Map<number, Set<number>>();
  /** lane key → vehicle that will pass through it next, having entered a junction (see boxLanes). */
  private claims = new Map<number, number>();
  /** vehicle → lanes it has claimed. */
  private claimed = new Map<number, number[]>();
  /** Vehicles held up by another, and since which tick. */
  private waitingSince = new Map<number, number>();
  /** Vehicles let through the vehicle ahead to break a gridlock. */
  private passing = new Set<number>();
  /** Called when a road vehicle stops at a station (cargo handling). */
  onArrive: ((t: Train, station: number) => void) | null = null;
  onLoading: ((t: Train, station: number) => boolean) | null = null;
  onService: ((t: Train) => void) | null = null;
  /** Is a level crossing closed to road traffic? (Set by the rail system.) */
  crossingClosed: ((tile: number) => boolean) | null = null;

  constructor(private readonly state: GameState) {}

  /** Lane keys by segment, valid for one road network version. */
  private lanes = new Map<number, number>();
  private lanesFor = -1;

  private laneKey(s: number): number {
    // A road change can turn a tile into a junction or back, moving vehicles to other lanes.
    if (this.lanesFor !== this.state.roadVersion) this.rebuildOccupancy();
    let k = this.lanes.get(s);
    if (k === undefined) {
      const tile = rsTile(s);
      const map = this.state.map;
      k = isUTurn(s) || isJunction(map, tile) || map.layers.type[tile] === TileType.RoadDepot ? tile * 8 + 7 : tile * 8 + rsExit(s);
      this.lanes.set(s, k);
    }
    return k;
  }

  /** A vehicle other than `id` using or claiming lane `k`, or -1. */
  private laneHolder(k: number, id: number): number {
    const set = this.occ.get(k);
    if (set) for (const o of set) if (o !== id) return o;
    const c = this.claims.get(k);
    return c !== undefined && c !== id ? c : -1;
  }

  /** A vehicle other than `id` in the way of segment `s`, or -1. */
  private holderOf(s: number, id: number): number {
    const k = this.laneKey(s);
    const h = this.laneHolder(k, id);
    if (h >= 0) return h;
    // A vehicle in a junction blocks every lane through it, and vice versa.
    const tile = rsTile(s);
    if (k % 8 !== 7) return this.laneHolder(tile * 8 + 7, id);
    for (let l = 0; l < 4; l++) {
      const o = this.laneHolder(tile * 8 + l, id);
      if (o >= 0) return o;
    }
    return -1;
  }

  private occupiedByOther(s: number, id: number): boolean {
    return this.holderOf(s, id) >= 0;
  }

  /** The vehicle holding up t's next step, or -1. */
  private blocker(t: Train): number {
    const next = t.route[0];
    if (next === undefined) return -1;
    const h = this.holderOf(next, t.id);
    const k = this.laneKey(next);
    if (h >= 0 || k % 8 !== 7 || t.path.some((p) => this.laneKey(p) === k)) return h;
    for (let j = 1; j < t.route.length; j++) {
      const s = t.route[j]!;
      const o = this.holderOf(s, t.id);
      if (o >= 0) return o;
      if (this.laneKey(s) % 8 !== 7) break;
    }
    return -1;
  }

  /**
   * Is t part of a gridlock: waiting on a vehicle that waits on another ... that waits on t?
   * (Road changes can put vehicles in a junction together, and nothing else would untangle it.)
   */
  private gridlocked(t: Train): boolean {
    const seen = new Set<number>();
    for (let cur = t; ; ) {
      const b = this.blocker(cur);
      if (b === t.id) return true;
      const o = this.state.trains.get(b);
      if (!o || seen.has(b) || o.status !== 'running' || o.brokenDown || !this.waitingSince.has(b)) return false;
      seen.add(b);
      cur = o;
    }
  }

  /**
   * Don't block the box: a vehicle may enter a junction (or a U-turn, or a run of them) at
   * route[i] only when the rest of the run and the lane out the far side are free too.
   * Returns the lanes to claim on the way through, or null if it must wait.
   */
  private boxLanes(t: Train, i: number): number[] | null {
    const route = t.route;
    const k = this.laneKey(route[i]!);
    if (k % 8 !== 7 || t.path.some((p) => this.laneKey(p) === k)) return [];
    return this.lanesThrough(t, i + 1);
  }

  /** Lanes of route[i...] up to and including the first one outside a junction, or null if any is taken. */
  private lanesThrough(t: Train, i: number): number[] | null {
    const route = t.route;
    const out: number[] = [];
    for (let j = i; j < route.length; j++) {
      const s = route[j]!;
      if (this.occupiedByOther(s, t.id)) return null;
      out.push(this.laneKey(s));
      if (this.laneKey(s) % 8 !== 7) break;
    }
    return out;
  }

  /** Hold lanes ahead so nobody else can take them while the vehicle is in a junction. */
  private claim(t: Train, lanes: number[]): void {
    if (lanes.length === 0) return;
    for (const k of lanes) this.claims.set(k, t.id);
    const held = (this.claimed.get(t.id) ?? []).filter((k) => this.claims.get(k) === t.id && !lanes.includes(k));
    this.claimed.set(t.id, [...held, ...lanes]);
  }

  private dropClaims(t: Train): void {
    for (const k of this.claimed.get(t.id) ?? []) if (this.claims.get(k) === t.id) this.claims.delete(k);
    this.claimed.delete(t.id);
  }

  private occupy(t: Train, s: number): void {
    const k = this.laneKey(s);
    if (this.claims.get(k) === t.id) this.claims.delete(k);
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
    this.dropClaims(t);
    this.waitingSince.delete(t.id);
    this.passing.delete(t.id);
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
    this.lanesFor = this.state.roadVersion;
    this.lanes.clear();
    this.occ.clear();
    this.claims.clear();
    this.claimed.clear();
    const road = [...this.state.trains.values()].filter((t) => t.mode === 'road');
    for (const t of road) for (const s of t.path) this.occupy(t, s);
    for (const t of road) if (t.path.length && this.laneKey(t.path[0]!) % 8 === 7) this.claim(t, this.lanesThrough(t, 0) ?? []);
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
      t.routeFor = -1;
      t.speed = 0;
    } else if (t.status === 'stopped') t.status = 'running';
  }

  stop(t: Train): void {
    if (t.status === 'running' || t.status === 'loading') t.status = 'stopped';
  }

  sendToDepot(t: Train): void {
    t.toDepot = !t.toDepot;
    t.routeFor = -1;
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
    t.routeFor = -1;
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
    t.routeFor = -1;
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
    if (key >= 0 && t.routeFor !== routeKey(this.state.roadVersion, key) && this.state.tick >= t.replanAt) this.plan(t);

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
    if (t.speed === 0 && t.status === 'running' && !t.brokenDown && this.blocker(t) >= 0) this.whenHeldUp(t);
    else this.waitingSince.delete(t.id);
  }

  private whenHeldUp(t: Train): void {
    const since = this.waitingSince.get(t.id);
    if (since === undefined) {
      this.waitingSince.set(t.id, this.state.tick);
      return;
    }
    const waited = this.state.tick - since;
    if (waited % REROUTE_TICKS === 0) this.plan(t);
    if (waited >= GRIDLOCK_TICKS && this.gridlocked(t)) this.passing.add(t.id);
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
    for (let i = 0; i < t.route.length; i++) {
      const s = t.route[i]!;
      if (d > horizon) return d;
      if (!(i === 0 && this.passing.has(t.id)) && (this.occupiedByOther(s, t.id) || !this.boxLanes(t, i))) return d - GAP;
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
      const pass = this.passing.has(t.id);
      const box = next === undefined ? null : pass ? [] : this.boxLanes(t, 0);
      // Never drive under lowered barriers, even if they came down too late to brake gently.
      const barred = next !== undefined && rsTile(next) !== rsTile(head) && this.crossingClosed?.(rsTile(next)) === true;
      if (next === undefined || !roadNext(this.state.map, head).includes(next) || (!pass && this.occupiedByOther(next, t.id)) || !box || barred) {
        t.pos = rsLength(head);
        t.speed = 0;
        break;
      }
      t.route.shift();
      t.path.unshift(next);
      this.occupy(t, next);
      this.claim(t, box);
      this.passing.delete(t.id);
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

  private targetKey(t: Train): number {
    const code = targetCode(t);
    return code % 4 === 2 ? -1 : code; // no waypoints on roads
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
    this.dropClaims(t);
    this.passing.delete(t.id);
    const key = this.targetKey(t);
    t.routeFor = routeKey(this.state.roadVersion, key);
    const o = t.orders[t.orderIndex];
    const goals = t.toDepot || t.serviceTrip ? this.goalTiles(t, 'depot') : o ? this.goalTiles(t, o) : new Set<number>();
    const penalty = (s: number) => (this.occupiedByOther(s, t.id) ? 3 : 0);
    let path = goals.size ? findRoadPath(this.state.map, t.path[0]!, goals, penalty) : null;
    if (!path && goals.size && t.speed < 0.5) {
      // Turn round where it stands and try the other way.
      const back = findRoadPath(this.state.map, rsReverse(t.path[t.path.length - 1]!), goals, penalty);
      if (back && this.reverse(t)) {
        path = back;
        t.routeFor = routeKey(this.state.roadVersion, key);
      }
    }
    if (!path) {
      t.route = [];
      t.replanAt = this.state.tick + REPLAN_DELAY;
      if (t.serviceTrip) {
        t.serviceTrip = false;
        t.routeFor = -1;
        t.replanAt = 0;
      }
      return;
    }
    t.route = path;
    // Replanned in a junction: claim the new way out.
    if (this.laneKey(t.path[0]!) % 8 === 7) this.claim(t, this.lanesThrough(t, 0) ?? []);
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
