import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  GameMap,
  GameState,
  HOUSE_TYPES,
  OWNER_NONE,
  Piece,
  REPUTATION_DEMOLISH_FLOOR,
  REPUTATION_START,
  ROAD_E,
  ROAD_W,
  TileType,
  encodeSnapshot,
  executeCommand,
  monthlyReputation,
  reputationLabel,
  reputationOf,
  restoreSnapshot,
  type Command,
  type Town,
} from '../src/index.ts';

const OFFICE = HOUSE_TYPES.findIndex((h) => h.model === 'office');

/** A flat map with one town at (40, 40): a street along y = 40 from x = 34 to 46, houses north of it. */
function world() {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear: 1960 }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  const town: Town = { id: 0, name: 'Testby', x: 40, y: 40, population: 0, houses: 0 };
  state.towns.set(0, town);
  for (let x = 34; x <= 46; x++) {
    const i = map.tileIndex(x, 40);
    map.layers.type[i] = TileType.Road;
    map.layers.owner[i] = OWNER_NONE;
    map.layers.data[i] = (x > 34 ? ROAD_W : 0) | (x < 46 ? ROAD_E : 0);
    map.layers.town[i] = 1;
    const h = map.tileIndex(x, 39);
    map.layers.type[h] = TileType.House;
    map.layers.owner[h] = OWNER_NONE;
    map.layers.data[h] = OFFICE;
    map.layers.town[h] = 1;
    town.houses++;
    town.population += HOUSE_TYPES[OFFICE]!.population;
  }
  const players = ['A', 'B'].map((n) => {
    const p = state.addPlayer(n, false);
    const c = state.foundCompany(p, `${n} Co`)!;
    c.money = 1e7;
    return { p, c };
  });
  const exec = (who: number, cmd: Command, dry = false) => executeCommand(state, { playerId: players[who]!.p.id, companyId: players[who]!.c.id }, cmd, dry);
  const run = (who: number, cmd: Command) => {
    const r = exec(who, cmd);
    if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
    return r;
  };
  const company = (who: number) => players[who]!.c.id;
  return { state, map, town, exec, run, company };
}

describe('town reputation', () => {
  test('bulldozing a town house costs money and reputation with that town only', () => {
    const { state, map, town, exec, run, company } = world();
    const preview = exec(0, { type: 'clearArea', x0: 40, y0: 39, x1: 40, y1: 39 }, true);
    expect(preview.ok && preview.cost > 0).toBe(true);
    expect(preview.ok && preview.note).toContain('Testby');
    const money = state.companies.get(company(0))!.money;
    const pop = town.population;
    run(0, { type: 'clearArea', x0: 40, y0: 39, x1: 40, y1: 39 });
    expect(map.layers.type[map.tileIndex(40, 39)]).toBe(TileType.Clear);
    expect(town.houses).toBe(12);
    expect(town.population).toBe(pop - HOUSE_TYPES[OFFICE]!.population);
    expect(state.companies.get(company(0))!.money).toBeLessThan(money);
    expect(reputationOf(town, company(0))).toBeLessThan(REPUTATION_START);
    expect(reputationOf(town, company(1))).toBe(REPUTATION_START);
    expect(state.dirtyTowns.has(0)).toBe(true);
  });

  test('town streets can be removed by dragging or bulldozing, for reputation', () => {
    const { map, town, run, company } = world();
    run(0, { type: 'removeRoad', x0: 44, y0: 40, x1: 46, y1: 40 });
    expect(map.layers.type[map.tileIndex(45, 40)]).toBe(TileType.Clear);
    expect(map.layers.data[map.tileIndex(44, 40)]! & 0xf).toBe(ROAD_W);
    const after = reputationOf(town, company(0));
    expect(after).toBeLessThan(REPUTATION_START);
    run(0, { type: 'clearArea', x0: 34, y0: 40, x1: 35, y1: 40 });
    expect(map.layers.type[map.tileIndex(34, 40)]).toBe(TileType.Clear);
    expect(reputationOf(town, company(0))).toBeLessThan(after);
  });

  test("the council refuses demolition that would ruin a company's reputation", () => {
    const { map, town, exec, company } = world();
    // Thirteen office blocks are far more than the council will allow at once.
    const r = exec(0, { type: 'clearArea', x0: 34, y0: 39, x1: 46, y1: 39 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('Testby council refuses');
    expect(map.layers.type[map.tileIndex(34, 39)]).toBe(TileType.House);
    expect(reputationOf(town, company(0))).toBe(REPUTATION_START);
    // One at a time, until the council says no more.
    let removed = 0;
    for (let x = 34; x <= 46; x++) if (exec(0, { type: 'clearArea', x0: x, y0: 39, x1: x, y1: 39 }).ok) removed++;
    expect(removed).toBeGreaterThan(0);
    expect(removed).toBeLessThan(13);
    expect(reputationOf(town, company(0))).toBeGreaterThanOrEqual(REPUTATION_DEMOLISH_FLOOR);
  });

  test('a poor reputation bars new stations until it recovers', () => {
    const { state, town, exec, run, company } = world();
    town.ratings = { [company(0)]: -50 };
    run(0, { type: 'buildTrack', pieces: [38, 43, Piece.X, 39, 43, Piece.X, 40, 43, Piece.X] });
    const r = exec(0, { type: 'buildStation', x: 38, y: 43, axis: 0, platforms: 1, length: 3 });
    expect(!r.ok && r.error).toContain('Testby council refuses');
    expect(reputationLabel(-50)).toBe('Poor');
    // Far from town the council has no say.
    run(0, { type: 'buildTrack', pieces: [100, 100, Piece.X, 101, 100, Piece.X] });
    run(0, { type: 'buildStation', x: 100, y: 100, axis: 0, platforms: 1, length: 2 });
    // The council forgives slowly.
    for (let m = 0; m < 5; m++) monthlyReputation(state);
    expect(reputationOf(town, company(0))).toBe(0);
    run(0, { type: 'buildStation', x: 38, y: 43, axis: 0, platforms: 1, length: 3 });
  });

  test('busy, well-rated stations raise reputation; neglected ones lower it, but not below mediocre', () => {
    const { state, town, run, company } = world();
    run(0, { type: 'buildTrack', pieces: [38, 43, Piece.X, 39, 43, Piece.X] });
    run(0, { type: 'buildStation', x: 38, y: 43, axis: 0, platforms: 1, length: 2 });
    const st = [...state.stations.values()][0]!;
    expect(st.townId).toBe(0);
    // New stations get a grace period.
    monthlyReputation(state);
    expect(reputationOf(town, company(0))).toBe(REPUTATION_START);
    state.date += 90;
    st.rating = 200;
    st.lastPickup = state.date - 5;
    monthlyReputation(state);
    expect(reputationOf(town, company(0))).toBeGreaterThan(REPUTATION_START);
    st.lastPickup = state.date - 60;
    for (let m = 0; m < 100; m++) monthlyReputation(state);
    expect(reputationOf(town, company(0))).toBe(0);
  });

  test('reputations survive a save and go when the company does', () => {
    const { state, town, run, company } = world();
    run(0, { type: 'clearArea', x0: 40, y0: 39, x1: 40, y1: 39 });
    const r = reputationOf(town, company(0));
    const loaded = restoreSnapshot(encodeSnapshot(state), { maxPlayers: 15, maxMapSize: 256 });
    expect(reputationOf(loaded.towns.get(0)!, company(0))).toBe(r);
    state.dissolveCompany(company(0));
    expect(town.ratings?.[company(0)]).toBeUndefined();
  });
});
