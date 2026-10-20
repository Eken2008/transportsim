import type { Infrastructure, MonthRecord, MonthSoFar, QuarterRecord } from '../economy/finance.ts';

/**
 * Member roles, most powerful first:
 * - owner: everything, including membership, roles and company settings
 * - manager: build, buy and sell, borrow; answer join requests and invite
 * - operator: drive trains and edit their orders
 * - viewer: read-only
 */
export type CompanyRole = 'owner' | 'manager' | 'operator' | 'viewer';
export const COMPANY_ROLES: readonly CompanyRole[] = ['owner', 'manager', 'operator', 'viewer'];

/** What a command needs from the player's role. */
export type Permission = 'build' | 'operate' | 'members' | 'owner' | 'member';

const ALLOWED: Record<Permission, readonly CompanyRole[]> = {
  owner: ['owner'],
  members: ['owner', 'manager'],
  build: ['owner', 'manager'],
  operate: ['owner', 'manager', 'operator'],
  member: COMPANY_ROLES,
};

export function roleAllows(role: CompanyRole | null | undefined, perm: Permission): boolean {
  return !!role && ALLOWED[perm].includes(role);
}

export const ROLE_LABELS: Record<CompanyRole, string> = {
  owner: 'Owner',
  manager: 'Manager',
  operator: 'Operator',
  viewer: 'Viewer',
};

export interface CompanyMember {
  /** Player name; membership follows the name across reconnects and saves. */
  name: string;
  role: CompanyRole;
}

export interface Company {
  id: number;
  name: string;
  /** Index into COMPANY_COLORS */
  color: number;
  money: number;
  loan: number;
  members: CompanyMember[];
  /** Names of players asking to join. */
  requests: string[];
  /** Players invited to join, with the role they will get. */
  invites: CompanyMember[];
  foundedDays: number;
  /** Quarterly books, oldest first; the last record is the current quarter. */
  finances: QuarterRecord[];
  /** Quarters in a row that ended with negative money. */
  badQuarters: number;
  /** Infrastructure owned, counted monthly. */
  infrastructure: Infrastructure;
  /** Tile of the north-west corner of the company's headquarters, if it has built them. */
  hq?: number;
  /** Company value (money − loan + vehicles + property), updated monthly. */
  value: number;
  /** Renew trains that outlive their design life when they visit a depot. */
  autorenew: boolean;
  /** Replacement rules: vehicle type → the type to replace it with on a depot visit. */
  replace: Record<string, string>;
  /** Month-end records, oldest first (statistics). */
  history: MonthRecord[];
  /** The current month's books and deliveries. */
  month: MonthSoFar;
}

export function memberOf(c: Company, name: string): CompanyMember | undefined {
  return c.members.find((m) => m.name === name);
}

export const COMPANY_COLORS = [
  '#d7263d', '#1b98e0', '#f49d37', '#3bb273', '#7768ae', '#e15554', '#4d9078', '#e1bc29',
  '#2e86ab', '#a23b72', '#f18f01', '#6a994e', '#bc4b51', '#5b8e7d', '#8338ec', '#3a86ff',
] as const;

/** Max company id + 1; ids must fit the per-tile owner byte (0xff is "none"). */
export const MAX_COMPANIES = 64;
/** Max members per company (keeps the global state message small). */
export const MAX_MEMBERS = 32;
