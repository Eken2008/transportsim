import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  Edge,
  GameMap,
  GameState,
  Market,
  PRICE_MAX,
  PRICE_MIN,
  Piece,
  Random,
  TICKS_PER_DAY,
  daysFromYmd,
  encodeSnapshot,
  executeCommand,
  industryType,
  newIndustry,
  placeIndustry,
  restoreSnapshot,
  saturation,
  seasonalEvents,
  ymdFromDays,
  type CargoId,
  type Command,
  type Industry,
  type Town,
} from '../src/index.ts';

const CARGOS: CargoId[] = ['passengers', 'mail', 'coal', 'iron_ore', 'steel', 'goods'];
const LIMITS = { maxPlayers: 15, maxMapSize: 256 };

/** A coal mine, an iron mine, two power stations, a steel mill and a factory, and a town of 2,000. */
function world(): { industries: Industry[]; towns: Town[] } {
  const types = ['coal_mine', 'iron_mine', 'power_station', 'power_station', 'steel_mill', 'factory'];
  const industries = types.map((t, i) => newIndustry(i, industryType(t)!, 10 + i * 10, 10, t));
  const towns = [{ id: 0, name: 'Town', x: 100, y: 100, population: 2000, houses: 100 } as Town];
  return { industries, towns };
}

/** The first day of the `n`th month from January 1900 (the market moves as a month starts). */
const monthStart = (n: number) => daysFromYmd(1900, n, 1);

