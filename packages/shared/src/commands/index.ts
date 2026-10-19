import type { GameState } from '../sim/state.ts';
import { terraformHandler, type TerraformCommand } from './terraform.ts';
import {
  buildTrackHandler,
  removeTrackHandler,
  type BuildTrackCommand,
  type RemoveTrackCommand,
} from './track.ts';
import {
  buildDepotHandler,
  buildStationHandler,
  clearAreaHandler,
  type BuildDepotCommand,
  type BuildStationCommand,
  type ClearAreaCommand,
} from './station.ts';
import {
  buyTrainHandler,
  editConsistHandler,
  setOrdersHandler,
  trainActionHandler,
  type BuyTrainCommand,
  type EditConsistCommand,
  type SetOrdersCommand,
  type TrainActionCommand,
} from './trains.ts';
import { setSignalHandler, type SetSignalCommand } from './signals.ts';
import { buildBridgeHandler, buildTunnelHandler, type BuildBridgeCommand, type BuildTunnelCommand } from './structures.ts';
import {
  answerJoinHandler,
  cancelJoinHandler,
  companySettingsHandler,
  foundCompanyHandler,
  invitePlayerHandler,
  joinCompanyHandler,
  leaveCompanyHandler,
  removeMemberHandler,
  setMemberRoleHandler,
  type AnswerJoinCommand,
  type CancelJoinCommand,
  type CompanySettingsCommand,
  type FoundCompanyCommand,
  type InvitePlayerCommand,
  type JoinCompanyCommand,
  type LeaveCompanyCommand,
  type RemoveMemberCommand,
  type SetMemberRoleCommand,
} from './company.ts';
import { roleAllows } from '../company/company.ts';
import type { CommandContext, CommandHandler, CommandEffects } from './types.ts';

export * from './types.ts';
export * from './terraform.ts';
export * from './track.ts';
export * from './station.ts';
export * from './trains.ts';
export * from './signals.ts';
export * from './structures.ts';
export * from './company.ts';

export type Command =
  | TerraformCommand
  | BuildTrackCommand
  | RemoveTrackCommand
  | BuildStationCommand
  | BuildDepotCommand
  | ClearAreaCommand
  | BuyTrainCommand
  | TrainActionCommand
  | SetOrdersCommand
  | EditConsistCommand
  | SetSignalCommand
  | BuildBridgeCommand
  | BuildTunnelCommand
  | FoundCompanyCommand
  | JoinCompanyCommand
  | CancelJoinCommand
  | LeaveCompanyCommand
  | AnswerJoinCommand
  | InvitePlayerCommand
  | SetMemberRoleCommand
  | RemoveMemberCommand
  | CompanySettingsCommand;
export type CommandType = Command['type'];

const HANDLERS: { [K in CommandType]: CommandHandler<Extract<Command, { type: K }>> } = {
  terraform: terraformHandler,
  buildTrack: buildTrackHandler,
  removeTrack: removeTrackHandler,
  buildStation: buildStationHandler,
  buildDepot: buildDepotHandler,
  clearArea: clearAreaHandler,
  buyTrain: buyTrainHandler,
  trainAction: trainActionHandler,
  setOrders: setOrdersHandler,
  editConsist: editConsistHandler,
  setSignal: setSignalHandler,
  buildBridge: buildBridgeHandler,
  buildTunnel: buildTunnelHandler,
  foundCompany: foundCompanyHandler,
  joinCompany: joinCompanyHandler,
  cancelJoin: cancelJoinHandler,
  leaveCompany: leaveCompanyHandler,
  answerJoin: answerJoinHandler,
  invitePlayer: invitePlayerHandler,
  setMemberRole: setMemberRoleHandler,
  removeMember: removeMemberHandler,
  companySettings: companySettingsHandler,
};

const PERMISSION_ERRORS = {
  build: 'Only managers and the owner can build and spend money',
  operate: 'Viewers cannot drive trains',
  members: 'Only managers and the owner can manage members',
  owner: 'Only the owner can do that',
  member: 'You are not a member of this company',
} as const;

export type CommandResult =
  | { ok: true; cost: number; effects: CommandEffects | null }
  | { ok: false; error: string };

/**
 * Validate and (unless dryRun) apply a command. The single entry point used by the
 * server for authoritative execution and by the client for build-cursor previews.
 */
export function executeCommand(
  state: GameState,
  ctx: CommandContext,
  cmd: Command,
  dryRun = false,
): CommandResult {
  if (!cmd || typeof cmd !== 'object') return { ok: false, error: 'Malformed command' };
  const handler = HANDLERS[cmd.type as CommandType] as CommandHandler<Command> | undefined;
  if (!handler) return { ok: false, error: `Unknown command ${String(cmd.type)}` };
  const company = ctx.companyId !== null ? state.companies.get(ctx.companyId) : undefined;
  if (handler.needsCompany) {
    if (!company) return { ok: false, error: 'You need a company first' };
    const perm = typeof handler.permission === 'function' ? handler.permission(cmd) : (handler.permission ?? 'build');
    if (!roleAllows(state.roleOf(ctx.playerId, company.id), perm)) return { ok: false, error: PERMISSION_ERRORS[perm] };
  }

  const plan = handler.plan(state, ctx, cmd);
  if (!plan.ok) return plan;
  if (company && plan.cost > 0 && company.money < plan.cost) {
    return { ok: false, error: `Not enough money (need £${plan.cost.toLocaleString('en-GB')})` };
  }
  if (dryRun) return { ok: true, cost: plan.cost, effects: null };
  const effects = plan.commit();
  if (company) company.money -= plan.cost;
  return { ok: true, cost: plan.cost, effects };
}
