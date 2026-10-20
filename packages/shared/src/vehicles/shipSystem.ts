import { TICKS_PER_DAY, TICKS_PER_SECOND } from '../sim/date.ts';
import type { GameState } from '../sim/state.ts';
import { findShipPath } from '../water/shipPath.ts';
import { dockBerth, navigable, stationDocks, waterLevelAtPoint } from '../water/waterways.ts';
import { TileType } from '../world/constants.ts';
import { foundRoute, noRoute } from './lost.ts';
import { advanceOrder, needsService } from './orders.ts';
import { DWELL_TICKS, KMH_PER_TILE_PER_S } from './railSystem.ts';
import type { ShipState, Train, TrainMotion } from './train.ts';

const DT = 1 / TICKS_PER_SECOND;
/** Ships sail a little faster than their real speed, so voyages take days, not weeks. */
const SHIP_SCALE = 1.6;
/** Ticks a ship spends in a lock while the water level changes. */
export const LOCK_TICKS = Math.round(TICKS_PER_DAY * 0.8);

/**
 * Moves ships (Trains with mode 'water') over the water grid. A ship finds a route to its next
 * dock, buoy or depot and sails from tile centre to tile centre. Ships pass through each other;
 * a lock holds one ship at a time, which waits there while the level changes.
 */
export class ShipSystem {
  /** Lock tile → ship using it. */
  private locks = new Map<number, number>();
  /** Tiles closed by a wreck, until a tick. */
  readonly wrecks = new Map<number, number>();
  onArrive: ((t: Train, station: number) => void) | null = null;
  onLoading: ((t: Train, station: number) => boolean) | null = null;
  onService: ((t: Train) => void) | null = null;

  constructor(private readonly state: GameState) {}

  private tileOf(s: ShipState): number {
    const map = this.state.map;
    const x = Math.max(0, Math.min(map.width - 1, Math.floor(s.x)));
    const y = Math.max(0, Math.min(map.height - 1, Math.floor(s.y)));
    return y * map.width + x;
  }

  /** Is a ship on (or sailing into) this tile? */
  busy(tile: number): boolean {
    for (const t of this.state.trains.values()) {
      const s = t.mode === 'water' && t.status !== 'depot' ? t.ship : undefined;
      if (s && (this.tileOf(s) === tile || s.path[0] === tile)) return true;
    }
    return false;
  }

  /** Is a ship parked in this depot? */
  inDepot(tile: number): boolean {
    for (const t of this.state.trains.values()) if (t.mode === 'water' && t.status === 'depot' && t.depot === tile) return true;
    return false;
  }

  private blocked = (tile: number) => (this.wrecks.get(tile) ?? 0) > this.state.tick;

  /** After loading a save: re-take locks from ship positions. */
  rebuild(): void {
    this.locks.clear();
    for (const t of this.state.trains.values()) {
      const s = t.mode === 'water' && t.status !== 'depot' ? t.ship : undefined;
      if (!s) continue;
      const tile = this.tileOf(s);
      if (this.state.map.layers.type[tile] === TileType.Lock) this.locks.set(tile, t.id);
    }
  }

  private release(t: Train): void {
    for (const [tile, id] of this.locks) if (id === t.id) this.locks.delete(tile);
  }

  removeFromWorld(t: Train): void {
    this.release(t);
    this.state.rail.invalidateStats(t);
  }

  // ---- control -------------------------------------------------------------------

  canStart(t: Train): string | null {
    if (t.status === 'depot') return t.orders.length === 0 ? 'Give the ship some orders first' : null;
    return t.status === 'stopped' ? null : 'Already running';
  }

  start(t: Train): void {
    if (t.status === 'stopped') {
      t.status = 'running';
      return;
    }
    if (t.status !== 'depot') return;
    const map = this.state.map;
    const x = t.depot % map.width;
    const y = (t.depot - x) / map.width;
    const axis = map.layers.data[t.depot]! & 1;
    t.status = 'running';
    t.ship = { x: x + 0.5, y: y + 0.5, heading: axis === 0 ? 0 : Math.PI / 2, path: [] };
    t.depot = -1;
    t.speed = 0;
    t.departedAt = this.state.tick;
    this.state.dirtyTrains.add(t.id);
  }

