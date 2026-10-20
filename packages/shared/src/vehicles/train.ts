import { CARGOS, type CargoId } from '../economy/cargo.ts';
import { railVehicle, unitCargo } from './catalog.ts';

/** What a conditional order looks at: load (% full), age (years), reliability (%), or a due service. */
export type JumpCondition = 'always' | 'load' | 'age' | 'reliability' | 'service';
export const JUMP_CONDITIONS: readonly JumpCondition[] = ['always', 'load', 'age', 'reliability', 'service'];

/** Go to order `to` if the condition holds (`op` compares with `value`), else to the next order. */
export interface JumpOrder {
  kind: 'jump';
  to: number;
  cond: JumpCondition;
  op?: 'lt' | 'ge';
  value?: number;
}

/**
 * Orders. Timetables: `wait` is the least time (days) to spend at a station, `travel` the
 * scheduled time (days) to get to an order from the previous one.
 */
export type Order =
  | { kind: 'station'; station: number; fullLoad?: boolean; wait?: number; travel?: number }
  | { kind: 'waypoint'; waypoint: number; travel?: number }
  | { kind: 'depot'; travel?: number }
  | JumpOrder;

export type TrainStatus =
  /** Parked inside a depot. */
  | 'depot'
  /** Driving (including waiting for a free path or a signal). */
  | 'running'
  /** Stopped on the line by the player. */
  | 'stopped'
  /** Standing at a platform, loading and unloading. */
  | 'loading';

/**
 * Cargo aboard: `n` units of `cargo` that set off from station `src` on day `day`, bound for
 * station `dest`. `hop` is where this train takes them (the destination, or a transfer).
 */
export interface CargoPacket {
  cargo: CargoId;
  dest: number;
  src: number;
  n: number;
  day: number;
  hop?: number;
  /** Station this leg started at (for paying each leg); the origin if missing. */
  at?: number;
}

export type AirPhase = 'taxi' | 'gate' | 'hold' | 'takeoff' | 'flying' | 'holding' | 'landing';

/** An aircraft's position (x, y in tiles; z its altitude in world units) and what it is doing. */
export interface AirState {
  phase: AirPhase;
  x: number;
  y: number;
  z: number;
  heading: number;
  /** Station of the airport it is at (on the ground) or flying to. */
  airport: number;
  /** Points to move through (x, y, z), first is next. */
  legs: [number, number, number][];
  /** Gate it holds at its airport, if any. */
  gate?: number;
  /** Landing to visit the hangar (service or depot order). */
  toHangar?: boolean;
  /** Where a taxiing aircraft is going: a gate, the runway hold point, the hangar, or waiting for a gate. */
  goal?: 'gate' | 'hold' | 'hangar' | 'waitGate';
}

/** A ship's position (tile coordinates) and route. */
export interface ShipState {
  x: number;
  y: number;
  heading: number;
  /** Tiles still to sail through, next first; the last is where it is going. */
  path: number[];
  /** Ticks left waiting in a lock (or for one to free up). */
  lockWait?: number;
  /** What the end of the path is: a dock's water tile, a buoy, or a depot. */
  goal?: 'dock' | 'buoy' | 'depot';
  /** Ticks to wait before trying to find a route again. */
  retry?: number;
  /** Waterways version the route was checked against. */
  ver?: number;
}

/**
 * A number naming a network version and a target (`code` from `targetCode`), compared each tick
 * to see whether a vehicle's route is still current.
 */
export const routeKey = (version: number, code: number) => version * 0x400000 + code;

/** The target of a vehicle's current order as a number: depot 3, station id*4+1, waypoint id*4+2; -1 if none. */
export function targetCode(t: Train): number {
  if (t.toDepot || t.serviceTrip) return 3;
  const o = t.orders[t.orderIndex];
  if (!o) return -1;
  if (o.kind === 'station') return o.station * 4 + 1;
  if (o.kind === 'waypoint') return o.waypoint * 4 + 2;
  return o.kind === 'depot' ? 3 : -1;
}

/** Is this a train (not a road vehicle or aircraft)? */
export const isRailVehicle = (t: { mode?: string }) => !t.mode || t.mode === 'rail';

export interface TrainUnit {
  type: string;
  /** Cargo a refittable wagon carries (default: its first cargo). */
  cargo?: CargoId;
}

