import { COMPANY_COLORS, COMPANY_ROLES, MAX_COMPANIES, memberOf, type Company, type CompanyRole } from '../company/company.ts';
import type { Station } from '../rail/station.ts';
import { generateTowns, type Town } from '../town/towns.ts';
import { PassengerSystem } from '../economy/passengers.ts';
import { COSTS } from '../economy/costs.ts';
import {
  BANKRUPT_QUARTERS,
  LEDGER_QUARTERS,
  emptyInfrastructure,
  emptyLedger,
  quarterOf,
  resaleValue,
  yearlyMaintenance,
  type Infrastructure,
  type LedgerCategory,
} from '../economy/finance.ts';
import { demolishTile, refreshStations } from '../commands/station.ts';
import { OWNER_NONE, TileType } from '../world/constants.ts';
import type { Agreement } from '../company/sharing.ts';
import { isSpanTd } from '../rail/track.ts';
import { segTd, segTile, type TrackAccess } from '../rail/network.ts';
import { NEWS_HISTORY, type NewsItem, type NewsKind } from '../news/news.ts';
import { RailSystem } from '../vehicles/railSystem.ts';
import type { Train } from '../vehicles/train.ts';
import { GameMap } from '../world/map.ts';
import { generateTerrain } from '../world/terrain.ts';
import { TICKS_PER_DAY, daysFromYmd, ymdFromDays } from './date.ts';
import { ECONOMY, type GameSettings } from './settings.ts';

export interface Player {
  id: number;
  name: string;
  companyId: number | null;
  connected: boolean;
  isHost: boolean;
}

export interface TickEvents {
  newDay: boolean;
  newMonth: boolean;
  newYear: boolean;
}

/** Authoritative game state. Pure data + deterministic stepping; no I/O. */
export class GameState {
  readonly settings: GameSettings;
  readonly map: GameMap;
  tick = 0;
  /** Days since 1970-01-01 */
  date: number;
  /** Tick within the current day, 0..TICKS_PER_DAY-1 */
  dayTick = 0;
  readonly companies = new Map<number, Company>();
  readonly players = new Map<number, Player>();
  readonly towns = new Map<number, Town>();
  readonly stations = new Map<number, Station>();
  nextStationId = 0;
  /** Stations changed/removed since the last sync flush (server broadcasts these). */
  readonly dirtyStations = new Set<number>();
  readonly removedStations = new Set<number>();
  readonly trains = new Map<number, Train>();
  nextTrainId = 0;
  readonly dirtyTrains = new Set<number>();
  readonly removedTrains = new Set<number>();
  /** Tile indices of all depots. */
  readonly depots = new Set<number>();
  /** Tile indices that carry at least one signal. */
  readonly signalTiles = new Set<number>();
  readonly rail: RailSystem;
  readonly passengers: PassengerSystem;
  /** Recent news, oldest first. */
  readonly news: NewsItem[] = [];
  /** News since the last sync flush (server broadcasts these). */
  readonly pendingNews: NewsItem[] = [];
  nextNewsId = 1;
  private nextPlayerId = 1;
  /** Bumped whenever track topology changes (invalidates routes, signal blocks). */
  trackVersion = 0;
  /** Track sharing agreements by id. */
  readonly agreements = new Map<number, Agreement>();
  nextAgreementId = 1;
  /** joins[a * 256 + b]: the networks of owners a and b connect (see TrackAccess). */
  private readonly joins = new Uint8Array(256 * 256);
  private readonly accessCache = new Map<number, TrackAccess>();
  /** Access for signal blocks: any owner, wherever networks are joined. */
  readonly blockAccess: TrackAccess;
  /** (host * 256 + guest) -> ticks guest trains spent on host track since the last bill. */
  private readonly sharingTicks = new Map<number, number>();

  constructor(settings: GameSettings, map: GameMap, date?: number) {
    this.settings = settings;
    this.map = map;
    this.date = date ?? daysFromYmd(settings.startYear, 0, 1);
    for (let o = 0; o < 256; o++) this.joins[o * 257] = 1;
    this.blockAccess = { uses: new Uint8Array(256).fill(1), joins: this.joins };
    this.rail = new RailSystem(this);
    this.passengers = new PassengerSystem(this);
    this.rail.onArrive = (t, s) => this.passengers.arrive(t, s);
    this.rail.onLoading = (t, s) => this.passengers.loading(t, s);
  }

