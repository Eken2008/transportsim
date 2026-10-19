import { AIRPORT_TYPES, airportNodes, hangarTile, taxiRoute, type AirportNodes, type Point } from '../air/airports.ts';
import type { Station } from '../rail/station.ts';
import { TICKS_PER_DAY, TICKS_PER_SECOND } from '../sim/date.ts';
import type { GameState } from '../sim/state.ts';
import { railVehicle } from './catalog.ts';
import { advanceOrder, needsService } from './orders.ts';
import { DWELL_TICKS, KMH_PER_TILE_PER_S } from './railSystem.ts';
import type { AirState, Train, TrainMotion } from './train.ts';

const DT = 1 / TICKS_PER_SECOND;
/** Taxiing speed, tiles per second. */
const TAXI = 1.2;
/** Aircraft fly at a quarter of their real speed, so flights take a few days, not minutes. */
const FLIGHT_SCALE = 0.25;
/** Cruise height (tiles above the ground) and the height aircraft descend to before landing. */
const CRUISE_Z = 3;
const APPROACH_Z = 1.2;
const HOLD_RADIUS = 3;

/** Does this aircraft type need a large airport? */
export const isHeavy = (type: string) => railVehicle(type)?.heavy === true;

/**
 * Moves aircraft (Trains with mode 'air'). Aircraft taxi between the hangar, gates and the
 * runway, take off, cruise to their destination, hold while its runway is busy, land and
 * taxi to a free gate. One aircraft uses a runway at a time; gates are reserved.
 */
export class AirSystem {
  /** Airport station → aircraft using its runway. */
  private runway = new Map<number, number>();
  /** Airport station → tick until which its runway is closed (accident cleanup). */
  readonly runwayClosed = new Map<number, number>();
  /** Airport station → aircraft at each gate. */
  private gates = new Map<number, (number | null)[]>();
  onArrive: ((t: Train, station: number) => void) | null = null;
  onLoading: ((t: Train, station: number) => boolean) | null = null;
  onService: ((t: Train) => void) | null = null;
  /** Called when an aircraft lands (incident rules hook in here). */
  onLanded: ((t: Train, airport: Station) => void) | null = null;

  constructor(private readonly state: GameState) {}

  private nodes(stationId: number): AirportNodes | null {
    const a = this.state.stations.get(stationId)?.airport;
    return a ? airportNodes(a) : null;
  }

  private gatesOf(stationId: number): (number | null)[] {
    let g = this.gates.get(stationId);
    const st = this.state.stations.get(stationId);
    const n = st?.airport ? AIRPORT_TYPES[st.airport.kind].gates : 0;
    if (!g || g.length !== n) this.gates.set(stationId, (g = Array.from({ length: n }, (_, i) => g?.[i] ?? null)));
    return g;
  }

  private runwayFree(stationId: number, id: number): boolean {
    const r = this.runway.get(stationId);
    return (r === undefined || r === id || !this.state.trains.has(r)) && (this.runwayClosed.get(stationId) ?? 0) <= this.state.tick;
  }

  private release(t: Train): void {
    for (const [s, id] of this.runway) if (id === t.id) this.runway.delete(s);
    for (const g of this.gates.values()) for (let i = 0; i < g.length; i++) if (g[i] === t.id) g[i] = null;
    if (t.air) t.air.gate = undefined;
  }

  /** After loading a save: re-take runways and gates from aircraft states. */
  rebuild(): void {
    this.runway.clear();
    this.gates.clear();
    for (const t of this.state.trains.values()) {
      const a = t.mode === 'air' ? t.air : undefined;
      if (!a) continue;
      if (a.phase === 'takeoff' || a.phase === 'landing') this.runway.set(a.airport, t.id);
      if (a.gate !== undefined) this.gatesOf(a.airport)[a.gate] = t.id;
    }
  }

  removeFromWorld(t: Train): void {
    this.release(t);
    this.state.rail.invalidateStats(t);
  }

  /** Aircraft at an airport (on the ground, or about to use it). */
  aircraftAt(stationId: number): Train[] {
    return [...this.state.trains.values()].filter((t) => t.mode === 'air' && t.air?.airport === stationId && t.air.phase !== 'flying' && t.air.phase !== 'holding');
  }

  // ---- control -------------------------------------------------------------------

  canStart(t: Train): string | null {
    if (t.status === 'depot') return t.orders.length === 0 ? 'Give the aircraft some orders first' : null;
    return t.status === 'stopped' ? null : 'Already running';
  }

