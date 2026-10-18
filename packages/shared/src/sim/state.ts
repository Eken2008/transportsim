import { COMPANY_COLORS, MAX_COMPANIES, type Company } from '../company/company.ts';
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
  private nextPlayerId = 1;
  /** Bumped whenever track topology changes (invalidates routes, signal blocks). */
  trackVersion = 0;

  constructor(settings: GameSettings, map: GameMap, date?: number) {
    this.settings = settings;
    this.map = map;
    this.date = date ?? daysFromYmd(settings.startYear, 0, 1);
  }

  static create(settings: GameSettings): GameState {
    const map = new GameMap(settings.mapWidth, settings.mapHeight);
    generateTerrain(map, {
      seed: settings.seed,
      roughness: settings.roughness,
      waterLevel: settings.waterLevel,
      treeDensity: settings.treeDensity,
    });
    return new GameState(settings, map);
  }

  /** Advance the simulation by one tick. */
  step(): TickEvents {
    this.tick++;
    const ev: TickEvents = { newDay: false, newMonth: false, newYear: false };
    if (++this.dayTick >= TICKS_PER_DAY) {
      this.dayTick = 0;
      const before = ymdFromDays(this.date);
      this.date++;
      const after = ymdFromDays(this.date);
      ev.newDay = true;
      ev.newMonth = after.month !== before.month;
      ev.newYear = after.year !== before.year;
      if (ev.newMonth) this.onNewMonth();
    }
    return ev;
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
  isPieceOccupied(_tile: number, _piece: number): boolean {
    return false;
  }

  /** Remove signals on the given pieces of a tile (track is being removed). */
  removeSignalsOn(_tile: number, _pieceBits: number): void {}

  // ---- players & companies -------------------------------------------------

  addPlayer(name: string, isHost: boolean): Player {
    const p: Player = { id: this.nextPlayerId++, name, companyId: null, connected: true, isHost };
    this.players.set(p.id, p);
    // Rejoin the company the player was a member of (e.g. after loading a save)
    for (const c of this.companies.values()) {
      if (c.members.includes(name)) {
        p.companyId = c.id;
        break;
      }
    }
    return p;
  }

  removePlayer(id: number): void {
    this.players.delete(id);
  }

  foundCompany(founder: Player, name?: string): Company | null {
    let id = 0;
    while (this.companies.has(id)) id++;
    if (id >= MAX_COMPANIES) return null;
    const usedColors = new Set([...this.companies.values()].map((c) => c.color));
    let color = 0;
    while (usedColors.has(color) && color < COMPANY_COLORS.length - 1) color++;
    const econ = ECONOMY[this.settings.economy];
    const company: Company = {
      id,
      name: name?.trim().slice(0, 40) || `${founder.name} Transport`,
      color,
      money: econ.startMoney,
      loan: 0,
      members: [founder.name],
      foundedDays: this.date,
    };
    this.companies.set(id, company);
    founder.companyId = id;
    return company;
  }

  /** Ensure the player has a company (one per player until multi-member companies land). */
  ensureCompany(player: Player): Company | null {
    if (player.companyId !== null) {
      const c = this.companies.get(player.companyId);
      if (c) return c;
    }
    return this.foundCompany(player);
  }

  /** Scale a base cost by economy difficulty. */
  cost(base: number): number {
    return Math.round(base * ECONOMY[this.settings.economy].costFactor);
  }
}
