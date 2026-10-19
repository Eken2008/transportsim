import { ymdFromDays } from '../sim/date.ts';

/** Where money comes from and goes to, as in a company's books. Income is positive. */
export const LEDGER_CATEGORIES = ['income', 'sharing', 'construction', 'vehicles', 'running', 'property', 'interest'] as const;
export type LedgerCategory = (typeof LEDGER_CATEGORIES)[number];
export type Ledger = Record<LedgerCategory, number>;

export const LEDGER_LABELS: Record<LedgerCategory, string> = {
  income: 'Train income',
  sharing: 'Track sharing',
  construction: 'Construction',
  vehicles: 'New vehicles',
  running: 'Running costs',
  property: 'Property maintenance',
  interest: 'Loan interest',
};

export interface QuarterRecord {
  year: number;
  /** 0..3 */
  quarter: number;
  ledger: Ledger;
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
