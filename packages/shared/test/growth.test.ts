import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  EDGE_DX,
  EDGE_DY,
  Edge,
  GameMap,
  GameState,
  HOUSE_TYPES,
  Piece,
  Random,
  TICKS_PER_DAY,
  TileType,
  executeCommand,
  growTown,
  type Command,
  type Station,
} from '../src/index.ts';

const settings = { ...DEFAULT_SETTINGS, mapWidth: 256, mapHeight: 256, seed: 11, waterLevel: 0.05, roughness: 'flat' as const, startYear: 1950 };

describe('town growth', () => {
  test('growth steps add houses beside streets, bigger buildings and longer streets', () => {
    const state = GameState.create(settings);
    const town = [...state.towns.values()][0]!;
    const before = { houses: town.houses, population: town.population };
    const rng = new Random(5);
    let changed = 0;
    for (let k = 0; k < 60; k++) changed += growTown(state.map, town, rng, 1950).length > 0 ? 1 : 0;
    expect(changed).toBeGreaterThan(40);
    expect(town.population).toBeGreaterThan(before.population);
    expect(town.houses).toBeGreaterThanOrEqual(before.houses);
    // Every house of the town still faces a street
    const map = state.map;
    for (let i = 0; i < map.layers.type.length; i++) {
      if (map.layers.type[i] !== TileType.House || map.layers.town[i] !== town.id + 1) continue;
      const x = i % map.width;
      const y = (i - x) / map.width;
      const roadNear = [Edge.N, Edge.E, Edge.S, Edge.W].some((e) => map.inBounds(x + EDGE_DX[e], y + EDGE_DY[e]) && map.type(x + EDGE_DX[e], y + EDGE_DY[e]) === TileType.Road);
      expect(roadNear).toBe(true);
    }
  });

  test('good service makes a town grow faster', () => {
    const state = GameState.create(settings);
    const [served, other] = [...state.towns.values()];
    // A well-rated station in the served town, picked up from every day.
    const st: Station = {
      id: 999, name: 'Fake', owner: 0, x: served!.x, y: served!.y, x0: served!.x, y0: served!.y, x1: served!.x, y1: served!.y,
      tiles: 1, townId: served!.id, builtDays: state.date, waiting: {}, waitingTotal: 0, rating: 220,
    };
    state.stations.set(st.id, st);
    const start = { a: served!.population, b: other!.population };
    for (let d = 0; d < 150; d++) {
      st.lastPickup = state.date;
      for (let i = 0; i < TICKS_PER_DAY; i++) state.step();
    }
    expect(served!.served).toBe(1);
    expect(served!.population - start.a).toBeGreaterThan((other!.population - start.b) + 20);
  });

  test("a town's stations count passengers picked up each month", () => {
    const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear: 1950, breakdowns: false }, new GameMap(128, 128));
    const map = state.map;
    map.heights.fill(2);
    for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
    const TOWNHOUSE = HOUSE_TYPES.findIndex((h) => h.model === 'townhouse');
    for (const [id, cx] of [[0, 7], [1, 51]] as const) {
      state.towns.set(id, { id, name: `T${id}`, x: cx, y: 12, population: 0, houses: 0 });
      for (let x = cx - 2; x <= cx + 2; x++) {
        for (const y of [12, 13]) {
          const i = map.tileIndex(x, y);
          map.layers.type[i] = TileType.House;
          map.layers.data[i] = TOWNHOUSE;
          map.layers.town[i] = id + 1;
        }
      }
    }
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
    run({ type: 'buildStation', x: 49, y: 10, axis: 0, platforms: 1, length: 4 });
    expect(state.stations.get(0)!.townId).toBe(0);
    run({ type: 'buyTrain', depot: map.tileIndex(2, 10), units: ['badger', 'coach_steel', 'mail_van'] });
    const t = [...state.trains.values()][0]!;
    run({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: 0 }, { kind: 'station', station: 1 }] });
    run({ type: 'trainAction', id: t.id, action: 'start' });
    for (let i = 0; i < TICKS_PER_DAY * 40; i++) state.step();
    const town = state.towns.get(0)!;
    const total = (town.stats?.passengers ?? 0) + (town.lastStats?.passengers ?? 0);
    expect(total).toBeGreaterThan(0);
    expect((town.stats?.mail ?? 0) + (town.lastStats?.mail ?? 0)).toBeGreaterThan(0);
  });
});