  static create(settings: GameSettings): GameState {
    const map = new GameMap(settings.mapWidth, settings.mapHeight);
    generateTerrain(map, {
      seed: settings.seed,
      roughness: settings.roughness,
      waterLevel: settings.waterLevel,
      treeDensity: settings.treeDensity,
    });
    const state = new GameState(settings, map);
    for (const t of generateTowns(map, settings.seed, settings.startYear)) state.towns.set(t.id, t);
    return state;
  }

  /** Advance the simulation by one tick. */
  step(): TickEvents {
    this.tick++;
    this.rail.step();
    if (this.agreements.size > 0) this.countSharing();
    const ev: TickEvents = { newDay: false, newMonth: false, newYear: false };
    if (++this.dayTick >= TICKS_PER_DAY) {
      this.dayTick = 0;
      const before = ymdFromDays(this.date);
      this.date++;
      const after = ymdFromDays(this.date);
      ev.newDay = true;
      ev.newMonth = after.month !== before.month;
      ev.newYear = after.year !== before.year;
      this.onNewDay();
      if (ev.newMonth) this.onNewMonth();
      if (ev.newYear) this.onNewYear();
    }
    return ev;
  }

  private onNewDay(): void {
    this.passengers.daily();
    this.billSharing();
    // Running costs for vehicles out of the depot, charged daily.
    for (const t of this.trains.values()) {
      if (t.status === 'depot') continue;
      const daily = this.cost(this.rail.statsOf(t).runningCost) / 365;
      t.profitThisYear -= daily;
      this.addMoney(t.owner, -daily, 'running');
    }
  }

  private onNewYear(): void {
    for (const t of this.trains.values()) {
      t.profitLastYear = t.profitThisYear;
      t.profitThisYear = 0;
      this.dirtyTrains.add(t.id);
    }
  }

  private onNewMonth(): void {
    const econ = ECONOMY[this.settings.economy];
    this.countInfrastructure();
    for (const c of this.companies.values()) {
      if (c.loan > 0) this.addMoney(c.id, -Math.round((c.loan * econ.interestRate) / 12), 'interest');
      this.addMoney(c.id, -Math.round(this.cost(yearlyMaintenance(c.infrastructure)) / 12), 'property');
      c.value = this.companyValue(c);
    }
    if (ymdFromDays(this.date).month % 3 === 0) this.onNewQuarter();
  }

  /** Close the books for the quarter; companies in the red for too long go bankrupt. */
  private onNewQuarter(): void {
    for (const c of [...this.companies.values()]) {
      if (c.money >= 0) c.badQuarters = 0;
      else {
        c.badQuarters++;
        const extra = { company: c.id };
        if (c.badQuarters >= BANKRUPT_QUARTERS) {
          this.addNews('finance', `${c.name} has gone bankrupt! Its trains, track and stations are removed`, extra);
          this.dissolveCompany(c.id);
          continue;
        } else if (c.badQuarters === BANKRUPT_QUARTERS - 1) {
          this.addNews('finance', `${c.name} goes bankrupt at the end of this quarter unless it has money again`, extra);
        } else {
          this.addNews('finance', `${c.name} is in financial trouble: borrow money or sell trains to stay afloat`, extra);
        }
      }
      c.finances.push({ ...quarterOf(this.date), ledger: emptyLedger() });
      if (c.finances.length > LEDGER_QUARTERS) c.finances.splice(0, c.finances.length - LEDGER_QUARTERS);
    }
  }

  /** Change a company's money, booking it under `category` (null: off the books, e.g. loans). */
  addMoney(companyId: number, delta: number, category: LedgerCategory | null): void {
    const c = this.companies.get(companyId);
    if (!c) return;
    c.money += delta;
    const q = c.finances[c.finances.length - 1];
    if (category && q) q.ledger[category] += delta;
  }

  /** Count every company's track, stations, depots and signals (for maintenance and value). */
  countInfrastructure(): void {
    const counts = new Map<number, Infrastructure>();
    for (const c of this.companies.values()) counts.set(c.id, emptyInfrastructure());
    const { type, owner, track, signals } = this.map.layers;
    for (let i = 0; i < type.length; i++) {
      const o = owner[i]!;
      if (o === OWNER_NONE) continue;
      const infra = counts.get(o);
      if (!infra) continue;
      const t = type[i];
      if (t === TileType.Rail) {
        let bits = track[i]!;
        let n = 0;
        while (bits) {
          n += bits & 1;
          bits >>= 1;
        }
        infra.track += Math.max(1, n);
        const sig = signals[i]!;
        for (let p = 0; p < 6; p++) if ((sig >> (p * 2)) & 3) infra.signals++;
      } else if (t === TileType.Station) infra.stations++;
      else if (t === TileType.Depot) infra.depots++;
    }
    for (const [id, infra] of counts) this.companies.get(id)!.infrastructure = infra;
  }

