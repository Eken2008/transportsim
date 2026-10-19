import { resaleValue } from '../economy/finance.ts';
import { isElectrified } from '../rail/railTypes.ts';
import { ymdFromDays } from '../sim/date.ts';
import { TileType } from '../world/constants.ts';
import { isAvailable, isBus, railVehicle, unitCargo } from '../vehicles/catalog.ts';
import { roadStationOk } from '../vehicles/roadSystem.ts';
import { isHeavy } from '../vehicles/airSystem.ts';
import { AirportRole } from '../air/airports.ts';
import { stationDocks } from '../water/waterways.ts';
import { stationHas } from '../rail/station.ts';
import { JUMP_CONDITIONS, isRailVehicle, trainStats, type Order, type Train, type TrainUnit } from '../vehicles/train.ts';
import { advanceOrder, settleOrders } from '../vehicles/orders.ts';
import { MAX_TRAIN_TILES } from '../vehicles/maintenance.ts';

/** A timetable duration in days (0.1 resolution, up to a year), or undefined. */
function days(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.min(365, Math.round(v * 10) / 10);
}
import { fail, isInt, type CommandHandler, type PlanResult } from './types.ts';

export const MAX_UNITS = 24;
export const MAX_TRAIN_LENGTH = MAX_TRAIN_TILES; // tiles
export const MAX_ORDERS = 32;

/** A unit in a command: a vehicle type id, or a type with the cargo a wagon is refitted to. */
export type UnitSpec = string | TrainUnit;

/** Buy a train in a depot: `units` lists vehicles front to back (first is the engine). */
export interface BuyTrainCommand {
  type: 'buyTrain';
  depot: number;
  units: UnitSpec[];
}

/** Validate unit specs; refits must be cargoes the wagon can carry. */
export function parseUnits(input: unknown): TrainUnit[] | string {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_UNITS) return `A train has 1–${MAX_UNITS} vehicles`;
  const out: TrainUnit[] = [];
  for (const u of input) {
    const type = typeof u === 'string' ? u : u && typeof u === 'object' ? (u as TrainUnit).type : undefined;
    const v = typeof type === 'string' ? railVehicle(type) : undefined;
    if (!v) return 'Unknown vehicle';
    const cargo = typeof u === 'object' ? (u as TrainUnit).cargo : undefined;
    if (cargo !== undefined && !v.cargoes?.includes(cargo)) return `${v.name} can't carry that`;
    out.push(cargo && cargo !== v.cargoes?.[0] ? { type: v.id, cargo } : { type: v.id });
  }
  return out;
}

export type TrainActionKind = 'start' | 'stop' | 'toDepot' | 'reverse' | 'sell' | 'skip' | 'autofill';

export interface TrainActionCommand {
  type: 'trainAction';
  id: number;
  action: TrainActionKind;
}

/**
 * Rearrange, add or remove vehicles of a train parked in a depot. `units` is the complete new
 * consist front to back; vehicles not in the old consist are bought, missing ones are sold.
 */
export interface EditConsistCommand {
  type: 'editConsist';
  id: number;
  units: UnitSpec[];
}

export interface SetOrdersCommand {
  type: 'setOrders';
  id: number;
  orders: Order[];
}

const noEffects = () => ({ dirtyChunks: new Set<number>() });

