import { COMPANY_COLORS, COMPANY_ROLES, MAX_MEMBERS, memberOf, type Company, type CompanyRole } from '../company/company.ts';
import type { GameState, Player } from '../sim/state.ts';
import { fail, isInt, type CommandContext, type CommandHandler, type PlanResult } from './types.ts';

/** Found a new company (the player must not be in one). */
export interface FoundCompanyCommand {
  type: 'foundCompany';
  name: string;
  color: number;
}

/** Ask to join a company. Accepts an invitation directly, and adopts a company without members. */
export interface JoinCompanyCommand {
  type: 'joinCompany';
  company: number;
}

/** Withdraw a join request, or decline an invitation. */
export interface CancelJoinCommand {
  type: 'cancelJoin';
  company: number;
}

export interface LeaveCompanyCommand {
  type: 'leaveCompany';
}

/** Accept (with a role) or decline a player's request to join. */
export interface AnswerJoinCommand {
  type: 'answerJoin';
  name: string;
  accept: boolean;
  role?: CompanyRole;
}

/** Invite a player in the game to join with a role, or withdraw the invitation. */
export interface InvitePlayerCommand {
  type: 'invitePlayer';
  name: string;
  role?: CompanyRole;
  cancel?: boolean;
}

/** Change a member's role. Giving someone the owner role hands over ownership. */
export interface SetMemberRoleCommand {
  type: 'setMemberRole';
  name: string;
  role: CompanyRole;
}

export interface RemoveMemberCommand {
  type: 'removeMember';
  name: string;
}

export interface CompanySettingsCommand {
  type: 'companySettings';
  name?: string;
  color?: number;
}

const MAX_PENDING = 16;
/** Fewer than MAX_COMPANIES so the owner byte never runs out. */
const MAX_COMPANY_SLOTS = 48;
const noEffects = () => ({ dirtyChunks: new Set<number>() });
const ok = (commit: () => void): PlanResult => ({ ok: true, cost: 0, commit: () => (commit(), noEffects()) });

function playerOf(state: GameState, ctx: CommandContext): Player | undefined {
  return state.players.get(ctx.playerId);
}

function companyArg(state: GameState, id: unknown): Company | undefined {
  return isInt(id) ? state.companies.get(id) : undefined;
}

/** Validate a company name; returns the cleaned name or an error. */
function checkName(state: GameState, name: unknown, self?: Company): { name: string } | { error: string } {
  if (typeof name !== 'string') return { error: 'Invalid name' };
  const clean = name.replace(/\s+/g, ' ').trim().slice(0, 40);
  if (!clean) return { error: 'Enter a company name' };
  for (const c of state.companies.values()) {
    if (c !== self && c.name.toLowerCase() === clean.toLowerCase()) return { error: 'Another company has that name' };
  }
  return { name: clean };
}

function checkColor(state: GameState, color: unknown, self?: Company): string | null {
  if (!isInt(color) || color < 0 || color >= COMPANY_COLORS.length) return 'Invalid colour';
  for (const c of state.companies.values()) if (c !== self && c.color === color) return 'Another company uses that colour';
  return null;
}

const isRole = (r: unknown): r is CompanyRole => COMPANY_ROLES.includes(r as CompanyRole);
/** Roles a new member can get (ownership is handed over separately). */
const isJoinRole = (r: unknown): r is CompanyRole => isRole(r) && r !== 'owner';

function checkJoinRole(state: GameState, ctx: CommandContext, role: unknown): string | null {
  if (!isJoinRole(role)) return 'Invalid role';
  if (role === 'manager' && state.roleOf(ctx.playerId, ctx.companyId) !== 'owner') return 'Only the owner can appoint managers';
  return null;
}

function join(state: GameState, c: Company, name: string, role: CompanyRole, news = `${name} joins ${c.name}`): void {
  const before = state.companyOfName(name);
  state.addMember(c, name, role);
  if (before && before !== c) newsIfEmpty(state, before);
  state.addNews('company', news, { company: c.id });
}

function leave(state: GameState, c: Company, name: string): void {
  state.removeMember(c, name);
  state.addNews('company', `${name} leaves ${c.name}`, { company: c.id });
  newsIfEmpty(state, c);
}

function newsIfEmpty(state: GameState, c: Company): void {
  if (c.members.length === 0) state.addNews('company', `${c.name} has no members left; anyone can take it over`, { company: c.id });
}

export const foundCompanyHandler: CommandHandler<FoundCompanyCommand> = {
  needsCompany: false,
  plan(state, ctx, cmd) {
    const p = playerOf(state, ctx);
    if (!p) return fail('Unknown player');
    if (state.companyOfName(p.name)) return fail('Leave your company first');
    const n = checkName(state, cmd.name);
    if ('error' in n) return fail(n.error);
    const colorErr = checkColor(state, cmd.color);
    if (colorErr) return fail(colorErr);
    if (state.companies.size >= MAX_COMPANY_SLOTS) return fail('No company slots left');
    return ok(() => {
      const c = state.foundCompany(p, n.name, cmd.color);
      if (c) state.addNews('company', `${p.name} founds ${c.name}`, { company: c.id });
    });
  },
};

