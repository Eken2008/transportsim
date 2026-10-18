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
  passengerPayment,
  type Command,
} from '../src/index.ts';

const TOWNHOUSE = HOUSE_TYPES.findIndex((h) => h.model === 'townhouse');

function world() {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear: 1900 }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  // Two clusters of houses just south of where the stations go.
  for (const cx of [7, 51]) {
    for (let x = cx - 2; x <= cx + 2; x++) {
      for (const y of [12, 13]) {
        const i = map.tileIndex(x, y);
        map.layers.type[i] = TileType.House;
        map.layers.data[i] = TOWNHOUSE;
      }
    }
  }
  const p = state.addPlayer('A', true);
  const c = state.foundCompany(p)!;
  c.money = 1e7;
  const ctx = { playerId: p.id, companyId: c.id };
  const run = (cmd: Command) => {
    const r = executeCommand(state, ctx, cmd);
    if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
  };
  run({ type: 'buildDepot', x: 2, y: 10, exit: Edge.E });
  const pieces: number[] = [];
  for (let x = 3; x <= 56; x++) pieces.push(x, 10, Piece.X);
  run({ type: 'buildTrack', pieces });
  run({ type: 'buildStation', x: 5, y: 10, axis: 0, platforms: 1, length: 4 });
  run({ type: 'buildStation', x: 49, y: 10, axis: 0, platforms: 1, length: 4 });
  const [a, b] = [state.stations.get(0)!, state.stations.get(1)!];
  run({ type: 'buyTrain', depot: map.tileIndex(2, 10), units: ['kestrel', 'coach_wood', 'coach_wood', 'coach_wood'] });
  const train = [...state.trains.values()][0]!;
  return { state, run, a, b, train, company: c };
}

describe('passengers', () => {
  test('payment grows with distance and shrinks with slow journeys', () => {
    expect(passengerPayment(10, 40, 3)).toBeGreaterThan(passengerPayment(10, 20, 3));
    expect(passengerPayment(10, 40, 60)).toBeLessThan(passengerPayment(10, 40, 3));
    expect(passengerPayment(10, 40, 1000)).toBeGreaterThan(0);
  });

  test('no service, no passengers; a linked pair of stations fills up', () => {
    const { state, run, a, b, train } = world();
    for (let i = 0; i < TICKS_PER_DAY * 5; i++) state.step();
    expect(a.waitingTotal).toBe(0);
    run({ type: 'setOrders', id: train.id, orders: [{ kind: 'station', station: a.id }, { kind: 'station', station: b.id }] });
    for (let i = 0; i < TICKS_PER_DAY * 5; i++) state.step();
    expect(a.waitingTotal).toBeGreaterThan(0);
    expect(Object.keys(a.waiting).map(Number)).toEqual([b.id]);
    expect(b.waiting[a.id]).toBeGreaterThan(0);
  });

  test('trains carry passengers and earn money', () => {
    const { state, run, a, b, train, company } = world();
    run({ type: 'setOrders', id: train.id, orders: [{ kind: 'station', station: a.id }, { kind: 'station', station: b.id }] });
    for (let i = 0; i < TICKS_PER_DAY * 10; i++) state.step();
    run({ type: 'trainAction', id: train.id, action: 'start' });
    let carried = 0;
    const before = company.money;
    for (let i = 0; i < TICKS_PER_DAY * 60; i++) {
      state.step();
      carried = Math.max(carried, train.cargo.reduce((s, p) => s + p.n, 0));
    }
    expect(carried).toBeGreaterThan(20);
    expect(train.profitThisYear).toBeGreaterThan(0);
    expect(company.money).toBeGreaterThan(before);
    expect(a.lastPickup).toBeGreaterThan(a.builtDays);
    // Every passenger aboard is headed for a stop in the train's orders.
    for (const p of train.cargo) expect([a.id, b.id]).toContain(p.dest);
  });

  test('full load waits until the train is full', () => {
    const { state, run, a, b, train } = world();
    run({ type: 'setOrders', id: train.id, orders: [{ kind: 'station', station: a.id, fullLoad: true }, { kind: 'station', station: b.id }] });
    run({ type: 'trainAction', id: train.id, action: 'start' });
    let sawLoadingLong = 0;
    let departedFull = false;
    let wasLoading = false;
    for (let i = 0; i < TICKS_PER_DAY * 90; i++) {
      state.step();
      if (train.status === 'loading' && train.lastStation === a.id) sawLoadingLong++;
      if (wasLoading && train.status === 'running' && train.lastStation === a.id) {
        departedFull = train.cargo.reduce((s, p) => s + p.n, 0) >= state.rail.statsOf(train).capacity;
        break;
      }
      wasLoading = train.status === 'loading';
    }
    expect(sawLoadingLong).toBeGreaterThan(TICKS_PER_DAY * 2);
    expect(departedFull).toBe(true);
  });
});
