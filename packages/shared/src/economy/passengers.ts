import { STATION_CATCHMENT, type Station } from '../rail/station.ts';
import type { GameState } from '../sim/state.ts';
import { houseType } from '../town/houses.ts';
import { TileType } from '../world/constants.ts';
import { Random } from '../util/random.ts';
import type { Train } from '../vehicles/train.ts';

/** Money per passenger per tile of (Manhattan) distance, for a prompt journey. */
export const PASSENGER_RATE = 0.45;
/** Passengers generated per day per resident in a station's catchment, at full rating. */
const GENERATION_PER_RESIDENT = 1 / 45;
/** Waiting passengers beyond this many per catchment resident start giving up. */
const WAIT_CAP_PER_RESIDENT = 0.35;

/** Payment for `n` passengers carried `dist` tiles in `days` days. */
export function passengerPayment(n: number, dist: number, days: number): number {
  const prompt = 2 + dist / 10;
  const factor = days <= prompt ? 1 : Math.max(0.3, 1 - ((days - prompt) / (prompt * 2)) * 0.7);
  return Math.round(n * dist * PASSENGER_RATE * factor);
}

export interface IncomeEvent {
  tile: number;
  amount: number;
  owner: number;
}

/**
 * Destination-based passengers. Each station collects passengers from the houses in its
 * catchment and assigns each a destination among the stations its company's trains link it
 * to (weighted by destination population). Trains unload passengers at their destination,
 * get paid by distance and journey time, and load passengers for their other stops.
 */
export class PassengerSystem {
  /** Station id → residents in its catchment (shared houses split between stations). */
  private catchmentPop = new Map<number, number>();
  /** Station id → stations reachable by a direct train service. */
  private links = new Map<number, number[]>();
  private rng: Random;
  /** Income events since the last flush (for floating "+£" labels). */
  readonly events: IncomeEvent[] = [];

  constructor(private readonly state: GameState) {
    this.rng = new Random(state.settings.seed ^ 0x9a55e9);
  }

  population(stationId: number): number {
    return this.catchmentPop.get(stationId) ?? 0;
  }

