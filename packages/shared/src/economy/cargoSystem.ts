import { STATION_CATCHMENT, type Station } from '../rail/station.ts';
import type { GameState } from '../sim/state.ts';
import { houseType } from '../town/houses.ts';
import { TileType } from '../world/constants.ts';
import { Random } from '../util/random.ts';
import { cargoCount, type Train } from '../vehicles/train.ts';
import { CARGO_IDS, cargoPayment, type CargoId } from './cargo.ts';
import { RATING_STEP, ratingParts } from './rating.ts';

/** Passengers generated per day per resident in a station's catchment, at full rating. */
const GENERATION_PER_RESIDENT = 1 / 45;
/** Mail per day per resident, at full rating. */
const MAIL_PER_RESIDENT = 1 / 160;
/** Waiting cargo beyond this many per catchment resident (or per monthly unit) starts giving up. */
const WAIT_CAP_PER_RESIDENT = 0.35;
/** Packets kept per station (smaller ones are merged when over). */
const MAX_PACKETS = 400;

/** Payment for `n` passengers carried `dist` tiles in `days` days. */
export function passengerPayment(n: number, dist: number, days: number): number {
  return cargoPayment('passengers', n, dist, days);
}

/** Cargo waiting at a station: `n` units of `cargo` from station `src` (since day `day`) bound for `dest`. */
export interface StationPacket {
  cargo: CargoId;
  dest: number;
  src: number;
  n: number;
  day: number;
}

export interface IncomeEvent {
  tile: number;
  amount: number;
  owner: number;
}

/** Everything a station's catchment supplies and accepts, recomputed daily. */
interface Catchment {
  residents: number;
  /** Residents it draws from after competition with other stations. */
  share: number;
}

/**
 * Cargo handling. Stations collect passengers and mail from the houses in their catchment, and
 * each unit gets a destination among the stations its trains link it to, weighted by what the
 * destination draws. Trains unload cargo at its destination (getting paid by distance and
 * time) and load cargo for their next stops.
 */
export class CargoSystem {
  private catch = new Map<number, Catchment>();
  /** cargo → station → stations reachable by a direct train service carrying that cargo. */
  private links = new Map<CargoId, Map<number, number[]>>();
  /** Packets waiting at each station. */
  readonly packets = new Map<number, StationPacket[]>();
  private rng: Random;
  /** Income events since the last flush (for floating "+£" labels). */
  readonly events: IncomeEvent[] = [];

  constructor(private readonly state: GameState) {
    this.rng = new Random(state.settings.seed ^ 0x9a55e9);
  }

  population(stationId: number): number {
    return this.catch.get(stationId)?.residents ?? 0;
  }

  /** Residents the station draws from, after competition with other stations. */
  share(stationId: number): number {
    return this.catch.get(stationId)?.share ?? 0;
  }

  /** Direct destinations of a station for a cargo. */
  destinations(cargo: CargoId, station: number): readonly number[] {
    return this.links.get(cargo)?.get(station) ?? [];
  }

  // ---- packets -----------------------------------------------------------------

  packetsAt(stationId: number): StationPacket[] {
    let list = this.packets.get(stationId);
    if (!list) this.packets.set(stationId, (list = []));
    return list;
  }

  /** Add cargo to a station, merging with a packet of the same origin and age. */
  addWaiting(st: Station, p: StationPacket): void {
    if (p.n <= 0) return;
    const list = this.packetsAt(st.id);
    const same = list.find((q) => q.cargo === p.cargo && q.dest === p.dest && q.src === p.src && q.day === p.day);
    if (same) same.n += p.n;
    else list.push({ ...p });
    if (list.length > MAX_PACKETS) this.compact(list);
    this.summarise(st);
  }

  /** Merge packets with the same cargo and destination, keeping the oldest day. */
  private compact(list: StationPacket[]): void {
    const by = new Map<string, StationPacket>();
    for (const p of list) {
      const k = `${p.cargo}:${p.dest}`;
      const q = by.get(k);
      if (q) {
        q.n += p.n;
        q.day = Math.min(q.day, p.day);
      } else by.set(k, { ...p });
    }
    list.length = 0;
    list.push(...by.values());
  }

