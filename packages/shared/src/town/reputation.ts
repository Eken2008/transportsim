import type { GameState } from '../sim/state.ts';
import { townRadius } from './growth.ts';
import { houseType } from './houses.ts';
import type { Town } from './towns.ts';

/**
 * Each town's council keeps a reputation for every company, from -1000 to 1000. Demolishing the
 * town's buildings and streets costs reputation; stations that vehicles call at often earn it
 * back. With too low a reputation, the council forbids more demolition and new stations.
 */
export const REPUTATION_MIN = -1000;
export const REPUTATION_MAX = 1000;
/** What a company starts with in every town. */
export const REPUTATION_START = 500;
/** The council refuses demolition that would take a company's reputation below this. */
export const REPUTATION_DEMOLISH_FLOOR = -200;
/** The council refuses new stations to companies with a reputation below this. */
export const REPUTATION_NEW_STATION = 0;
/** Reputation lost for each street tile removed. */
export const REPUTATION_ROAD_LOSS = 40;

/** Monthly change for each of a company's stations in a town: well used, or neglected. */
const STATION_UP = 12;
const STATION_DOWN = 15;
/** Neglected stations never take a reputation below this. */
const NEGLECT_FLOOR = 0;
/** A council forgives a bad reputation slowly by itself. */
const RECOVERY = 10;
/** New stations get this many days before they count. */
const STATION_GRACE_DAYS = 60;
/** A town speaks for land this far (tiles) beyond the area it builds in. */
const AUTHORITY_MARGIN = 6;

const BANDS: readonly [number, string][] = [
  [-400, 'Appalling'],
  [-200, 'Very poor'],
  [0, 'Poor'],
  [200, 'Mediocre'],
  [400, 'Good'],
  [600, 'Very good'],
  [800, 'Excellent'],
  [Infinity, 'Outstanding'],
];

export function reputationLabel(r: number): string {
  for (const [below, name] of BANDS) if (r < below) return name;
  return 'Outstanding';
}

export const reputationOf = (town: Town, company: number): number => town.ratings?.[company] ?? REPUTATION_START;

/** Change a company's reputation in a town, not going below `floor` by a loss. Returns whether it changed. */
export function changeReputation(town: Town, company: number, delta: number, floor = REPUTATION_MIN): boolean {
  const before = reputationOf(town, company);
  let next = before + delta;
  if (delta < 0) next = Math.max(next, Math.min(before, floor));
  next = Math.round(Math.max(REPUTATION_MIN, Math.min(REPUTATION_MAX, next)));
  if (next === before) return false;
  (town.ratings ??= {})[company] = next;
  return true;
}

/** Reputation lost for demolishing a house (`data` is the House tile's data). Churches matter most. */
export function houseRemovalLoss(data: number): number {
  const h = houseType(data);
  return h.model === 'church' ? 250 : Math.round(30 + h.population * 1.5);
}

/** The town whose council speaks for a tile: the nearest one whose area (with a margin) covers it. */
export function authorityTown(towns: Iterable<Town>, x: number, y: number): Town | null {
  let best: Town | null = null;
  let bestD = Infinity;
  for (const t of towns) {
    const d = Math.hypot(t.x - x, t.y - y);
    if (d <= townRadius(t) + AUTHORITY_MARGIN && d < bestD) {
      best = t;
      bestD = d;
    }
  }
  return best;
}

/** Why a town's council forbids a company a new station at (x, y), or null if it doesn't. */
export function stationRefusal(state: GameState, company: number, x: number, y: number): string | null {
  const town = authorityTown(state.towns.values(), x, y);
  if (!town || reputationOf(town, company) >= REPUTATION_NEW_STATION) return null;
  return `The ${town.name} council refuses: your reputation there is ${reputationLabel(reputationOf(town, company)).toLowerCase()}`;
}

/**
 * Check that the councils allow a company demolition costing each town `losses` reputation.
 * Returns an error, or a note describing what the demolition does to the company's reputation.
 */
export function demolitionVerdict(state: GameState, company: number, losses: Map<number, number>): { error: string } | { note: string | undefined } {
  const notes: string[] = [];
  for (const [id, loss] of losses) {
    const town = state.towns.get(id);
    if (!town) continue;
    const now = reputationOf(town, company);
    if (now - loss < REPUTATION_DEMOLISH_FLOOR) {
      return { error: `The ${town.name} council refuses: your reputation there would fall too low (now ${reputationLabel(now).toLowerCase()})` };
    }
    notes.push(`${town.name}: reputation ${reputationLabel(now)} → ${reputationLabel(now - loss)} (−${loss})`);
  }
  return { note: notes.length ? notes.join(' · ') : undefined };
}

/** Apply demolition losses (checked with `demolitionVerdict`). */
export function applyDemolition(state: GameState, company: number, losses: Map<number, number>): void {
  for (const [id, loss] of losses) {
    const town = state.towns.get(id);
    if (town && changeReputation(town, company, -loss)) state.dirtyTowns.add(id);
  }
}

/**
 * Monthly: each station of a company in a town that vehicles called at in the last 20 days, and
 * that is rated 50% or better, raises its reputation; neglected ones lower it. Bad reputations
 * recover slowly by themselves.
 */
export function monthlyReputation(state: GameState): void {
  const deltas = new Map<Town, Map<number, { up: number; down: number }>>();
  for (const st of state.stations.values()) {
    if (st.townId === null || state.date - st.builtDays < STATION_GRACE_DAYS) continue;
    const town = state.towns.get(st.townId);
    if (!town) continue;
    let byCompany = deltas.get(town);
    if (!byCompany) deltas.set(town, (byCompany = new Map()));
    const d = byCompany.get(st.owner) ?? { up: 0, down: 0 };
    if (st.rating >= 128 && state.date - (st.lastPickup ?? -1e9) <= 20) d.up += STATION_UP;
    else d.down += STATION_DOWN;
    byCompany.set(st.owner, d);
  }
  for (const town of state.towns.values()) {
    const byCompany = deltas.get(town);
    let changed = false;
    for (const [company, d] of byCompany ?? []) {
      if (d.up) changed = changeReputation(town, company, d.up) || changed;
      if (d.down) changed = changeReputation(town, company, -d.down, NEGLECT_FLOOR) || changed;
    }
    for (const [key, r] of Object.entries(town.ratings ?? {})) {
      if (r < 0) changed = changeReputation(town, Number(key), Math.min(RECOVERY, -r)) || changed;
    }
    if (changed) state.dirtyTowns.add(town.id);
  }
}