  start(t: Train): void {
    if (t.status === 'stopped') {
      t.status = 'running';
      return;
    }
    if (t.status !== 'depot') return;
    const home = this.stationOfHangar(t.depot);
    const n = home !== undefined ? this.nodes(home) : null;
    if (home === undefined || !n) return;
    t.status = 'running';
    t.depot = -1;
    t.speed = 0;
    t.air = { phase: 'taxi', x: n.hangarDoor.x, y: n.hangarDoor.y, z: 0, heading: 0, airport: home, legs: [] };
    t.departedAt = this.state.tick;
    this.leaveGround(t);
  }

  /** On the ground only: aircraft can't stop in the air. */
  stop(t: Train): void {
    if (t.status === 'running' && (t.air?.phase === 'taxi' || t.air?.phase === 'hold' || t.air?.phase === 'gate')) t.status = 'stopped';
  }

  sendToDepot(t: Train): void {
    t.toDepot = !t.toDepot;
  }

  reverse(): boolean {
    return false;
  }

  private stationOfHangar(tile: number): number | undefined {
    for (const st of this.state.stations.values()) if (st.airport && hangarTile(this.state.map, st.airport) === tile) return st.id;
    return undefined;
  }

  enterDepot(t: Train, tile: number): void {
    this.release(t);
    t.air = undefined;
    t.status = 'depot';
    t.depot = tile;
    t.speed = 0;
    t.toDepot = false;
    t.lastService = this.state.date;
    this.onService?.(t);
    this.state.dirtyTrains.add(t.id);
  }

  // ---- planning --------------------------------------------------------------------

  /** Where to fly next: a hangar for service/depot orders, else the current order's airport. */
  private destination(t: Train): { station: number; hangar: boolean } | null {
    const o = t.orders[t.orderIndex];
    if (t.toDepot || t.serviceTrip || o?.kind === 'depot') {
      const here = t.air ? { x: t.air.x, y: t.air.y } : { x: 0, y: 0 };
      let best: Station | undefined;
      let bestD = Infinity;
      for (const st of this.state.stations.values()) {
        if (!st.airport || st.owner !== t.owner) continue;
        const d = Math.hypot(st.x - here.x, st.y - here.y);
        if (d < bestD) {
          bestD = d;
          best = st;
        }
      }
      return best ? { station: best.id, hangar: true } : null;
    }
    if (o?.kind === 'station' && this.state.stations.get(o.station)?.airport) return { station: o.station, hangar: false };
    return null;
  }

  /** On the ground at its airport: go to a gate here, to the hangar, or to the runway to leave. */
  private leaveGround(t: Train): void {
    const a = t.air!;
    const dest = this.destination(t);
    const n = this.nodes(a.airport);
    if (!n) return;
    if (dest && dest.station === a.airport) {
      if (dest.hangar) return this.taxi(t, n, n.hangarDoor, 'hangar');
      return this.toGate(t, n);
    }
    this.taxi(t, n, n.hold, 'hold');
  }

  private taxi(t: Train, n: AirportNodes, to: Point, goal: 'gate' | 'hold' | 'hangar'): void {
    const a = t.air!;
    a.phase = 'taxi';
    a.legs = taxiRoute(n, { x: a.x, y: a.y }, to).map((p) => [p.x, p.y, 0]);
    a.goal = goal;
  }

  /** Taxi to a free gate, or wait where it is until one frees up. */
  private toGate(t: Train, n: AirportNodes): void {
    const a = t.air!;
    const gates = this.gatesOf(a.airport);
    let g = gates.indexOf(t.id);
    if (g < 0) g = gates.indexOf(null);
    if (g < 0) {
      a.phase = 'taxi';
      a.legs = [];
      a.goal = 'waitGate';
      return;
    }
    gates[g] = t.id;
    a.gate = g;
    this.taxi(t, n, n.gates[g]!, 'gate');
  }

  // ---- simulation ------------------------------------------------------------------

  step(): void {
    for (const t of this.state.trains.values()) {
      if (t.mode !== 'air' || t.status === 'depot' || !t.air) continue;
      this.stepAircraft(t, t.air);
    }
  }

  private cruise(t: Train): number {
    const v = this.state.rail.statsOf(t).maxSpeed / KMH_PER_TILE_PER_S;
    return v * FLIGHT_SCALE * (t.brokenDown ? 0.6 : 1);
  }

