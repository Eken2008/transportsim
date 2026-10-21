import type { Industry } from './industries.ts';
import { industryType } from './industries.ts';
import type { Town } from '../town/towns.ts';
import type { Random } from '../util/random.ts';
import { MONTH_NAMES, daysFromYmd, ymdFromDays } from '../sim/date.ts';
import { isCargo, type CargoId } from './cargo.ts';

/**
 * Cargo prices. Each cargo has a price level (1 = its normal rate) that changes every month:
 *
 * - Supply against demand: what was delivered across the world in the last few months against
 *   what the world takes (the industries that accept the cargo, and for town cargo and passengers,
 *   how many people live on the map). Cargo nobody carries pays a little more; a flooded market
 *   pays less.
 * - A slow random drift.
 * - World events (a miners' strike, a bumper harvest, a recession) that push prices up or down
 *   for some months. Seasonal ones (a bitter winter, the Christmas post, a summer drought) only
 *   start at their time of year, each with its own chance, so they come round like the seasons.
 *
 * Prices are sticky: the market part moves only part of the way to its target each month, so a
 * glut or a shortage shows over a season. Events act at once, and end at once.
 */

/** Units a month each industry that accepts a cargo takes before its market starts to fill. */
const INDUSTRY_DEMAND = 400;
/** Units a month each resident on the map takes, for cargo towns take (and passengers and mail). */
const RESIDENT_DEMAND: Partial<Record<CargoId, number>> = {
  passengers: 0.35,
  mail: 0.08,
  goods: 0.25,
  food: 0.25,
  water: 0.25,
  building_materials: 0.1,
  gold: 0.015,
  diamonds: 0.03,
};
/** Demand never counts as less than this (units a month). */
const MIN_DEMAND = 200;
/** How strongly each cargo's price reacts (fares and postage are regulated; valuables swing). */
const VOLATILITY: Partial<Record<CargoId, number>> = { passengers: 0.35, mail: 0.35, gold: 1.2, diamonds: 1.2 };
/** Share of the gap to its target the market price closes each month. */
const STICKINESS = 0.4;
/** Weight of the latest month in the smoothed supply. */
const SUPPLY_SMOOTHING = 0.5;
/** Monthly chance of a new world event at any time of year, and how many may run at once. */
const EVENT_CHANCE = 0.12;
const MAX_EVENTS = 3;
/** Months of price history kept. */
export const MARKET_HISTORY_MONTHS = 120;
export const PRICE_MIN = 0.3;
export const PRICE_MAX = 3;

/**
 * Price from supply against demand, at `u` = smoothed deliveries ÷ demand: 110% when nobody
 * carries it, 95% at half the demand, 86% at the demand, 78% at twice it, towards 60%.
 */
export function saturation(u: number): number {
  return 0.6 + 0.5 / (1 + 0.9 * Math.max(0, u));
}

export interface CargoMarket {
  /** Price level paid now (market × events). */
  price: number;
  /** The supply-and-demand part of the price. */
  base: number;
  /** Random drift, around 0. */
  drift: number;
  /** Deliveries a month (smoothed over the last few months). */
  supply: number;
  /** Units a month the world takes. */
  demand: number;
  /** Delivered so far this month. */
  month: number;
}

/** A world event moving the prices of some cargo for a while. */
export interface MarketEvent {
  id: number;
  cargos: CargoId[];
  /** Price multiplier while it lasts. */
  factor: number;
  /** Day it started and the day it ends. */
  from: number;
  until: number;
  /** Headline, and the news when it ends. */
  text: string;
  end: string;
}

export interface MarketMonth {
  /** Game date (days) of the month's end. */
  date: number;
  prices: Partial<Record<CargoId, number>>;
}

/** What clients see of the market (in the daily global state). */
export interface MarketView {
  cargos: Partial<Record<CargoId, { price: number; supply: number; demand: number }>>;
  events: MarketEvent[];
}

