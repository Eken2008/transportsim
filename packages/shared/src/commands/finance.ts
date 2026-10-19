import { LOAN_STEP } from '../economy/finance.ts';
import { fail, isInt, type CommandHandler } from './types.ts';

/** Borrow or repay `amount` (a multiple of LOAN_STEP). */
export interface LoanCommand {
  type: 'loan';
  action: 'borrow' | 'repay';
  amount: number;
}

export const loanHandler: CommandHandler<LoanCommand> = {
  needsCompany: true,
  category: null,
  plan(state, ctx, cmd) {
    const c = state.companies.get(ctx.companyId!)!;
    const { amount } = cmd;
    if (!isInt(amount) || amount <= 0 || amount % LOAN_STEP !== 0) return fail('Invalid amount');
    const noEffects = () => ({ dirtyChunks: new Set<number>() });
    if (cmd.action === 'borrow') {
      const max = state.maxLoan();
      if (c.loan + amount > max) return fail(`The bank lends at most £${max.toLocaleString('en-GB')}`);
      return { ok: true, cost: -amount, commit: () => ((c.loan += amount), noEffects()) };
    }
    if (cmd.action === 'repay') {
      if (amount > c.loan) return fail('That is more than you owe');
      return { ok: true, cost: amount, commit: () => ((c.loan -= amount), noEffects()) };
    }
    return fail('Unknown action');
  },
};
