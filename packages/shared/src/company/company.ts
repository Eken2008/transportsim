export interface Company {
  id: number;
  name: string;
  /** Index into COMPANY_COLORS */
  color: number;
  money: number;
  loan: number;
  /** Player names that belong to the company; survives save/load and reconnects. */
  members: string[];
  foundedDays: number;
}

export const COMPANY_COLORS = [
  '#d7263d', '#1b98e0', '#f49d37', '#3bb273', '#7768ae', '#e15554', '#4d9078', '#e1bc29',
  '#2e86ab', '#a23b72', '#f18f01', '#6a994e', '#bc4b51', '#5b8e7d', '#8338ec', '#3a86ff',
] as const;

/** Max company id + 1; ids must fit the per-tile owner byte (0xff is "none"). */
export const MAX_COMPANIES = 64;