export const joinCompanyHandler: CommandHandler<JoinCompanyCommand> = {
  needsCompany: false,
  plan(state, ctx, cmd) {
    const p = playerOf(state, ctx);
    const c = companyArg(state, cmd.company);
    if (!p || !c) return fail('No such company');
    if (memberOf(c, p.name)) return fail('You are already a member');
    if (c.members.length === 0) return ok(() => join(state, c, p.name, 'owner', `${p.name} takes over ${c.name}`));
    const invite = c.invites.find((m) => m.name === p.name);
    if (invite) return ok(() => join(state, c, p.name, invite.role));
    if (c.members.length >= MAX_MEMBERS) return fail('That company is full');
    if (c.requests.includes(p.name)) return fail('You have already asked to join');
    if (c.requests.length >= MAX_PENDING) return fail('That company has too many open requests');
    return ok(() => c.requests.push(p.name));
  },
};

export const cancelJoinHandler: CommandHandler<CancelJoinCommand> = {
  needsCompany: false,
  plan(state, ctx, cmd) {
    const p = playerOf(state, ctx);
    const c = companyArg(state, cmd.company);
    if (!p || !c) return fail('No such company');
    if (!c.requests.includes(p.name) && !c.invites.some((m) => m.name === p.name)) return fail('Nothing to cancel');
    return ok(() => {
      c.requests = c.requests.filter((n) => n !== p.name);
      c.invites = c.invites.filter((m) => m.name !== p.name);
    });
  },
};

export const leaveCompanyHandler: CommandHandler<LeaveCompanyCommand> = {
  needsCompany: true,
  permission: 'member',
  plan(state, ctx) {
    const p = playerOf(state, ctx)!;
    const c = state.companies.get(ctx.companyId!)!;
    return ok(() => leave(state, c, p.name));
  },
};

export const answerJoinHandler: CommandHandler<AnswerJoinCommand> = {
  needsCompany: true,
  permission: 'members',
  plan(state, ctx, cmd) {
    const c = state.companies.get(ctx.companyId!)!;
    if (!c.requests.includes(cmd.name)) return fail('No such request');
    if (!cmd.accept) return ok(() => (c.requests = c.requests.filter((n) => n !== cmd.name)));
    const role = cmd.role ?? 'operator';
    const err = checkJoinRole(state, ctx, role);
    if (err) return fail(err);
    if (c.members.length >= MAX_MEMBERS) return fail('The company is full');
    return ok(() => join(state, c, cmd.name, role));
  },
};

export const invitePlayerHandler: CommandHandler<InvitePlayerCommand> = {
  needsCompany: true,
  permission: 'members',
  plan(state, ctx, cmd) {
    const c = state.companies.get(ctx.companyId!)!;
    if (cmd.cancel) {
      if (!c.invites.some((m) => m.name === cmd.name)) return fail('No such invitation');
      return ok(() => (c.invites = c.invites.filter((m) => m.name !== cmd.name)));
    }
    if (![...state.players.values()].some((p) => p.name === cmd.name)) return fail('No such player');
    if (memberOf(c, cmd.name)) return fail('Already a member');
    const role = cmd.role ?? 'operator';
    const err = checkJoinRole(state, ctx, role);
    if (err) return fail(err);
    if (c.members.length >= MAX_MEMBERS) return fail('The company is full');
    // They asked already: inviting accepts the request.
    if (c.requests.includes(cmd.name)) return ok(() => join(state, c, cmd.name, role));
    if (c.invites.some((m) => m.name === cmd.name)) return fail('Already invited');
    if (c.invites.length >= MAX_PENDING) return fail('Too many open invitations');
    return ok(() => c.invites.push({ name: cmd.name, role }));
  },
};

export const setMemberRoleHandler: CommandHandler<SetMemberRoleCommand> = {
  needsCompany: true,
  permission: 'owner',
  plan(state, ctx, cmd) {
    const c = state.companies.get(ctx.companyId!)!;
    const me = memberOf(c, state.players.get(ctx.playerId)!.name)!;
    const m = memberOf(c, cmd.name);
    if (!m) return fail('Not a member');
    if (!isRole(cmd.role)) return fail('Invalid role');
    if (m === me) return fail('Give another member the owner role to step down');
    if (m.role === cmd.role) return fail('They already have that role');
    return ok(() => {
      if (cmd.role === 'owner') {
        me.role = 'manager';
        state.addNews('company', `${m.name} is the new owner of ${c.name}`, { company: c.id });
      }
      m.role = cmd.role;
    });
  },
};

export const removeMemberHandler: CommandHandler<RemoveMemberCommand> = {
  needsCompany: true,
  permission: 'owner',
  plan(state, ctx, cmd) {
    const c = state.companies.get(ctx.companyId!)!;
    const m = memberOf(c, cmd.name);
    if (!m) return fail('Not a member');
    if (m.role === 'owner') return fail('Leave the company instead');
    return ok(() => leave(state, c, cmd.name));
  },
};

export const companySettingsHandler: CommandHandler<CompanySettingsCommand> = {
  needsCompany: true,
  permission: 'owner',
  plan(state, ctx, cmd) {
    const c = state.companies.get(ctx.companyId!)!;
    let name = c.name;
    if (cmd.name !== undefined) {
      const n = checkName(state, cmd.name, c);
      if ('error' in n) return fail(n.error);
      name = n.name;
    }
    if (cmd.color !== undefined) {
      const err = checkColor(state, cmd.color, c);
      if (err) return fail(err);
    }
    return ok(() => {
      if (name !== c.name) state.addNews('company', `${c.name} is renamed ${name}`, { company: c.id });
      c.name = name;
      if (cmd.color !== undefined) c.color = cmd.color;
    });
  },
};
