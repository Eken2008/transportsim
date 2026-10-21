import type { GameState } from '../sim/state.ts';
import { TICKS_PER_DAY } from '../sim/date.ts';
import type { Line } from './lines.ts';
import type { Train } from './train.ts';

/**
 * Even spacing: a line can name one of its stations as a timing point. A vehicle leaving it
 * waits until the gap since the previous vehicle on the line left is at least the line's
 * round-trip time divided by the number of vehicles running on it. The round trip is measured
 * from the vehicles' own runs (leaving the timing point to leaving it again, less any time held
 * there for spacing), so no timetable is needed.
 */

/** Departure gaps kept for the line window (days). */
export const SPACING_GAPS_KEPT = 8;
/** Weight of a new round-trip sample in the line's running average. */
const LAP_WEIGHT = 0.3;

/** Index of the order that is the line's timing point: the first visit to its spacing station. */
export function timingOrder(line: Line): number {
  if (line.spacing === undefined) return -1;
  return line.orders.findIndex((o) => o.kind === 'station' && o.station === line.spacing);
}

/** Vehicles on a line that are out running it (not parked or stopped by the player). */
export function runningOn(state: GameState, lineId: number): number {
  let n = 0;
  for (const t of state.trains.values()) if (t.line === lineId && t.status !== 'depot' && t.status !== 'stopped') n++;
  return n;
}

/** The gap (ticks) the line aims for between departures from its timing point, or 0 if none yet. */
export function targetGap(state: GameState, line: Line): number {
  if (line.lap === undefined) return 0;
  const n = runningOn(state, line.id);
  return n >= 2 ? line.lap / n : 0;
}

/**
 * Called every tick a vehicle stands at a stop, after cargo has had its say (`keep`: cargo
 * wants it to stay, for a full load). Returns true to hold it for spacing. The vehicle
 * systems depart a vehicle on the tick this hook (with cargo's) says not to keep it and its
 * dwell time is up, so that is when a departure is recorded.
 */
export function spacingAtStop(state: GameState, t: Train, station: number, keep: boolean): boolean {
  const line = t.line !== undefined ? state.lines.get(t.line) : undefined;
  if (!line || line.spacing !== station || t.orderIndex !== timingOrder(line)) return false;
  if (keep || t.loadTicks > 0) return false;
  const gap = targetGap(state, line);
  if (gap > 0 && line.lastDeparture !== undefined && state.tick - line.lastDeparture < gap) {
    t.spacingHeld = (t.spacingHeld ?? 0) + 1;
    return true;
  }
  departed(state, t, line);
  return false;
}

/** A vehicle leaves the timing point: measure its round trip and the gap to the one before it. */
function departed(state: GameState, t: Train, line: Line): void {
  const now = state.tick;
  if (t.lapStart !== undefined) {
    const sample = now - t.lapStart - (t.spacingHeld ?? 0);
    if (sample > 0) {
      // Breakdowns and detours make some laps long; one sample can at most double the average.
      line.lap = line.lap === undefined ? sample : Math.round(line.lap * (1 - LAP_WEIGHT) + Math.min(sample, line.lap * 2) * LAP_WEIGHT);
    }
  }
  t.lapStart = now;
  t.spacingHeld = 0;
  if (line.lastDeparture !== undefined) {
    const gap = Math.round(((now - line.lastDeparture) / TICKS_PER_DAY) * 10) / 10;
    line.gaps = [...(line.gaps ?? []), gap].slice(-SPACING_GAPS_KEPT);
  }
  line.lastDeparture = now;
  state.dirtyLines.add(line.id);
  state.dirtyTrains.add(t.id);
}

/** Forget what was measured (the line's stops or timing point changed). */
export function resetSpacing(state: GameState, line: Line): void {
  line.lap = undefined;
  line.lastDeparture = undefined;
  line.gaps = undefined;
  for (const t of state.trains.values()) {
    if (t.line !== line.id) continue;
    t.lapStart = undefined;
    t.spacingHeld = undefined;
  }
}
