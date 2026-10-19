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

export interface TrainUnit {
  type: string;
  /** Cargo a refittable wagon carries (default: its first cargo). */
  cargo?: CargoId;
}

export interface Train {
  id: number;
  /** Rail (default) or road: a bus or truck, moved by the road system. */
  mode?: 'rail' | 'road';
  owner: number;
  name: string;
  units: TrainUnit[];
  status: TrainStatus;
  /** Depot tile while parked; -1 otherwise. */
  depot: number;
  /** Occupied segments, head first. */
  path: number[];
  /** Distance (tiles) the head has travelled along path[0]. */
  pos: number;
  /** km/h */
  speed: number;
  orders: Order[];
  orderIndex: number;
  /** Heading for the nearest depot (player "send to depot"). */
  toDepot: boolean;
  /** Planned segments beyond the head. */
  route: number[];
  /** What the current route was planned for: `${trackVersion}:${target}`. */
  routeFor: string;
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
}