  stop(t: Train): void {
    if (t.status === 'running') t.status = 'stopped';
  }

  sendToDepot(t: Train): void {
    t.toDepot = !t.toDepot;
    if (t.ship) t.ship.path = [];
  }

  /** Turn round: plan the route again from here. */
  reverse(t: Train): boolean {
    if (t.ship) t.ship.path = [];
    return true;
  }

  enterDepot(t: Train, tile: number): void {
    this.release(t);
    t.ship = undefined;
    t.status = 'depot';
    t.depot = tile;
    t.speed = 0;
    t.toDepot = false;
    t.lastService = this.state.date;
    this.onService?.(t);
    this.state.dirtyTrains.add(t.id);
  }

  // ---- planning --------------------------------------------------------------------

  /** Where to sail next: tiles to aim for and what they are. */
  private destination(t: Train): { targets: Set<number>; goal: ShipState['goal'] } | null {
    const map = this.state.map;
    const o = t.orders[t.orderIndex];
    if (t.toDepot || t.serviceTrip || o?.kind === 'depot') {
      const targets = new Set<number>();
      for (const d of this.state.shipDepots) if (map.layers.owner[d] === t.owner) targets.add(d);
      return targets.size ? { targets, goal: 'depot' } : null;
    }
    if (o?.kind === 'station') {
      const st = this.state.stations.get(o.station);
      if (!st) return null;
      const targets = new Set(stationDocks(map, st).map((d) => dockBerth(map, d)));
      return targets.size ? { targets, goal: 'dock' } : null;
    }
    if (o?.kind === 'waypoint') {
      const wp = this.state.waypoints.get(o.waypoint);
      return wp?.buoy ? { targets: new Set([wp.tile]), goal: 'buoy' } : null;
    }
    return null;
  }

  /** Plan a route from where the ship is. False if there is nowhere to go (or no way there). */
  private plan(t: Train, s: ShipState): boolean {
    s.ver = this.state.waterVersion;
    const dest = this.destination(t);
    const path = dest && findShipPath(this.state.map, this.tileOf(s), dest.targets, this.blocked);
    if (!dest || !path) {
      noRoute(this.state, t);
      return false;
    }
    foundRoute(this.state, t);
    s.path = path;
    s.goal = dest.goal;
    return true;
  }

  // ---- simulation ------------------------------------------------------------------

  step(): void {
    for (const t of this.state.trains.values()) {
      if (t.mode !== 'water' || t.status === 'depot' || !t.ship) continue;
      this.stepShip(t, t.ship);
    }
    for (const [tile, until] of this.wrecks) if (until <= this.state.tick) this.wrecks.delete(tile);
  }

  private cruise(t: Train): number {
    return (this.state.rail.statsOf(t).maxSpeed / KMH_PER_TILE_PER_S) * SHIP_SCALE * (t.brokenDown ? 0.4 : 1);
  }

