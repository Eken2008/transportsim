import { lifespan, ratingPercent, type Line, type Station, type TrainInfo } from '@transportsim/shared';
import type { ClientWorld } from './clientWorld.ts';

/** Something wrong with a vehicle that its owner should look at. */
export type VehicleIssue = 'loss' | 'old' | 'lost' | 'stopped' | 'noLine';

export const VEHICLE_ISSUE_TEXT: Record<VehicleIssue, string> = {
  loss: 'lost money last year',
  old: 'past its design life',
  lost: 'lost: no route to its next stop',
  stopped: 'stopped outside a depot',
  noLine: 'not on a line',
};

/** Age of a vehicle in years. */
export const vehicleAge = (t: TrainInfo, date: number): number => (date - t.builtDays) / 365;

/** What is wrong with a vehicle, most serious first. */
export function vehicleIssues(t: TrainInfo, date: number): VehicleIssue[] {
  const out: VehicleIssue[] = [];
  const age = vehicleAge(t, date);
  if (t.lost) out.push('lost');
  // A vehicle bought last year hasn't had a whole year to earn its keep.
  if (t.profitLastYear < 0 && age >= 1) out.push('loss');
  if (t.status === 'stopped') out.push('stopped');
  if (t.line === undefined && t.status !== 'depot') out.push('noLine');
  if (age >= lifespan(t.units)) out.push('old');
  return out;
}

/** Cargo waiting at a station above which it counts as piling up (where it starts to hurt the rating). */
export const PILING_UP = 1000;
/** How far (rating points, of 255) below its rating a station's target must be to count as falling. */
export const FALLING_BY = 26;

export type StationIssue = 'falling' | 'pilingUp';

export function stationIssues(st: Station, target: number | undefined): StationIssue[] {
  const out: StationIssue[] = [];
  if (target !== undefined && target <= st.rating - FALLING_BY) out.push('falling');
  if (st.waitingTotal > PILING_UP) out.push('pilingUp');
  return out;
}

/** One thing wrong in a company's network. */
export type Problem =
  | { kind: 'vehicle'; issue: VehicleIssue; vehicle: TrainInfo }
  | { kind: 'station'; issue: StationIssue; station: Station; target?: number }
  | { kind: 'line'; issue: 'empty'; line: Line };

/** Everything wrong with a company's vehicles, stations and lines, grouped by kind of problem. */
export function companyProblems(world: ClientWorld, company: number, date: number): Problem[] {
  const out: Problem[] = [];
  const vehicles = [...world.trains.values()].filter((t) => t.owner === company);
  for (const t of vehicles) for (const issue of vehicleIssues(t, date)) out.push({ kind: 'vehicle', issue, vehicle: t });
  for (const st of world.state.stations.values()) {
    if (st.owner !== company) continue;
    const target = world.ratingTargets.get(st.id);
    for (const issue of stationIssues(st, target)) out.push({ kind: 'station', issue, station: st, target });
  }
  const used = new Set(vehicles.map((t) => t.line));
  for (const line of world.state.lines.values()) if (line.owner === company && !used.has(line.id)) out.push({ kind: 'line', issue: 'empty', line });
  return out;
}

/** What a station problem says, e.g. "rating falling: 64% → 40%". */
export function stationIssueText(issue: StationIssue, st: Station, target?: number): string {
  if (issue === 'pilingUp') return `${st.waitingTotal.toLocaleString('en-GB')} waiting: cargo piling up`;
  return `rating falling: ${ratingPercent(st.rating)}% → ${ratingPercent(target ?? st.rating)}%`;
}
