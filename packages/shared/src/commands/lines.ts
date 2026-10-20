import {
  LINE_COLORS,
  MAX_LINES,
  VEHICLE_MODES,
  addLine,
  assignVehicle,
  deleteLine,
  parseOrders,
  setLineOrders,
  vehicleMode,
  vehiclesOn,
  type VehicleMode,
} from '../vehicles/lines.ts';
import type { Order, Train } from '../vehicles/train.ts';
import { fail, isInt, type CommandHandler, type PlanResult } from './types.ts';

/** Start a new line, optionally with orders, and optionally put a vehicle on it straight away. */
export interface CreateLineCommand {
  type: 'createLine';
  mode: VehicleMode;
  name?: string;
  orders?: Order[];
  vehicle?: number;
}

/** Change a line's orders, name or colour. */
export interface EditLineCommand {
  type: 'editLine';
  id: number;
  orders?: Order[];
  name?: string;
  color?: number;
}

/** Remove a line; vehicles on it are left without orders. */
export interface DeleteLineCommand {
  type: 'deleteLine';
  id: number;
}

/** Put a vehicle on a line (or take it off one, with null). */
export interface AssignLineCommand {
  type: 'assignLine';
  vehicle: number;
  line: number | null;
}

/** Shorthand: set the orders of a vehicle's line, starting a line for it if it has none. */
export interface SetOrdersCommand {
  type: 'setOrders';
  id: number;
  orders: Order[];
}

const noEffects = () => ({ dirtyChunks: new Set<number>() });

function lineName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = input.trim().slice(0, 40);
  return name || null;
}

export const createLineHandler: CommandHandler<CreateLineCommand> = {
  needsCompany: true,
  permission: 'operate',
  plan(state, ctx, cmd): PlanResult {
    const company = ctx.companyId!;
    if (!VEHICLE_MODES.includes(cmd.mode)) return fail('Invalid line type');
    if ([...state.lines.values()].filter((l) => l.owner === company).length >= MAX_LINES) return fail(`At most ${MAX_LINES} lines`);
    let vehicle: Train | undefined;
    if (cmd.vehicle !== undefined) {
      vehicle = isInt(cmd.vehicle) ? state.trains.get(cmd.vehicle) : undefined;
      if (!vehicle || vehicle.owner !== company) return fail('Not your vehicle');
      if (vehicleMode(vehicle) !== cmd.mode) return fail('That vehicle runs on another kind of line');
    }
    const orders = parseOrders(state, company, cmd.mode, cmd.orders ?? [], vehicle ? [vehicle] : []);
    if (typeof orders === 'string') return fail(orders);
    const name = cmd.name === undefined ? undefined : lineName(cmd.name);
    if (name === null) return fail('Give the line a name');
    return {
      ok: true,
      cost: 0,
      commit() {
        const line = addLine(state, company, cmd.mode, orders, name);
        if (vehicle) assignVehicle(state, vehicle, line);
        return noEffects();
      },
    };
  },
};

export const editLineHandler: CommandHandler<EditLineCommand> = {
  needsCompany: true,
  permission: 'operate',
  plan(state, ctx, cmd): PlanResult {
    const line = isInt(cmd.id) ? state.lines.get(cmd.id) : undefined;
    if (!line || line.owner !== ctx.companyId) return fail('Not your line');
    let orders: Order[] | undefined;
    if (cmd.orders !== undefined) {
      const parsed = parseOrders(state, line.owner, line.mode, cmd.orders, vehiclesOn(state, line.id));
      if (typeof parsed === 'string') return fail(parsed);
      orders = parsed;
    }
    const name = cmd.name === undefined ? undefined : lineName(cmd.name);
    if (name === null) return fail('Give the line a name');
    if (cmd.color !== undefined && (!isInt(cmd.color) || cmd.color < 0 || cmd.color >= LINE_COLORS.length)) return fail('Invalid colour');
    return {
      ok: true,
      cost: 0,
      commit() {
        if (name !== undefined) line.name = name;
        if (cmd.color !== undefined) line.color = cmd.color;
        state.dirtyLines.add(line.id);
        if (orders) setLineOrders(state, line, orders);
        return noEffects();
      },
    };
  },
};

export const deleteLineHandler: CommandHandler<DeleteLineCommand> = {
  needsCompany: true,
  permission: 'operate',
  plan(state, ctx, cmd): PlanResult {
    const line = isInt(cmd.id) ? state.lines.get(cmd.id) : undefined;
    if (!line || line.owner !== ctx.companyId) return fail('Not your line');
    return { ok: true, cost: 0, commit: () => (deleteLine(state, line.id), noEffects()) };
  },
};

export const assignLineHandler: CommandHandler<AssignLineCommand> = {
  needsCompany: true,
  permission: 'operate',
  plan(state, ctx, cmd): PlanResult {
    const t = isInt(cmd.vehicle) ? state.trains.get(cmd.vehicle) : undefined;
    if (!t || t.owner !== ctx.companyId) return fail('Not your vehicle');
    if (cmd.line === null) {
      if (t.line === undefined) return fail('It is not on a line');
      return { ok: true, cost: 0, commit: () => (assignVehicle(state, t, null), noEffects()) };
    }
    const line = isInt(cmd.line) ? state.lines.get(cmd.line) : undefined;
    if (!line || line.owner !== ctx.companyId) return fail('Not your line');
    if (line.mode !== vehicleMode(t)) return fail(`${t.name} can't run on ${line.name}`);
    if (t.line === line.id) return fail(`${t.name} is already on ${line.name}`);
    // The line's stops must suit this vehicle too (a truck needs truck stops).
    const check = parseOrders(state, line.owner, line.mode, line.orders, [t]);
    if (typeof check === 'string') return fail(check);
    return { ok: true, cost: 0, commit: () => (assignVehicle(state, t, line), noEffects()) };
  },
};

export const setOrdersHandler: CommandHandler<SetOrdersCommand> = {
  needsCompany: true,
  permission: 'operate',
  plan(state, ctx, cmd): PlanResult {
    const t = isInt(cmd.id) ? state.trains.get(cmd.id) : undefined;
    if (!t || t.owner !== ctx.companyId) return fail('Not your train');
    const line = t.line !== undefined ? state.lines.get(t.line) : undefined;
    const mode = vehicleMode(t);
    const orders = parseOrders(state, t.owner, mode, cmd.orders, line ? vehiclesOn(state, line.id) : [t]);
    if (typeof orders === 'string') return fail(orders);
    return {
      ok: true,
      cost: 0,
      commit() {
        if (line) setLineOrders(state, line, orders);
        else assignVehicle(state, t, addLine(state, t.owner, mode, orders));
        return noEffects();
      },
    };
  },
};