interface EventTemplate {
  cargos: readonly CargoId[] | 'freight';
  up: boolean;
  /** Headline; `{pct}` is the change. */
  text: string;
  end: string;
  /** Relative frequency (events at any time of year). */
  weight?: number;
  /**
   * Seasonal events: the months (0 = January) it may start in, its chance of starting in each of
   * them, how many months it lasts, and a short name for the market's calendar.
   */
  season?: { name: string; months: readonly number[]; chance: number; length: readonly [number, number] };
}

const EVENTS: readonly EventTemplate[] = [
  { cargos: ['coal'], up: true, text: "Miners' strike: coal pays {pct} more", end: "The miners' strike is over and coal prices settle" },
  {
    cargos: ['coal'],
    up: true,
    text: 'Bitter winter: coal is in demand and pays {pct} more',
    end: 'The cold spell breaks and coal prices settle',
    season: { name: 'Bitter winter', months: [10, 11, 0], chance: 0.12, length: [2, 4] },
  },
  {
    cargos: ['coal'],
    up: false,
    text: 'Mild winter: coal pays {pct} less',
    end: 'Coal prices recover after the mild winter',
    season: { name: 'Mild winter', months: [11, 0], chance: 0.08, length: [2, 3] },
  },
  { cargos: ['iron_ore', 'steel'], up: true, text: 'Railway building boom: steel and iron ore pay {pct} more', end: 'The railway building boom cools and steel prices settle' },
  { cargos: ['steel'], up: false, text: 'Cheap imported steel floods the market: steel pays {pct} less', end: 'Steel imports dry up and steel prices recover' },
  { cargos: ['wood'], up: true, text: 'Housing boom: wood pays {pct} more', end: 'The housing boom is over and wood prices settle' },
  { cargos: ['wood'], up: false, text: 'Timber glut: wood pays {pct} less', end: 'The timber glut is cleared and wood prices recover' },
  {
    cargos: ['grain', 'livestock', 'fruit'],
    up: true,
    text: 'Summer drought ruins the harvest: farm produce pays {pct} more',
    end: 'The rains return and farm prices settle',
    season: { name: 'Summer drought', months: [5, 6, 7], chance: 0.07, length: [3, 5] },
  },
  {
    cargos: ['grain', 'fruit'],
    up: false,
    text: 'Bumper harvest: grain and fruit pay {pct} less',
    end: 'The bumper harvest is sold and crop prices recover',
    season: { name: 'Bumper harvest', months: [7, 8], chance: 0.12, length: [2, 4] },
  },
  { cargos: ['livestock'], up: true, text: 'Cattle disease thins the herds: livestock pays {pct} more', end: 'The herds recover and livestock prices settle' },
  { cargos: ['food'], up: true, text: 'Food shortage in the cities: food pays {pct} more', end: 'The food shortage eases and food prices settle' },
  { cargos: ['oil'], up: true, text: 'Oil crisis: oil pays {pct} more', end: 'The oil crisis is over and oil prices settle' },
  { cargos: ['oil'], up: false, text: 'New oil fields abroad: oil pays {pct} less', end: 'Oil prices recover as the foreign fields run dry' },
  { cargos: ['rubber'], up: true, text: 'Motor car craze: rubber pays {pct} more', end: 'The motor car craze fades and rubber prices settle' },
  { cargos: ['copper_ore'], up: true, text: 'Electrification drive: copper ore pays {pct} more', end: 'The electrification drive slows and copper prices settle' },
  { cargos: ['copper_ore'], up: false, text: 'Copper slump: copper ore pays {pct} less', end: 'Copper prices recover' },
  { cargos: ['stone', 'building_materials'], up: true, text: 'Building boom: stone and building materials pay {pct} more', end: 'The building boom slows and building prices settle' },
  { cargos: ['stone'], up: true, text: "Quarrymen's strike: stone pays {pct} more", end: "The quarrymen's strike is over and stone prices settle" },
  { cargos: ['building_materials'], up: true, text: 'A great fire in the capital: building materials pay {pct} more for the rebuilding', end: 'The capital is rebuilt and building materials prices settle' },
  { cargos: ['building_materials'], up: false, text: 'Building slump: building materials pay {pct} less', end: 'Builders are busy again and building materials prices recover' },
  {
    cargos: ['building_materials'],
    up: true,
    text: 'Spring building season: building materials pay {pct} more',
    end: 'The spring building rush is over and prices settle',
    season: { name: 'Building season', months: [2, 3], chance: 0.15, length: [2, 3] },
  },
  {
    cargos: ['stone', 'building_materials'],
    up: false,
    text: 'Hard frost halts building work: stone and building materials pay {pct} less',
    end: 'The frost lifts and building work resumes',
    season: { name: 'Hard frost', months: [11, 0], chance: 0.08, length: [2, 3] },
  },
  { cargos: ['chemicals'], up: true, text: 'Demand for dyes and fertiliser soars: chemicals pay {pct} more', end: 'Demand for chemicals eases and prices settle' },
  { cargos: ['chemicals'], up: false, text: 'Strict new rules after a chemical works blast abroad: chemicals pay {pct} less', end: 'The new safety rules bed in and chemical prices recover' },
  { cargos: ['cotton'], up: true, text: 'Boll weevil blight: cotton pays {pct} more', end: 'The blight is beaten and cotton prices settle' },
  { cargos: ['cotton'], up: true, text: 'Cotton frocks are all the fashion: cotton pays {pct} more', end: 'The fashion passes and cotton prices settle' },
  {
    cargos: ['cotton'],
    up: false,
    text: 'The cotton harvest floods the market: cotton pays {pct} less',
    end: 'The cotton harvest is sold and prices recover',
    season: { name: 'Cotton harvest', months: [8, 9], chance: 0.15, length: [2, 3] },
  },
  { cargos: ['goods'], up: true, text: 'Shopping spree: goods pay {pct} more', end: 'The shopping spree is over and goods prices settle' },
  {
    cargos: ['goods'],
    up: true,
    text: 'Christmas shopping: goods pay {pct} more',
    end: 'The Christmas rush is over and goods prices settle',
    season: { name: 'Christmas shopping', months: [10], chance: 0.4, length: [2, 2] },
  },
  { cargos: ['goods'], up: false, text: 'Trade slump: goods pay {pct} less', end: 'Trade picks up and goods prices recover' },
  { cargos: ['paper'], up: true, text: 'Newspaper boom: paper pays {pct} more', end: 'The newspaper boom is over and paper prices settle' },
  { cargos: ['gold'], up: true, text: 'Gold fever: gold pays {pct} more', end: 'Gold fever passes and gold prices settle' },
  { cargos: ['gold'], up: false, text: 'Gold found abroad: gold pays {pct} less', end: 'Gold prices recover' },
  { cargos: ['diamonds'], up: true, text: 'Diamonds are in fashion: they pay {pct} more', end: 'The diamond fashion passes and prices settle' },
  { cargos: ['diamonds'], up: false, text: 'A diamond glut: diamonds pay {pct} less', end: 'Diamond prices recover' },
  {
    cargos: ['water'],
    up: true,
    text: 'Heatwave: water pays {pct} more',
    end: 'The heatwave breaks and water prices settle',
    season: { name: 'Heatwave', months: [5, 6, 7], chance: 0.1, length: [1, 3] },
  },
  {
    cargos: ['passengers'],
    up: true,
    text: 'Summer holidays: fares are {pct} higher',
    end: 'The summer holidays are over and fares settle',
    season: { name: 'Summer holidays', months: [5], chance: 0.35, length: [3, 3] },
  },
  {
    cargos: ['passengers'],
    up: true,
    text: 'A grand exhibition draws visitors: fares are {pct} higher',
    end: 'The grand exhibition closes and fares settle',
    season: { name: 'Grand exhibition', months: [3, 4], chance: 0.06, length: [4, 6] },
  },
  {
    cargos: ['mail'],
    up: true,
    text: 'Christmas post: mail pays {pct} more',
    end: 'The Christmas post is delivered',
    season: { name: 'Christmas post', months: [11], chance: 0.5, length: [1, 1] },
  },
  { cargos: 'freight', up: true, text: 'Economic boom: all freight pays {pct} more', end: 'The economic boom is over and freight prices settle', weight: 0.5 },
  { cargos: 'freight', up: false, text: 'Recession: all freight pays {pct} less', end: 'The recession is over and freight prices recover', weight: 0.5 },
];

