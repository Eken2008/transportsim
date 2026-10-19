import { resaleValue } from '../economy/finance.ts';
import { isElectrified } from '../rail/railTypes.ts';
import { ymdFromDays } from '../sim/date.ts';
import { TileType } from '../world/constants.ts';
import { isAvailable, railVehicle } from '../vehicles/catalog.ts';
import { JUMP_CONDITIONS, trainStats, type Order, type Train } from '../vehicles/train.ts';
import { advanceOrder, settleOrders } from '../vehicles/orders.ts';

/** A timetable duration in days (0.1 resolution, up to a year), or undefined. */
function days(v: unknown): number | undefined {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return undefined;
  return Math.min(365, Math.round(v * 10) / 10);
}
import { fail, isInt, type CommandHandler, type PlanResult } from './types.ts';

export const MAX_UNITS = 24;
export const MAX_TRAIN_LENGTH = 16; // tiles
export const MAX_ORDERS = 32;

/** Buy a train in a depot: `units` lists vehicle type ids front to back (first is the engine). */
export interface BuyTrainCommand {
  type: 'buyTrain';
  depot: number;
  units: string[];
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
  units: string[];
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
    const { depot, units } = cmd;
    const map = state.map;
    if (!isInt(depot) || depot < 0 || depot >= map.layers.type.length) return fail('Invalid depot');
    if (map.layers.type[depot] !== TileType.Depot || map.layers.owner[depot] !== ctx.companyId) return fail('Not your depot');
    if (!Array.isArray(units) || units.length === 0 || units.length > MAX_UNITS) return fail(`A train has 1–${MAX_UNITS} vehicles`);
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
    const stats = trainStats(units.map((type) => ({ type })));
    if (stats.length > MAX_TRAIN_LENGTH) return fail(`Trains can be at most ${MAX_TRAIN_LENGTH} tiles long`);
    const total = state.cost(cost);
    return {
      ok: true,
      cost: total,
      commit() {
        const n = [...state.trains.values()].filter((t) => t.owner === ctx.companyId).length + 1;
        const t: Train = {
          id: state.nextTrainId++,
          owner: ctx.companyId!,
          name: `Train ${n}`,
          units: units.map((type) => ({ type })),
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
    const rail = state.rail;
    switch (cmd.action) {
      case 'start': {
        const err = rail.canStart(t);
        if (err) return fail(err);
        return { ok: true, cost: 0, commit: () => (rail.start(t), done(), noEffects()) };
      }
      case 'stop':
        if (t.status === 'depot' || t.status === 'stopped') return fail('Already stopped');
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
            rail.removeFromWorld(t);
            state.trains.delete(t.id);
            state.dirtyTrains.delete(t.id);
            state.removedTrains.add(t.id);
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
        orders.push({ kind: 'station', station: st.id, fullLoad: o.fullLoad === true || undefined, wait: days(o.wait), travel });
      } else if (o?.kind === 'waypoint') {
        const wp = isInt(o.waypoint) ? state.waypoints.get(o.waypoint) : undefined;
        if (!wp) return fail('Unknown waypoint');
        if (!state.accessFor(ctx.companyId!).uses[wp.owner]) return fail(`${wp.name} is on another company's track`);
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
    const units = cmd.units;
    if (!Array.isArray(units) || units.length === 0 || units.length > MAX_UNITS) return fail(`A train has 1–${MAX_UNITS} vehicles`);
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
    if (trainStats(units.map((type) => ({ type }))).length > MAX_TRAIN_LENGTH) return fail(`Trains can be at most ${MAX_TRAIN_LENGTH} tiles long`);
    if (units.some((id) => railVehicle(id)?.traction === 'electric') && !isElectrified(state.map.layers.railType[t.depot]!)) {
      return fail('Electric engines need an electrified depot');
    }
    const age = (state.date - t.builtDays) / 365;
    const resale = Math.max(0.2, 0.85 - age * 0.04);
    let removed = 0;
    for (const [id, n] of old) removed += (railVehicle(id)?.cost ?? 0) * n;
    const cost = state.cost(added) - Math.round(state.cost(removed) * resale);
    const same = units.length === t.units.length && units.every((u, i) => u === t.units[i]!.type);
    if (same) return fail('No changes');
    return {
      ok: true,
      cost,
      commit() {
        t.units = units.map((type) => ({ type }));
        t.value = Math.max(0, t.value + state.cost(added) - state.cost(removed));
        t.cargo = [];
        state.rail.invalidateStats(t);
        state.dirtyTrains.add(t.id);
        return noEffects();
      },
    };
  },
};
