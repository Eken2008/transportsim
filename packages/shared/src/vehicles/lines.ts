import type { GameState } from '../sim/state.ts';
import { stationHas } from '../rail/station.ts';
import { stationDocks } from '../water/waterways.ts';
import { isBus } from './catalog.ts';
import { settleOrders } from './orders.ts';
import { resetSpacing } from './spacing.ts';
import { JUMP_CONDITIONS, type Order, type Train } from './train.ts';

/** How a vehicle (and a line) gets around. */
export type VehicleMode = 'rail' | 'road' | 'air' | 'water';
export const VEHICLE_MODES: readonly VehicleMode[] = ['rail', 'road', 'air', 'water'];
export const vehicleMode = (t: { mode?: VehicleMode }): VehicleMode => t.mode ?? 'rail';

/**
 * A line: the stops (orders) that every vehicle on it serves in turn. Vehicles are assigned
 * to a line and follow its orders; editing the line changes them for all its vehicles.
 */
export interface Line {
  id: number;
  owner: number;
  name: string;
  /** The kind of vehicle that runs on it. */
  mode: VehicleMode;
  /** Index into LINE_COLORS. */
  color: number;
  orders: Order[];
  /** Even spacing: the station whose departures are spaced out (see vehicles/spacing.ts). */
  spacing?: number;
  /** Measured round trip (ticks), from the timing point back to it. */
  lap?: number;
  /** Tick the last vehicle left the timing point. */
  lastDeparture?: number;
  /** The latest gaps between departures from the timing point (days), oldest first. */
  gaps?: number[];
}

export const LINE_COLORS = [
  '#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4',
  '#42d4f4', '#f032e6', '#bfef45', '#fabed4', '#469990', '#9a6324',
] as const;

export const MAX_ORDERS = 32;
/** Lines a company may have. */
export const MAX_LINES = 1000;

const LINE_PREFIX: Record<VehicleMode, string> = { rail: 'Rail line', road: 'Road line', air: 'Air route', water: 'Sea route' };

/** A fresh name for a company's next line of this kind ("Rail line 3"). */
export function nextLineName(state: GameState, owner: number, mode: VehicleMode): string {
  const prefix = LINE_PREFIX[mode];
  const used = new Set([...state.lines.values()].filter((l) => l.owner === owner).map((l) => l.name));
  let n = 1;
  while (used.has(`${prefix} ${n}`)) n++;
  return `${prefix} ${n}`;
}

/** The vehicles assigned to a line. */
export function vehiclesOn(state: GameState, lineId: number): Train[] {
  return [...state.trains.values()].filter((t) => t.line === lineId);
}

/** A timetable duration in days (0.1 resolution, up to a year), or undefined. */
function days(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.min(365, Math.round(v * 10) / 10);
}

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);

/**
 * Validate untrusted orders for a line of `mode` run by `company`. Every vehicle in
 * `vehicles` must be able to serve each stop (buses need bus stops, trucks truck stops).
 */