/** A seasonal event that can happen in this world: its name and the months it may start in. */
export interface SeasonalEvent {
  name: string;
  months: readonly number[];
  up: boolean;
}

/** The seasonal events that can happen with these cargoes, in calendar order. */
export function seasonalEvents(cargos: readonly CargoId[]): SeasonalEvent[] {
  return EVENTS.filter((t) => t.season && t.cargos !== 'freight' && t.cargos.some((c) => cargos.includes(c)))
    .map((t) => ({ name: t.season!.name, months: t.season!.months, up: t.up }))
    .sort((a, b) => a.months[0]! - b.months[0]!);
}

/** "Nov–Jan" for a run of months. */
export const monthSpan = (months: readonly number[]) =>
  months.length === 1 ? MONTH_NAMES[months[0]!]! : `${MONTH_NAMES[months[0]!]}–${MONTH_NAMES[months[months.length - 1]!]}`;

const round3 = (v: number) => Math.round(v * 1000) / 1000;
const pct = (factor: number) => `${Math.round(Math.abs(factor - 1) * 100)}%`;

/** The world's cargo market. Pure data and monthly stepping; the game state owns it. */
export class Market {
  cargos: Partial<Record<CargoId, CargoMarket>> = {};
  events: MarketEvent[] = [];
  history: MarketMonth[] = [];
  nextEventId = 1;
  /** Set when a month was added to the history (the server sends it out). */
  historyChanged = false;
  /** Scales the chance of every world event (0: none). */
  eventRate = 1;

