import { TICKS_PER_DAY } from '../sim/date.ts';
import type { GameState } from '../sim/state.ts';
import { targetCode, type Train } from './train.ts';

/** Days a vehicle may go without a route to its next stop before its owner is told it is lost. */
export const LOST_DAYS = 3;

/** A vehicle found no route to its current order: start counting (unless it has nowhere to go). */
export function noRoute(state: GameState, t: Train): void {
  if (targetCode(t) < 0) return;
  t.noRouteSince ??= state.tick;
}

/** A vehicle found a route: it is no longer lost. */
export function foundRoute(state: GameState, t: Train): void {
  t.noRouteSince = undefined;
  if (!t.lost) return;
  t.lost = false;
  state.dirtyTrains.add(t.id);
}

const HINTS: Record<string, string> = {
  rail: 'No track leads there from where it is. Look for gaps, signals facing the wrong way, track it may not use, or (for electric engines) track without electrification.',
  road: 'No road leads there from where it is. Look for gaps, one-way roads, and whether the stop takes buses or trucks.',
  water: 'No waterway leads there from where it is. Look for gaps in canals, locks, and whether the dock is still there.',
};

/** What a vehicle is trying to reach, for the warning. */
function destination(state: GameState, t: Train): string {
  if (t.toDepot || t.serviceTrip) return 'a depot';
  const o = t.orders[t.orderIndex];
  if (o?.kind === 'station') return state.stations.get(o.station)?.name ?? 'its next station';
  if (o?.kind === 'waypoint') return state.waypoints.get(o.waypoint)?.name ?? 'its next waypoint';
  return 'a depot';
}

/** Where a vehicle is (for "show on the map"). */
function tileOf(state: GameState, t: Train): number | undefined {
  const map = state.map;
  const at = t.ship ?? t.air;
  if (at) return Math.max(0, Math.min(map.height - 1, Math.floor(at.y))) * map.width + Math.max(0, Math.min(map.width - 1, Math.floor(at.x)));
  if (t.path.length) return Math.floor(t.path[0]! / 16);
  return t.depot >= 0 ? t.depot : undefined;
}

/** Daily: warn the owner (once) about vehicles that have gone LOST_DAYS without a route. */
export function warnLost(state: GameState): void {
  for (const t of state.trains.values()) {
    if (t.noRouteSince === undefined) continue;
    if (t.status === 'depot' || targetCode(t) < 0) {
      foundRoute(state, t);
      continue;
    }
    if (t.lost || t.status !== 'running' || state.tick - t.noRouteSince < LOST_DAYS * TICKS_PER_DAY) continue;
    t.lost = true;
    state.dirtyTrains.add(t.id);
    const c = state.companies.get(t.owner);
    const owner = c ? ` of ${c.name}` : '';
    state.addNews('vehicle', `${t.name}${owner} is lost: it can't find a route to ${destination(state, t)}`, {
      company: t.owner,
      tile: tileOf(state, t),
      vehicle: t.id,
      detail: HINTS[t.mode ?? 'rail'],
    });
  }
}
