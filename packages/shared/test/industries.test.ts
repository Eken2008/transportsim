import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  Edge,
  GameMap,
  GameState,
  Ground,
  CLIMATES,
  Piece,
  TICKS_PER_DAY,
  TileType,
  encodeSnapshot,
  executeCommand,
  industryType,
  newIndustry,
  placeIndustry,
  restoreSnapshot,
  typesFor,
  zoneFits,
  type Command,
} from '../src/index.ts';

/** A flat world with a line from x = 3 to 56 on y = 10 and a station at each end. */
function world(startYear = 1960) {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear, breakdowns: false }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  const p = state.addPlayer('A', true);
  const c = state.foundCompany(p)!;
  c.money = 1e7;
  const ctx = { playerId: p.id, companyId: c.id };
  const run = (cmd: Command) => {
    const r = executeCommand(state, ctx, cmd);
    if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
  };
  const industry = (type: string, x: number, y: number) => {
    const ind = newIndustry(state.nextIndustryId++, industryType(type)!, x, y, type);
    placeIndustry(map, ind);
    state.industries.set(ind.id, ind);
    return ind;
  };
  run({ type: 'buildDepot', x: 2, y: 10, exit: Edge.E });
  const pieces: number[] = [];
  for (let x = 3; x <= 56; x++) pieces.push(x, 10, Piece.X);
  run({ type: 'buildTrack', pieces });
  run({ type: 'buildStation', x: 5, y: 10, axis: 0, platforms: 1, length: 4 });
  run({ type: 'buildStation', x: 49, y: 10, axis: 0, platforms: 1, length: 4 });
  const [a, b] = [state.stations.get(0)!, state.stations.get(1)!];
  const days = (n: number) => {
    for (let i = 0; i < TICKS_PER_DAY * n; i++) state.step();
  };
  return { state, map, company: c, run, industry, a, b, days, depot: map.tileIndex(2, 10) };
}

describe('industries', () => {
  test.each(CLIMATES)('new %s worlds get industries of every type of the climate, on their own tiles in their zones', (climate) => {
    const state = GameState.create({ ...DEFAULT_SETTINGS, mapWidth: 256, mapHeight: 256, seed: 3, waterLevel: 0.1, startYear: 1950, climate });
    const kinds = new Set([...state.industries.values()].map((i) => i.type));
    const types = typesFor(1950, climate);
    expect(state.industries.size).toBeGreaterThanOrEqual(types.length);
    expect([...kinds].sort()).toEqual(types.map((t) => t.id).sort());
    for (const ind of state.industries.values()) {
      expect(zoneFits(state.map, industryType(ind.type)!, ind.x, ind.y)).toBe(true);
      for (let y = ind.y; y < ind.y + ind.h; y++) {
        for (let x = ind.x; x < ind.x + ind.w; x++) {
          const i = state.map.tileIndex(x, y);
          expect(state.map.layers.type[i]).toBe(TileType.Industry);
          expect(state.map.layers.data[i]).toBe(ind.id);
        }
      }
    }
  });

  test('a coal mine supplies a station; coal delivered to a power station is paid for', () => {
    const { state, run, industry, a, b, days, company, depot } = world();
    const mine = industry('coal_mine', 4, 12);
    const power = industry('power_station', 49, 12);
    days(1);
    expect(a.supplies).toContain('coal');
    expect(b.accepts).toContain('coal');
    expect(a.industries).toEqual([mine.id]);
    run({ type: 'buyTrain', depot, units: ['ox', 'hopper', 'hopper', 'hopper'] });
    const t = [...state.trains.values()][0]!;
    run({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: a.id, fullLoad: true }, { kind: 'station', station: b.id }] });
    run({ type: 'trainAction', id: t.id, action: 'start' });
    const money = company.money;
    days(70);
    const all = (o: Record<string, number | undefined>) => (o.coal ?? 0);
    expect(all(mine.lastProduced) + all(mine.produced)).toBeGreaterThan(0);
    expect(all(mine.lastTransported) + all(mine.transported)).toBeGreaterThan(0);
    expect(all(power.lastDelivered) + all(power.delivered)).toBeGreaterThan(0);
    expect(company.finances.reduce((s, q) => s + q.ledger.income, 0)).toBeGreaterThan(0);
    expect(money).toBeGreaterThan(0);
  });

  test('secondary industries turn deliveries into output', () => {
    const { state, run, industry, a, b, days, depot } = world();
    industry('forest', 4, 12);
    const sawmill = industry('sawmill', 49, 12);
    // Wood one way; goods from the sawmill go back to a town at the far end.
    run({ type: 'buyTrain', depot, units: ['ox', { type: 'hopper', cargo: 'wood' }, { type: 'hopper', cargo: 'wood' }, 'box_wagon'] });
    const t = [...state.trains.values()][0]!;
    run({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: a.id }, { kind: 'station', station: b.id }] });
    run({ type: 'trainAction', id: t.id, action: 'start' });
    days(90);
    const goods = (sawmill.produced.goods ?? 0) + (sawmill.lastProduced.goods ?? 0);
    expect((sawmill.delivered.wood ?? 0) + (sawmill.lastDelivered.wood ?? 0)).toBeGreaterThan(0);
    expect(goods).toBeGreaterThan(0);
    expect(b.supplies).toContain('goods');
  });

  test('industries survive saves', () => {
    const { state, industry } = world();
    const mine = industry('iron_mine', 20, 20);
    mine.level = 2;
    mine.lastProduced = { iron_ore: 123 };
    const restored = restoreSnapshot(encodeSnapshot(state), { maxPlayers: 15, maxMapSize: 256 });
    expect(restored.industries.get(mine.id)).toEqual(mine);
  });
});

describe('farm fields', () => {
  test('generated farms lie among large fields of open land', () => {
    const state = GameState.create({ ...DEFAULT_SETTINGS, mapWidth: 256, mapHeight: 256, seed: 7 });
    const map = state.map;
    const farms = [...state.industries.values()].filter((i) => i.type === 'farm');
    expect(farms.length).toBeGreaterThan(0);
    for (const farm of farms) {
      let fields = 0;
      for (let y = farm.y - 16; y < farm.y + farm.h + 16; y++) {
        for (let x = farm.x - 16; x < farm.x + farm.w + 16; x++) {
          if (!map.inBounds(x, y)) continue;
          const i = map.tileIndex(x, y);
          if (map.layers.type[i] !== TileType.Clear || ((map.layers.data[i]! >> 3) & 7) !== Ground.Field) continue;
          fields++;
          expect(map.treeCount(x, y)).toBe(0);
        }
      }
      expect(fields).toBeGreaterThanOrEqual(40);
    }
  });
});
