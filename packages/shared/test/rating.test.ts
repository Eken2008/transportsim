import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  Edge,
  GameMap,
  GameState,
  HOUSE_TYPES,
  Piece,
  TICKS_PER_DAY,
  TileType,
  executeCommand,
  ratingParts,
  type Command,
  type Station,
} from '../src/index.ts';

const TOWNHOUSE = HOUSE_TYPES.findIndex((h) => h.model === 'townhouse');

/** Two towns; companies A (track on y=10) and B (y=15) each link them with a station pair. */
function world() {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear: 1900 }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  for (const cx of [7, 51]) {
    for (let x = cx - 2; x <= cx + 2; x++) {
      for (const y of [12, 13]) {
        const i = map.tileIndex(x, y);
        map.layers.type[i] = TileType.House;
        map.layers.data[i] = TOWNHOUSE;
      }
    }
  }
  const line = (name: string, y: number) => {
    const p = state.addPlayer(name, false);
    const c = state.foundCompany(p, `${name} Rail`)!;
    c.money = 1e7;
    const run = (cmd: Command) => {
      const r = executeCommand(state, { playerId: p.id, companyId: c.id }, cmd);
      if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
    };
    run({ type: 'buildDepot', x: 2, y, exit: Edge.E });
    const pieces: number[] = [];
    for (let x = 3; x <= 56; x++) pieces.push(x, y, Piece.X);
    run({ type: 'buildTrack', pieces });
    const before = new Set(state.stations.keys());
    run({ type: 'buildStation', x: 5, y, axis: 0, platforms: 1, length: 4 });
    run({ type: 'buildStation', x: 49, y, axis: 0, platforms: 1, length: 4 });
    const [s0, s1] = [...state.stations.values()].filter((s) => !before.has(s.id));
    run({ type: 'buyTrain', depot: map.tileIndex(2, y), units: ['kestrel', 'coach_wood'] });
    const train = [...state.trains.values()].find((t) => t.owner === c.id)!;
    run({ type: 'setOrders', id: train.id, orders: [{ kind: 'station', station: s0!.id }, { kind: 'station', station: s1!.id }] });
    return { c, run, train, stations: [s0!, s1!] as const };
  };
  return { state, a: line('A', 10), b: line('B', 15) };
}

describe('station ratings', () => {
  const base = { waitingTotal: 0, builtDays: 1000 } as Station;

  test('parts: recent service, little waiting, a fast new train', () => {
    expect(ratingParts(base, 1000)).toMatchObject({ pickup: 95, waiting: 40, speed: 0, age: 0, target: 135 });
    const served = { ...base, lastPickup: 1000, lastSpeed: 205, lastVehicleAge: 0.5 };
    expect(ratingParts(served, 1002)).toMatchObject({ pickup: 95, speed: 30, age: 33, target: 198 });
    expect(ratingParts({ ...served, lastVehicleAge: 4, lastSpeed: 60 }, 1002)).toMatchObject({ speed: 0, age: 0 });
    expect(ratingParts({ ...base, waitingTotal: 2000 }, 1030)).toMatchObject({ pickup: 0, waiting: -90, target: 0 });
  });

  test('the rating drifts towards its target, and service keeps it up', () => {
    const { state, a } = world();
    const [s0] = a.stations;
    s0.rating = 250;
    for (let i = 0; i < TICKS_PER_DAY * 30; i++) state.step();
    // Never served: the pickup part has run out
    expect(s0.rating).toBeLessThan(100);
    a.run({ type: 'trainAction', id: a.train.id, action: 'start' });
    for (let i = 0; i < TICKS_PER_DAY * 40; i++) state.step();
    expect(s0.lastSpeed).toBeGreaterThan(0);
    expect(s0.lastVehicleAge).toBe(0.1);
    expect(s0.rating).toBeGreaterThan(110);
  });

  test('competing stations split the houses they share by rating', () => {
    const { state, a, b } = world();
    const [a0] = a.stations;
    const [b0] = b.stations;
    state.passengers.refresh();
    const pop = state.passengers.population(a0.id);
    expect(pop).toBeGreaterThan(0);
    expect(state.passengers.population(b0.id)).toBe(pop);
    a0.rating = 200;
    b0.rating = 50;
    state.passengers.refresh();
    expect(state.passengers.share(a0.id) / state.passengers.share(b0.id)).toBeCloseTo(4, 5);
    expect(state.passengers.share(a0.id) + state.passengers.share(b0.id)).toBeCloseTo(pop, 5);
    expect(a0.share).toBe(0.8);

    // A station no train serves does not compete
    b.run({ type: 'setOrders', id: b.train.id, orders: [] });
    state.passengers.refresh();
    expect(state.passengers.share(a0.id)).toBeCloseTo(pop, 5);
    expect(state.passengers.share(b0.id)).toBe(0);
  });
});