  private stepShip(t: Train, s: ShipState): void {
    if (t.status === 'loading') {
      if (t.loadTicks > 0) t.loadTicks--;
      const keep = this.onLoading?.(t, t.lastStation) ?? false;
      if (t.loadTicks <= 0 && !keep) this.depart(t);
      return;
    }
    if (t.brokenDown && --t.brokenDown <= 0) {
      t.brokenDown = 0;
      this.state.dirtyTrains.add(t.id);
    }
    if (t.status === 'stopped') {
      t.speed = 0;
      return;
    }
    if (s.lockWait) {
      // Waiting while the lock fills or empties.
      t.speed = 0;
      s.lockWait--;
      return;
    }
    if (s.retry) {
      s.retry--;
      t.speed = 0;
      return;
    }
    if (s.ver !== this.state.waterVersion && s.path.length) {
      // Waterways changed: keep the route if every tile on it is still open water.
      const map = this.state.map;
      if (s.path.some((i) => !navigable(map, i) || this.blocked(i))) s.path = [];
      s.ver = this.state.waterVersion;
    }
    if (s.path.length === 0) {
      if (!this.plan(t, s)) {
        s.path = [];
        s.retry = TICKS_PER_DAY;
        t.speed = 0;
        return;
      }
      if (s.path.length === 0) return this.arrive(t, s);
    }
    const map = this.state.map;
    const speed = this.cruise(t);
    t.speed = speed * KMH_PER_TILE_PER_S;
    let dist = speed * DT;
    while (dist > 0 && s.path.length) {
      const next = s.path[0]!;
      // Into a lock only when it is free.
      if (map.layers.type[next] === TileType.Lock && this.tileOf(s) !== next) {
        const user = this.locks.get(next);
        if (user !== undefined && user !== t.id && this.state.trains.has(user)) {
          t.speed = 0;
          return;
        }
        this.locks.set(next, t.id);
      }
      const nx = (next % map.width) + 0.5;
      const ny = Math.floor(next / map.width) + 0.5;
      const dx = nx - s.x;
      const dy = ny - s.y;
      const d = Math.hypot(dx, dy);
      if (d > 1e-6) s.heading = Math.atan2(dy, dx);
      if (d <= dist) {
        const was = this.tileOf(s);
        s.x = nx;
        s.y = ny;
        s.path.shift();
        dist -= d;
        if (was !== next && this.locks.get(was) === t.id) this.locks.delete(was);
        if (map.layers.type[next] === TileType.Lock) {
          s.lockWait = LOCK_TICKS;
          break;
        }
      } else {
        s.x += (dx / d) * dist;
        s.y += (dy / d) * dist;
        dist = 0;
      }
    }
    // Left a lock behind?
    const here = this.tileOf(s);
    for (const [tile, id] of this.locks) if (id === t.id && tile !== here && tile !== s.path[0]) this.locks.delete(tile);
    if (s.path.length === 0) this.arrive(t, s);
  }

  /** At the end of its route: load at a dock, pass a buoy, or go into a depot. */
  private arrive(t: Train, s: ShipState): void {
    const o = t.orders[t.orderIndex];
    t.speed = 0;
    if (s.goal === 'depot') {
      const tile = this.tileOf(s);
      if (this.state.map.layers.type[tile] !== TileType.ShipDepot) {
        s.path = [];
        return;
      }
      const park = t.toDepot;
      const detour = t.serviceTrip && o?.kind !== 'depot';
      t.serviceTrip = false;
      this.enterDepot(t, tile);
      if (park) return;
      if (!detour && o) advanceOrder(this.state, t);
      this.start(t);
      return;
    }
    if (s.goal === 'buoy') {
      advanceOrder(this.state, t);
      s.path = [];
      this.state.dirtyTrains.add(t.id);
      return;
    }
    if (s.goal === 'dock' && o?.kind === 'station') {
      t.status = 'loading';
      t.loadTicks = DWELL_TICKS;
      if (o.wait) t.loadTicks = Math.max(t.loadTicks, Math.round(o.wait * TICKS_PER_DAY));
      t.lastStation = o.station;
      this.state.dirtyTrains.add(t.id);
      this.onArrive?.(t, o.station);
      return;
    }
    s.path = [];
  }

  private depart(t: Train): void {
    t.status = 'running';
    advanceOrder(this.state, t);
    t.departedAt = this.state.tick;
    if (this.state.settings.breakdowns && needsService(this.state, t) && !t.orders.some((o) => o.kind === 'depot')) t.serviceTrip = true;
    if (t.ship) t.ship.path = [];
    this.state.dirtyTrains.add(t.id);
  }

  motion(t: Train): TrainMotion {
    const s = t.ship;
    const level = s ? waterLevelAtPoint(this.state.map, s.x, s.y) : 0;
    return {
      id: t.id,
      path: [],
      pos: 0,
      speed: t.speed,
      ahead: [],
      ship: s ? [s.x, s.y, level, s.heading, t.status === 'running' && !s.lockWait ? t.speed / KMH_PER_TILE_PER_S : 0] : undefined,
    };
  }
}
