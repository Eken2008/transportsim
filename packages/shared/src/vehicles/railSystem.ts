import {
  depotExitSegment,
  pieceKey,
  segLength,
  segReverse,
  segTd,
  segTile,
  segmentExists,
  segmentsConnect,
} from '../rail/network.ts';
import { depotGoal, extendThroughPlatform, findPath, stationGoal, type PathGoal } from '../rail/pathfinder.ts';
import { edgeHeight, tdEntry, tdExit, tdPiece, pieceLength } from '../rail/track.ts';
import { TICKS_PER_DAY, TICKS_PER_SECOND } from '../sim/date.ts';
import type { GameState } from '../sim/state.ts';
import { TileType } from '../world/constants.ts';
import { PASSENGER_MASS, cargoCount, trainStats, type Train, type TrainMotion, type TrainStats } from './train.ts';

/** km/h corresponding to 1 tile per second. Sets the game's sense of scale. */
export const KMH_PER_TILE_PER_S = 28;
/** Acceleration is scaled up from real physics so trains reach speed in seconds, not minutes. */
export const ACCEL_SCALE = 6;
/** Service braking, km/h per second. */
export const BRAKE_KMH_PER_S = 40;
/** Gradient of a one-level climb over one tile. */
export const GRADE_PER_LEVEL = 0.025;
/** Ticks spent at a platform per stop. */
export const DWELL_TICKS = Math.round(TICKS_PER_DAY * 1.2);
/** Stop this far (tiles) behind an obstacle. */
const SAFETY_MARGIN = 0.3;
const REPLAN_DELAY = 45;
/** Minimum approach speed for the final metres to a stop point. */
const CREEP_KMH = 4;

const DT = 1 / TICKS_PER_SECOND;

/** Distance (tiles) needed to stop from `kmh`. */
export function brakingDistance(kmh: number): number {
  const v = kmh / KMH_PER_TILE_PER_S;
  const a = BRAKE_KMH_PER_S / KMH_PER_TILE_PER_S;
  return (v * v) / (2 * a);
}

/** Highest speed (km/h) from which the train can still stop within `d` tiles. */
export function speedForDistance(d: number): number {
  if (d <= 0) return 0;
  const a = BRAKE_KMH_PER_S / KMH_PER_TILE_PER_S;
  return Math.sqrt(2 * a * d) * KMH_PER_TILE_PER_S;
}

/**
 * Owns train movement: occupancy of track pieces, route planning, physics, stopping at
 * stations, entering and leaving depots, and reversing at termini.
 */
export class RailSystem {
  /** pieceKey → ids of trains on that piece. */
  private occ = new Map<number, Set<number>>();
  private stats = new Map<number, TrainStats>();
  /** Called when a train arrives at a platform (cargo handling hooks in here). */
  onArrive: ((t: Train, station: number) => void) | null = null;
  /** Called every tick while loading; return true to keep waiting (e.g. full load). */
  onLoading: ((t: Train, station: number) => boolean) | null = null;

  constructor(private readonly state: GameState) {}

  statsOf(t: Train): TrainStats {
    let s = this.stats.get(t.id);
    if (!s) this.stats.set(t.id, (s = trainStats(t.units)));
    return s;
  }

  forget(t: Train): void {
    this.releaseAll(t);
    this.stats.delete(t.id);
  }

  // ---- occupancy -------------------------------------------------------------

  isOccupied(tile: number, piece: number, except = -1): boolean {
    const set = this.occ.get(tile * 8 + piece);
    if (!set) return false;
    for (const id of set) if (id !== except) return true;
    return false;
  }

  private occupiedByOther(s: number, id: number): boolean {
    const set = this.occ.get(pieceKey(s));
    if (!set) return false;
    for (const o of set) if (o !== id) return true;
    return false;
  }

  private occupy(t: Train, s: number): void {
    const k = pieceKey(s);
    let set = this.occ.get(k);
    if (!set) this.occ.set(k, (set = new Set()));
    set.add(t.id);
  }

  private release(t: Train, s: number): void {
    const k = pieceKey(s);
    const set = this.occ.get(k);
    if (!set) return;
    // Another segment of the same train may still be on this piece (it can't, pieces are
    // traversed once per pass, but be safe if a train is tightly looped).
    if (!t.path.some((p) => pieceKey(p) === k)) set.delete(t.id);
    if (set.size === 0) this.occ.delete(k);
  }

  private releaseAll(t: Train): void {
    for (const s of t.path) {
      const set = this.occ.get(pieceKey(s));
      set?.delete(t.id);
      if (set && set.size === 0) this.occ.delete(pieceKey(s));
    }
  }

  /** Rebuild occupancy from scratch (after loading a save). */
  rebuildOccupancy(): void {
    this.occ.clear();
    for (const t of this.state.trains.values()) for (const s of t.path) this.occupy(t, s);
  }

  depotHasVehicles(tile: number): boolean {
    for (const t of this.state.trains.values()) {
      if (t.status === 'depot' && t.depot === tile) return true;
      if (t.path.some((s) => segTile(s) === tile)) return true;
    }
    return false;
  }

  // ---- control -----------------------------------------------------------------

