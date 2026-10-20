import { describe, expect, test } from 'bun:test';
import {
  COSTS,
  DEFAULT_SETTINGS,
  GameMap,
  GameState,
  HQ_SIZE_VALUES,
  OWNER_NONE,
  TileType,
  encodeSnapshot,
  executeCommand,
  hqPart,
  hqSize,
  hqSizeFor,
  resizeHeadquarters,
  restoreSnapshot,
  type Command,
} from '../src/index.ts';

/** A flat map at height 2 with two companies. */
function world() {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear: 1960, breakdowns: false }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  const players = ['A', 'B'].map((n) => {
    const p = state.addPlayer(n, false);
    const c = state.foundCompany(p, `${n} Co`)!;
    return { p, c };
  });
  const exec = (who: number, cmd: Command) => executeCommand(state, { playerId: players[who]!.p.id, companyId: players[who]!.c.id }, cmd);
  const build = (who: number, x: number, y: number) => exec(who, { type: 'buildHeadquarters', x, y });
  const company = (who: number) => players[who]!.c;
  /** Headquarters tiles of a company. */
  const hqTiles = (who: number) => [...map.layers.type.keys()].filter((i) => map.layers.type[i] === TileType.Headquarters && map.layers.owner[i] === company(who).id);
  return { state, map, exec, build, company, hqTiles };
}

describe('headquarters', () => {
  test('a company builds its 2×2 headquarters on open land', () => {
    const { state, map, build, company, hqTiles } = world();
    const money = company(0).money;
    const r = build(0, 20, 30);
    expect(r.ok).toBe(true);
    expect(company(0).money).toBe(money - state.cost(COSTS.headquarters));
    expect(company(0).hq).toBe(map.tileIndex(20, 30));
    const tiles = hqTiles(0);
    expect(tiles).toEqual([map.tileIndex(20, 30), map.tileIndex(21, 30), map.tileIndex(20, 31), map.tileIndex(21, 31)]);
    expect(tiles.map((i) => hqPart(map.layers.data[i]!))).toEqual([0, 1, 2, 3]);
    expect(state.news.at(-1)!.text).toContain('builds its headquarters');
  });

  test('building again elsewhere moves them, even by a tile', () => {
    const { state, map, build, company, hqTiles } = world();
    build(0, 20, 30);
    expect(build(0, 20, 30).ok).toBe(false); // already there
    expect(build(0, 50, 50).ok).toBe(true);
    expect(company(0).hq).toBe(map.tileIndex(50, 50));
    expect(hqTiles(0)).toHaveLength(4);
    expect(map.layers.type[map.tileIndex(20, 30)]).toBe(TileType.Clear);
    expect(map.layers.owner[map.tileIndex(20, 30)]).toBe(OWNER_NONE);
    expect(state.news.at(-1)!.text).toContain('moves its headquarters');
    // Overlapping its old site.
    expect(build(0, 51, 50).ok).toBe(true);
    expect(company(0).hq).toBe(map.tileIndex(51, 50));
    expect(hqTiles(0)).toHaveLength(4);
    expect(map.layers.type[map.tileIndex(50, 50)]).toBe(TileType.Clear);
  });

  test('they need dry, level land clear of other things', () => {
    const { map, build } = world();
    build(1, 20, 30);
    expect(build(0, 21, 31).ok).toBe(false); // another company's headquarters
    expect(build(0, 127, 10).ok).toBe(false); // off the edge
    map.setWater(map.tileIndex(60, 60));
    expect(build(0, 59, 59).ok).toBe(false);
    // A steep spot can't be built on; a gentle slope gets a foundation.
    map.heights[map.cornerIndex(81, 81)] = 6;
    expect(build(0, 80, 80).ok).toBe(false);
    map.heights[map.cornerIndex(81, 81)] = 2;
    map.heights[map.cornerIndex(41, 41)] = 3;
    const r = build(0, 40, 40);
    expect(r.ok).toBe(true);
    expect([40, 41].every((x) => map.surfaceHeight(x, 40) === 3 && map.surfaceHeight(x, 41) === 3)).toBe(true);
  });

  test('they can’t be bulldozed, and come down with the company', () => {
    const { state, map, exec, build, company, hqTiles } = world();
    build(0, 20, 30);
    const r = exec(0, { type: 'clearArea', x0: 19, y0: 29, x1: 22, y1: 32 });
    expect(r.ok).toBe(false);
    expect(hqTiles(0)).toHaveLength(4);
    // Another company can't knock them down either.
    exec(1, { type: 'clearArea', x0: 20, y0: 30, x1: 21, y1: 31 });
    expect(hqTiles(0)).toHaveLength(4);
    const id = company(0).id;
    state.dissolveCompany(id);
    expect(map.layers.type[map.tileIndex(20, 30)]).toBe(TileType.Clear);
    expect([...map.layers.owner].some((o, i) => o === id && map.layers.type[i] === TileType.Headquarters)).toBe(false);
  });

  test('they grow with the company’s value', () => {
    const { state, map, build, company, hqTiles } = world();
    expect(hqSizeFor(0)).toBe(0);
    expect(hqSizeFor(HQ_SIZE_VALUES[2])).toBe(2);
    expect(hqSizeFor(1e12)).toBe(HQ_SIZE_VALUES.length - 1);
    company(0).value = 0;
    build(0, 20, 30);
    expect(hqTiles(0).every((i) => hqSize(map.layers.data[i]!) === 0)).toBe(true);
    company(0).value = HQ_SIZE_VALUES[3];
    resizeHeadquarters(state, company(0));
    expect(hqTiles(0).every((i) => hqSize(map.layers.data[i]!) === 3)).toBe(true);
    expect(hqTiles(0).map((i) => hqPart(map.layers.data[i]!))).toEqual([0, 1, 2, 3]);
  });

  test('viewers can’t build them, and saves keep them', () => {
    const { state, map, build, company } = world();
    build(0, 20, 30);
    const loaded = restoreSnapshot(encodeSnapshot(state), { maxPlayers: 15, maxMapSize: 256 });
    expect(loaded.companies.get(company(0).id)!.hq).toBe(map.tileIndex(20, 30));
    expect(loaded.companies.get(company(1).id)!.hq).toBeUndefined();
    const watcher = state.addPlayer('C', false);
    state.addMember(company(1), 'C', 'viewer');
    expect(executeCommand(state, { playerId: watcher.id, companyId: company(1).id }, { type: 'buildHeadquarters', x: 60, y: 60 }).ok).toBe(false);
  });
});