  /** Money − loan + resale value of trains + half the cost of building the property again. */
  companyValue(c: Company): number {
    let vehicles = 0;
    for (const t of this.trains.values()) if (t.owner === c.id) vehicles += resaleValue(t.value, (this.date - t.builtDays) / 365);
    const i = c.infrastructure;
    const property = this.cost(
      (i.track * COSTS.railPiece + i.stations * COSTS.stationTile + i.depots * COSTS.depot + i.signals * COSTS.signal) / 2,
    );
    return Math.round(c.money - c.loan + vehicles + property);
  }

  /** Remove a company with all its trains and infrastructure (bankruptcy). */
  dissolveCompany(id: number): void {
    // Other companies' trains on its track go home first, and lose orders for its stations.
    for (const a of [...this.agreements.values()]) if (a.host === id || a.guest === id) this.agreements.delete(a.id);
    this.agreementsChanged();
    for (const t of [...this.trains.values()]) {
      if (t.owner === id) continue;
      this.dropOrdersFor(t, id);
      if (this.isOnTrackOf(t, id)) this.towHome(t);
    }
    for (const t of [...this.trains.values()]) {
      if (t.owner !== id) continue;
      this.rail.removeFromWorld(t);
      this.trains.delete(t.id);
      this.dirtyTrains.delete(t.id);
      this.removedTrains.add(t.id);
    }
    const { type, owner } = this.map.layers;
    const dirty = new Set<number>();
    const stations = new Set<number>();
    for (let i = 0; i < type.length; i++) {
      if (owner[i] !== id) continue;
      const t = type[i];
      if (t !== TileType.Rail && t !== TileType.Station && t !== TileType.Depot) continue;
      const st = demolishTile(this, i, dirty);
      if (st !== null) stations.add(st);
    }
    refreshStations(this, stations);
    this.onTrackChanged();
    this.companies.delete(id);
    for (const p of this.players.values()) if (p.companyId === id) p.companyId = null;
  }

  // ---- rail network hooks (filled in by the train/signal systems) -------------

  // ---- track sharing --------------------------------------------------------

  /** Whose track `company`'s trains may use. */
  accessFor(company: number): TrackAccess {
    let a = this.accessCache.get(company);
    if (!a) {
      const uses = new Uint8Array(256);
      uses[company] = 1;
      for (const ag of this.agreements.values()) if (ag.status === 'active' && ag.guest === company) uses[ag.host] = 1;
      a = { uses, joins: this.joins };
      this.accessCache.set(company, a);
    }
    return a;
  }

  /** Whether the networks of two owners connect (the same owner, or an active agreement). */
  joined(a: number, b: number): boolean {
    return this.joins[a * 256 + b] === 1;
  }

  agreementBetween(host: number, guest: number): Agreement | undefined {
    for (const a of this.agreements.values()) if (a.host === host && a.guest === guest) return a;
    return undefined;
  }

  /** Whether `company`'s trains may call at a station (its own, or shared with it). */
  canUseStation(company: number, st: Station): boolean {
    if (st.owner === company) return true;
    const a = this.agreementBetween(st.owner, company);
    return a?.status === 'active' && a.stations;
  }

  /** Rebuild access after agreements change; routes and signal blocks are recomputed. */
  agreementsChanged(): void {
    this.joins.fill(0);
    for (let o = 0; o < 256; o++) this.joins[o * 257] = 1;
    for (const a of this.agreements.values()) {
      if (a.status !== 'active') continue;
      this.joins[a.host * 256 + a.guest] = 1;
      this.joins[a.guest * 256 + a.host] = 1;
    }
    this.accessCache.clear();
    this.onTrackChanged();
  }

  /** Replace all agreements (client mirror, save restore). */
  setAgreements(list: readonly Agreement[]): void {
    this.agreements.clear();
    for (const a of list) this.agreements.set(a.id, a);
    this.agreementsChanged();
  }

  /**
   * End (or withdraw) an agreement. The guest's trains on the host's track are towed to their
   * nearest depot, and lose their orders for the host's stations. Returns how many were towed.
   */
  endAgreement(a: Agreement): number {
    this.agreements.delete(a.id);
    if (a.status !== 'active') return 0;
    this.agreementsChanged();
    let towed = 0;
    for (const t of [...this.trains.values()]) {
      if (t.owner !== a.guest) continue;
      this.dropOrdersFor(t, a.host);
      if (this.isOnTrackOf(t, a.host)) {
        this.towHome(t);
        towed++;
      }
    }
    return towed;
  }

