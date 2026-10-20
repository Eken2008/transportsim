import { hqSite, placeHeadquarters } from '../company/headquarters.ts';
import { stationName } from '../rail/station.ts';
import { Foundation } from '../world/foundation.ts';
import { fail, isInt, type CommandHandler, type PlanResult } from './types.ts';

/** Build the company's 2×2 headquarters with the north-west corner at (x, y); if it has some, move them there. */
export interface BuildHeadquartersCommand {
  type: 'buildHeadquarters';
  x: number;
  y: number;
}

export const buildHeadquartersHandler: CommandHandler<BuildHeadquartersCommand> = {
  needsCompany: true,
  plan(state, ctx, cmd): PlanResult {
    const { x, y } = cmd;
    if (!isInt(x) || !isInt(y)) return fail('Invalid headquarters');
    const c = state.companies.get(ctx.companyId!)!;
    const site = hqSite(state, c.id, x, y);
    if (typeof site === 'string') return fail(site);
    const moving = c.hq !== undefined;
    return {
      ok: true,
      cost: state.cost(site.cost),
      note: moving ? 'Moves your headquarters here' : undefined,
      foundations: new Map([...site.levelled].map((i) => [i, Foundation.Level])),
      commit() {
        const dirtyChunks = new Set<number>();
        placeHeadquarters(state, c, site, dirtyChunks);
        const town = stationName(x, y, state.towns.values(), []).name;
        const where = state.towns.size ? ` near ${town}` : '';
        state.addNews('company', moving ? `${c.name} moves its headquarters${where}` : `${c.name} builds its headquarters${where}`, {
          company: c.id,
          tile: site.tiles[0],
        });
        return { dirtyChunks };
      },
    };
  },
};