  private stepAircraft(t: Train, a: AirState): void {
    if (t.status === 'loading') {
      if (t.loadTicks > 0) t.loadTicks--;
      const keep = this.onLoading?.(t, a.airport) ?? false;
      if (t.loadTicks <= 0 && !keep) this.depart(t);
      return;
    }
    if (t.brokenDown && --t.brokenDown <= 0) {
      t.brokenDown = 0;
      this.state.dirtyTrains.add(t.id);
    }
    const onGround = a.phase === 'taxi' || a.phase === 'hold' || a.phase === 'gate';
    if (t.status === 'stopped' || (onGround && t.brokenDown)) {
      t.speed = 0;
      return;
    }
    // The airport we are at or heading for has gone: pick a new destination.
    if (!this.state.stations.get(a.airport)?.airport) return this.divert(t, a);

    let speed: number; // tiles per second
    if (a.phase === 'taxi' || a.phase === 'gate') speed = TAXI;
    else if (a.phase === 'takeoff') speed = Math.max(TAXI, this.cruise(t) * Math.min(1, 0.25 + this.progress(a) * 0.75));
    else if (a.phase === 'landing') speed = Math.max(TAXI, this.cruise(t) * 0.5);
    else speed = this.cruise(t);
    t.speed = speed * KMH_PER_TILE_PER_S;
    let dist = speed * DT;
    while (dist > 0 && a.legs.length) {
      const [lx, ly, lz] = a.legs[0]!;
      const dx = lx - a.x;
      const dy = ly - a.y;
      const dz = lz - a.z;
      const d = Math.hypot(dx, dy, dz);
      if (Math.hypot(dx, dy) > 1e-6) a.heading = Math.atan2(dy, dx);
      if (d <= dist) {
        a.x = lx;
        a.y = ly;
        a.z = lz;
        a.legs.shift();
        dist -= d;
      } else {
        a.x += (dx / d) * dist;
        a.y += (dy / d) * dist;
        a.z += (dz / d) * dist;
        dist = 0;
      }
    }
    if (a.legs.length === 0) this.legsDone(t, a);
  }

  /** How far along the runway a takeoff is (0..1). */
  private progress(a: AirState): number {
    const n = this.nodes(a.airport);
    if (!n) return 1;
    return Math.max(0, Math.min(1, (a.x - n.runwayStart.x) / Math.max(0.1, n.runwayEnd.x - n.runwayStart.x)));
  }

  private legsDone(t: Train, a: AirState): void {
    const n = this.nodes(a.airport)!;
    switch (a.phase) {
      case 'taxi':
        if (a.goal === 'waitGate') return this.toGate(t, n);
        if (a.goal === 'hold') {
          a.phase = 'hold';
          return;
        }
        if (a.goal === 'hangar') return this.enterHangar(t, a);
        if (a.goal === 'gate') return this.atGate(t, a);
        return this.leaveGround(t);
      case 'hold':
        if (!this.runwayFree(a.airport, t.id)) return;
        this.runway.set(a.airport, t.id);
        a.phase = 'takeoff';
        a.legs = [
          [n.runwayStart.x, n.runwayStart.y, 0],
          [n.runwayStart.x + (n.runwayEnd.x - n.runwayStart.x) * 0.6, n.runwayEnd.y, 0],
          [n.runwayEnd.x, n.runwayEnd.y, 0.6],
        ];
        return;
      case 'takeoff':
        this.runway.delete(a.airport);
        return this.fly(t, a);
      case 'flying':
      case 'holding': {
        if (this.runwayFree(a.airport, t.id)) {
          this.runway.set(a.airport, t.id);
          a.phase = 'landing';
          a.legs = [
            [n.runwayStart.x + 0.4, n.runwayStart.y, 0],
            [n.runwayEnd.x - 0.3, n.runwayEnd.y, 0],
          ];
          return;
        }
        // Circle until the runway is free.
        a.phase = 'holding';
        // Kept on the map, even for airports by its edge.
        const cx = Math.max(HOLD_RADIUS, n.approach.x);
        const cy = Math.max(HOLD_RADIUS, n.approach.y - HOLD_RADIUS);
        a.legs = [0, 1, 2, 3, 4].map((k) => {
          const ang = Math.PI / 2 - (k * Math.PI) / 2;
          return [cx + Math.cos(ang) * HOLD_RADIUS, cy + Math.sin(ang) * HOLD_RADIUS, APPROACH_Z] as [number, number, number];
        });
        return;
      }
      case 'landing': {
        this.runway.delete(a.airport);
        const st = this.state.stations.get(a.airport)!;
        this.onLanded?.(t, st);
        if (!this.state.trains.has(t.id)) return; // crashed
        t.speed = TAXI * KMH_PER_TILE_PER_S;
        a.phase = 'taxi';
        a.legs = [[n.exit.x, n.exit.y, 0]];
        a.goal = a.toHangar ? 'hangar' : 'gate';
        if (a.toHangar) a.legs.push(...taxiRoute(n, n.exit, n.hangarDoor).map((p) => [p.x, p.y, 0] as [number, number, number]));
        else a.goal = 'waitGate';
        return;
      }
      default:
        return;
    }
  }

