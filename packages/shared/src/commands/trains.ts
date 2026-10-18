import { ymdFromDays } from '../sim/date.ts';
import { TileType } from '../world/constants.ts';
import { isAvailable, railVehicle } from '../vehicles/catalog.ts';
import { trainStats, type Order, type Train } from '../vehicles/train.ts';
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

export type TrainActionKind = 'start' | 'stop' | 'toDepot' | 'reverse' | 'sell' | 'skip';

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
            t.orderIndex = (t.orderIndex + 1) % t.orders.length;
            t.routeFor = '';
            if (t.status === 'loading') t.loadTicks = 0;
            done();
            return noEffects();
          },
        };
      case 'sell': {
        if (t.status !== 'depot') return fail('Trains can only be sold inside a depot');
        const age = (state.date - t.builtDays) / 365;
        const refund = Math.round(t.value * Math.max(0.2, 0.85 - age * 0.04));
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
  plan(state, ctx, cmd): PlanResult {
    const t = isInt(cmd.id) ? state.trains.get(cmd.id) : undefined;
    if (!t || t.owner !== ctx.companyId) return fail('Not your train');
    if (!Array.isArray(cmd.orders) || cmd.orders.length > MAX_ORDERS) return fail(`At most ${MAX_ORDERS} orders`);
    const orders: Order[] = [];
    for (const o of cmd.orders) {
      if (o?.kind === 'station') {
        const st = isInt(o.station) ? state.stations.get(o.station) : undefined;
        if (!st) return fail('Unknown station');
        if (st.owner !== ctx.companyId) return fail(`${st.name} belongs to another company`);
        orders.push({ kind: 'station', station: st.id, fullLoad: o.fullLoad === true || undefined });
      } else if (o?.kind === 'depot') {
        orders.push({ kind: 'depot' });
      } else {
        return fail('Invalid order');
      }
    }
    return {
      ok: true,
      cost: 0,
      commit() {
        const current = t.orders[t.orderIndex];
        t.orders = orders;
        // Keep heading to the same station if it's still in the list.
        const same = current?.kind === 'station' ? orders.findIndex((o) => o.kind === 'station' && o.station === current.station) : -1;
        t.orderIndex = same >= 0 ? same : 0;
        t.routeFor = '';
        state.dirtyTrains.add(t.id);
        return noEffects();
      },
    };
  },
};

export const editConsistHandler: CommandHandler<EditConsistCommand> = {
  needsCompany: true,
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