export interface Train {
  id: number;
  /** Rail (default), road (a bus or truck), air (an aircraft) or water (a ship). */
  mode?: 'rail' | 'road' | 'air' | 'water';
  /** Aircraft only: where it is and what it is doing. */
  air?: AirState;
  /** Ships only: where it is and where it is sailing. */
  ship?: ShipState;
  owner: number;
  name: string;
  units: TrainUnit[];
  /** The line it runs on; its orders are the line's. */
  line?: number;
  status: TrainStatus;
  /** Depot tile while parked; -1 otherwise. */
  depot: number;
  /** Occupied segments, head first. */
  path: number[];
  /** Distance (tiles) the head has travelled along path[0]. */
  pos: number;
  /** km/h */
  speed: number;
  /** Its line's orders (the same list on the server); empty without a line. */
  orders: Order[];
  orderIndex: number;
  /** Heading for the nearest depot (player "send to depot"). */
  toDepot: boolean;
  /** Planned segments beyond the head. */
  route: number[];
  /** What the current route was planned for (see `routeKey`); -1 = nothing. */
  routeFor: number;
  /** Earliest tick to retry planning after a failure. */
  replanAt: number;
  /** Ticks left at the current platform. */
  loadTicks: number;
  cargo: CargoPacket[];
  builtDays: number;
  value: number;
  profitThisYear: number;
  profitLastYear: number;
  /** Station of the last stop (for "last visited" UI and cargo bookkeeping). */
  lastStation: number;
  /** Passed a path signal (and no block signal since): may only enter pieces reserved for it. */
  pbs?: boolean;
  /** Tick it left its previous order (timetable). */
  departedAt?: number;
  /** Days late (negative: early) at its last timetabled order. */
  lateness?: number;
  /** Record travel times into the timetable as it runs. */
  autofill?: boolean;
  /** Day of the last service at a depot. */
  lastService?: number;
  /** 0..1, drops between services (breakdowns). */
  reliability?: number;
  /** Ticks left standing still after a breakdown. */
  brokenDown?: number;
  /** Breakdowns so far. */
  breakdowns?: number;
  /** Detouring to the nearest depot for a service due (then carries on with its orders). */
  serviceTrip?: boolean;
  /** Days between services (default SERVICE_INTERVAL_DAYS). */
  serviceInterval?: number;
  /** Already told the owner it outlived its design life. */
  oldWarned?: boolean;
  /** Ticks left coasting without brakes (a brake failure: signals are passed at danger). */
  brakeFail?: number;
  /** Tick it last ran past a red signal (during a brake failure), for accident reports. */
  ranRedAt?: number;
  /** Tick it first failed to find a route to its current order (cleared once it finds one). */
  noRouteSince?: number;
  /** Has gone too long without a route to its next stop; its owner has been told. */
  lost?: boolean;
}

export interface TrainStats {
  /** tiles */
  length: number;
  /** tonnes (empty) */
  mass: number;
  /** kW */
  power: number;
  /** kN */
  tractiveEffort: number;
  /** km/h */
  maxSpeed: number;
  /** Total capacity, all cargoes. */
  capacity: number;
  /** Capacity by cargo. */
  capacities: Partial<Record<CargoId, number>>;
  runningCost: number;
  /** Has an electric engine: needs electrified track. */
  electric: boolean;
}

/** Visual gap between coupled units (tiles). */
export const UNIT_GAP = 0.03;
/** Mass (tonnes) of the cargo aboard. */
export const cargoMass = (t: { cargo: readonly CargoPacket[] }) => t.cargo.reduce((s, p) => s + p.n * (CARGOS[p.cargo]?.weight ?? 1), 0);

export function trainStats(units: readonly TrainUnit[]): TrainStats {
  let length = 0, mass = 0, power = 0, te = 0, capacity = 0, running = 0;
  let maxSpeed = Infinity;
  let electric = false;
  const capacities: Partial<Record<CargoId, number>> = {};
  for (const u of units) {
    const v = railVehicle(u.type);
    if (!v) continue;
    electric ||= v.traction === 'electric';
    const c = unitCargo(u);
    if (c && v.capacity > 0) capacities[c] = (capacities[c] ?? 0) + v.capacity;
    length += v.length / 16 + UNIT_GAP;
    mass += v.mass;
    power += v.power;
    te += v.tractiveEffort;
    capacity += v.capacity;
    running += v.runningCost;
    maxSpeed = Math.min(maxSpeed, v.maxSpeed);
  }
  return {
    length: Math.max(0.1, length - UNIT_GAP),
    mass,
    power,
    tractiveEffort: te,
    maxSpeed: maxSpeed === Infinity ? 0 : maxSpeed,
    capacity,
    capacities,
    runningCost: running,
    electric,
  };
}

export const cargoCount = (t: { cargo: readonly CargoPacket[] }) => t.cargo.reduce((s, p) => s + p.n, 0);

/** The client-visible part of a train (no route internals). */
export type TrainInfo = Omit<Train, 'route' | 'routeFor' | 'replanAt' | 'path' | 'pos'>;

export function trainInfo(t: Train): TrainInfo {
  const { route: _r, routeFor: _f, replanAt: _p, path: _path, pos: _pos, ...info } = t;
  return info;
}

/** Compact motion state streamed to clients at ~10 Hz. */
export interface TrainMotion {
  id: number;
  path: number[];
  pos: number;
  speed: number;
  /** Next few planned segments, so clients can extrapolate past the head segment. */
  ahead: number[];
  /** Aircraft: x, y (tiles), altitude (world units), heading (radians), speed (tiles per second), climb rate (altitude per second). */
  air?: [number, number, number, number, number, number];
  /** Ships: [x, y, water level (height units), heading, speed tiles/s]. */
  ship?: [number, number, number, number, number];
}
