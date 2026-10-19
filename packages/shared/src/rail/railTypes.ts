import { ymdFromDays } from '../sim/date.ts';
import type { GameState } from '../sim/state.ts';

/** Track types, stored per tile in the `railType` layer. */
export interface RailType {
  name: string;
  /** km/h */
  maxSpeed: number;
  /** Carries overhead wires, so electric engines can run on it. */
  electrified: boolean;
  /** Build cost relative to standard track. */
  costFactor: number;
  intro: number;
}

export const RAIL_TYPES: readonly RailType[] = [
  { name: 'Standard', maxSpeed: 160, electrified: false, costFactor: 1, intro: 1850 },
  { name: 'Electrified', maxSpeed: 200, electrified: true, costFactor: 1.8, intro: 1910 },
  { name: 'High-speed', maxSpeed: 350, electrified: true, costFactor: 3, intro: 1975 },
];

/** Speed limit (km/h) of each rail type, indexed by layer value. */
export const RAIL_TYPE_SPEED = RAIL_TYPES.map((t) => t.maxSpeed);
/** Rail types electric engines can use (TrackAccess.types). */
export const ELECTRIC_TYPES = new Uint8Array(8).fill(0).map((_, i) => (RAIL_TYPES[i]?.electrified ? 1 : 0));

export const isElectrified = (type: number): boolean => RAIL_TYPES[type]?.electrified === true;

/** Validate a rail type a player wants to build; returns an error or null. */
export function railTypeError(state: GameState, type: unknown): string | null {
  if (typeof type !== 'number' || !Number.isInteger(type) || !RAIL_TYPES[type]) return 'Invalid track type';
  const year = ymdFromDays(state.date).year;
  const t = RAIL_TYPES[type]!;
  if (state.settings.timeline === 'era' && t.intro > year) return `${t.name} track arrives in ${t.intro}`;
  return null;
}

/** Rail types available to build now. */
export function availableRailTypes(year: number, timeline: 'era' | 'sandbox'): number[] {
  return RAIL_TYPES.flatMap((t, i) => (timeline === 'sandbox' || t.intro <= year ? [i] : []));
}