  /** Rebuild a station's waiting summary (sent to clients) from its packets. */
  summarise(st: Station): void {
    const waiting: Station['waiting'] = {};
    let total = 0;
    for (const p of this.packets.get(st.id) ?? []) {
      const by = (waiting[p.cargo] ??= {});
      by[p.dest] = (by[p.dest] ?? 0) + p.n;
      total += p.n;
    }
    st.waiting = waiting;
    st.waitingTotal = total;
    this.state.markStationDirty(st.id);
  }

  /** Scale a station's waiting cargo of one kind (cargo giving up), dropping empty packets. */
  private scaleWaiting(st: Station, keep: (p: StationPacket) => number): void {
    const list = this.packets.get(st.id);
    if (!list) return;
    for (const p of list) p.n = Math.floor(p.n * keep(p));
    this.packets.set(
      st.id,
      list.filter((p) => p.n > 0),
    );
    this.summarise(st);
  }

  // ---- catchment and links -----------------------------------------------------

  /**
   * Recompute catchments, acceptance, service links and shares (cheap enough to do daily). A
   * house covered by several served stations splits its residents between them in proportion
   * to their ratings; stations no train serves yet don't compete.
   */
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
    this.catch.clear();
    for (const st of this.state.stations.values()) this.catch.set(st.id, { residents: 0, share: 0 });
    for (const [i, ids] of cover) {
      const pop = houseType(map.layers.data[i]!).population;
      for (const id of ids) this.catch.get(id)!.residents += pop;
    }
    for (const st of this.state.stations.values()) {
      const accepts: CargoId[] = this.catch.get(st.id)!.residents > 0 ? ['passengers', 'mail'] : [];
      if (accepts.join() !== (st.accepts ?? []).join()) {
        st.accepts = accepts;
        this.state.markStationDirty(st.id);
      }
    }

    // Direct links per cargo: stations that a train carrying the cargo calls at in turn.
    this.links.clear();
    for (const t of this.state.trains.values()) {
      const caps = this.state.rail.statsOf(t).capacities;
      const stops = [...new Set(t.orders.flatMap((o) => (o.kind === 'station' ? [o.station] : [])))];
      for (const cargo of CARGO_IDS) {
        if (!caps[cargo]) continue;
        let byStation = this.links.get(cargo);
        if (!byStation) this.links.set(cargo, (byStation = new Map()));
        for (const a of stops) {
          const set = byStation.get(a) ?? [];
          for (const b of stops) if (b !== a && !set.includes(b) && this.state.stations.get(b)?.accepts?.includes(cargo)) set.push(b);
          byStation.set(a, set);
        }
      }
    }