describe('market', () => {
  test('saturation: scarce cargo pays a little more, a flooded market less', () => {
    expect(saturation(0)).toBeCloseTo(1.1, 6);
    for (let u = 0; u < 10; u += 0.25) expect(saturation(u + 0.25)).toBeLessThan(saturation(u));
    expect(saturation(1)).toBeGreaterThan(0.85);
    expect(saturation(1)).toBeLessThan(0.9);
    expect(saturation(1000)).toBeGreaterThan(0.6);
  });

  test('demand counts accepting industries and the people on the map', () => {
    const { industries, towns } = world();
    const d = Market.demand(CARGOS, industries, towns);
    // Two power stations and a steel mill take coal; one mill takes iron ore.
    expect(d.coal).toBe(3 * d.iron_ore!);
    expect(d.goods).toBeCloseTo(2000 * 0.25, 6);
    // Bigger towns want more goods.
    const bigger = Market.demand(CARGOS, industries, [{ ...towns[0]!, population: 8000 }]);
    expect(bigger.goods).toBeGreaterThan(d.goods!);
  });

  test('a cargo flooding the market falls in price, a scarce one rises, and both move gradually', () => {
    const { industries, towns } = world();
    const m = new Market();
    m.eventRate = 0;
    const rng = new Random(1);
    const coal: number[] = [];
    for (let month = 0; month < 24; month++) {
      m.record('coal', 5000);
      m.monthly(monthStart(month), CARGOS, industries, towns, rng);
      coal.push(m.price('coal'));
    }
    expect(m.events).toEqual([]);
    // Coal: 5,000 a month against 1,200 taken.
    expect(m.price('coal')).toBeLessThan(0.85);
    // Prices are sticky: the first month moves only part of the way.
    expect(coal[0]!).toBeGreaterThan(m.price('coal'));
    // Nobody carries steel: it pays more than normal (give or take the drift).
    expect(m.price('steel')).toBeGreaterThan(m.price('coal') + 0.1);
    // Passengers and mail barely move.
    expect(Math.abs(m.price('passengers') - 1)).toBeLessThan(0.15);
    // When the coal stops, its price recovers.
    for (let month = 24; month < 48; month++) m.monthly(monthStart(month), CARGOS, industries, towns, rng);
    expect(m.price('coal')).toBeGreaterThan(0.95);
  });

  test('world events start and end with news, move prices, and prices stay in bounds', () => {
    const { industries, towns } = world();
    const m = new Market();
    const rng = new Random(7);
    const news: string[] = [];
    let seen = 0;
    let moved = false;
    for (let month = 0; month < 600; month++) {
      const before = Object.fromEntries(CARGOS.map((c) => [c, m.price(c)]));
      const ids = new Set(m.events.map((e) => e.id));
      news.push(...m.monthly(monthStart(month), CARGOS, industries, towns, rng));
      for (const e of m.events) {
        if (ids.has(e.id)) continue;
        seen++;
        // A new event moves its cargo's price its way at once (drift aside).
        for (const c of e.cargos) if (Math.sign(m.price(c) - before[c]!) === Math.sign(e.factor - 1)) moved = true;
        expect(e.cargos.every((c) => CARGOS.includes(c))).toBe(true);
        expect(e.text).toMatch(/\d+%/);
      }
      expect(m.events.length).toBeLessThanOrEqual(3);
      for (const c of CARGOS) {
        expect(m.price(c)).toBeGreaterThanOrEqual(PRICE_MIN);
        expect(m.price(c)).toBeLessThanOrEqual(PRICE_MAX);
      }
    }
    // A few a year: about one at any time of year, and the seasons' (Christmas post, summer holidays...).
    expect(seen).toBeGreaterThan(50);
    expect(seen).toBeLessThan(200);
    expect(moved).toBe(true);
    expect(news.length).toBeGreaterThanOrEqual(2 * seen - 3);
    // Cargo nobody on the map makes gets no events (no oil wells, farms or forests here).
    expect(news.some((n) => /oil|grain|wood/i.test(n))).toBe(false);
    expect(m.history.length).toBe(120);
  });

  test('seasonal events start only at their time of year and end as a month ends', () => {
    const { industries, towns } = world();
    const m = new Market();
    const rng = new Random(11);
    const started = new Map<string, Set<number>>();
    for (let month = 0; month < 1200; month++) {
      const ids = new Set(m.events.map((e) => e.id));
      m.monthly(monthStart(month), CARGOS, industries, towns, rng);
      for (const e of m.events) {
        if (ids.has(e.id)) continue;
        const key = e.text.split(':')[0]!;
        if (!started.has(key)) started.set(key, new Set());
        started.get(key)!.add(ymdFromDays(e.from).month);
        // Events run whole months.
        expect(ymdFromDays(e.until).day).toBe(1);
        expect(e.until).toBeGreaterThan(e.from);
      }
    }
    // The Christmas post comes in December, for December only; Christmas shopping in November.
    expect([...started.get('Christmas post')!]).toEqual([11]);
    expect([...started.get('Christmas shopping')!]).toEqual([10]);
    expect([...started.get('Summer holidays')!]).toEqual([5]);
    for (const month of started.get('Bitter winter') ?? []) expect([10, 11, 0]).toContain(month);
    // Seasonal events this world can have (no farms or water here), for the market's calendar.
    const names = seasonalEvents(CARGOS).map((s) => s.name);
    expect(names).toContain('Christmas post');
    expect(names).toContain('Bitter winter');
    expect(names).not.toContain('Bumper harvest');
    expect(names).not.toContain('Heatwave');
  });

  test('deliveries are paid at the market price, and count towards supply', () => {
    const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear: 1940, breakdowns: false }, new GameMap(128, 128));
    state.map.heights.fill(2);
    for (let i = 0; i < 128 * 128; i++) state.map.setClear(i, 0, 0);
    const ind = newIndustry(0, industryType('power_station')!, 40, 14, 'Power');
    placeIndustry(state.map, ind);
    state.industries.set(0, ind);
    const p = state.addPlayer('A', true);
    const c = state.foundCompany(p)!;
    c.money = 1e7;
    const run = (cmd: Command) => {
      const r = executeCommand(state, { playerId: p.id, companyId: c.id }, cmd);
      if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
    };
    run({ type: 'buildDepot', x: 2, y: 10, exit: Edge.E });
    const pieces: number[] = [];
    for (let x = 3; x <= 56; x++) pieces.push(x, 10, Piece.X);
    run({ type: 'buildTrack', pieces });
    run({ type: 'buildStation', x: 5, y: 10, axis: 0, platforms: 1, length: 4 });
    run({ type: 'buildStation', x: 40, y: 10, axis: 0, platforms: 1, length: 4 });
    run({ type: 'buyTrain', depot: state.map.tileIndex(2, 10), units: ['badger', 'open_wagon'] });
    const t = [...state.trains.values()][0]!;
    state.cargo.daily();
    const pay = (price: number) => {
      state.market.cargos.coal = { price, base: price, drift: 0, supply: 0, demand: 1000, month: 0 };
      t.cargo = [{ cargo: 'coal', dest: 1, src: 0, n: 20, day: state.date, hop: 1, at: 0 }];
      const before = c.money;
      state.cargo.arrive(t, 1);
      return c.money - before;
    };
    const normal = pay(1);
    expect(normal).toBeGreaterThan(0);
    expect(pay(1.5)).toBeCloseTo(normal * 1.5, -1);
    expect(state.market.cargos.coal!.month).toBe(20);
    // With market prices off, cargo pays its normal rate.
    state.settings.dynamicPrices = false;
    expect(pay(1.5)).toBe(normal);
  });

  test('prices, events and history survive saves; with the setting off prices stay normal', () => {
    const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear: 1950 }, new GameMap(128, 128));
    state.map.heights.fill(2);
    for (let i = 0; i < 128 * 128; i++) state.map.setClear(i, 0, 0);
    for (let i = 0; i < TICKS_PER_DAY * 70; i++) state.step();
    state.market.events.push({ id: 9, cargos: ['coal'], factor: 1.4, from: state.date, until: state.date + 90, text: "Miners' strike: coal pays 40% more", end: 'Over' });
    state.market.nextEventId = 10;
    expect(state.market.history.length).toBe(2);
    const restored = restoreSnapshot(encodeSnapshot(state), LIMITS);
    expect(restored.market.save()).toEqual(state.market.save());
    expect(restored.settings.dynamicPrices).toBe(true);

    const off = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear: 1950, dynamicPrices: false }, new GameMap(128, 128));
    off.market.record('coal', 1e6);
    for (let i = 0; i < TICKS_PER_DAY * 70; i++) off.step();
    expect(off.cargoPrice('coal')).toBe(1);
    expect(off.market.history.length).toBe(0);
  });
});