  /** Is any part of the train on track owned by `owner` (spans count as the ground below)? */
  private isOnTrackOf(t: Train, owner: number): boolean {
    const o = this.map.layers.owner;
    return t.path.some((s) => !isSpanTd(segTd(s)) && o[segTile(s)] === owner);
  }

  private dropOrdersFor(t: Train, owner: number): void {
    const keep = t.orders.filter((o) => o.kind !== 'station' || this.stations.get(o.station)?.owner !== owner);
    if (keep.length === t.orders.length) return;
    t.orders = keep;
    t.orderIndex = keep.length ? Math.min(t.orderIndex, keep.length - 1) : 0;
    t.routeFor = '';
    this.dirtyTrains.add(t.id);
  }

  /** Put a train straight into its company's nearest depot, or sell it if there is none. */
  towHome(t: Train): void {
    const w = this.map.width;
    const head = t.path.length ? segTile(t.path[0]!) : Math.max(0, t.depot);
    const hx = head % w;
    const hy = (head - hx) / w;
    let best = -1;
    let bestD = Infinity;
    for (const d of this.depots) {
      if (this.map.layers.owner[d] !== t.owner) continue;
      const dx = (d % w) - hx;
      const dy = Math.floor(d / w) - hy;
      if (dx * dx + dy * dy < bestD) {
        bestD = dx * dx + dy * dy;
        best = d;
      }
    }
    if (best >= 0) {
      this.rail.enterDepot(t, best);
      return;
    }
    this.addMoney(t.owner, resaleValue(t.value, (this.date - t.builtDays) / 365), 'vehicles');
    this.rail.removeFromWorld(t);
    this.trains.delete(t.id);
    this.dirtyTrains.delete(t.id);
    this.removedTrains.add(t.id);
  }

  /** Count ticks guest trains spend on other companies' track (billed daily). */
  private countSharing(): void {
    const owner = this.map.layers.owner;
    for (const t of this.trains.values()) {
      if (t.path.length === 0) continue;
      const s = t.path[0]!;
      if (isSpanTd(segTd(s))) continue;
      const o = owner[segTile(s)]!;
      if (o === t.owner || o === OWNER_NONE) continue;
      const k = o * 256 + t.owner;
      this.sharingTicks.set(k, (this.sharingTicks.get(k) ?? 0) + 1);
    }
  }

  private billSharing(): void {
    for (const [k, ticks] of this.sharingTicks) {
      const a = this.agreementBetween(k >> 8, k & 255);
      if (a?.status !== 'active' || a.fee <= 0) continue;
      const fee = (a.fee * ticks) / TICKS_PER_DAY;
      this.addMoney(a.guest, -fee, 'sharing');
      this.addMoney(a.host, fee, 'sharing');
    }
    this.sharingTicks.clear();
  }

  onTrackChanged(): void {
    this.trackVersion++;
  }

  /** Whether any train currently occupies this track piece. */
  isPieceOccupied(tile: number, piece: number): boolean {
    return this.rail.isOccupied(tile, piece);
  }

  /** Remove signals on the given pieces of a tile (track is being removed). */
  removeSignalsOn(tile: number, pieceBits: number): void {
    let mask = 0;
    for (let p = 0; p < 6; p++) if ((pieceBits >> p) & 1) mask |= 3 << (p * 2);
    const sig = this.map.layers.signals;
    sig[tile] = sig[tile]! & ~mask;
    if (!(sig[tile]! & 0x0fff)) {
      sig[tile] = 0;
      this.signalTiles.delete(tile);
    }
  }

  /** Whether any vehicle is parked in (or heading into) the depot on this tile. */
  depotHasVehicles(tile: number): boolean {
    return this.rail.depotHasVehicles(tile);
  }

  markStationDirty(id: number): void {
    this.dirtyStations.add(id);
  }

  deleteStation(id: number): void {
    this.stations.delete(id);
    this.dirtyStations.delete(id);
    this.removedStations.add(id);
  }

  addNews(kind: NewsKind, text: string, extra: { company?: number; tile?: number } = {}): NewsItem {
    const item: NewsItem = { id: this.nextNewsId++, date: this.date, kind, text, ...extra };
    this.news.push(item);
    if (this.news.length > NEWS_HISTORY) this.news.splice(0, this.news.length - NEWS_HISTORY);
    this.pendingNews.push(item);
    return item;
  }

