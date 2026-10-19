import { TICKS_PER_DAY } from '../sim/date.ts';
import { STATION_CATCHMENT, type Station } from '../rail/station.ts';
import type { GameState } from '../sim/state.ts';
import { houseType } from '../town/houses.ts';
import { TileType } from '../world/constants.ts';
import { Random } from '../util/random.ts';
import { cargoCount, type Train } from '../vehicles/train.ts';
import { isBus } from '../vehicles/catalog.ts';
import { CARGO_IDS, cargoPayment, type CargoId } from './cargo.ts';
import { RATING_STEP, ratingParts } from './rating.ts';
import { industryType } from './industries.ts';
import { solveLinkGraph, type LinkGraphInput, type LinkGraphResult } from './linkGraph.ts';

/** Solve link graphs and hand back the results (possibly later, e.g. from a worker). */
export type LinkGraphRunner = (inputs: LinkGraphInput[], done: (results: LinkGraphResult[]) => void) => void;

/** Days between link graph recalculations (sooner when services change). */
export const LINK_GRAPH_DAYS = 8;

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

/** Towns accept goods and food once a station's catchment has this many residents. */
export const GOODS_RESIDENTS = 200;
export const FOOD_RESIDENTS = 100;

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
  /** cargo → link "from>to" → capacity: consecutive stops of trains carrying the cargo. */
  private linkCaps = new Map<CargoId, Map<string, number>>();
  /** Cargodist results per cargo: demand and next hops. */
  private flows = new Map<CargoId, { demand: Map<number, [number, number][]>; nextHop: Map<number, Map<number, number>> }>();
  private graphPending = false;
  private graphDay = -Infinity;
  private graphKey = '';
  /** Solves link graphs; synchronous by default, a worker on the server. */
  runner: LinkGraphRunner = (inputs, done) => done(inputs.map(solveLinkGraph));
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

  /** Destinations a station sends a cargo to: from cargodist, or (before it has run) direct links. */
  destinations(cargo: CargoId, station: number): readonly number[] {
    return this.destinationWeights(cargo, station).map(([d]) => d);
  }

  /** Destinations with demand weights. */
  destinationWeights(cargo: CargoId, station: number): readonly [number, number][] {
    const flow = this.flows.get(cargo);
    if (flow) return flow.demand.get(station) ?? [];
    const symmetric = cargo === 'passengers' || cargo === 'mail';
    return (this.links.get(cargo)?.get(station) ?? []).map((d) => [d, symmetric ? Math.max(1, this.population(d)) : 1]);
  }

  /** The next station cargo for `dest` goes to from `station`, or undefined if it can't get there. */
  hopFor(cargo: CargoId, station: number, dest: number): number | undefined {
    const flow = this.flows.get(cargo);
    if (flow) return flow.nextHop.get(station)?.get(dest);
    return this.links.get(cargo)?.get(station)?.includes(dest) ? dest : undefined;
  }

  // ---- cargodist -----------------------------------------------------------------

  /** Link graph inputs for every cargo some train carries. */
  graphInputs(): LinkGraphInput[] {
    const inputs: LinkGraphInput[] = [];
    for (const [cargo, caps] of this.linkCaps) {
      const symmetric = cargo === 'passengers' || cargo === 'mail';
      const stations = [...this.state.stations.values()].map((st) => ({
        id: st.id,
        x: st.x,
        y: st.y,
        supply: this.supplyOf(st, cargo),
        accepts: st.accepts?.includes(cargo) ?? false,
      }));
      const links = [...caps].map(([k, capacity]) => {
        const [from, to] = k.split('>').map(Number);
        return { from: from!, to: to!, capacity };
      });
      inputs.push({ cargo, symmetric, stations, links });
    }
    return inputs;
  }

  /** Monthly amount of a cargo a station could send (residents, or nearby industries' output). */
  private supplyOf(st: Station, cargo: CargoId): number {
    if (cargo === 'passengers') return this.share(st.id) * GENERATION_PER_RESIDENT * 30;
    if (cargo === 'mail') return this.share(st.id) * MAIL_PER_RESIDENT * 30;
    let n = 0;
    for (const id of st.industries ?? []) {
      const ind = this.state.industries.get(id);
      const type = ind && industryType(ind.type);
      if (!ind || !type?.produces.includes(cargo)) continue;
      n += type.production > 0 ? type.production * ind.level : (ind.lastProduced[cargo] ?? 0);
    }
    return n;
  }

  /** Recompute link graphs every few days, or as soon as the services change. */
  private scheduleGraph(): void {
    if (this.graphPending) return;
    const key = [...this.linkCaps].map(([c, m]) => `${c}:${[...m.keys()].sort().join(',')}`).join(';');
    if (key === this.graphKey && this.state.date - this.graphDay < LINK_GRAPH_DAYS) return;
    this.graphKey = key;
    this.graphDay = this.state.date;
    const inputs = this.graphInputs();
    this.graphPending = true;
    this.runner(inputs, (results) => this.applyGraph(results));
  }

  /** Install solved link graphs. */
  applyGraph(results: LinkGraphResult[]): void {
    this.graphPending = false;
    this.flows.clear();
    for (const r of results) {
      this.flows.set(r.cargo, {
        demand: new Map(r.demand),
        nextHop: new Map(r.nextHop.map(([s, hops]) => [s, new Map(hops)])),
      });
    }
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
      const residents = this.catch.get(st.id)!.residents;
      const industries = this.industriesNear(st);
      const accepts = new Set<CargoId>();
      const supplies = new Set<CargoId>();
      if (residents > 0) {
        for (const c of ['passengers', 'mail'] as const) {
          accepts.add(c);
          supplies.add(c);
        }
      }
      if (residents >= GOODS_RESIDENTS) accepts.add('goods');
      if (residents >= FOOD_RESIDENTS) accepts.add('food');
      for (const id of industries) {
        const type = industryType(this.state.industries.get(id)!.type)!;
        for (const c of type.accepts) accepts.add(c);
        for (const c of type.produces) supplies.add(c);
      }
      const acc = CARGO_IDS.filter((c) => accepts.has(c));
      const sup = CARGO_IDS.filter((c) => supplies.has(c));
      if (acc.join() !== (st.accepts ?? []).join() || sup.join() !== (st.supplies ?? []).join() || industries.join() !== (st.industries ?? []).join()) {
        st.accepts = acc;
        st.supplies = sup;
        st.industries = industries;
        this.state.markStationDirty(st.id);
      }
    }

    // Direct links per cargo: stations that a train carrying the cargo calls at in turn.
    this.links.clear();
    this.linkCaps.clear();
    for (const t of this.state.trains.values()) {
      const caps = this.state.rail.statsOf(t).capacities;
      const order = t.orders.flatMap((o) => (o.kind === 'station' ? [o.station] : []));
      const stops = [...new Set(order)];
      for (const cargo of CARGO_IDS) {
        if (!caps[cargo]) continue;
        let linkCaps = this.linkCaps.get(cargo);
        if (!linkCaps) this.linkCaps.set(cargo, (linkCaps = new Map()));
        for (let k = 0; k < order.length && order.length > 1; k++) {
          const a = order[k]!;
          const b = order[(k + 1) % order.length]!;
          if (a !== b) linkCaps.set(`${a}>${b}`, (linkCaps.get(`${a}>${b}`) ?? 0) + caps[cargo]!);
        }
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

  /** Industries whose footprint touches the station's catchment. */
  private industriesNear(st: Station): number[] {
    const x0 = st.x0 - STATION_CATCHMENT;
    const y0 = st.y0 - STATION_CATCHMENT;
    const x1 = st.x1 + STATION_CATCHMENT;
    const y1 = st.y1 + STATION_CATCHMENT;
    const out: number[] = [];
    for (const ind of this.state.industries.values()) {
      if (ind.x <= x1 && ind.x + ind.w - 1 >= x0 && ind.y <= y1 && ind.y + ind.h - 1 >= y0) out.push(ind.id);
    }
    return out;
  }

  /** Daily: update ratings, generate cargo, let unserved or excess cargo give up. */
  daily(): void {
    this.refresh();
    this.scheduleGraph();
    this.produce();
  }

  /**
   * Each tick, the stations whose turn it is (by id, so each once a day) update their rating,
   * shed cargo that can't get anywhere and get new passengers and mail. Spreading this over
   * the day keeps any one tick short.
   */
  tick(): void {
    const turn = this.state.dayTick;
    for (const st of this.state.stations.values()) {
      if (st.id % TICKS_PER_DAY !== turn) continue;
      this.updateRating(st);
      // Cargo that can no longer get to its destination drifts away.
      const list = this.packets.get(st.id);
      if (list?.some((p) => this.hopFor(p.cargo, st.id, p.dest) === undefined)) {
        this.scaleWaiting(st, (p) => (this.hopFor(p.cargo, st.id, p.dest) === undefined ? 0.8 : 1));
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

  /**
   * Industries produce: primary ones at their monthly rate, secondary ones from what was
   * delivered. Output goes to the (up to two) best-rated stations nearby that send that cargo
   * somewhere; the share moved follows the best rating, the rest is lost.
   */
  private produce(): void {
    const near = new Map<number, Station[]>();
    for (const st of this.state.stations.values()) for (const id of st.industries ?? []) near.set(id, [...(near.get(id) ?? []), st]);
    for (const ind of this.state.industries.values()) {
      const type = industryType(ind.type);
      if (!type) continue;
      const out = new Map<CargoId, number>();
      if (type.production > 0) {
        for (const c of type.produces) {
          const perDay = (type.production * ind.level) / 30;
          out.set(c, Math.floor(perDay) + (this.rng.next() < perDay % 1 ? 1 : 0));
        }
      } else if (type.produces.length) {
        let input = 0;
        for (const c of type.accepts) input += ind.input[c] ?? 0;
        ind.input = {};
        const each = Math.floor(input / type.produces.length);
        for (const c of type.produces) out.set(c, each);
      }
      for (const [cargo, n] of out) {
        if (n <= 0) continue;
        ind.produced[cargo] = (ind.produced[cargo] ?? 0) + n;
        const stations = (near.get(ind.id) ?? []).filter((st) => this.destinations(cargo, st.id).length > 0).sort((a, b) => b.rating - a.rating).slice(0, 2);
        if (stations.length === 0) continue;
        const moved = Math.floor(n * (stations[0]!.rating / 255));
        const total = stations.reduce((s, st) => s + st.rating, 0);
        let left = moved;
        stations.forEach((st, k) => {
          const share = k === stations.length - 1 ? left : Math.floor((moved * st.rating) / total);
          left -= share;
          this.send(st, cargo, share);
        });
        ind.transported[cargo] = (ind.transported[cargo] ?? 0) + moved;
      }
      this.state.dirtyIndustries.add(ind.id);
    }
  }

  /** Put `n` units of cargo produced near a station on its platforms, spread over destinations. */
  private send(st: Station, cargo: CargoId, n: number): void {
    const dests = this.destinationWeights(cargo, st.id);
    if (dests.length === 0) return;
    const total = dests.reduce((a, [, w]) => a + w, 0);
    while (n > 0) {
      let r = this.rng.next() * total;
      let k = 0;
      while (k < dests.length - 1 && r >= dests[k]![1]) r -= dests[k++]![1];
      const batch = Math.max(1, Math.ceil(n / 4));
      this.addWaiting(st, { cargo, dest: dests[k]![0], src: st.id, n: batch, day: this.state.date });
      n -= batch;
    }
  }

  /** Cargo delivered to a station: industries around it that accept it take it in. */
  private deliverToIndustry(st: Station, cargo: CargoId, n: number): void {
    let best: { id: number; d: number } | null = null;
    for (const id of st.industries ?? []) {
      const ind = this.state.industries.get(id);
      if (!ind || !industryType(ind.type)?.accepts.includes(cargo)) continue;
      const d = Math.abs(ind.x + ind.w / 2 - st.x) + Math.abs(ind.y + ind.h / 2 - st.y);
      if (!best || d < best.d) best = { id, d };
    }
    if (!best) return;
    const ind = this.state.industries.get(best.id)!;
    ind.input[cargo] = (ind.input[cargo] ?? 0) + n;
    ind.delivered[cargo] = (ind.delivered[cargo] ?? 0) + n;
    this.state.dirtyIndustries.add(ind.id);
  }

  /** Generate `perDay` (at full rating) units of `cargo` at a station, spread over its destinations. */
  private generate(st: Station, cargo: CargoId, perDay: number): void {
    if (this.destinationWeights(cargo, st.id).length === 0) return;
    const expected = perDay * (st.rating / 255);
    this.send(st, cargo, Math.floor(expected) + (this.rng.next() < expected % 1 ? 1 : 0));
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
      const first = t.mode === 'air' ? 'first aircraft lands' : t.mode === 'water' ? 'first ship docks' : t.mode === 'road' ? `first ${isBus(t.units[0]!) ? 'bus' : 'truck'} arrives` : 'first train arrives';
      this.state.addNews('station', `Citizens celebrate! The ${first} at ${st.name} (${owner})`, {
        company: t.owner,
        tile: st.y * this.state.map.width + st.x,
      });
    }
    let income = 0;
    const keep = [];
    const ahead = new Set(this.stopsAfter(t, stationId));
    for (const p of t.cargo) {
      const deliver = p.dest === stationId;
      // Transfer here if this is the planned hop, or if the train no longer goes to it.
      const transfer = !deliver && (p.hop === stationId || p.hop === undefined || !ahead.has(p.hop));
      if (!deliver && !transfer) {
        keep.push(p);
        continue;
      }
      // Each leg is paid to the company that carried it.
      const from = this.state.stations.get(p.at ?? p.src);
      const dist = from ? Math.abs(from.x - st.x) + Math.abs(from.y - st.y) : 0;
      income += Math.round(cargoPayment(p.cargo, p.n, dist, this.state.date - p.day) * this.state.inflation.payments);
      if (deliver) {
        this.deliverToIndustry(st, p.cargo, p.n);
        if (p.cargo === 'goods' || p.cargo === 'food') this.countForTown(st, p.cargo, p.n);
      }
      else this.addWaiting(st, { cargo: p.cargo, dest: p.dest, src: p.src, n: p.n, day: p.day });
    }
    t.cargo = keep;
    if (income > 0) {
      t.profitThisYear += income;
      this.state.addMoney(t.owner, income, 'income');
      this.events.push({ tile: st.y * this.state.map.width + st.x, amount: income, owner: t.owner });
    }
    this.load(t, st);
  }

  /** Add to the town's monthly figures. */
  private countForTown(st: Station, what: 'passengers' | 'mail' | 'goods' | 'food', n: number): void {
    const town = st.townId === null ? undefined : this.state.towns.get(st.townId);
    if (!town) return;
    town.stats ??= { passengers: 0, mail: 0, goods: 0, food: 0 };
    town.stats[what] += n;
  }

  /** Stations a train calls at after `here`, in order (one round of its orders). */
  private stopsAfter(t: Train, here: number): number[] {
    const stops: number[] = [];
    const n = t.orders.length;
    for (let k = 1; k <= n; k++) {
      const o = t.orders[(t.orderIndex + k) % n]!;
      if (o.kind === 'station' && o.station !== here && !stops.includes(o.station)) stops.push(o.station);
    }
    return stops;
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
    // Cargo boards if the train calls at its next hop; nearest stops first.
    const stops = this.stopsAfter(t, st.id);
    let boarded = 0;
    for (const hop of stops) {
      for (const p of list) {
        const space = room.get(p.cargo) ?? 0;
        if (p.n <= 0 || space <= 0 || this.hopFor(p.cargo, st.id, p.dest) !== hop) continue;
        const n = Math.min(p.n, space);
        p.n -= n;
        room.set(p.cargo, space - n);
        if (p.cargo === 'passengers' || p.cargo === 'mail') this.countForTown(st, p.cargo, n);
        const same = t.cargo.find((q) => q.cargo === p.cargo && q.dest === p.dest && q.src === p.src && q.day === p.day && q.hop === hop && q.at === st.id);
        if (same) same.n += n;
        else t.cargo.push({ cargo: p.cargo, dest: p.dest, src: p.src, n, day: p.day, hop, at: st.id });
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
