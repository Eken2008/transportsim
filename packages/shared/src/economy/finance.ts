import { ymdFromDays } from '../sim/date.ts';
import { isCargo, type CargoId } from './cargo.ts';

/** Where money comes from and goes to, as in a company's books. Income is positive. */
export const LEDGER_CATEGORIES = ['income', 'sharing', 'construction', 'vehicles', 'running', 'property', 'interest', 'incidents'] as const;
export type LedgerCategory = (typeof LEDGER_CATEGORIES)[number];
export type Ledger = Record<LedgerCategory, number>;

export const LEDGER_LABELS: Record<LedgerCategory, string> = {
  income: 'Vehicle income',
  sharing: 'Track sharing',
  construction: 'Construction',
  vehicles: 'New vehicles',
  running: 'Running costs',
  property: 'Property maintenance',
  interest: 'Loan interest',
  incidents: 'Accidents',
};

export interface QuarterRecord {
  year: number;
  /** 0..3 */
  quarter: number;
  ledger: Ledger;
}

/** A company at the end of a month, for its statistics. */
export interface MonthRecord {
  /** Game date (days) the month ended. */
  date: number;
  money: number;
  loan: number;
  value: number;
  vehicles: number;
  /** The month's books. */
  ledger: Ledger;
  /** Cargo delivered to its final destination during the month. */
  delivered: Partial<Record<CargoId, number>>;
}

/** The month so far. */
export interface MonthSoFar {
  ledger: Ledger;
  delivered: Partial<Record<CargoId, number>>;
}

/** Months of statistics kept per company (ten years). */
export const HISTORY_MONTHS = 120;

export function sanitizeHistory(input: unknown): MonthRecord[] {
  if (!Array.isArray(input)) return [];
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  return input
    .filter((r): r is MonthRecord => !!r && typeof r === 'object' && typeof (r as MonthRecord).date === 'number')
    .slice(-HISTORY_MONTHS)
    .map((r) => ({
      date: r.date,
      money: num(r.money),
      loan: num(r.loan),
      value: num(r.value),
      vehicles: num(r.vehicles),
      ledger: sanitizeLedger(r.ledger),
      delivered: sanitizeDelivered(r.delivered),
    }));
}

export function sanitizeDelivered(input: unknown): Partial<Record<CargoId, number>> {
  if (!input || typeof input !== 'object') return {};
  return Object.fromEntries(Object.entries(input).filter(([k, v]) => isCargo(k) && typeof v === 'number' && Number.isFinite(v)));
}

export function sanitizeLedger(input: unknown): Ledger {
  const out = emptyLedger();
  if (input && typeof input === 'object') {
    for (const c of LEDGER_CATEGORIES) {
      const v = (input as Record<string, unknown>)[c];
      if (typeof v === 'number' && Number.isFinite(v)) out[c] = v;
    }
  }
  return out;
}

/** Quarters of history kept per company (the last one is the current quarter). */
export const LEDGER_QUARTERS = 8;
/** Loans are taken and repaid in steps of this much. */
export const LOAN_STEP = 10_000;
/** Quarters in a row with negative money before a company goes bankrupt. */
export const BANKRUPT_QUARTERS = 3;

/** Yearly maintenance per piece of infrastructure (before economy scaling). */
export const MAINTENANCE = {
  track: 30,
  station: 90,
  depot: 220,
  signal: 40,
} as const;

export interface Infrastructure {
  /** Track pieces, counting each bridge or tunnel as one. */
  track: number;
  stations: number;
  depots: number;
  signals: number;
}

export const emptyInfrastructure = (): Infrastructure => ({ track: 0, stations: 0, depots: 0, signals: 0 });

export function emptyLedger(): Ledger {
  return Object.fromEntries(LEDGER_CATEGORIES.map((c) => [c, 0])) as Ledger;
}

export function quarterOf(date: number): { year: number; quarter: number } {
  const { year, month } = ymdFromDays(date);
  return { year, quarter: Math.floor(month / 3) };
}

/** Yearly maintenance of some infrastructure, before economy scaling. */
export function yearlyMaintenance(infra: Infrastructure): number {
  return (
    infra.track * MAINTENANCE.track +
    infra.stations * MAINTENANCE.station +
    infra.depots * MAINTENANCE.depot +
    infra.signals * MAINTENANCE.signal
  );
}

/** What a vehicle bought for `value` sells for after `ageYears`. */
export function resaleValue(value: number, ageYears: number): number {
  return Math.round(value * Math.max(0.2, 0.85 - ageYears * 0.04));
}

export const ledgerTotal = (l: Ledger): number => LEDGER_CATEGORIES.reduce((s, c) => s + l[c], 0);

/** Sum of the given quarters' ledgers. */
export function sumLedgers(records: readonly QuarterRecord[]): Ledger {
  const out = emptyLedger();
  for (const r of records) for (const c of LEDGER_CATEGORIES) out[c] += r.ledger[c];
  return out;
}

export function sanitizeFinances(input: unknown, date: number): QuarterRecord[] {
  const out: QuarterRecord[] = [];
  if (Array.isArray(input)) {
    for (const r of input.slice(-LEDGER_QUARTERS)) {
      if (!r || typeof r.year !== 'number' || typeof r.quarter !== 'number') continue;
      const ledger = emptyLedger();
      for (const c of LEDGER_CATEGORIES) {
        const v = r.ledger?.[c];
        if (typeof v === 'number' && Number.isFinite(v)) ledger[c] = v;
      }
      out.push({ year: r.year, quarter: Math.min(3, Math.max(0, Math.floor(r.quarter))), ledger });
    }
  }
  const now = quarterOf(date);
  const last = out[out.length - 1];
  if (!last || last.year !== now.year || last.quarter !== now.quarter) out.push({ ...now, ledger: emptyLedger() });
  return out.slice(-LEDGER_QUARTERS);
}
