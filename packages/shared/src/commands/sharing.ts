import { MAX_AGREEMENTS, MAX_SHARING_FEE, type Agreement } from '../company/sharing.ts';
import type { GameState } from '../sim/state.ts';
import { fail, isInt, type CommandHandler, type PlanResult } from './types.ts';

/** Propose sharing track with another company: as `host` we let them use ours, as `guest` we ask to use theirs. */
export interface ProposeSharingCommand {
  type: 'proposeSharing';
  partner: number;
  role: 'host' | 'guest';
  stations: boolean;
  fee: number;
}

/** Accept or decline a proposal the other company made. */
export interface AnswerSharingCommand {
  type: 'answerSharing';
  id: number;
  accept: boolean;
}

/** Withdraw a proposal, or end an agreement in force (either side). */
export interface EndSharingCommand {
  type: 'endSharing';
  id: number;
}

const noEffects = () => ({ dirtyChunks: new Set<number>() });
const ok = (commit: () => void): PlanResult => ({ ok: true, cost: 0, commit: () => (commit(), noEffects()) });

const name = (state: GameState, id: number) => state.companies.get(id)?.name ?? 'A company';

function describe(state: GameState, a: Agreement): string {
  const what = a.stations ? 'track and stations' : 'track';
  const fee = a.fee > 0 ? ` for £${a.fee.toLocaleString('en-GB')} per train per day` : ' for free';
  return `${name(state, a.guest)} may now use ${name(state, a.host)}'s ${what}${fee}`;
}

function involving(state: GameState, company: number): number {
  let n = 0;
  for (const a of state.agreements.values()) if (a.host === company || a.guest === company) n++;
  return n;
}

export const proposeSharingHandler: CommandHandler<ProposeSharingCommand> = {
  needsCompany: true,
  category: null,
  plan(state, ctx, cmd) {
    const me = ctx.companyId!;
    if (!isInt(cmd.partner) || cmd.partner === me || !state.companies.has(cmd.partner)) return fail('Choose another company');
    if (cmd.role !== 'host' && cmd.role !== 'guest') return fail('Invalid role');
    if (!isInt(cmd.fee) || cmd.fee < 0 || cmd.fee > MAX_SHARING_FEE) return fail(`The fee is £0–${MAX_SHARING_FEE.toLocaleString('en-GB')}`);
    const host = cmd.role === 'host' ? me : cmd.partner;
    const guest = cmd.role === 'host' ? cmd.partner : me;
    const existing = state.agreementBetween(host, guest);
    if (existing) return fail(existing.status === 'active' ? 'That agreement is already in force' : 'That has already been proposed');
    if (involving(state, me) >= MAX_AGREEMENTS || involving(state, cmd.partner) >= MAX_AGREEMENTS) return fail('Too many agreements');
    return ok(() => {
      const id = state.nextAgreementId++;
      state.agreements.set(id, { id, host, guest, stations: cmd.stations === true, fee: cmd.fee, status: 'proposed', proposedBy: me, since: state.date });
    });
  },
};

export const answerSharingHandler: CommandHandler<AnswerSharingCommand> = {
  needsCompany: true,
  category: null,
  plan(state, ctx, cmd) {
    const a = isInt(cmd.id) ? state.agreements.get(cmd.id) : undefined;
    const me = ctx.companyId!;
    if (!a || a.status !== 'proposed' || (a.host !== me && a.guest !== me) || a.proposedBy === me) return fail('No such proposal');
    if (!cmd.accept) return ok(() => state.agreements.delete(a.id));
    return ok(() => {
      a.status = 'active';
      a.since = state.date;
      state.agreementsChanged();
      state.addNews('agreement', describe(state, a), { company: a.host });
    });
  },
};

export const endSharingHandler: CommandHandler<EndSharingCommand> = {
  needsCompany: true,
  category: null,
  plan(state, ctx, cmd) {
    const a = isInt(cmd.id) ? state.agreements.get(cmd.id) : undefined;
    const me = ctx.companyId!;
    if (!a || (a.host !== me && a.guest !== me)) return fail('No such agreement');
    if (a.status === 'proposed') return ok(() => state.endAgreement(a));
    return ok(() => {
      const towed = state.endAgreement(a);
      const extra = towed > 0 ? `; ${towed} of ${name(state, a.guest)}'s trains are towed home` : '';
      state.addNews('agreement', `${name(state, a.guest)} may no longer use ${name(state, a.host)}'s track${extra}`, { company: a.host });
    });
  },
};