  canStart(t: Train): string | null {
    if (t.status === 'depot') {
      if (t.orders.length === 0) return 'Give the train some orders first';
      if (this.occupiedByOther(depotExitSegment(this.state.map, t.depot), t.id)) return 'The depot exit is blocked';
      return null;
    }
    return t.status === 'stopped' ? null : 'Already running';
  }

  /** Leave the depot (or resume after a player stop). Call canStart() first. */
  start(t: Train): void {
    if (t.status === 'depot') {
      const s = depotExitSegment(this.state.map, t.depot);
      t.path = [s];
      t.pos = 0;
      t.speed = 0;
      t.depot = -1;
      t.status = 'running';
      t.route = [];
      t.routeFor = '';
      this.occupy(t, s);
    } else if (t.status === 'stopped') {
      t.status = 'running';
    }
  }

  stop(t: Train): void {
    if (t.status === 'running' || t.status === 'loading') t.status = 'stopped';
  }

  /** Toggle heading for the nearest depot. */
  sendToDepot(t: Train): void {
    t.toDepot = !t.toDepot;
    t.routeFor = '';
  }

  /** Turn the train around (only when stopped and fully out of the depot). */
  reverse(t: Train): boolean {
    if (t.path.length === 0 || t.speed > 0.5) return false;
    const len = this.statsOf(t).length;
    let covered = t.pos;
    for (let i = 1; i < t.path.length; i++) covered += segLength(t.path[i]!);
    if (covered + 1e-6 < len) return false; // tail still inside a depot
    const last = t.path[t.path.length - 1]!;
    const newPath = t.path.map(segReverse).reverse();
    t.pos = segLength(last) - (covered - len);
    t.path = newPath;
    t.route = [];
    t.routeFor = '';
    t.speed = 0;
    return true;
  }

  /** Remove a parked train completely. */
  removeFromWorld(t: Train): void {
    this.forget(t);
  }

  // ---- simulation --------------------------------------------------------------

  step(): void {
    for (const t of this.state.trains.values()) {
      if (t.status === 'depot') continue;
      this.stepTrain(t);
    }
  }

