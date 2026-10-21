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
  cloneVehicleHandler,
  editConsistHandler,
  trainActionHandler,
  type BuyTrainCommand,
  type CloneVehicleCommand,
  type EditConsistCommand,
  type TrainActionCommand,
} from './trains.ts';
import {
  assignLineHandler,
  createLineHandler,
  deleteLineHandler,
  editLineHandler,
  setOrdersHandler,
  type AssignLineCommand,
  type CreateLineCommand,
  type DeleteLineCommand,
  type EditLineCommand,
  type SetOrdersCommand,
} from './lines.ts';
import { setSignalHandler, setSignalRunHandler, type SetSignalCommand, type SetSignalRunCommand } from './signals.ts';
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
import { giftMoneyHandler, loanHandler, type GiftMoneyCommand, type LoanCommand } from './finance.ts';
import { convertRailHandler, type ConvertRailCommand } from './convert.ts';
import { buildWaypointHandler, removeWaypointHandler, type BuildWaypointCommand, type RemoveWaypointCommand } from './waypoint.ts';
import { buildAirportHandler, type BuildAirportCommand } from './airport.ts';
import {
  buildBuoyHandler,
  buildCanalHandler,
  buildDockHandler,
  buildLockHandler,
  buildShipDepotHandler,
  type BuildBuoyCommand,
  type BuildCanalCommand,
  type BuildDockCommand,
  type BuildLockCommand,
  type BuildShipDepotCommand,
} from './water.ts';
import { trainSettingsHandler, vehicleSettingsHandler, type TrainSettingsCommand, type VehicleSettingsCommand } from './maintenance.ts';
import {
  buildRoadDepotHandler,
  buildRoadHandler,
  buildRoadStopHandler,
  removeRoadHandler,
  setOneWayHandler,
  type BuildRoadCommand,
  type BuildRoadDepotCommand,
  type BuildRoadStopCommand,
  type RemoveRoadCommand,
  type SetOneWayCommand,
} from './road.ts';
import {
  answerSharingHandler,
  endSharingHandler,
  proposeSharingHandler,
  type AnswerSharingCommand,
  type EndSharingCommand,
  type ProposeSharingCommand,
} from './sharing.ts';
import { townActionHandler, type TownActionCommand } from './town.ts';
import { buildHeadquartersHandler, type BuildHeadquartersCommand } from './headquarters.ts';
import { renameStationHandler, renameVehicleHandler, type RenameStationCommand, type RenameVehicleCommand } from './rename.ts';
import { roleAllows } from '../company/company.ts';
import type { CommandContext, CommandHandler, CommandEffects } from './types.ts';

export * from './types.ts';
export * from './terraform.ts';
export * from './track.ts';
export * from './station.ts';
export * from './trains.ts';
export * from './lines.ts';
export * from './signals.ts';
export * from './structures.ts';
export * from './company.ts';
export * from './finance.ts';
export * from './sharing.ts';
export * from './convert.ts';
export * from './waypoint.ts';
export * from './maintenance.ts';
export * from './road.ts';
export * from './airport.ts';
export * from './water.ts';
export * from './town.ts';
export * from './headquarters.ts';
export * from './rename.ts';

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
  | CreateLineCommand
  | EditLineCommand
  | DeleteLineCommand
  | AssignLineCommand
  | CloneVehicleCommand
  | EditConsistCommand
  | SetSignalCommand
  | SetSignalRunCommand
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
  | CompanySettingsCommand
  | LoanCommand
  | GiftMoneyCommand
  | ProposeSharingCommand
  | AnswerSharingCommand
  | EndSharingCommand
  | ConvertRailCommand
  | BuildWaypointCommand
  | RemoveWaypointCommand
  | TrainSettingsCommand
  | VehicleSettingsCommand
  | BuildRoadCommand
  | RemoveRoadCommand
  | SetOneWayCommand
  | BuildRoadDepotCommand
  | BuildRoadStopCommand
  | BuildAirportCommand
  | BuildCanalCommand
  | BuildLockCommand
  | BuildDockCommand
  | BuildShipDepotCommand
  | BuildBuoyCommand
  | TownActionCommand
  | BuildHeadquartersCommand
  | RenameStationCommand
  | RenameVehicleCommand;
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
  createLine: createLineHandler,
  editLine: editLineHandler,
  deleteLine: deleteLineHandler,
  assignLine: assignLineHandler,
  cloneVehicle: cloneVehicleHandler,
  editConsist: editConsistHandler,
  setSignal: setSignalHandler,
  setSignalRun: setSignalRunHandler,
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
  loan: loanHandler,
  giftMoney: giftMoneyHandler,
  proposeSharing: proposeSharingHandler,
  answerSharing: answerSharingHandler,
  endSharing: endSharingHandler,
  convertRail: convertRailHandler,
  buildWaypoint: buildWaypointHandler,
  removeWaypoint: removeWaypointHandler,
  trainSettings: trainSettingsHandler,
  vehicleSettings: vehicleSettingsHandler,
  buildRoad: buildRoadHandler,
  removeRoad: removeRoadHandler,
  setOneWay: setOneWayHandler,
  buildRoadDepot: buildRoadDepotHandler,
  buildRoadStop: buildRoadStopHandler,
  buildAirport: buildAirportHandler,
  buildCanal: buildCanalHandler,
  buildLock: buildLockHandler,
  buildDock: buildDockHandler,
  buildShipDepot: buildShipDepotHandler,
  buildBuoy: buildBuoyHandler,
  townAction: townActionHandler,
  buildHeadquarters: buildHeadquartersHandler,
  renameStation: renameStationHandler,
  renameVehicle: renameVehicleHandler,
};

const PERMISSION_ERRORS = {
  build: 'Only managers and the owner can build and spend money',
  operate: 'Viewers cannot drive trains',
  members: 'Only managers and the owner can manage members',
  owner: 'Only the owner can do that',
  member: 'You are not a member of this company',
} as const;

export type CommandResult =
  | { ok: true; cost: number; effects: CommandEffects | null; note?: string; foundations?: ReadonlyMap<number, number> }
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
  if (dryRun) return { ok: true, cost: plan.cost, effects: null, note: plan.note, foundations: plan.foundations };
  const mode = typeof handler.mode === 'function' ? handler.mode(cmd, state) : handler.mode;
  const effects = plan.commit();
  if (company && plan.cost !== 0) {
    const category = handler.category === undefined ? 'construction' : handler.category;
    state.addMoney(company.id, -plan.cost, category, mode);
  }
  return { ok: true, cost: plan.cost, effects };
}
