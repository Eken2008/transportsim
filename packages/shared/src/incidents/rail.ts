import { pieceKey, segTile } from '../rail/network.ts';
import { TICKS_PER_DAY } from '../sim/date.ts';
import type { AccidentSeverity } from '../sim/settings.ts';
import type { GameState } from '../sim/state.ts';
import { Random } from '../util/random.ts';
import { cargoCount, type Train } from '../vehicles/train.ts';

export interface AccidentRules {
  /** How far (tiles) a driver sees a train ahead that signals don't protect against. */
  sight: number;
  /** Running into another train faster than this (km/h) is a collision; slower is a bump. */
  collideAbove: number;
  /** Chance a breakdown at speed is a brake failure (the train coasts and can pass red signals). */
  brakeFailChance: number;
  /** Trains far over a curve's limit derail. */
  derail: boolean;
  /** Compensation: per accident and per passenger aboard. */
  base: number;
  perPassenger: number;
  /** Rating points every station of the company loses. */
  ratingHit: number;
  /** Days the wreckage blocks the track. */
  cleanupDays: number;
}

export const ACCIDENT_RULES: Record<Exclude<AccidentSeverity, 'off'>, AccidentRules> = {
  low: { sight: 8, collideAbove: 25, brakeFailChance: 0.05, derail: false, base: 20_000, perPassenger: 500, ratingHit: 30, cleanupDays: 5 },
  realistic: { sight: 4, collideAbove: 10, brakeFailChance: 0.2, derail: true, base: 60_000, perPassenger: 2_000, ratingHit: 70, cleanupDays: 15 },
};

/** Derailment threshold: this much over the curve limit. */
export const DERAIL_OVERSPEED = 1.3;

/**
 * Rail accidents (when the game has them on): collisions between trains that signals did not
 * keep apart, brake failures that run trains past red signals, and (realistic) derailments
 * from overspeed in curves. Trains involved are destroyed, their track is blocked by wreckage
 * for a while, the owner pays compensation and its stations lose rating.
 */
export class IncidentSystem {
  private rng: Random;

  constructor(private readonly state: GameState) {
    this.rng = new Random(state.settings.seed ^ 0xacc1de);
  }

  get rules(): AccidentRules | null {
    const s = this.state.settings.accidents;
    return s === 'off' ? null : ACCIDENT_RULES[s];
  }

  /** A breakdown at speed may be a brake failure: the train coasts for a while, ignoring signals. */
  onBreakdown(t: Train): void {
    const rules = this.rules;
    if (!rules || t.speed < 30 || !this.rng.chance(rules.brakeFailChance)) return;
    t.brakeFail = Math.round(TICKS_PER_DAY * 0.8);
  }

  /** `t` ran into whatever occupies segment `s` (other trains, or wreckage). */
  collide(t: Train, s: number): void {
    const others = this.state.rail.trainsOn(s, t.id).map((id) => this.state.trains.get(id)!);
    const names = [t, ...others].map((x) => x.name);
    const where = this.placeName(segTile(s));
    const what =
      others.length > 0
        ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)} collide${where}`
        : `${t.name} runs into wreckage${where}`;
    this.wreck([t, ...others], segTile(s), what);
  }

  /** A train runs into road vehicles on a level crossing: they are destroyed, the train carries on. */
  crossingCollision(train: Train, roadVehicles: number[], tile: number): void {
    const victims = roadVehicles.map((id) => this.state.trains.get(id)).filter((t): t is Train => !!t);
    if (!victims.length) return;
    const names = victims.map((v) => v.name).join(' and ');
    this.wreck(victims, tile, `${train.name} hits ${names} at a level crossing${this.placeName(tile)}`, false);
  }

  derail(t: Train): void {
    if (t.path.length === 0) return;
    this.wreck([t], segTile(t.path[0]!), `${t.name} derails on a curve${this.placeName(segTile(t.path[0]!))}`);
  }

  private wreck(trains: Train[], tile: number, what: string, blockTrack = true): void {
    const rules = this.rules ?? ACCIDENT_RULES.low;
    const state = this.state;
    const until = state.tick + rules.cleanupDays * TICKS_PER_DAY;
    let aboard = 0;
    const byOwner = new Map<number, number>();
    const pieces: number[] = [];
    for (const t of trains) {
      const n = cargoCount(t);
      aboard += n;
      byOwner.set(t.owner, (byOwner.get(t.owner) ?? 0) + n);
      if (t.mode !== 'road') for (const s of t.path) pieces.push(pieceKey(s));
      state.removeVehicle(t);
    }
    if (blockTrack) for (const k of pieces) state.rail.addWreck(k, until);
    for (const [owner, n] of byOwner) {
      state.addMoney(owner, -state.cost(rules.base + rules.perPassenger * n), 'incidents');
      for (const st of state.stations.values()) {
        if (st.owner !== owner) continue;
        st.rating = Math.max(0, st.rating - rules.ratingHit);
        state.markStationDirty(st.id);
      }
    }
    const people = aboard > 0 ? `; ${aboard} passengers were aboard` : '';
    const owners = [...byOwner.keys()].map((o) => state.companies.get(o)?.name).filter(Boolean);
    state.addNews('accident', `Rail accident! ${what}${people}. ${owners.join(' and ')} must pay compensation`, {
      company: trains[0]!.owner,
      tile,
    });
  }

  private placeName(tile: number): string {
    const w = this.state.map.width;
    const x = tile % w;
    const y = Math.floor(tile / w);
    let best = '';
    let bestD = Infinity;
    for (const t of this.state.towns.values()) {
      const d = Math.abs(t.x - x) + Math.abs(t.y - y);
      if (d < bestD) {
        bestD = d;
        best = t.name;
      }
    }
    return best ? ` near ${best}` : '';
  }
}
