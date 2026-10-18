/** Simulation ticks per second at 1× speed. */
export const TICKS_PER_SECOND = 30;
/** Ticks per in-game day (OpenTTD uses 74, ~2.5 s per day at 1×). */
export const TICKS_PER_DAY = 74;

const MS_PER_DAY = 86_400_000;

export const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const;

/** Dates are whole days since 1970-01-01 (negative before 1970). */
export function daysFromYmd(year: number, month: number, day: number): number {
  return Math.round(Date.UTC(year, month, day) / MS_PER_DAY);
}

export interface Ymd {
  year: number;
  /** 0-based month */
  month: number;
  /** 1-based day of month */
  day: number;
}

export function ymdFromDays(days: number): Ymd {
  const d = new Date(days * MS_PER_DAY);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() };
}

export function formatDate(days: number): string {
  const { year, month, day } = ymdFromDays(days);
  return `${day} ${MONTH_NAMES[month]} ${year}`;
}