  /** The price level a cargo pays now (1 = its normal rate). */
  price(cargo: CargoId): number {
    return this.cargos[cargo]?.price ?? 1;
  }

  /** Count a delivery to its destination (transfers don't count). */
  record(cargo: CargoId, n: number): void {
    (this.cargos[cargo] ??= fresh()).month += n;
  }

  /** What the world takes of each cargo, in units a month. */
  static demand(cargos: readonly CargoId[], industries: Iterable<Industry>, towns: Iterable<Town>): Partial<Record<CargoId, number>> {
    let residents = 0;
    for (const t of towns) residents += t.population;
    const out: Partial<Record<CargoId, number>> = {};
    for (const c of cargos) out[c] = residents * (RESIDENT_DEMAND[c] ?? 0);
    for (const ind of industries) {
      for (const c of industryType(ind.type)?.accepts ?? []) if (out[c] !== undefined) out[c]! += INDUSTRY_DEMAND;
    }
    for (const c of cargos) out[c] = Math.max(MIN_DEMAND, out[c]!);
    return out;
  }

  /**
   * End of a month: update supply and demand, move prices, end and start events. Returns news
   * headlines for events that started or ended.
   */
  monthly(date: number, cargos: readonly CargoId[], industries: readonly Industry[], towns: Iterable<Town>, rng: Random): string[] {
    const news: string[] = [];
    const demand = Market.demand(cargos, industries, towns);

    // Events that ran out.
    for (const e of this.events.filter((e) => e.until <= date)) news.push(e.end);
    this.events = this.events.filter((e) => e.until > date);

    // New event: only for cargo someone on the map makes (or passengers and mail).
    const made = new Set<CargoId>(['passengers', 'mail']);
    for (const ind of industries) for (const c of industryType(ind.type)?.produces ?? []) made.add(c);
    const inPlay = cargos.filter((c) => made.has(c));
    const busy = new Set(this.events.flatMap((e) => e.cargos));
    const options = EVENTS.map((t) => ({
      t,
      cargos: t.cargos === 'freight' ? inPlay.filter((c) => c !== 'passengers' && c !== 'mail') : t.cargos.filter((c) => inPlay.includes(c)),
    })).filter((o) => o.cargos.length > 0);
    type Option = (typeof options)[number];
    const free = (o: Option) => this.events.length < MAX_EVENTS && !o.cargos.some((c) => busy.has(c));
    // The month that starts now (the date is its first day).
    const { year, month } = ymdFromDays(date);
    const start = (o: Option, months: number) => {
      const wide = o.t.cargos === 'freight';
      // Booms and recessions move everything a little; fares and postage move half as much.
      const tame = o.cargos.every((c) => (VOLATILITY[c] ?? 1) < 1) ? 0.5 : 1;
      const size = (wide ? 0.1 + rng.next() * 0.1 : o.t.up ? 0.2 + rng.next() * 0.3 : 0.15 + rng.next() * 0.2) * tame;
      const factor = round3(o.t.up ? 1 + size : 1 - size);
      // Events end as a month ends.
      const until = daysFromYmd(year, month + months, 1);
      const e: MarketEvent = { id: this.nextEventId++, cargos: o.cargos, factor, from: date, until, text: o.t.text.replace('{pct}', pct(factor)), end: o.t.end };
      this.events.push(e);
      for (const c of o.cargos) busy.add(c);
      news.push(e.text);
    };
    // Seasonal events in their season, each with its own chance.
    for (const o of options) {
      const s = o.t.season;
      if (s && s.months.includes(month) && free(o) && rng.chance(s.chance * this.eventRate)) start(o, rng.int(s.length[0], s.length[1]));
    }
    // Now and then an event at any time of year.
    if (rng.chance(EVENT_CHANCE * this.eventRate)) {
      const open = options.filter((o) => !o.t.season && free(o));
      const total = open.reduce((s, o) => s + (o.t.weight ?? 1), 0);
      let r = rng.next() * total;
      const pick = open.find((o) => (r -= o.t.weight ?? 1) < 0);
      if (pick) start(pick, pick.t.cargos === 'freight' ? rng.int(6, 14) : rng.int(3, 10));
    }

    // Prices.
    const prices: Partial<Record<CargoId, number>> = {};
    for (const c of cargos) {
      const m = (this.cargos[c] ??= fresh());
      m.supply = m.supply * (1 - SUPPLY_SMOOTHING) + m.month * SUPPLY_SMOOTHING;
      m.month = 0;
      m.demand = demand[c]!;
      // Mean-reverting drift; the sum of three uniforms is a near-normal step.
      m.drift = m.drift * 0.9 + (rng.next() + rng.next() + rng.next() - 1.5) * 0.06;
      const vol = VOLATILITY[c] ?? 1;
      const target = Math.max(0.4, Math.min(2, 1 + vol * (saturation(m.supply / m.demand) - 1) + vol * m.drift));
      m.base += (target - m.base) * STICKINESS;
      let events = 1;
      for (const e of this.events) if (e.cargos.includes(c)) events *= e.factor;
      m.price = round3(Math.max(PRICE_MIN, Math.min(PRICE_MAX, m.base * events)));
      prices[c] = m.price;
    }
    this.history.push({ date, prices });
    if (this.history.length > MARKET_HISTORY_MONTHS) this.history.splice(0, this.history.length - MARKET_HISTORY_MONTHS);
    this.historyChanged = true;
    return news;
  }