    const served = (id: number) => (this.links.get('passengers')?.get(id)?.length ?? 0) > 0 || (this.links.get('mail')?.get(id)?.length ?? 0) > 0;
    for (const [i, ids] of cover) {
      const competing = ids.filter(served);
      const total = competing.reduce((s, id) => s + Math.max(1, this.state.stations.get(id)!.rating), 0);
      if (total === 0) continue;
      const pop = houseType(map.layers.data[i]!).population;
      for (const id of competing) this.catch.get(id)!.share += (pop * Math.max(1, this.state.stations.get(id)!.rating)) / total;
    }
    for (const st of this.state.stations.values()) {
      // Only served stations with residents compete; anything else counts as a full share.
      const c = this.catch.get(st.id)!;
      const share = c.residents > 0 && served(st.id) ? Math.round((c.share / c.residents) * 100) / 100 : 1;
      if (st.share !== share) {
        st.share = share;
        this.state.markStationDirty(st.id);
      }
    }
  }

  /** Daily: update ratings, generate passengers and mail, let unserved or excess cargo give up. */
  daily(): void {
    this.refresh();
    for (const st of this.state.stations.values()) {
      this.updateRating(st);
      // Cargo for destinations no longer served drifts away.
      const list = this.packets.get(st.id);
      if (list?.some((p) => !this.destinations(p.cargo, st.id).includes(p.dest))) {
        this.scaleWaiting(st, (p) => (this.destinations(p.cargo, st.id).includes(p.dest) ? 1 : 0.8));
      }
      const pop = this.share(st.id);
      if (pop <= 0) continue;
      this.generate(st, 'passengers', pop * GENERATION_PER_RESIDENT);
      this.generate(st, 'mail', pop * MAIL_PER_RESIDENT);
      // Overcrowded stations lose cargo.
      const cap = pop * WAIT_CAP_PER_RESIDENT + 40;
      if (st.waitingTotal > cap) {
        const keep = cap / st.waitingTotal;
        this.scaleWaiting(st, () => keep);
      }
    }
  }

  /** Generate `perDay` (at full rating) units of `cargo` at a station, spread over its destinations. */
  private generate(st: Station, cargo: CargoId, perDay: number): void {
    const dests = this.destinations(cargo, st.id);
    if (dests.length === 0) return;
    const expected = perDay * (st.rating / 255);
    let n = Math.floor(expected) + (this.rng.next() < expected % 1 ? 1 : 0);
    const weights = dests.map((d) => Math.max(1, this.population(d)));
    const total = weights.reduce((a, b) => a + b, 0);
    while (n > 0) {
      let r = this.rng.next() * total;
      let k = 0;
      while (k < dests.length - 1 && r >= weights[k]!) r -= weights[k++]!;
      const batch = Math.max(1, Math.ceil(n / 4));
      this.addWaiting(st, { cargo, dest: dests[k]!, src: st.id, n: batch, day: this.state.date });
      n -= batch;
    }
  }

  private updateRating(st: Station): void {
    const { target } = ratingParts(st, this.state.date);
    const before = st.rating;
    st.rating += Math.sign(target - st.rating) * Math.min(RATING_STEP, Math.abs(target - st.rating));
    if (Math.round(before) !== Math.round(st.rating)) this.state.markStationDirty(st.id);
  }

  // ---- trains at stations ------------------------------------------------------

  /** Train arrived at a platform: deliver cargo bound here (getting paid), then load. */
  arrive(t: Train, stationId: number): void {
    const st = this.state.stations.get(stationId);
    if (!st) return;
    // The last train to call sets the speed and age parts of the rating.
    st.lastPickup = this.state.date;
    st.lastSpeed = this.state.rail.statsOf(t).maxSpeed;
    st.lastVehicleAge = Math.floor(((this.state.date - t.builtDays) / 365) * 10) / 10;
    this.state.markStationDirty(st.id);
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
      income += cargoPayment(p.cargo, p.n, dist, this.state.date - p.day);
    }
    t.cargo = keep;
    if (income > 0) {
      t.profitThisYear += income;
      this.state.addMoney(t.owner, income, 'income');
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
    const full = cargoCount(t) >= this.state.rail.statsOf(t).capacity;
    return order?.kind === 'station' && order.station === stationId && order.fullLoad === true && !full;
  }

  private load(t: Train, st: Station): void {
    const caps = this.state.rail.statsOf(t).capacities;
    const room = new Map<CargoId, number>();
    for (const [c, cap] of Object.entries(caps) as [CargoId, number][]) {
      const aboard = t.cargo.reduce((s, p) => s + (p.cargo === c ? p.n : 0), 0);
      if (cap - aboard > 0) room.set(c, cap - aboard);
    }
    const list = this.packets.get(st.id);
    if (room.size === 0 || !list?.length) return;
    // Next stops first, so cargo for the nearest destination boards first.
    const stops: number[] = [];
    for (let k = 1; k <= t.orders.length; k++) {
      const o = t.orders[(t.orderIndex + k) % t.orders.length]!;
      if (o.kind === 'station' && o.station !== st.id && !stops.includes(o.station)) stops.push(o.station);
    }
    let boarded = 0;
    for (const dest of stops) {
      for (const p of list) {
        const space = room.get(p.cargo) ?? 0;
        if (p.dest !== dest || p.n <= 0 || space <= 0) continue;
        const n = Math.min(p.n, space);
        p.n -= n;
        room.set(p.cargo, space - n);
        const same = t.cargo.find((q) => q.cargo === p.cargo && q.dest === dest && q.src === p.src && q.day === p.day);
        if (same) same.n += n;
        else t.cargo.push({ cargo: p.cargo, dest, src: p.src, n, day: p.day, hop: dest });
        boarded += n;
      }
    }
    if (boarded > 0) {
      this.packets.set(
        st.id,
        list.filter((p) => p.n > 0),
      );
      this.summarise(st);
      st.lastPickup = this.state.date;
      this.state.dirtyTrains.add(t.id);
    }
  }
}
