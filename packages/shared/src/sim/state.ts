import { COMPANY_COLORS, COMPANY_ROLES, MAX_COMPANIES, memberOf, type Company, type CompanyRole } from '../company/company.ts';
import type { Station } from '../rail/station.ts';
import { generateTowns, type Town } from '../town/towns.ts';
import { PassengerSystem } from '../economy/passengers.ts';
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
  private nextPlayerId = 1;
  /** Bumped whenever track topology changes (invalidates routes, signal blocks). */
  trackVersion = 0;

  constructor(settings: GameSettings, map: GameMap, date?: number) {
    this.settings = settings;
    this.map = map;
    this.date = date ?? daysFromYmd(settings.startYear, 0, 1);
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
    // Running costs for vehicles out of the depot, charged daily.
    for (const t of this.trains.values()) {
      if (t.status === 'depot') continue;
      const daily = this.cost(this.rail.statsOf(t).runningCost) / 365;
      t.profitThisYear -= daily;
      const c = this.companies.get(t.owner);
      if (c) c.money -= daily;
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
    // Monthly loan interest, scaled by difficulty (simple model for now).
    for (const c of this.companies.values()) {
      if (c.loan > 0) c.money -= Math.round((c.loan * 0.04) / 12);
    }
  }

  // ---- rail network hooks (filled in by the train/signal systems) -------------

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
