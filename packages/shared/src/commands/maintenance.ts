import { railVehicle } from '../vehicles/catalog.ts';
import { fail, isInt, type CommandHandler } from './types.ts';

/** Per-train settings: how many days between depot services. */
export interface TrainSettingsCommand {
  type: 'trainSettings';
  id: number;
  serviceInterval: number;
}

/** Company vehicle policy: renew old trains, and replace one vehicle type with another (to: null removes the rule). */
export interface VehicleSettingsCommand {
  type: 'vehicleSettings';
  autorenew?: boolean;
  replace?: { from: string; to: string | null };
}

const noEffects = () => ({ dirtyChunks: new Set<number>() });
export const MIN_SERVICE_INTERVAL = 30;
export const MAX_SERVICE_INTERVAL = 800;

export const trainSettingsHandler: CommandHandler<TrainSettingsCommand> = {
  needsCompany: true,
  permission: 'operate',
  category: null,
  plan(state, ctx, cmd) {
    const t = isInt(cmd.id) ? state.trains.get(cmd.id) : undefined;
    if (!t || t.owner !== ctx.companyId) return fail('Not your train');
    if (!isInt(cmd.serviceInterval) || cmd.serviceInterval < MIN_SERVICE_INTERVAL || cmd.serviceInterval > MAX_SERVICE_INTERVAL) {
      return fail(`Service every ${MIN_SERVICE_INTERVAL}–${MAX_SERVICE_INTERVAL} days`);
    }
    return {
      ok: true,
      cost: 0,
      commit() {
        t.serviceInterval = cmd.serviceInterval;
        state.dirtyTrains.add(t.id);
        return noEffects();
      },
    };
  },
};

export const vehicleSettingsHandler: CommandHandler<VehicleSettingsCommand> = {
  needsCompany: true,
  category: null,
  plan(state, ctx, cmd) {
    const c = state.companies.get(ctx.companyId!)!;
    const rule = cmd.replace;
    if (rule) {
      const from = typeof rule.from === 'string' ? railVehicle(rule.from) : undefined;
      if (!from) return fail('Unknown vehicle');
      if (rule.to !== null) {
        const to = typeof rule.to === 'string' ? railVehicle(rule.to) : undefined;
        if (!to) return fail('Unknown vehicle');
        if (to.mode !== from.mode) return fail('Replace road vehicles with road vehicles, and rail with rail');
        if (to.kind !== from.kind) return fail(from.kind === 'loco' ? 'Replace engines with engines' : 'Replace wagons with wagons');
        if (to.id === from.id) return fail('Pick a different vehicle');
      }
    }
    if (cmd.autorenew !== undefined && typeof cmd.autorenew !== 'boolean') return fail('Invalid setting');
    return {
      ok: true,
      cost: 0,
      commit() {
        if (cmd.autorenew !== undefined) c.autorenew = cmd.autorenew;
        if (rule) {
          const next = { ...c.replace };
          if (rule.to === null) delete next[rule.from];
          else next[rule.from] = rule.to;
          c.replace = next;
        }
        return noEffects();
      },
    };
  },
};