export function parseOrders(state: GameState, company: number, mode: VehicleMode, input: unknown, vehicles: readonly Train[]): Order[] | string {
  if (!Array.isArray(input) || input.length > MAX_ORDERS) return `At most ${MAX_ORDERS} orders`;
  const orders: Order[] = [];
  const n = input.length;
  for (const o of input as Order[]) {
    const travel = days(o?.kind !== 'jump' ? o?.travel : undefined);
    if (o?.kind === 'station') {
      const st = isInt(o.station) ? state.stations.get(o.station) : undefined;
      if (!st) return 'Unknown station';
      if (!state.canUseStation(company, st)) return `${st.name} belongs to another company`;
      if (mode === 'air') {
        if (!st.airport) return `${st.name} has no airport`;
      } else if (mode === 'water') {
        if (stationDocks(state.map, st).length === 0) return `${st.name} has no dock`;
      } else if (mode === 'road') {
        if (!stationHas(state.map, st, 'bus') && !stationHas(state.map, st, 'truck')) return `${st.name} has no bus or truck stop`;
        for (const t of vehicles) {
          const kind = isBus(t.units[0]!) ? 'bus' : 'truck';
          if (!stationHas(state.map, st, kind)) return `${st.name} has no ${kind} stop for ${t.name}`;
        }
      } else if (!stationHas(state.map, st, 'rail')) {
        return `${st.name} has no platforms`;
      }
      orders.push({ kind: 'station', station: st.id, fullLoad: o.fullLoad === true || undefined, wait: days(o.wait), travel });
    } else if (o?.kind === 'waypoint') {
      if (mode === 'road' || mode === 'air') return 'Waypoints are for trains and ships';
      const wp = isInt(o.waypoint) ? state.waypoints.get(o.waypoint) : undefined;
      if (!wp) return 'Unknown waypoint';
      if (mode === 'water' ? !wp.buoy : wp.buoy) return mode === 'water' ? 'Ships steer by buoys' : 'Buoys are for ships';
      if (!wp.buoy && !state.accessFor(company).uses[wp.owner]) return `${wp.name} is on another company's track`;
      orders.push({ kind: 'waypoint', waypoint: wp.id, travel });
    } else if (o?.kind === 'depot') {
      orders.push({ kind: 'depot', travel });
    } else if (o?.kind === 'jump') {
      if (!isInt(o.to) || o.to < 0 || o.to >= n) return 'A jump must go to an order in the list';
      if (!JUMP_CONDITIONS.includes(o.cond)) return 'Invalid condition';
      const op = o.op === 'ge' ? 'ge' : 'lt';
      const value = typeof o.value === 'number' && Number.isFinite(o.value) ? Math.max(0, Math.min(1000, o.value)) : 0;
      orders.push({ kind: 'jump', to: o.to, cond: o.cond, op, value });
    } else {
      return 'Invalid order';
    }
  }
  if (orders.length > 0 && orders.every((o) => o.kind === 'jump')) return 'Add a station, waypoint or depot to jump to';
  return orders;
}

/** Give a vehicle new orders, carrying on to the same station if it is still among them. */
export function setVehicleOrders(state: GameState, t: Train, orders: Order[]): void {
  const current = t.orders[t.orderIndex];
  t.orders = orders;
  const same = current?.kind === 'station' ? orders.findIndex((o) => o.kind === 'station' && o.station === current.station) : -1;
  t.orderIndex = same >= 0 ? same : 0;
  settleOrders(state, t);
  t.routeFor = -1;
  state.dirtyTrains.add(t.id);
}

/** The stops of a list of orders, without timetable times (to see whether the route changed). */
const routeOf = (orders: readonly Order[]) =>
  orders.map((o) => (o.kind === 'station' ? `s${o.station}` : o.kind === 'waypoint' ? `w${o.waypoint}` : o.kind === 'jump' ? `j${o.to}${o.cond}${o.op}${o.value}` : 'd')).join();

/** Replace a line's orders; every vehicle on it follows the new ones. */
export function setLineOrders(state: GameState, line: Line, orders: Order[]): void {
  if (routeOf(orders) !== routeOf(line.orders)) {
    // A new route takes a different time round, and the timing point may be gone.
    resetSpacing(state, line);
    if (line.spacing !== undefined && !orders.some((o) => o.kind === 'station' && o.station === line.spacing)) line.spacing = undefined;
  }
  line.orders = orders;
  state.dirtyLines.add(line.id);
  for (const t of state.trains.values()) if (t.line === line.id) setVehicleOrders(state, t, orders);
}

/** Put a vehicle on a line (or take it off, with null): it follows the line's orders. */
export function assignVehicle(state: GameState, t: Train, line: Line | null): void {
  t.line = line?.id;
  t.lapStart = undefined;
  t.spacingHeld = undefined;
  setVehicleOrders(state, t, line ? line.orders : []);
}

/** A new line, registered with the game. */
export function addLine(state: GameState, owner: number, mode: VehicleMode, orders: Order[] = [], name?: string): Line {
  const used = new Set([...state.lines.values()].filter((l) => l.owner === owner && l.mode === mode).map((l) => l.color));
  let color = state.lines.size % LINE_COLORS.length;
  for (let k = 0; k < LINE_COLORS.length; k++) {
    if (!used.has(k)) {
      color = k;
      break;
    }
  }
  const line: Line = { id: state.nextLineId++, owner, name: name ?? nextLineName(state, owner, mode), mode, color, orders };
  state.lines.set(line.id, line);
  state.dirtyLines.add(line.id);
  return line;
}

/** Remove a line; its vehicles are left without orders. */
export function deleteLine(state: GameState, id: number): void {
  for (const t of state.trains.values()) if (t.line === id) assignVehicle(state, t, null);
  state.lines.delete(id);
  state.dirtyLines.delete(id);
  state.removedLines.add(id);
}