  view(): MarketView {
    const cargos: MarketView['cargos'] = {};
    for (const [c, m] of Object.entries(this.cargos) as [CargoId, CargoMarket][]) cargos[c] = { price: m.price, supply: Math.round(m.supply), demand: Math.round(m.demand) };
    return { cargos, events: this.events };
  }

  /** Take on what clients are told (client side). */
  applyView(v: MarketView): void {
    for (const [c, x] of Object.entries(v.cargos) as [CargoId, { price: number; supply: number; demand: number }][]) {
      const m = (this.cargos[c] ??= fresh());
      m.price = x.price;
      m.supply = x.supply;
      m.demand = x.demand;
    }
    this.events = v.events;
  }

  /** Back to normal prices (the setting is off). */
  reset(): void {
    this.cargos = {};
    this.events = [];
  }

  /** Restore from an untrusted save. */
  restore(input: unknown): void {
    const s = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);
    this.cargos = {};
    for (const [c, m] of Object.entries((s.cargos as object) ?? {})) {
      if (!isCargo(c) || !m || typeof m !== 'object') continue;
      const x = m as Record<string, unknown>;
      this.cargos[c] = {
        price: num(x.price, PRICE_MIN, PRICE_MAX, 1),
        base: num(x.base, 0.4, 2, 1),
        drift: num(x.drift, -1, 1, 0),
        supply: num(x.supply, 0, 1e9, 0),
        demand: num(x.demand, 0, 1e9, MIN_DEMAND),
        month: num(x.month, 0, 1e9, 0),
      };
    }
    this.events = [];
    for (const e of Array.isArray(s.events) ? s.events.slice(0, MAX_EVENTS) : []) {
      if (!e || typeof e !== 'object' || !Array.isArray(e.cargos)) continue;
      const cargos = (e.cargos as unknown[]).filter(isCargo);
      if (!cargos.length) continue;
      this.events.push({
        id: num(e.id, 0, 1e9, 0),
        cargos,
        factor: num(e.factor, 0.5, 2, 1),
        from: num(e.from, -1e9, 1e9, 0),
        until: num(e.until, -1e9, 1e9, 0),
        text: String(e.text ?? '').slice(0, 200),
        end: String(e.end ?? '').slice(0, 200),
      });
    }
    this.history = sanitizeMarketHistory(s.history);
    this.nextEventId = Math.max(num(s.nextEventId, 1, 1e9, 1), ...this.events.map((e) => e.id + 1));
  }

  /** What saves keep. */
  save(): { cargos: Partial<Record<CargoId, CargoMarket>>; events: MarketEvent[]; history: MarketMonth[]; nextEventId: number } {
    return { cargos: this.cargos, events: this.events, history: this.history, nextEventId: this.nextEventId };
  }
}

function fresh(): CargoMarket {
  return { price: 1, base: 1, drift: 0, supply: 0, demand: MIN_DEMAND, month: 0 };
}

export function sanitizeMarketHistory(input: unknown): MarketMonth[] {
  if (!Array.isArray(input)) return [];
  const out: MarketMonth[] = [];
  for (const h of input.slice(-MARKET_HISTORY_MONTHS)) {
    if (!h || typeof h.date !== 'number' || !h.prices || typeof h.prices !== 'object') continue;
    const prices: Partial<Record<CargoId, number>> = {};
    for (const [c, p] of Object.entries(h.prices)) if (isCargo(c) && typeof p === 'number' && Number.isFinite(p)) prices[c] = Math.max(PRICE_MIN, Math.min(PRICE_MAX, p));
    out.push({ date: h.date, prices });
  }
  return out;
}

/** "112%" for a price level. */
export const formatPrice = (price: number) => `${Math.round(price * 100)}%`;

/** The events moving a cargo's price now. */
export const eventsFor = (events: readonly MarketEvent[], cargo: CargoId) => events.filter((e) => e.cargos.includes(cargo));
