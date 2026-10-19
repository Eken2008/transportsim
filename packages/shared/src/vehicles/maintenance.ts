import { resaleValue } from '../economy/finance.ts';
import { isElectrified } from '../rail/railTypes.ts';
import { TICKS_PER_DAY, ymdFromDays } from '../sim/date.ts';
import type { GameState } from '../sim/state.ts';
import { Random } from '../util/random.ts';
import { isAvailable, railVehicle } from './catalog.ts';
import { trainStats, type Train, type TrainUnit } from './train.ts';

/** Reliability lost per day between services. */
export const RELIABILITY_DECAY_PER_DAY = 0.0015;
/** Longest train (tiles), shared with the consist commands. */
export const MAX_TRAIN_TILES = 16;

/** Reliability of a new train: its least reliable engine. */
export function baseReliability(units: readonly TrainUnit[]): number {
  let r = 1;
  for (const u of units) {
    const v = railVehicle(u.type);
    if (v?.kind === 'loco') r = Math.min(r, v.reliability);
  }
  return r;
}

/** Design life (years) of a train: its shortest-lived engine. */
export function lifespan(units: readonly TrainUnit[]): number {
  let years = Infinity;
  for (const u of units) {
    const v = railVehicle(u.type);
    if (v?.kind === 'loco') years = Math.min(years, v.lifespan);
  }
  return years === Infinity ? 40 : years;
}

/** Best reliability a service can restore: falls 6% a year once a train outlives its design life. */
export function maxReliability(t: Train, date: number): number {
  const age = (date - t.builtDays) / 365;
  const over = Math.max(0, age - lifespan(t.units));
  return baseReliability(t.units) * Math.max(0.3, 1 - 0.06 * over);
}

/** Daily chance of a breakdown at a given reliability. */
export const breakdownChance = (reliability: number): number => 0.03 * Math.pow(Math.max(0, 1 - reliability), 1.5);

/**
 * Reliability, breakdowns, servicing and renewal. Reliability decays every day and a depot
 * visit restores it; with breakdowns on, unreliable trains break down and stand still for a
 * while. On a depot visit, the company's autorenew and replacement rules are applied.
 */
export class MaintenanceSystem {
  private rng: Random;
  /** Called when a train breaks down (accident rules hook in here). */
  onBreakdown: ((t: Train) => void) | null = null;

  constructor(private readonly state: GameState) {
    this.rng = new Random(state.settings.seed ^ 0xb7ea4d);
  }

  daily(): void {
    const state = this.state;
    for (const t of state.trains.values()) {
      if (t.reliability === undefined) t.reliability = maxReliability(t, state.date);
      if (t.status === 'depot') continue;
      const before = Math.round(t.reliability * 100);
      t.reliability = Math.max(0, t.reliability - RELIABILITY_DECAY_PER_DAY);
      if (Math.round(t.reliability * 100) !== before) state.dirtyTrains.add(t.id);
      if (state.settings.breakdowns && t.status === 'running' && !t.brokenDown && t.speed > 1) {
        if (this.rng.chance(breakdownChance(t.reliability))) {
          t.brokenDown = Math.round((TICKS_PER_DAY * this.rng.int(15, 40)) / 10);
          t.breakdowns = (t.breakdowns ?? 0) + 1;
          state.dirtyTrains.add(t.id);
          this.onBreakdown?.(t);
        }
      }
      // Once a train outlives its design life, say so (once).
      if (!t.oldWarned && (state.date - t.builtDays) / 365 >= lifespan(t.units)) {
        t.oldWarned = true;
        const c = state.companies.get(t.owner);
        if (c && !c.autorenew) state.addNews('vehicle', `${t.name} of ${c.name} is getting old and will break down more often`, { company: c.id });
      }
    }
  }

  /** A depot visit: renew or replace vehicles by the company's rules, then restore reliability. */
  service(t: Train): void {
    this.renew(t);
    t.reliability = maxReliability(t, this.state.date);
    t.brokenDown = 0;
    this.state.dirtyTrains.add(t.id);
  }

  /** Apply autorenew (old trains get new vehicles of the same types) and replacement rules. */
  renew(t: Train): boolean {
    const state = this.state;
    const c = state.companies.get(t.owner);
    if (!c || t.depot < 0) return false;
    const year = ymdFromDays(state.date).year;
    const age = (state.date - t.builtDays) / 365;
    const old = c.autorenew && age >= lifespan(t.units);
    const units = t.units.map((u) => {
      const to = c.replace[u.type];
      const v = to ? railVehicle(to) : undefined;
      if (v && isAvailable(v, year, state.settings.timeline)) return to!;
      if (old && isAvailable(railVehicle(u.type)!, year, state.settings.timeline)) return u.type;
      return null;
    });
    if (units.every((u) => u === null)) return false;
    const next = t.units.map((u, i) => ({ type: units[i] ?? u.type }));
    if (railVehicle(next[0]!.type)?.kind !== 'loco') return false;
    if (trainStats(next).length > MAX_TRAIN_TILES) return false;
    if (next.some((u) => railVehicle(u.type)?.traction === 'electric') && !isElectrified(state.map.layers.railType[t.depot]!)) return false;
    let bought = 0;
    let refund = 0;
    units.forEach((u, i) => {
      if (u === null) return;
      bought += state.cost(railVehicle(u)!.cost);
      refund += resaleValue(state.cost(railVehicle(t.units[i]!.type)!.cost), age);
    });
    const cost = bought - refund;
    if ((state.companies.get(t.owner)?.money ?? 0) < cost) return false;
    const engineNew = units[0] !== null;
    t.units = next;
    t.value = Math.max(0, t.value + bought - refund);
    if (engineNew) {
      t.builtDays = state.date;
      t.oldWarned = false;
    }
    state.rail.invalidateStats(t);
    state.addMoney(t.owner, -cost, 'vehicles');
    state.dirtyTrains.add(t.id);
    return true;
  }
}
