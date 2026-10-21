import { lifespan, type TrainInfo } from '@transportsim/shared';

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