  private stepTrain(t: Train): void {
    const map = this.state.map;
    // Track under the train may have been removed (only possible for tiles not occupied when
    // the command ran, so this is a safety net for saves/edge cases).
    if (!t.path.every((s) => segmentExists(map, s))) {
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

    const target = this.targetKey(t);
    if (target !== null && t.routeFor !== `${this.state.trackVersion}:${target}` && this.state.tick >= t.replanAt) {
      this.plan(t);
    }

    // Look ahead for the nearest place we must stop.
    const stats = this.statsOf(t);
    const stopAt = this.stopDistance(t, brakingDistance(t.speed) + 2);
    // Brake for the stop point, but creep the last bit so trains reach it exactly.
    let limit = Math.min(stats.maxSpeed, Math.max(speedForDistance(stopAt), stopAt > 0.01 ? CREEP_KMH : 0));
    if (t.status === 'stopped') limit = 0;

    if (t.speed > limit) {
      t.speed = Math.max(limit, t.speed - BRAKE_KMH_PER_S * DT);
    } else {
      const a = this.acceleration(t, stats);
      t.speed = Math.max(0, Math.min(limit, t.speed + a * DT));
    }
    if (t.speed < 0.05 && limit < 0.5) t.speed = 0;

    this.advance(t, (t.speed / KMH_PER_TILE_PER_S) * DT);

    if (t.speed === 0 && t.status === 'running') this.whenStopped(t);
  }

  /** Acceleration in km/h per second from tractive effort, resistance and gradient. */
  private acceleration(t: Train, s: TrainStats): number {
    const mass = s.mass + cargoCount(t) * PASSENGER_MASS;
    if (mass <= 0) return 0;
    const vms = Math.max(t.speed / 3.6, 1);
    const tractive = Math.min(s.tractiveEffort, s.power / vms); // kN
    const resist = mass * (0.012 + 0.00015 * t.speed) + 0.0005 * t.speed * t.speed; // kN
    const grade = this.gradeUnder(t) * GRADE_PER_LEVEL * 9.81 * mass; // kN
    const a = ((tractive - resist - grade) / mass) * ACCEL_SCALE; // m/s²
    return a * 3.6;
  }

  /** Average climb (levels per tile) under the train, weighted by segment length. */
  private gradeUnder(t: Train): number {
    const map = this.state.map;
    let sum = 0;
    let len = 0;
    for (const s of t.path.slice(0, 6)) {
      const tile = segTile(s);
      const x = tile % map.width;
      const corners = map.tileCorners(x, (tile - x) / map.width);
      const td = segTd(s);
      const l = pieceLength(tdPiece(td));
      sum += edgeHeight(corners, tdExit(td)) - edgeHeight(corners, tdEntry(td));
      len += l;
    }
    return len > 0 ? sum / len : 0;
  }

  /** Distance (tiles) from the head to the first place the train must stop, up to `horizon`. */
  private stopDistance(t: Train, horizon: number): number {
    const map = this.state.map;
    let d = segLength(t.path[0]!) - t.pos;
    let prev = t.path[0]!;
    for (const s of t.route) {
      if (d > horizon) return d;
      if (!segmentsConnect(map, prev, s, t.owner)) return d; // route went stale
      if (this.occupiedByOther(s, t.id)) return d - SAFETY_MARGIN;
      d += segLength(s);
      prev = s;
    }
    return d; // end of route: destination platform end, depot, or dead end
  }

  private advance(t: Train, dist: number): void {
    const map = this.state.map;
    while (dist > 0) {
      const head = t.path[0]!;
      const room = segLength(head) - t.pos;
      if (dist <= room) {
        t.pos += dist;
        break;
      }
      const next = t.route[0];
      if (next === undefined || !segmentsConnect(map, head, next, t.owner) || this.occupiedByOther(next, t.id)) {
        t.pos = segLength(head);
        t.speed = 0;
        break;
      }
      t.route.shift();
      t.path.unshift(next);
      this.occupy(t, next);
      t.pos = 0;
      dist -= room;
    }
    this.trimTail(t);
  }

  private trimTail(t: Train): void {
    const len = this.statsOf(t).length;
    let covered = t.pos;
    let keep = 1;
    while (keep < t.path.length && covered < len) covered += segLength(t.path[keep++]!);
    while (t.path.length > keep) this.release(t, t.path.pop()!);
  }

  /** Train has come to a halt while running: arrived, blocked, or at a dead end. */
  private whenStopped(t: Train): void {
    const map = this.state.map;
    const head = t.path[0]!;
    const atEnd = t.pos >= segLength(head) - 0.01 && t.route.length === 0;
    if (!atEnd) return; // waiting behind something; keep the route

    const tile = segTile(head);
    if (t.toDepot && map.layers.type[tile] === TileType.Depot) {
      this.enterDepot(t, tile);
      return;
    }
    const order = t.orders[t.orderIndex];
    if (!t.toDepot && order?.kind === 'station' && map.layers.type[tile] === TileType.Station && map.layers.data[tile] === order.station) {
      t.status = 'loading';
      t.loadTicks = DWELL_TICKS;
      t.lastStation = order.station;
      this.state.dirtyTrains.add(t.id);
      this.onArrive?.(t, order.station);
      return;
    }
    // Dead end or nowhere to go: try again (possibly reversing) after a short delay.
    if (this.state.tick >= t.replanAt) this.plan(t);
  }

  private enterDepot(t: Train, tile: number): void {
    this.releaseAll(t);
    t.path = [];
    t.route = [];
    t.pos = 0;
    t.speed = 0;
    t.status = 'depot';
    t.depot = tile;
    t.toDepot = false;
    t.routeFor = '';
    this.state.dirtyTrains.add(t.id);
  }

  private depart(t: Train): void {
    t.status = 'running';
    this.state.dirtyTrains.add(t.id);
    if (t.orders.length > 0) t.orderIndex = (t.orderIndex + 1) % t.orders.length;
    t.routeFor = '';
    t.replanAt = 0;
    this.plan(t);
  }

  private targetKey(t: Train): string | null {
    if (t.toDepot) return 'depot';
    const o = t.orders[t.orderIndex];
    if (!o) return null;
    return o.kind === 'station' ? `s${o.station}` : 'depot';
  }

  private goalFor(t: Train): PathGoal | null {
    const map = this.state.map;
    const o = t.orders[t.orderIndex];
    if (t.toDepot || o?.kind === 'depot') {
      const depots = [...this.state.depots].filter((d) => map.layers.owner[d] === t.owner);
      return depots.length ? depotGoal(map, depots) : null;
    }
    if (o?.kind === 'station') {
      const st = this.state.stations.get(o.station);
      return st ? stationGoal(map, st.id, st) : null;
    }
    return null;
  }

  /** Plan a route to the current target; reverse if only the way back leads there. */
  plan(t: Train): void {
    const key = this.targetKey(t);
    const goal = this.goalFor(t);
    t.routeFor = `${this.state.trackVersion}:${key}`;
    if (!goal) {
      t.route = [];
      t.replanAt = this.state.tick + REPLAN_DELAY;
      return;
    }
    const map = this.state.map;
    const penalty = (s: number) => (this.occupiedByOther(s, t.id) ? 6 : 0);
    let path = findPath(map, t.path[0]!, goal, { owner: t.owner, penalty });
    if (!path && t.speed < 0.5) {
      // Try the other way round: plan from the tail segment, reversed.
      const tail = segReverse(t.path[t.path.length - 1]!);
      const back = findPath(map, tail, goal, { owner: t.owner, penalty });
      if (back && this.reverse(t)) {
        path = back;
        t.routeFor = `${this.state.trackVersion}:${key}`;
      }
    }
    if (!path) {
      t.route = [];
      t.replanAt = this.state.tick + REPLAN_DELAY;
      return;
    }
    extendThroughPlatform(map, path, t.owner);
    t.route = path;
  }

  motion(t: Train): TrainMotion {
    return { id: t.id, path: t.path.slice(), pos: t.pos, speed: t.speed, ahead: t.route.slice(0, 6) };
  }
}
