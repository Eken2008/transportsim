import { pieceKey, segLength, segPoint, segTd, segTile } from '../rail/network.ts';
import { segHeights, spanOver } from '../rail/structures.ts';
import { isSpanTd } from '../rail/track.ts';
import { roadSegPoint, rsLength } from '../road/roadNetwork.ts';
import { waterLevelAtPoint } from '../water/waterways.ts';
import { TICKS_PER_DAY } from '../sim/date.ts';
import type { AccidentSeverity } from '../sim/settings.ts';
import type { GameState } from '../sim/state.ts';
import { Random } from '../util/random.ts';
import { cargoCount, isRailVehicle, UNIT_GAP, type Train } from '../vehicles/train.ts';
import { vehicleMode, type VehicleMode } from '../vehicles/lines.ts';
import { isHeavy } from '../vehicles/airSystem.ts';
import { railVehicle } from '../vehicles/catalog.ts';
import type { Station } from '../rail/station.ts';

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

/** One wrecked vehicle unit, lying where its accident left it until the wreckage is cleared. */
export interface Wreck {
  type: string;
  owner: number;
  mode: 'rail' | 'road' | 'air' | 'water';
  /** Tile-space centre, and its height in map levels. */
  x: number;
  y: number;
  z: number;
  /** Direction it was heading (radians, map x towards map y). */
  heading: number;
  /** Tick the wreckage is cleared. */
  until: number;
}

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
  /** Wrecked vehicles still lying where they crashed. */
  readonly wreckage: Wreck[] = [];
  /** Bumped whenever `wreckage` changes. */
  wreckageVersion = 0;

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
    if (t.mode === 'air') {
      // An aircraft breaking down in flight may crash.
      const flying = t.air && ['flying', 'holding', 'takeoff', 'landing'].includes(t.air.phase);
      if (rules && flying && this.rng.chance(rules === ACCIDENT_RULES.realistic ? 0.1 : 0.02)) {
        const tile = this.tileOf(t);
        this.wreck([t], tile, `${t.name} crashes after an engine failure${this.placeName(tile)}`, `Its engine failed in flight. ${this.upkeep(t)}`, false);
      }
      return;
    }
    if (t.mode === 'water') {
      // A ship that breaks down at sea may founder; its wreck closes the tile for a while.
      if (rules && t.ship && this.rng.chance(rules === ACCIDENT_RULES.realistic ? 0.06 : 0.015)) {
        const tile = this.tileOf(t);
        this.state.ships.wrecks.set(tile, this.state.tick + rules.cleanupDays * TICKS_PER_DAY);
        this.wreck([t], tile, `${t.name} founders after a breakdown${this.placeName(tile)}`, `It broke down on the water. ${this.upkeep(t)}`, false);
      }
      return;
    }
    if (t.mode === 'road') return;
    if (!rules || t.speed < 30 || !this.rng.chance(rules.brakeFailChance)) return;
    t.brakeFail = Math.round(TICKS_PER_DAY * 0.8);
  }

  /** `t` ran into whatever occupies segment `s` (other trains, or wreckage); `cause` says why. */
  collide(t: Train, s: number, cause: string): void {
    const others = this.state.rail.trainsOn(s, t.id).map((id) => this.state.trains.get(id)!);
    const names = [t, ...others].map((x) => x.name);
    const where = this.placeName(segTile(s));
    const what =
      others.length > 0
        ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)} collide${where}`
        : `${t.name} runs into wreckage${where}`;
    this.wreck([t, ...others], segTile(s), what, cause);
  }

  /** A train runs into road vehicles on a level crossing: they are destroyed, the train carries on. */
  crossingCollision(train: Train, roadVehicles: number[], tile: number): void {
    const victims = roadVehicles.map((id) => this.state.trains.get(id)).filter((t): t is Train => !!t);
    if (!victims.length) return;
    const names = victims.map((v) => v.name).join(' and ');
    const v = victims[0]!;
    const why = v.brokenDown ? 'had broken down' : v.speed < 1 ? 'was stuck in traffic' : 'was still crossing';
    const cause = `${v.name} ${why} on the crossing when ${train.name} arrived; a train cannot stop for road vehicles in its way.`;
    this.wreck(victims, tile, `${train.name} hits ${names} at a level crossing${this.placeName(tile)}`, cause, false);
  }

  /** An aircraft too heavy for a small airport may crash on landing, closing its runway. */
  onLanded(t: Train, airport: Station): void {
    const rules = this.rules;
    if (!rules || airport.airport?.kind !== 'small' || !isHeavy(t.units[0]!.type)) return;
    if (!this.rng.chance(rules === ACCIDENT_RULES.realistic ? 0.08 : 0.02)) return;
    this.state.air.runwayClosed.set(airport.id, this.state.tick + rules.cleanupDays * TICKS_PER_DAY);
    const type = railVehicle(t.units[0]!.type)?.name ?? t.name;
    const cause = `The ${type} is a heavy aircraft that needs a city airport's long runway; on a small airport it may overrun.`;
    this.wreck([t], this.tileOf(t), `${t.name} crashes landing at ${airport.name}, too small an airport for it`, cause, false);
  }

  /** Reliability and servicing, behind a breakdown. */
  /** Clear wreckage whose cleanup time has passed. */
  clearWreckage(): void {
    const tick = this.state.tick;
    const left = this.wreckage.filter((w) => w.until > tick);
    if (left.length === this.wreckage.length) return;
    this.wreckage.splice(0, this.wreckage.length, ...left);
    this.wreckageVersion++;
  }

  /** Where each unit of `t` is now (as wreckage lasting until `until`). */
  private wreckOf(t: Train, until: number): Wreck[] {
    const map = this.state.map;
    const mode = t.mode ?? 'rail';
    const type = t.units[0]!.type;
    const at = (x: number, y: number, z: number, heading: number, type: string): Wreck => ({ type, owner: t.owner, mode, x, y, z, heading, until });
    if (t.air) return [at(t.air.x, t.air.y, map.heightAt(t.air.x, t.air.y), t.air.heading, type)];
    if (t.ship) return [at(t.ship.x, t.ship.y, waterLevelAtPoint(map, t.ship.x, t.ship.y), t.ship.heading, type)];
    if (!t.path.length) return [];
    const road = mode === 'road';
    const len = road ? rsLength : segLength;
    /** Point `back` tiles behind the head, or null past the end of the path (or inside a tunnel). */
    const point = (back: number): { x: number; y: number; z: number } | null => {
      let i = 0;
      let d = t.pos - back;
      while (d < 0 && i < t.path.length - 1) d += len(t.path[++i]!);
      if (d < 0) return null;
      const s = t.path[i]!;
      if (road) {
        const p = roadSegPoint(map, s, d);
        return { x: p.x, y: p.y, z: map.heightAt(p.x, p.y) };
      }
      const td = segTd(s);
      if (isSpanTd(td) && spanOver(map, segTile(s), td < 14 ? 0 : 1)?.kind === 'tunnel') return null;
      const p = segPoint(map, s, d);
      const [ha, hb] = segHeights(map, segTile(s), td);
      return { x: p.x, y: p.y, z: ha + ((hb - ha) * d) / len(s) };
    };
    const out: Wreck[] = [];
    let offset = 0;
    for (const u of t.units) {
      const v = railVehicle(u.type);
      if (!v) continue;
      const l = v.length / 16;
      const f = point(offset);
      const b = point(offset + l);
      offset += l + UNIT_GAP;
      if (!f || !b) continue;
      out.push(at((f.x + b.x) / 2, (f.y + b.y) / 2, (f.z + b.z) / 2, Math.atan2(f.y - b.y, f.x - b.x), u.type));
    }
    return out;
  }

  private upkeep(t: Train): string {
    const r = Math.round((t.reliability ?? 1) * 100);
    const since = this.state.date - (t.lastService ?? t.builtDays);
    const service = t.lastService === undefined ? `never serviced in ${since} days` : `last serviced ${since} days ago`;
    return `Its reliability was ${r}% (${service}); breakdowns get likelier as reliability drops, and servicing restores it.`;
  }

  private tileOf(t: Train): number {
    const w = this.state.map.width;
    const at = t.air ?? t.ship;
    const x = Math.max(0, Math.min(w - 1, Math.floor(at?.x ?? 0)));
    const y = Math.max(0, Math.min(this.state.map.height - 1, Math.floor(at?.y ?? 0)));
    return y * w + x;
  }

  derail(t: Train, cause: string): void {
    if (t.path.length === 0) return;
    this.wreck([t], segTile(t.path[0]!), `${t.name} derails on a curve${this.placeName(segTile(t.path[0]!))}`, cause);
  }

  private wreck(trains: Train[], tile: number, what: string, cause: string, blockTrack = true): void {
    const rules = this.rules ?? ACCIDENT_RULES.low;
    const state = this.state;
    const until = state.tick + rules.cleanupDays * TICKS_PER_DAY;
    let aboard = 0;
    const byOwner = new Map<number, number>();
    /** Each owner's loss is booked to the kind of vehicle it lost. */
    const modeOf = new Map<number, VehicleMode>();
    const pieces: number[] = [];
    for (const t of trains) {
      const n = cargoCount(t);
      aboard += n;
      byOwner.set(t.owner, (byOwner.get(t.owner) ?? 0) + n);
      if (!modeOf.has(t.owner)) modeOf.set(t.owner, vehicleMode(t));
      if (isRailVehicle(t)) for (const s of t.path) pieces.push(pieceKey(s));
      this.wreckage.push(...this.wreckOf(t, until));
      state.removeVehicle(t);
    }
    this.wreckageVersion++;
    if (blockTrack) for (const k of pieces) state.rail.addWreck(k, until);
    for (const [owner, n] of byOwner) {
      state.addMoney(owner, -state.cost(rules.base + rules.perPassenger * n), 'incidents', modeOf.get(owner));
      for (const st of state.stations.values()) {
        if (st.owner !== owner) continue;
        st.rating = Math.max(0, st.rating - rules.ratingHit);
        state.markStationDirty(st.id);
      }
    }
    const people = aboard > 0 ? `; ${aboard} passengers were aboard` : '';
    const owners = [...byOwner.keys()].map((o) => state.companies.get(o)?.name).filter(Boolean);
    const head = trains[0]!.mode === 'air' ? 'Air crash!' : trains[0]!.mode === 'water' ? 'Shipwreck!' : 'Rail accident!';
    state.addNews('accident', `${head} ${what}${people}. ${owners.join(' and ')} must pay compensation`, {
      company: trains[0]!.owner,
      tile,
      detail: cause,
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
