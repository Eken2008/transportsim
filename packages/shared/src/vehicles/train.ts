import { railVehicle } from './catalog.ts';

export type Order =
  | { kind: 'station'; station: number; fullLoad?: boolean }
  | { kind: 'depot' };

export type TrainStatus =
  /** Parked inside a depot. */
  | 'depot'
  /** Driving (including waiting for a free path or a signal). */
  | 'running'
  /** Stopped on the line by the player. */
  | 'stopped'
  /** Standing at a platform, loading and unloading. */
  | 'loading';

/** Passengers aboard: `n` travelling from station `src` to station `dest`, boarded on day `day`. */
export interface CargoPacket {
  dest: number;
  src: number;
  n: number;
  day: number;
}

export interface TrainUnit {
  type: string;
}

export interface Train {
  id: number;
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
  capacity: number;
  runningCost: number;
}

/** Visual gap between coupled units (tiles). */
export const UNIT_GAP = 0.03;
/** Passenger mass, tonnes. */
export const PASSENGER_MASS = 0.08;

export function trainStats(units: readonly TrainUnit[]): TrainStats {
  let length = 0, mass = 0, power = 0, te = 0, capacity = 0, running = 0;
  let maxSpeed = Infinity;
  for (const u of units) {
    const v = railVehicle(u.type);
    if (!v) continue;
    length += v.length / 16 + UNIT_GAP;
    mass += v.mass;
    power += v.power;
    te += v.tractiveEffort;
    capacity += v.cargo === 'passengers' ? v.capacity : 0;
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
    runningCost: running,
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