export const buyTrainHandler: CommandHandler<BuyTrainCommand> = {
  needsCompany: true,
  category: 'vehicles',
  plan(state, ctx, cmd): PlanResult {
    const { depot } = cmd;
    const map = state.map;
    if (!isInt(depot) || depot < 0 || depot >= map.layers.type.length) return fail('Invalid depot');
    const depotType = map.layers.type[depot];
    const hangar = depotType === TileType.Airport && map.layers.track[depot] === AirportRole.Hangar;
    const shipyard = depotType === TileType.ShipDepot;
    if ((depotType !== TileType.Depot && depotType !== TileType.RoadDepot && !hangar && !shipyard) || map.layers.owner[depot] !== ctx.companyId) return fail('Not your depot');
    const road = depotType === TileType.RoadDepot;
    const mode: 'rail' | 'road' | 'air' | 'water' = road ? 'road' : hangar ? 'air' : shipyard ? 'water' : 'rail';
    const parsed = parseUnits(cmd.units);
    if (typeof parsed === 'string') return fail(parsed);
    if (parsed.some((u) => (railVehicle(u.type)!.mode ?? 'rail') !== mode)) {
      return fail(road ? 'Road depots sell road vehicles' : hangar ? 'Hangars sell aircraft' : shipyard ? 'Ship depots sell ships' : 'Train depots sell rail vehicles');
    }
    if (mode !== 'rail' && parsed.length !== 1) return fail(road ? 'A road vehicle is a single vehicle' : shipyard ? 'A ship is a single vehicle' : 'An aircraft is a single vehicle');
    if (hangar && isHeavy(parsed[0]!.type) && state.stations.get(map.layers.data[depot]!)?.airport?.kind !== 'large') {
      return fail(`The ${railVehicle(parsed[0]!.type)!.name} needs a large airport`);
    }
    const units = parsed.map((u) => u.type);
    const year = ymdFromDays(state.date).year;
    let cost = 0;
    for (const [k, id] of units.entries()) {
      const v = typeof id === 'string' ? railVehicle(id) : undefined;
      if (!v) return fail('Unknown vehicle');
      if (!isAvailable(v, year, state.settings.timeline)) return fail(`${v.name} is not available in ${year}`);
      if (k === 0 && v.kind !== 'loco') return fail('A train needs an engine at the front');
      cost += v.cost;
    }
    if (units.some((id) => railVehicle(id)?.traction === 'electric') && !isElectrified(map.layers.railType[depot]!)) {
      return fail('Electric engines need an electrified depot');
    }
    const stats = trainStats(parsed);
    if (stats.length > MAX_TRAIN_LENGTH) return fail(`Trains can be at most ${MAX_TRAIN_LENGTH} tiles long`);
    const total = state.cost(cost);
    return {
      ok: true,
      cost: total,
      commit() {
        const kind = road ? (isBus(parsed[0]!) ? 'Bus' : 'Truck') : hangar ? 'Aircraft' : shipyard ? 'Ship' : 'Train';
        const n = [...state.trains.values()].filter((t) => t.owner === ctx.companyId && t.name.startsWith(kind)).length + 1;
        const t: Train = {
          id: state.nextTrainId++,
          mode: mode === 'rail' ? undefined : mode,
          owner: ctx.companyId!,
          name: `${kind} ${n}`,
          units: parsed,
          status: 'depot',
          depot,
          path: [],
          pos: 0,
          speed: 0,
          orders: [],
          orderIndex: 0,
          toDepot: false,
          route: [],
          routeFor: '',
          replanAt: 0,
          loadTicks: 0,
          cargo: [],
          builtDays: state.date,
          value: total,
          profitThisYear: 0,
          profitLastYear: 0,
          lastStation: -1,
        };
        state.trains.set(t.id, t);
        state.dirtyTrains.add(t.id);
        return noEffects();
      },
    };
  },
};

