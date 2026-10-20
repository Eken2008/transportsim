import { resaleValue } from '../economy/finance.ts';
import { isElectrified } from '../rail/railTypes.ts';
import { ymdFromDays } from '../sim/date.ts';
import { TileType } from '../world/constants.ts';
import { isAvailable, isBus, railVehicle, unitCargo } from '../vehicles/catalog.ts';
import { isHeavy } from '../vehicles/airSystem.ts';
import { AirportRole } from '../air/airports.ts';
import { isRailVehicle, trainStats, type Train, type TrainUnit } from '../vehicles/train.ts';
import { advanceOrder } from '../vehicles/orders.ts';
import { assignVehicle, parseOrders, vehicleMode } from '../vehicles/lines.ts';
import { MAX_TRAIN_TILES } from '../vehicles/maintenance.ts';
import { fail, isInt, type CommandHandler, type PlanResult } from './types.ts';

export const MAX_UNITS = 24;
export const MAX_TRAIN_LENGTH = MAX_TRAIN_TILES; // tiles

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

/**
 * Buy a copy of a vehicle: the same vehicles and refits, on the same line, with the same
 * service interval. It is bought in `depot`, or else the depot the vehicle is in, or else the
 * company's nearest suitable depot, and waits there to be started.
 */
export interface CloneVehicleCommand {
  type: 'cloneVehicle';
  id: number;
  depot?: number;
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
          routeFor: -1,
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

export const cloneVehicleHandler: CommandHandler<CloneVehicleCommand> = {
  needsCompany: true,
  category: 'vehicles',
  plan(state, ctx, cmd): PlanResult {
    const t = isInt(cmd.id) ? state.trains.get(cmd.id) : undefined;
    if (!t || t.owner !== ctx.companyId) return fail('Not your vehicle');
    const units = t.units.map((u) => ({ ...u }));
    const buyIn = (depot: number) => buyTrainHandler.plan(state, ctx, { type: 'buyTrain', depot, units });
    let plan: PlanResult;
    if (cmd.depot !== undefined) plan = buyIn(cmd.depot);
    else if (t.status === 'depot' && t.depot >= 0) plan = buyIn(t.depot);
    else {
      // The nearest depot that can sell this vehicle (electric engines need power, heavy jets a large airport).
      const depot = state.nearestDepot(t, (d) => buyIn(d).ok);
      if (depot < 0) return fail(`${t.name} has no depot that can build a copy of it`);
      plan = buyIn(depot);
    }
    if (!plan.ok) return plan;
    const line = t.line !== undefined ? state.lines.get(t.line) : undefined;
    if (line && typeof parseOrders(state, t.owner, vehicleMode(t), line.orders, [t]) === 'string') return fail(`${line.name} no longer suits ${t.name}`);
    const commit = plan.commit;
    return {
      ok: true,
      cost: plan.cost,
      commit() {
        const effects = commit();
        const copy = state.trains.get(state.nextTrainId - 1)!;
        copy.serviceInterval = t.serviceInterval;
        if (line) assignVehicle(state, copy, line);
        return effects;
      },
    };
  },
};
