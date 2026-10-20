import { applyTownAction, isTownAction, townActionCost, townActionRefusal, type TownAction } from '../town/actions.ts';
import { fail, isInt, type CommandHandler } from './types.ts';

/** Pay a town council for an action (advertising, road reconstruction, a statue, ...). */
export interface TownActionCommand {
  type: 'townAction';
  town: number;
  action: TownAction;
}

export const townActionHandler: CommandHandler<TownActionCommand> = {
  needsCompany: true,
  category: 'councils',
  plan(state, ctx, cmd) {
    const town = isInt(cmd.town) ? state.towns.get(cmd.town) : undefined;
    if (!town) return fail('No such town');
    if (!isTownAction(cmd.action)) return fail('Unknown town action');
    const company = ctx.companyId!;
    const refusal = townActionRefusal(state, town, company, cmd.action);
    if (refusal) return fail(refusal);
    return {
      ok: true,
      cost: townActionCost(state, cmd.action),
      commit() {
        const dirtyChunks = new Set<number>();
        applyTownAction(state, town, company, cmd.action, dirtyChunks);
        return { dirtyChunks };
      },
    };
  },
};