export const trainActionHandler: CommandHandler<TrainActionCommand> = {
  needsCompany: true,
  permission: (cmd) => (cmd.action === 'sell' ? 'build' : 'operate'),
  category: 'vehicles',
  plan(state, ctx, cmd): PlanResult {
    const t = isInt(cmd.id) ? state.trains.get(cmd.id) : undefined;
    if (!t || t.owner !== ctx.companyId) return fail('Not your train');
    const rail = state.systemOf(t);
    switch (cmd.action) {
      case 'start': {
        const err = rail.canStart(t);
        if (err) return fail(err);
        return { ok: true, cost: 0, commit: () => (rail.start(t), done(), noEffects()) };
      }
      case 'stop':
        if (t.status === 'depot' || t.status === 'stopped') return fail('Already stopped');
        if (t.mode === 'air' && t.air && !['taxi', 'hold', 'gate'].includes(t.air.phase)) return fail("Aircraft can't stop in the air");
        return { ok: true, cost: 0, commit: () => (rail.stop(t), done(), noEffects()) };
      case 'toDepot':
        if (t.status === 'depot') return fail('Already in a depot');
        return { ok: true, cost: 0, commit: () => (rail.sendToDepot(t), done(), noEffects()) };
      case 'reverse':
        if (t.status === 'depot') return fail('The train is in a depot');
        if (t.speed > 0.5) return fail('Stop the train first');
        return { ok: true, cost: 0, commit: () => (rail.reverse(t), done(), noEffects()) };
      case 'skip':
        if (t.orders.length < 2) return fail('Nothing to skip to');
        return {
          ok: true,
          cost: 0,
          commit() {
            advanceOrder(state, t);
            if (t.status === 'loading') t.loadTicks = 0;
            done();
            return noEffects();
          },
        };
      case 'autofill':
        return { ok: true, cost: 0, commit: () => ((t.autofill = !t.autofill), done(), noEffects()) };
      case 'sell': {
        if (t.status !== 'depot') return fail('Trains can only be sold inside a depot');
        const refund = resaleValue(t.value, (state.date - t.builtDays) / 365);
        return {
          ok: true,
          cost: -refund,
          commit() {
            state.removeVehicle(t);
            return noEffects();
          },
        };
      }
      default:
        return fail('Unknown action');
    }
    function done() {
      state.dirtyTrains.add(t!.id);
    }
  },
};

export const setOrdersHandler: CommandHandler<SetOrdersCommand> = {
  needsCompany: true,
  permission: 'operate',
  plan(state, ctx, cmd): PlanResult {
    const t = isInt(cmd.id) ? state.trains.get(cmd.id) : undefined;
    if (!t || t.owner !== ctx.companyId) return fail('Not your train');
    if (!Array.isArray(cmd.orders) || cmd.orders.length > MAX_ORDERS) return fail(`At most ${MAX_ORDERS} orders`);
    const orders: Order[] = [];
    const n = cmd.orders.length;
    for (const o of cmd.orders) {
      const travel = days(o?.kind !== 'jump' ? o?.travel : undefined);
      if (o?.kind === 'station') {
        const st = isInt(o.station) ? state.stations.get(o.station) : undefined;
        if (!st) return fail('Unknown station');
        if (!state.canUseStation(ctx.companyId!, st)) return fail(`${st.name} belongs to another company`);
        if (t.mode === 'air') {
          if (!st.airport) return fail(`${st.name} has no airport`);
        } else if (t.mode === 'water') {
          if (stationDocks(state.map, st).length === 0) return fail(`${st.name} has no dock`);
        } else if (t.mode === 'road' ? !roadStationOk(state, t, st.id) : !stationHas(state.map, st, 'rail')) {
          return fail(t.mode === 'road' ? `${st.name} has no ${isBus(t.units[0]!) ? 'bus' : 'truck'} stop` : `${st.name} has no platforms`);
        }
        orders.push({ kind: 'station', station: st.id, fullLoad: o.fullLoad === true || undefined, wait: days(o.wait), travel });
      } else if (o?.kind === 'waypoint') {
        if (t.mode === 'road' || t.mode === 'air') return fail('Waypoints are for trains and ships');
        const wp = isInt(o.waypoint) ? state.waypoints.get(o.waypoint) : undefined;
        if (!wp) return fail('Unknown waypoint');
        if (t.mode === 'water' ? !wp.buoy : wp.buoy) return fail(t.mode === 'water' ? 'Ships steer by buoys' : 'Buoys are for ships');
        if (!wp.buoy && !state.accessFor(ctx.companyId!).uses[wp.owner]) return fail(`${wp.name} is on another company's track`);
        orders.push({ kind: 'waypoint', waypoint: wp.id, travel });
      } else if (o?.kind === 'depot') {
        orders.push({ kind: 'depot', travel });
      } else if (o?.kind === 'jump') {
        if (!isInt(o.to) || o.to < 0 || o.to >= n) return fail('A jump must go to an order in the list');
        if (!JUMP_CONDITIONS.includes(o.cond)) return fail('Invalid condition');
        const op = o.op === 'ge' ? 'ge' : 'lt';
        const value = typeof o.value === 'number' && Number.isFinite(o.value) ? Math.max(0, Math.min(1000, o.value)) : 0;
        orders.push({ kind: 'jump', to: o.to, cond: o.cond, op, value });
      } else {
        return fail('Invalid order');
      }
    }
    if (orders.length > 0 && orders.every((o) => o.kind === 'jump')) return fail('Add a station, waypoint or depot to jump to');
    return {
      ok: true,
      cost: 0,
      commit() {
        const current = t.orders[t.orderIndex];
        t.orders = orders;
        // Keep heading to the same station if it's still in the list.
        const same = current?.kind === 'station' ? orders.findIndex((o) => o.kind === 'station' && o.station === current.station) : -1;
        t.orderIndex = same >= 0 ? same : 0;
        settleOrders(state, t);
        t.routeFor = '';
        state.dirtyTrains.add(t.id);
        return noEffects();
      },
    };
  },
};