  private fly(t: Train, a: AirState): void {
    const dest = this.destination(t);
    if (!dest) {
      // Nowhere to go: come back down here.
      a.phase = 'flying';
      const n = this.nodes(a.airport)!;
      a.legs = [[n.approach.x, n.approach.y, APPROACH_Z]];
      return;
    }
    const n = this.nodes(dest.station)!;
    a.airport = dest.station;
    a.toHangar = dest.hangar;
    a.phase = 'flying';
    const mid: [number, number, number] = [(a.x + n.approach.x) / 2, (a.y + n.approach.y) / 2, CRUISE_Z];
    a.legs = [mid, [n.approach.x, n.approach.y, APPROACH_Z]];
  }

  /** The destination airport disappeared: fly somewhere sensible instead. */
  private divert(t: Train, a: AirState): void {
    if (a.phase === 'flying' || a.phase === 'holding' || a.phase === 'landing' || a.phase === 'takeoff') {
      this.release(t);
      const o = t.orders[t.orderIndex];
      if (o?.kind === 'station' && !this.state.stations.get(o.station)?.airport) advanceOrder(this.state, t);
      if (!this.destination(t)) t.toDepot = true;
      return this.fly(t, a);
    }
    // On the ground at an airport that was removed: can't happen (airports with aircraft can't be removed).
  }

  private atGate(t: Train, a: AirState): void {
    a.phase = 'gate';
    t.speed = 0;
    const o = t.orders[t.orderIndex];
    if (o?.kind === 'station' && o.station === a.airport) {
      t.status = 'loading';
      t.loadTicks = DWELL_TICKS;
      if (o.wait) t.loadTicks = Math.max(t.loadTicks, Math.round(o.wait * TICKS_PER_DAY));
      t.lastStation = a.airport;
      this.state.dirtyTrains.add(t.id);
      this.onArrive?.(t, a.airport);
      return;
    }
    this.depart(t, false);
  }

  private enterHangar(t: Train, a: AirState): void {
    const st = this.state.stations.get(a.airport)!;
    const park = t.toDepot;
    const order = t.orders[t.orderIndex];
    const detour = t.serviceTrip && order?.kind !== 'depot';
    t.serviceTrip = false;
    this.enterDepot(t, hangarTile(this.state.map, st.airport!));
    if (park) return;
    if (!detour && order) advanceOrder(this.state, t);
    this.start(t);
  }

  private depart(t: Train, advance = true): void {
    const a = t.air!;
    t.status = 'running';
    if (advance) advanceOrder(this.state, t);
    t.departedAt = this.state.tick;
    if (this.state.settings.breakdowns && needsService(this.state, t) && !t.orders.some((o) => o.kind === 'depot')) t.serviceTrip = true;
    // Free the gate unless the next stop is here again.
    const dest = this.destination(t);
    if (!dest || dest.station !== a.airport || dest.hangar) {
      const g = this.gatesOf(a.airport);
      if (a.gate !== undefined && g[a.gate] === t.id) g[a.gate] = null;
      a.gate = undefined;
    }
    this.state.dirtyTrains.add(t.id);
    this.leaveGround(t);
  }

  motion(t: Train): TrainMotion {
    const a = t.air;
    const speed = t.speed / KMH_PER_TILE_PER_S;
    return {
      id: t.id,
      path: [],
      pos: 0,
      speed: t.speed,
      ahead: [],
      air: a ? [a.x, a.y, a.z, a.heading, t.status === 'running' ? speed : 0] : undefined,
    };
  }
}
