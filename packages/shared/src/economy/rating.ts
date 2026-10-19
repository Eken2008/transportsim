import type { Station } from '../rail/station.ts';

/**
 * A station's rating (0..255) drifts each day towards a target made of these parts, much like
 * OpenTTD's. A higher rating means more passengers turn up, and where stations compete for the
 * same houses, a bigger share of them.
 */
export interface RatingParts {
  /** Days since a train last called to load. */
  days: number;
  pickup: number;
  waiting: number;
  /** Top speed (km/h) of the last train that called, if any. */
  speedKmh: number | null;
  speed: number;
  /** Age in years of the last train that called, if any. */
  ageYears: number | null;
  age: number;
  target: number;
}

/** Rating points per day the rating can move towards its target. */
export const RATING_STEP = 6;
export const MAX_RATING = 255;

export function ratingParts(st: Station, date: number): RatingParts {
  const days = Math.max(0, date - (st.lastPickup ?? st.builtDays));
  const pickup = days > 21 ? 0 : days > 12 ? 25 : days > 6 ? 45 : days > 3 ? 65 : 95;
  const w = st.waitingTotal;
  const waiting = w > 1500 ? -90 : w > 1000 ? -35 : w > 600 ? 0 : w > 300 ? 10 : w > 100 ? 30 : 40;
  const speedKmh = st.lastSpeed ?? null;
  const speed = speedKmh === null ? 0 : Math.min(42, Math.max(0, Math.round((speedKmh - 85) / 4)));
  const ageYears = st.lastVehicleAge ?? null;
  const age = ageYears === null ? 0 : ageYears >= 3 ? 0 : ageYears >= 2 ? 10 : ageYears >= 1 ? 20 : 33;
  const target = Math.max(0, Math.min(MAX_RATING, pickup + waiting + speed + age));
  return { days, pickup, waiting, speedKmh, speed, ageYears, age, target };
}

/** Rating as a percentage. */
export const ratingPercent = (rating: number): number => Math.round((rating / MAX_RATING) * 100);
