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
import type { CommandContext, CommandHandler, CommandEffects } from './types.ts';

export * from './types.ts';
export * from './terraform.ts';
export * from './track.ts';
export * from './station.ts';
export * from './trains.ts';
export * from './signals.ts';
export * from './structures.ts';

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
  | BuildTunnelCommand;
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
};

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
  if (handler.needsCompany && !company) return { ok: false, error: 'You need a company first' };

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