  /** Recompute catchments and service links (cheap enough to do daily). */
  refresh(): void {
    const map = this.state.map;
    const cover = new Map<number, number[]>();
    for (const st of this.state.stations.values()) {
      const x0 = Math.max(0, st.x0 - STATION_CATCHMENT);
      const y0 = Math.max(0, st.y0 - STATION_CATCHMENT);
      const x1 = Math.min(map.width - 1, st.x1 + STATION_CATCHMENT);
      const y1 = Math.min(map.height - 1, st.y1 + STATION_CATCHMENT);
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const i = map.tileIndex(x, y);
          if (map.layers.type[i] !== TileType.House) continue;
          let list = cover.get(i);
          if (!list) cover.set(i, (list = []));
          list.push(st.id);
        }
      }
    }
    this.catchmentPop.clear();
    for (const [i, ids] of cover) {
      const pop = houseType(map.layers.data[i]!).population / ids.length;
      for (const id of ids) this.catchmentPop.set(id, (this.catchmentPop.get(id) ?? 0) + pop);
    }

    const links = new Map<number, Set<number>>();
    for (const t of this.state.trains.values()) {
      const stops = [...new Set(t.orders.flatMap((o) => (o.kind === 'station' ? [o.station] : [])))];
      for (const a of stops) {
        let set = links.get(a);
        if (!set) links.set(a, (set = new Set()));
        for (const b of stops) if (b !== a) set.add(b);
      }
    }
    this.links.clear();
    for (const [a, set] of links) this.links.set(a, [...set].filter((b) => (this.catchmentPop.get(b) ?? 0) > 0));
  }

  /** Daily: generate passengers, let excess give up, update ratings. */
  daily(): void {
    this.refresh();
    for (const st of this.state.stations.values()) {
      this.updateRating(st);
      const pop = this.catchmentPop.get(st.id) ?? 0;
      const dests = this.links.get(st.id) ?? [];
      let changed = false;
      // Passengers for destinations no longer served drift away.
      for (const key of Object.keys(st.waiting)) {
        const d = Number(key);
        if (!dests.includes(d)) {
          const left = Math.floor(st.waiting[d]! * 0.8);
          setWaiting(st, d, left);
          changed = true;
        }
      }
      if (pop > 0 && dests.length > 0) {
        const expected = pop * GENERATION_PER_RESIDENT * (st.rating / 255);
        let n = Math.floor(expected) + (this.rng.next() < expected % 1 ? 1 : 0);
        const weights = dests.map((d) => this.catchmentPop.get(d) ?? 0);
        const total = weights.reduce((a, b) => a + b, 0);
        while (n > 0 && total > 0) {
          let r = this.rng.next() * total;
          let k = 0;
          while (k < dests.length - 1 && r >= weights[k]!) r -= weights[k++]!;
          const batch = Math.max(1, Math.ceil(n / 4));
          setWaiting(st, dests[k]!, (st.waiting[dests[k]!] ?? 0) + batch);
          n -= batch;
          changed = true;
        }
        // Overcrowded stations lose passengers.
        const cap = pop * WAIT_CAP_PER_RESIDENT + 40;
        if (st.waitingTotal > cap) {
          const keep = cap / st.waitingTotal;
          for (const key of Object.keys(st.waiting)) setWaiting(st, Number(key), Math.floor(st.waiting[Number(key)]! * keep));
        }
      }
      if (changed) this.state.markStationDirty(st.id);
    }
  }

  private updateRating(st: Station): void {
    const days = this.state.date - (st.lastPickup ?? st.builtDays);
    let target = 170;
    if (days <= 7) target += 45;
    target -= Math.min(110, Math.max(0, days - 7) * 3);
    target -= Math.min(60, st.waitingTotal / 25);
    target = Math.max(20, Math.min(255, target));
    const before = st.rating;
    st.rating += Math.sign(target - st.rating) * Math.min(6, Math.abs(target - st.rating));
    if (Math.round(before) !== Math.round(st.rating)) this.state.markStationDirty(st.id);
  }

  /** Train arrived at a platform: pay for passengers whose destination this is, then load. */
  arrive(t: Train, stationId: number): void {
    const st = this.state.stations.get(stationId);
    if (!st) return;
    if (st.firstArrival === undefined) {
      st.firstArrival = this.state.date;
      const owner = this.state.companies.get(t.owner)?.name ?? 'A company';
      this.state.addNews('station', `Citizens celebrate! The first train arrives at ${st.name} (${owner})`, {
        company: t.owner,
        tile: st.y * this.state.map.width + st.x,
      });
    }
    let income = 0;
    const keep = [];
    for (const p of t.cargo) {
      if (p.dest !== stationId) {
        keep.push(p);
        continue;
      }
      const src = this.state.stations.get(p.src);
      const dist = src ? Math.abs(src.x - st.x) + Math.abs(src.y - st.y) : 0;
      income += passengerPayment(p.n, dist, this.state.date - p.day);
    }
    t.cargo = keep;
    if (income > 0) {
      t.profitThisYear += income;
      const c = this.state.companies.get(t.owner);
      if (c) c.money += income;
      this.events.push({ tile: st.y * this.state.map.width + st.x, amount: income, owner: t.owner });
    }
    this.load(t, st);
  }

  /** While standing at a platform: keep topping up; returns true to keep waiting (full load). */
  loading(t: Train, stationId: number): boolean {
    const st = this.state.stations.get(stationId);
    if (!st) return false;
    this.load(t, st);
    const order = t.orders[t.orderIndex];
    const full = t.cargo.reduce((s, p) => s + p.n, 0) >= this.state.rail.statsOf(t).capacity;
    return order?.kind === 'station' && order.station === stationId && order.fullLoad === true && !full;
  }

  private load(t: Train, st: Station): void {
    const capacity = this.state.rail.statsOf(t).capacity;
    let room = capacity - t.cargo.reduce((s, p) => s + p.n, 0);
    if (room <= 0) return;
    // Next stops first, so passengers for the nearest destination board first.
    const stops: number[] = [];
    for (let k = 1; k <= t.orders.length; k++) {
      const o = t.orders[(t.orderIndex + k) % t.orders.length]!;
      if (o.kind === 'station' && o.station !== st.id && !stops.includes(o.station)) stops.push(o.station);
    }
    let boarded = 0;
    for (const dest of stops) {
      const waiting = st.waiting[dest] ?? 0;
      const n = Math.min(waiting, room);
      if (n <= 0) continue;
      setWaiting(st, dest, waiting - n);
      const same = t.cargo.find((p) => p.dest === dest && p.src === st.id && p.day === this.state.date);
      if (same) same.n += n;
      else t.cargo.push({ dest, src: st.id, n, day: this.state.date });
      room -= n;
      boarded += n;
      if (room <= 0) break;
    }
    if (boarded > 0) {
      st.lastPickup = this.state.date;
      this.state.markStationDirty(st.id);
      this.state.dirtyTrains.add(t.id);
    }
  }
}

function setWaiting(st: Station, dest: number, n: number): void {
  const before = st.waiting[dest] ?? 0;
  if (n > 0) st.waiting[dest] = n;
  else delete st.waiting[dest];
  st.waitingTotal += Math.max(0, n) - before;
}