export const editConsistHandler: CommandHandler<EditConsistCommand> = {
  needsCompany: true,
  category: 'vehicles',
  plan(state, ctx, cmd): PlanResult {
    const t = isInt(cmd.id) ? state.trains.get(cmd.id) : undefined;
    if (!t || t.owner !== ctx.companyId) return fail('Not your train');
    if (t.status !== 'depot') return fail('Trains can only be changed inside a depot');
    const parsed = parseUnits(cmd.units);
    if (typeof parsed === 'string') return fail(parsed);
    if (!isRailVehicle(t) && (parsed.length !== 1 || parsed[0]!.type !== t.units[0]!.type)) return fail('Road vehicles, aircraft and ships can only be refitted');
    if (isRailVehicle(t) && parsed.some((u) => railVehicle(u.type)!.mode)) return fail('That is not a rail vehicle');
    const units = parsed.map((u) => u.type);
    const year = ymdFromDays(state.date).year;
    // Multiset difference between old and new consists.
    const old = new Map<string, number>();
    for (const u of t.units) old.set(u.type, (old.get(u.type) ?? 0) + 1);
    let added = 0;
    let engines = 0;
    for (const id of units) {
      const v = typeof id === 'string' ? railVehicle(id) : undefined;
      if (!v) return fail('Unknown vehicle');
      if (v.kind === 'loco') engines++;
      const have = old.get(id) ?? 0;
      if (have > 0) old.set(id, have - 1);
      else {
        if (!isAvailable(v, year, state.settings.timeline)) return fail(`${v.name} is not available in ${year}`);
        added += v.cost;
      }
    }
    if (engines === 0) return fail('A train needs at least one engine');
    if (trainStats(parsed).length > MAX_TRAIN_LENGTH) return fail(`Trains can be at most ${MAX_TRAIN_LENGTH} tiles long`);
    if (units.some((id) => railVehicle(id)?.traction === 'electric') && !isElectrified(state.map.layers.railType[t.depot]!)) {
      return fail('Electric engines need an electrified depot');
    }
    const age = (state.date - t.builtDays) / 365;
    const resale = Math.max(0.2, 0.85 - age * 0.04);
    let removed = 0;
    for (const [id, n] of old) removed += (railVehicle(id)?.cost ?? 0) * n;
    const cost = state.cost(added) - Math.round(state.cost(removed) * resale);
    const same = parsed.length === t.units.length && parsed.every((u, i) => u.type === t.units[i]!.type && unitCargo(u) === unitCargo(t.units[i]!));
    if (same) return fail('No changes');
    return {
      ok: true,
      cost,
      commit() {
        t.units = parsed;
        t.value = Math.max(0, t.value + state.cost(added) - state.cost(removed));
        t.cargo = [];
        state.rail.invalidateStats(t);
        state.dirtyTrains.add(t.id);
        return noEffects();
      },
    };
  },
};