  // ---- players & companies -------------------------------------------------

  addPlayer(name: string, isHost: boolean): Player {
    const p: Player = { id: this.nextPlayerId++, name, companyId: null, connected: true, isHost };
    this.players.set(p.id, p);
    // Rejoin the company the player is a member of (e.g. after loading a save)
    p.companyId = this.companyOfName(name)?.id ?? null;
    return p;
  }

  removePlayer(id: number): void {
    this.players.delete(id);
  }

  companyOfName(name: string): Company | undefined {
    for (const c of this.companies.values()) if (memberOf(c, name)) return c;
    return undefined;
  }

  /** The role of the command's player in the command's company, if any. */
  roleOf(playerId: number, companyId: number | null): CompanyRole | null {
    const p = this.players.get(playerId);
    const c = companyId === null ? undefined : this.companies.get(companyId);
    return (p && c && memberOf(c, p.name)?.role) || null;
  }

  foundCompany(founder: Player, name?: string, color?: number): Company | null {
    let id = 0;
    while (this.companies.has(id)) id++;
    if (id >= MAX_COMPANIES) return null;
    const usedColors = new Set([...this.companies.values()].map((c) => c.color));
    if (color === undefined || usedColors.has(color)) {
      color = 0;
      while (usedColors.has(color) && color < COMPANY_COLORS.length - 1) color++;
    }
    const econ = ECONOMY[this.settings.economy];
    const company: Company = {
      id,
      name: name?.trim().slice(0, 40) || `${founder.name} Transport`,
      color,
      money: econ.startMoney,
      loan: 0,
      members: [],
      requests: [],
      invites: [],
      foundedDays: this.date,
      finances: [{ ...quarterOf(this.date), ledger: emptyLedger() }],
      badQuarters: 0,
      infrastructure: emptyInfrastructure(),
      value: econ.startMoney,
    };
    this.companies.set(id, company);
    this.addMember(company, founder.name, 'owner');
    return company;
  }

  /** Make `name` a member (leaving any other company), clearing their pending requests and invites. */
  addMember(company: Company, name: string, role: CompanyRole): void {
    const current = this.companyOfName(name);
    if (current && current !== company) this.removeMember(current, name);
    for (const c of this.companies.values()) {
      c.requests = c.requests.filter((n) => n !== name);
      c.invites = c.invites.filter((m) => m.name !== name);
    }
    const m = memberOf(company, name);
    if (m) m.role = role;
    else company.members.push({ name, role });
    this.setPlayersCompany(name, company.id);
  }

  /** Remove a member; if the owner leaves, the most senior remaining member takes over. */
  removeMember(company: Company, name: string): void {
    const m = memberOf(company, name);
    if (!m) return;
    company.members = company.members.filter((x) => x !== m);
    if (m.role === 'owner' && company.members.length > 0) {
      const rank = (r: CompanyRole) => COMPANY_ROLES.indexOf(r);
      const heir = company.members.reduce((a, b) => (rank(b.role) < rank(a.role) ? b : a));
      heir.role = 'owner';
    }
    this.setPlayersCompany(name, null);
  }

  /** The host removed a player: they leave their company, and their requests and invitations go. */
  kickPlayer(player: Player): void {
    const c = this.companyOfName(player.name);
    if (c) {
      this.removeMember(c, player.name);
      this.addNews('company', `${player.name} leaves ${c.name}`, { company: c.id });
    }
    for (const co of this.companies.values()) {
      co.requests = co.requests.filter((n) => n !== player.name);
      co.invites = co.invites.filter((m) => m.name !== player.name);
    }
    this.players.delete(player.id);
  }

  /** A player changed their name: membership, requests and invites follow them. */
  renamePlayer(player: Player, name: string): void {
    const old = player.name;
    player.name = name;
    if (old === name) return;
    for (const c of this.companies.values()) {
      for (const m of c.members) if (m.name === old) m.name = name;
      c.requests = c.requests.map((n) => (n === old ? name : n));
      for (const m of c.invites) if (m.name === old) m.name = name;
    }
  }

  private setPlayersCompany(name: string, companyId: number | null): void {
    for (const p of this.players.values()) if (p.name === name) p.companyId = companyId;
  }

  /** Scale a base cost by economy difficulty. */
  cost(base: number): number {
    return Math.round(base * ECONOMY[this.settings.economy].costFactor);
  }
}
