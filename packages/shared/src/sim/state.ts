import { COMPANY_COLORS, COMPANY_ROLES, MAX_COMPANIES, memberOf, type Company, type CompanyRole } from '../company/company.ts';
import type { Station } from '../rail/station.ts';
import { TOWN_NEED, emptyTownStats, generateTowns, townNeeds, type Town } from '../town/towns.ts';
import { growTown } from '../town/growth.ts';
import { monthlyReputation } from '../town/reputation.ts';
import { FUNDED_GROWTH, forgetCompanyInTowns, townActionsDaily } from '../town/actions.ts';
import { industryMonthly } from '../economy/industryChanges.ts';
import { Random } from '../util/random.ts';
import { CargoSystem } from '../economy/cargoSystem.ts';
import { climateCargos, generateIndustries, type Industry } from '../economy/industries.ts';
import { Market } from '../economy/market.ts';
import type { CargoId } from '../economy/cargo.ts';
import { warnLost } from '../vehicles/lost.ts';
import { MaintenanceSystem } from '../vehicles/maintenance.ts';
import { IncidentSystem } from '../incidents/rail.ts';
import { COSTS } from '../economy/costs.ts';
import {
  BANKRUPT_QUARTERS,
  HISTORY_MONTHS,
  bookInto,
  LEDGER_QUARTERS,
  LOAN_STEP,
  emptyInfrastructure,
  emptyLedger,
  quarterOf,
  resaleValue,
  yearlyMaintenance,
  type Infrastructure,
  type LedgerCategory,
} from '../economy/finance.ts';
import { demolishTile, refreshStations } from '../commands/station.ts';
import { removeAirport } from '../commands/airport.ts';
import { OWNER_NONE, TileType, WATER_BUOY, WATER_CANAL } from '../world/constants.ts';
import type { Agreement } from '../company/sharing.ts';
import { removeHeadquarters, resizeHeadquarters } from '../company/headquarters.ts';
import { WAYPOINT_FLAG, type Waypoint } from '../rail/waypoint.ts';
import { ELECTRIC_TYPES } from '../rail/railTypes.ts';
import { isSpanTd } from '../rail/track.ts';
import { segTd, segTile, type TrackAccess } from '../rail/network.ts';
import { NEWS_HISTORY, type NewsItem, type NewsKind } from '../news/news.ts';
import { RailSystem } from '../vehicles/railSystem.ts';
import { RoadSystem } from '../vehicles/roadSystem.ts';
import { AirSystem } from '../vehicles/airSystem.ts';
import { ShipSystem } from '../vehicles/shipSystem.ts';
import { removeWaterTile } from '../commands/water.ts';
import { hangarTile } from '../air/airports.ts';
import { isRailVehicle } from '../vehicles/train.ts';
import type { Order, Train } from '../vehicles/train.ts';
import { spacingAtStop } from '../vehicles/spacing.ts';
import { VEHICLE_MODES, deleteLine, setLineOrders, vehicleMode, type Line, type VehicleMode } from '../vehicles/lines.ts';
import { GameMap } from '../world/map.ts';
import { generateTerrain, worldClimate } from '../world/terrain.ts';
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
  readonly industries = new Map<number, Industry>();
  /** Price levels: construction and running costs, and cargo payments (inflation). */
  readonly inflation = { costs: 1, payments: 1 };
  /** Cargo prices: supply and demand, and world events (see economy/market.ts). */
  readonly market = new Market();
  private marketRng: Random;
  private industryRng: Random;
  /** Towns changed since the last sync flush. */
  readonly dirtyTowns = new Set<number>();
  private townRng: Random;
  /** Chance in town actions: bribes found out, where road works start. */
  councilRng: Random;
  /** Street tiles under road works (a town's road reconstruction) → the day they finish. */
  readonly roadWorks = new Map<number, number>();
  nextIndustryId = 0;
  /** Industries changed/removed since the last sync flush. */
  readonly dirtyIndustries = new Set<number>();
  readonly removedIndustries = new Set<number>();
  readonly stations = new Map<number, Station>();
  nextStationId = 0;
  /** Stations changed/removed since the last sync flush (server broadcasts these). */
  readonly dirtyStations = new Set<number>();
  readonly removedStations = new Set<number>();
  readonly trains = new Map<number, Train>();
  nextTrainId = 0;
  readonly dirtyTrains = new Set<number>();
  readonly removedTrains = new Set<number>();
  readonly lines = new Map<number, Line>();
  nextLineId = 0;
  /** Lines changed/removed since the last sync flush. */
  readonly dirtyLines = new Set<number>();
  readonly removedLines = new Set<number>();
  /** Tile indices of all depots. */
  readonly depots = new Set<number>();
  /** Tile indices of all road depots. */
  readonly roadDepots = new Set<number>();
  /** Bumped whenever roads change (invalidates road vehicle routes). */
  roadVersion = 0;
  /** Companies whose statistics got a new month (or a closed quarter) since the last sync. */
  readonly historyChanged = new Set<number>();
  /** Tile indices of all ship depots. */
  readonly shipDepots = new Set<number>();
  /** Bumped whenever waterways change (ships check their routes). */
  waterVersion = 0;
  /** Tile indices that carry at least one signal. */
  readonly signalTiles = new Set<number>();
  readonly rail: RailSystem;
  readonly road: RoadSystem;
  readonly air: AirSystem;
  readonly ships: ShipSystem;
  readonly cargo: CargoSystem;
  readonly maintenance: MaintenanceSystem;
  readonly incidents: IncidentSystem;
  /** Recent news, oldest first. */
  readonly news: NewsItem[] = [];
  /** News since the last sync flush (server broadcasts these). */
  readonly pendingNews: NewsItem[] = [];
  nextNewsId = 1;
  private nextPlayerId = 1;
  /** Bumped whenever track topology changes (invalidates routes, signal blocks). */
  trackVersion = 0;
  readonly waypoints = new Map<number, Waypoint>();
  nextWaypointId = 0;
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
    map.climate = worldClimate(settings);
    this.date = date ?? daysFromYmd(settings.startYear, 0, 1);
    this.townRng = new Random(settings.seed ^ 0x70e115);
    this.councilRng = new Random(settings.seed ^ 0xc0c111);
    this.industryRng = new Random(settings.seed ^ 0x1dc4a9);
    this.marketRng = new Random(settings.seed ^ 0x3a2e7);
    for (let o = 0; o < 256; o++) this.joins[o * 257] = 1;
    this.blockAccess = { uses: new Uint8Array(256).fill(1), joins: this.joins };
    this.rail = new RailSystem(this);
    this.road = new RoadSystem(this);
    this.road.crossingClosed = (tile) => this.rail.closedCrossings.has(tile);
    this.air = new AirSystem(this);
    this.air.onService = (t) => this.maintenance.service(t);
    this.air.onArrive = (t, s) => this.cargo.arrive(t, s);
    this.air.onLoading = (t, s) => this.atStop(t, s);
    this.ships = new ShipSystem(this);
    this.ships.onService = (t) => this.maintenance.service(t);
    this.ships.onArrive = (t, s) => this.cargo.arrive(t, s);
    this.ships.onLoading = (t, s) => this.atStop(t, s);
    this.cargo = new CargoSystem(this);
    this.maintenance = new MaintenanceSystem(this);
    this.rail.onService = (t) => this.maintenance.service(t);
    this.road.onService = (t) => this.maintenance.service(t);
    this.road.onArrive = (t, s) => this.cargo.arrive(t, s);
    this.road.onLoading = (t, s) => this.atStop(t, s);
    this.incidents = new IncidentSystem(this);
    this.maintenance.onBreakdown = (t) => this.incidents.onBreakdown(t);
    this.air.onLanded = (t, st) => this.incidents.onLanded(t, st);
    this.rail.onArrive = (t, s) => this.cargo.arrive(t, s);
    this.rail.onLoading = (t, s) => this.atStop(t, s);
  }

  /** Each tick a vehicle stands at a stop: true keeps it there (a full load, or even spacing). */
  private atStop(t: Train, station: number): boolean {
    const keep = this.cargo.loading(t, station);
    return spacingAtStop(this, t, station, keep) || keep;
  }

  static create(settings: GameSettings): GameState {
    const map = new GameMap(settings.mapWidth, settings.mapHeight);
    map.climate = worldClimate(settings);
    generateTerrain(map, {
      seed: settings.seed,
      roughness: settings.roughness,
      waterLevel: settings.waterLevel,
      treeDensity: settings.treeDensity,
      rivers: settings.rivers ?? 1,
    });
    const state = new GameState(settings, map);
    for (const t of generateTowns(map, settings.seed, settings.startYear)) state.towns.set(t.id, t);
    for (const ind of generateIndustries(map, [...state.towns.values()], settings.seed, settings.startYear)) state.industries.set(ind.id, ind);
    state.nextIndustryId = state.industries.size;
    return state;
  }

  /** Advance the simulation by one tick. */
  step(): TickEvents {
    this.tick++;
    this.rail.step();
    this.road.step();
    this.air.step();
    this.ships.step();
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
    this.cargo.tick();
    return ev;
  }

  private onNewDay(): void {
    this.cargo.daily();
    this.maintenance.daily();
    warnLost(this);
    this.rail.clearWrecks();
    this.incidents.clearWreckage();
    this.growTowns();
    townActionsDaily(this);
    this.billSharing();
    // Running costs for vehicles out of the depot, charged daily.
    for (const t of this.trains.values()) {
      if (t.status === 'depot') continue;
      const daily = this.cost(this.rail.statsOf(t).runningCost) / 365;
      t.profitThisYear -= daily;
      this.addMoney(t.owner, -daily, 'running', vehicleMode(t));
    }
  }

  private onNewYear(): void {
    if (this.settings.inflation) {
      this.inflation.costs = Math.min(20, this.inflation.costs * 1.03);
      this.inflation.payments = Math.min(20, this.inflation.payments * 1.025);
    }
    for (const t of this.trains.values()) {
      t.profitLastYear = t.profitThisYear;
      t.profitThisYear = 0;
      this.dirtyTrains.add(t.id);
    }
  }

  private onNewMonth(): void {
    for (const t of this.towns.values()) {
      t.lastStats = t.stats ?? emptyTownStats();
      t.stats = emptyTownStats();
      this.dirtyTowns.add(t.id);
    }
    for (const ind of this.industries.values()) {
      ind.lastProduced = ind.produced;
      ind.lastTransported = ind.transported;
      ind.lastDelivered = ind.delivered;
      ind.produced = {};
      ind.transported = {};
      ind.delivered = {};
      this.dirtyIndustries.add(ind.id);
    }
    const econ = ECONOMY[this.settings.economy];
    this.countInfrastructure();
    const vehicles = new Map<number, number>();
    for (const t of this.trains.values()) vehicles.set(t.owner, (vehicles.get(t.owner) ?? 0) + 1);
    for (const c of this.companies.values()) {
      if (c.loan > 0) this.addMoney(c.id, -Math.round((c.loan * econ.interestRate) / 12), 'interest');
      // Each transport type pays for the property it uses.
      for (const mode of VEHICLE_MODES) {
        const infra = c.infrastructure.modes?.[mode];
        const due = infra ? Math.round(this.cost(yearlyMaintenance(infra)) / 12) : 0;
        if (due) this.addMoney(c.id, -due, 'property', mode);
      }
      c.value = this.companyValue(c);
      resizeHeadquarters(this, c);
      c.history.push({ date: this.date, money: c.money, loan: c.loan, value: c.value, vehicles: vehicles.get(c.id) ?? 0, ...c.month });
      if (c.history.length > HISTORY_MONTHS) c.history.splice(0, c.history.length - HISTORY_MONTHS);
      c.month = { ledger: emptyLedger(), modes: {}, delivered: {} };
      this.historyChanged.add(c.id);
    }
    industryMonthly(this, this.industryRng, ymdFromDays(this.date).year);
    this.updateMarket();
    monthlyReputation(this);
    if (ymdFromDays(this.date).month % 3 === 0) this.onNewQuarter();
  }

  /** Move cargo prices for the month that ended, with news of world events. */
  private updateMarket(): void {
    if (!this.settings.dynamicPrices) {
      this.market.reset();
      return;
    }
    const cargos = climateCargos(this.map.climate.id);
    for (const text of this.market.monthly(this.date, cargos, [...this.industries.values()], this.towns.values(), this.marketRng)) this.addNews('market', text);
  }

  /** The price level `cargo` pays now (1 = its normal rate). */
  cargoPrice(cargo: CargoId): number {
    return this.settings.dynamicPrices ? this.market.price(cargo) : 1;
  }

  /**
   * Towns grow a little on their own and much faster with good service: each well-served
   * station (picked up within 20 days, rated over 50%) adds growth, as do goods, food, building
   * materials and a company funding new buildings. Towns above the sub-arctic snow line, or in
   * the desert, only grow with food (and water) delivered.
   */
  private growTowns(): void {
    const served = new Map<number, number>();
    for (const st of this.stations.values()) {
      if (st.townId === null || st.rating < 128 || this.date - (st.lastPickup ?? -1e9) > 20) continue;
      served.set(st.townId, (served.get(st.townId) ?? 0) + 1);
    }
    const year = ymdFromDays(this.date).year;
    for (const t of this.towns.values()) {
      const n = Math.min(4, served.get(t.id) ?? 0);
      const last = t.lastStats ?? emptyTownStats();
      const funded = t.funded && t.funded.until > this.date ? FUNDED_GROWTH : 0;
      // Towns in the snow or the desert don't grow without food (and water) unless funded.
      const lacking = townNeeds(this.map, t).some((c) => (last[c] ?? 0) < TOWN_NEED);
      const rate = lacking ? funded : 1 / 150 + n / 30 + (last.goods >= 30 ? 1 / 40 : 0) + (last.food >= 30 ? 1 / 40 : 0) + ((last.building_materials ?? 0) >= 30 ? 1 / 40 : 0) + funded;
      if (t.served !== n || t.growthRate !== rate) {
        t.served = n;
        t.growthRate = rate;
        this.dirtyTowns.add(t.id);
      }
      t.growth = (t.growth ?? 0) + rate;
      if (t.growth < 1) continue;
      t.growth -= 1;
      const changed = growTown(this.map, t, this.townRng, year);
      for (const i of changed) {
        const x = i % this.map.width;
        this.map.touchTile(x, (i - x) / this.map.width);
      }
      if (changed.length) this.dirtyTowns.add(t.id);
      if (changed.some((i) => this.map.layers.type[i] === TileType.Road)) this.onRoadsChanged();
    }
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
      c.finances.push({ ...quarterOf(this.date), ledger: emptyLedger(), modes: {} });
      if (c.finances.length > LEDGER_QUARTERS) c.finances.splice(0, c.finances.length - LEDGER_QUARTERS);
    }
  }

  /**
   * Change a company's money, booking it under `category` (null: off the books, e.g. loans) and
   * the transport type it belongs to, if any.
   */
  addMoney(companyId: number, delta: number, category: LedgerCategory | null, mode?: VehicleMode): void {
    const c = this.companies.get(companyId);
    if (!c) return;
    c.money += delta;
    if (!category) return;
    const q = c.finances[c.finances.length - 1];
    if (q) bookInto(q, delta, category, mode);
    bookInto(c.month, delta, category, mode);
  }

  /** Count every company's track, stations, depots and signals (for maintenance and value), in total and by transport type. */
  countInfrastructure(): void {
    const counts = new Map<number, Infrastructure>();
    for (const c of this.companies.values()) counts.set(c.id, { ...emptyInfrastructure(), modes: {} });
    const { type, owner, track, signals } = this.map.layers;
    for (let i = 0; i < type.length; i++) {
      const o = owner[i]!;
      if (o === OWNER_NONE) continue;
      const infra = counts.get(o);
      if (!infra) continue;
      const t = type[i];
      const of = (mode: VehicleMode) => (infra.modes![mode] ??= emptyInfrastructure());
      if (t === TileType.Rail) {
        let bits = track[i]!;
        let n = 0;
        while (bits) {
          n += bits & 1;
          bits >>= 1;
        }
        const sig = signals[i]!;
        let s = 0;
        for (let p = 0; p < 6; p++) if ((sig >> (p * 2)) & 3) s++;
        for (const x of [infra, of('rail')]) {
          x.track += Math.max(1, n);
          x.signals += s;
        }
      } else if (t === TileType.Lock || (t === TileType.Water && this.map.layers.data[i]! & WATER_CANAL)) {
        infra.track++;
        of('water').track++;
      } else if (t === TileType.Station || t === TileType.RoadStop || t === TileType.Airport || t === TileType.Dock) {
        infra.stations++;
        of(t === TileType.Station ? 'rail' : t === TileType.RoadStop ? 'road' : t === TileType.Airport ? 'air' : 'water').stations++;
      } else if (t === TileType.Depot || t === TileType.RoadDepot || t === TileType.ShipDepot) {
        infra.depots++;
        of(t === TileType.Depot ? 'rail' : t === TileType.RoadDepot ? 'road' : 'water').depots++;
      }
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
    for (const line of this.lines.values()) if (line.owner !== id) this.dropOrdersFor(line, id);
    for (const t of [...this.trains.values()]) if (t.owner !== id && this.isOnTrackOf(t, id)) this.towHome(t);
    for (const t of [...this.trains.values()]) if (t.owner === id) this.removeVehicle(t);
    for (const line of [...this.lines.values()]) if (line.owner === id) deleteLine(this, line.id);
    for (const wp of [...this.waypoints.values()]) if (wp.buoy && wp.owner === id) this.deleteWaypoint(wp.id);
    const { type, owner } = this.map.layers;
    const dirty = new Set<number>();
    removeHeadquarters(this, this.companies.get(id)!, dirty);
    const stations = new Set<number>();
    for (let i = 0; i < type.length; i++) {
      if (owner[i] !== id) continue;
      const t = type[i];
      if (t === TileType.Airport) {
        stations.add(this.map.layers.data[i]!);
        removeAirport(this, this.map.layers.data[i]!);
        continue;
      }
      if (t === TileType.Water || t === TileType.Lock || t === TileType.ShipDepot || t === TileType.Dock) {
        const st = removeWaterTile(this, i, id, dirty);
        if (st !== null) stations.add(st);
        continue;
      }
      if (t !== TileType.Rail && t !== TileType.Station && t !== TileType.Depot && t !== TileType.RoadStop && t !== TileType.RoadDepot) continue;
      const st = demolishTile(this, i, dirty);
      if (st !== null) stations.add(st);
    }
    // Its roads stay, as public roads.
    for (let i = 0; i < type.length; i++) if (owner[i] === id && type[i] === TileType.Road) owner[i] = OWNER_NONE;
    refreshStations(this, stations);
    this.onTrackChanged();
    forgetCompanyInTowns(this, id);
    this.companies.delete(id);
    for (const t of this.towns.values()) {
      if (t.ratings?.[id] === undefined) continue;
      delete t.ratings[id];
      this.dirtyTowns.add(t.id);
    }
    for (const p of this.players.values()) if (p.companyId === id) p.companyId = null;
  }

  // ---- rail network hooks (filled in by the train/signal systems) -------------

  // ---- track sharing --------------------------------------------------------

  /** Whose track `company`'s trains may use; electric trains only where it is electrified. */
  accessFor(company: number, electric = false): TrackAccess {
    const key = company * 2 + (electric ? 1 : 0);
    let a = this.accessCache.get(key);
    if (!a) {
      const uses = new Uint8Array(256);
      uses[company] = 1;
      for (const ag of this.agreements.values()) if (ag.status === 'active' && ag.guest === company) uses[ag.host] = 1;
      a = { uses, joins: this.joins, types: electric ? ELECTRIC_TYPES : undefined };
      this.accessCache.set(key, a);
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
    for (const line of this.lines.values()) if (line.owner === a.guest) this.dropOrdersFor(line, a.host);
    for (const t of [...this.trains.values()]) {
      if (t.owner !== a.guest || !isRailVehicle(t)) continue;
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

  /** A line loses its stops at `owner`'s stations. */
  private dropOrdersFor(line: Line, owner: number): void {
    this.dropOrders(line, (o) => o.kind === 'station' && this.stations.get(o.station)?.owner === owner);
  }

  /** Remove some of a line's orders; jumps follow the orders that stay. */
  private dropOrders(line: Line, drop: (o: Order) => boolean): void {
    if (!line.orders.some(drop)) return;
    const index: number[] = [];
    const keep: Order[] = [];
    line.orders.forEach((o, i) => {
      index[i] = keep.length;
      if (!drop(o)) keep.push(o);
    });
    const fixed = keep.map((o) => (o.kind === 'jump' ? { ...o, to: Math.min(index[o.to] ?? 0, Math.max(0, keep.length - 1)) } : o));
    setLineOrders(this, line, fixed.every((o) => o.kind === 'jump') ? [] : fixed);
  }

  /** Put a vehicle straight into its company's nearest depot, or sell it if there is none. */
  towHome(t: Train): void {
    const best = this.nearestDepot(t);
    if (best >= 0) {
      this.systemOf(t).enterDepot(t, best);
      return;
    }
    this.addMoney(t.owner, resaleValue(t.value, (this.date - t.builtDays) / 365), 'vehicles', vehicleMode(t));
    this.removeVehicle(t);
  }

  /** The company's depot (of the vehicle's kind) nearest to it, as the crow flies, that passes `ok`; -1 if none. */
  nearestDepot(t: Train, ok?: (depot: number) => boolean): number {
    const w = this.map.width;
    const free = t.air ?? t.ship;
    const head = free ? Math.floor(free.y) * this.map.width + Math.floor(free.x) : t.path.length ? segTile(t.path[0]!) : Math.max(0, t.depot);
    const hx = head % w;
    const hy = (head - hx) / w;
    const depots = t.mode === 'road' ? this.roadDepots : t.mode === 'air' ? this.hangars(t.owner) : t.mode === 'water' ? this.shipDepots : this.depots;
    const near = [...depots]
      .filter((d) => this.map.layers.owner[d] === t.owner)
      .map((d) => ({ d, dist: ((d % w) - hx) ** 2 + (Math.floor(d / w) - hy) ** 2 }))
      .sort((a, b) => a.dist - b.dist);
    return near.find(({ d }) => !ok || ok(d))?.d ?? -1;
  }

  /** Count ticks guest trains spend on other companies' track (billed daily). */
  private countSharing(): void {
    const owner = this.map.layers.owner;
    for (const t of this.trains.values()) {
      if (t.path.length === 0 || !isRailVehicle(t)) continue;
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
      this.addMoney(a.guest, -fee, 'sharing', 'rail');
      this.addMoney(a.host, fee, 'sharing', 'rail');
    }
    this.sharingTicks.clear();
  }

  /** Remove a waypoint; trains drop their orders for it. */
  deleteWaypoint(id: number): void {
    const wp = this.waypoints.get(id);
    if (!wp) return;
    this.waypoints.delete(id);
    const { type, data } = this.map.layers;
    if (type[wp.tile] === TileType.Rail) data[wp.tile] = data[wp.tile]! & ~WAYPOINT_FLAG;
    if (type[wp.tile] === TileType.Water) data[wp.tile] = data[wp.tile]! & ~WATER_BUOY;
    this.map.touchTile(wp.tile % this.map.width, Math.floor(wp.tile / this.map.width));
    for (const line of this.lines.values()) this.dropOrders(line, (o) => o.kind === 'waypoint' && o.waypoint === id);
  }

  onTrackChanged(): void {
    this.trackVersion++;
    // Waypoints whose track went away go with it.
    const { type, data } = this.map.layers;
    for (const wp of [...this.waypoints.values()]) {
      if (wp.buoy) continue;
      if (type[wp.tile] !== TileType.Rail || !(data[wp.tile]! & WAYPOINT_FLAG)) this.deleteWaypoint(wp.id);
    }
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

  onRoadsChanged(): void {
    this.roadVersion++;
  }

  onWaterChanged(): void {
    this.waterVersion++;
  }

  /** Is a road vehicle on this tile? */
  roadBusy(tile: number): boolean {
    return this.road.busy(tile);
  }

  /** The system that moves a vehicle: rail for trains, road for buses and trucks. */
  systemOf(t: Train): RailSystem | RoadSystem | AirSystem | ShipSystem {
    return t.mode === 'road' ? this.road : t.mode === 'air' ? this.air : t.mode === 'water' ? this.ships : this.rail;
  }

  /** Hangar tiles of a company's airports. */
  hangars(company: number): number[] {
    const out: number[] = [];
    for (const st of this.stations.values()) if (st.airport && st.owner === company) out.push(hangarTile(this.map, st.airport));
    return out;
  }

  /** Take a vehicle out of the world for good (sold, crashed, its company gone). */
  removeVehicle(t: Train): void {
    this.systemOf(t).removeFromWorld(t);
    this.trains.delete(t.id);
    this.dirtyTrains.delete(t.id);
    this.removedTrains.add(t.id);
  }

  /** Is any road vehicle parked in (or on) the road depot on this tile? */
  roadDepotHasVehicles(tile: number): boolean {
    for (const t of this.trains.values()) {
      if (t.mode !== 'road') continue;
      if ((t.status === 'depot' || t.path.length === 0) && t.depot === tile) return true;
      if (t.path.some((s) => segTile(s) === tile)) return true;
    }
    return false;
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

  addNews(kind: NewsKind, text: string, extra: { company?: number; tile?: number; detail?: string; vehicle?: number } = {}): NewsItem {
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
      finances: [{ ...quarterOf(this.date), ledger: emptyLedger(), modes: {} }],
      badQuarters: 0,
      infrastructure: emptyInfrastructure(),
      value: econ.startMoney,
      autorenew: true,
      replace: {},
      history: [],
      month: { ledger: emptyLedger(), modes: {}, delivered: {} },
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
    return Math.round(base * ECONOMY[this.settings.economy].costFactor * this.inflation.costs);
  }

  /** The most a company may borrow (rises with inflation, in loan steps). */
  maxLoan(): number {
    return Math.round((ECONOMY[this.settings.economy].maxLoan * this.inflation.costs) / LOAN_STEP) * LOAN_STEP;
  }
}
