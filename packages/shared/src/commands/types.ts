import type { Permission } from '../company/company.ts';
import type { LedgerCategory } from '../economy/finance.ts';
import type { GameState } from '../sim/state.ts';
import type { VehicleMode } from '../vehicles/lines.ts';

export interface CommandContext {
  playerId: number;
  companyId: number | null;
}

export interface CommandEffects {
  /** Chunks whose tile data changed and must be re-sent to subscribers. */
  dirtyChunks: Set<number>;
}

export type PlanResult =
  | { ok: true; cost: number; commit: () => CommandEffects; /** Shown with the preview, e.g. what it does to a town's reputation. */ note?: string }
  | { ok: false; error: string };

export interface CommandHandler<C> {
  /** Validate untrusted input and compute cost, without mutating state. */
  plan(state: GameState, ctx: CommandContext, cmd: C): PlanResult;
  /** Whether the command acts for the player's company (requires one). */
  needsCompany: boolean;
  /** Role permission the command needs (company commands only); defaults to 'build'. */
  permission?: Permission | ((cmd: C) => Permission);
  /** Ledger category for the cost; defaults to 'construction'. null moves money off the books (loans). */
  category?: LedgerCategory | null;
  /** The transport type the cost is booked to (none: general, e.g. terraforming). Read before the command runs. */
  mode?: VehicleMode | ((cmd: C, state: GameState) => VehicleMode | undefined);
}

export const fail = (error: string): PlanResult => ({ ok: false, error });

export const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
