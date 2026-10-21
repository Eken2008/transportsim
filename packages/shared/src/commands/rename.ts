import { fail, isInt, type CommandHandler, type PlanResult } from './types.ts';

/** Longest name a station or vehicle can be given. */
export const MAX_NAME_LENGTH = 40;

/** Rename one of the company's stations. Station names are unique in the game. */
export interface RenameStationCommand {
  type: 'renameStation';
  id: number;
  name: string;
}

/** Rename one of the company's vehicles. Vehicle names are unique within the company. */
export interface RenameVehicleCommand {
  type: 'renameVehicle';
  id: number;
  name: string;
}

const noEffects = () => ({ dirtyChunks: new Set<number>() });

/** A name as typed: spaces collapsed and trimmed, cut to the longest allowed; null if empty. */
export function cleanName(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const name = input.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME_LENGTH).trim();
  return name || null;
}

export const renameStationHandler: CommandHandler<RenameStationCommand> = {
  needsCompany: true,
  permission: 'operate',
  plan(state, ctx, cmd): PlanResult {
    const st = isInt(cmd.id) ? state.stations.get(cmd.id) : undefined;
    if (!st || st.owner !== ctx.companyId) return fail('Not your station');
    const name = cleanName(cmd.name);
    if (!name) return fail('Give the station a name');
    if (name === st.name) return fail('That is already its name');
    const lower = name.toLowerCase();
    if ([...state.stations.values()].some((s) => s !== st && s.name.toLowerCase() === lower)) return fail(`There is already a station called ${name}`);
    return {
      ok: true,
      cost: 0,
      commit() {
        st.name = name;
        state.dirtyStations.add(st.id);
        return noEffects();
      },
    };
  },
};

export const renameVehicleHandler: CommandHandler<RenameVehicleCommand> = {
  needsCompany: true,
  permission: 'operate',
  plan(state, ctx, cmd): PlanResult {
    const t = isInt(cmd.id) ? state.trains.get(cmd.id) : undefined;
    if (!t || t.owner !== ctx.companyId) return fail('Not your vehicle');
    const name = cleanName(cmd.name);
    if (!name) return fail('Give the vehicle a name');
    if (name === t.name) return fail('That is already its name');
    const lower = name.toLowerCase();
    if ([...state.trains.values()].some((o) => o !== t && o.owner === t.owner && o.name.toLowerCase() === lower)) return fail(`You already have a vehicle called ${name}`);
    return {
      ok: true,
      cost: 0,
      commit() {
        t.name = name;
        state.dirtyTrains.add(t.id);
        return noEffects();
      },
    };
  },
};
