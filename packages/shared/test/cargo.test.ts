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
  cargoPayment,
  encode,
  encodeSnapshot,
  executeCommand,
  parseUnits,
  restoreSnapshot,
  takeSnapshot,
  trainStats,
  type Command,
} from '../src/index.ts';

const TOWNHOUSE = HOUSE_TYPES.findIndex((h) => h.model === 'townhouse');

/** Two clusters of houses with a station by each, linked by straight track. */
function world(startYear = 1940) {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear, breakdowns: false }, new GameMap(128, 128));
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
  const p = state.addPlayer('A', true);
  const c = state.foundCompany(p)!;
  c.money = 1e7;
  const ctx = { playerId: p.id, companyId: c.id };
  const exec = (cmd: Command) => executeCommand(state, ctx, cmd);
  const run = (cmd: Command) => {
    const r = exec(cmd);
    if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
  };
  run({ type: 'buildDepot', x: 2, y: 10, exit: Edge.E });
  const pieces: number[] = [];
  for (let x = 3; x <= 56; x++) pieces.push(x, 10, Piece.X);
  run({ type: 'buildTrack', pieces });
  run({ type: 'buildStation', x: 5, y: 10, axis: 0, platforms: 1, length: 4 });
  run({ type: 'buildStation', x: 49, y: 10, axis: 0, platforms: 1, length: 4 });
  const [a, b] = [state.stations.get(0)!, state.stations.get(1)!];
  return { state, map, company: c, exec, run, a, b, depot: map.tileIndex(2, 10) };
}

describe('cargo', () => {
  test('payment depends on cargo: mail pays well but hates waiting, coal is patient', () => {
    expect(cargoPayment('mail', 10, 40, 3)).toBeGreaterThan(cargoPayment('passengers', 10, 40, 3));
    expect(cargoPayment('coal', 10, 40, 15)).toBe(cargoPayment('coal', 10, 40, 1));
    expect(cargoPayment('mail', 10, 40, 20)).toBeLessThan(cargoPayment('mail', 10, 40, 1));
  });

  test('wagons refit to cargoes they can carry; capacity and weight follow the cargo', () => {
    expect(parseUnits(['badger', { type: 'open_wagon', cargo: 'grain' }])).toEqual([{ type: 'badger' }, { type: 'open_wagon', cargo: 'grain' }]);
    expect(parseUnits(['badger', { type: 'open_wagon', cargo: 'oil' }])).toBe("Open wagon can't carry that");
    // The default cargo isn't stored
    expect(parseUnits([{ type: 'open_wagon', cargo: 'coal' }])).toEqual([{ type: 'open_wagon' }]);
    const stats = trainStats([{ type: 'badger' }, { type: 'open_wagon', cargo: 'grain' }, { type: 'open_wagon' }, { type: 'mail_van' }]);
    expect(stats.capacities).toEqual({ grain: 20, coal: 20, mail: 30 });
    expect(stats.capacity).toBe(70);
  });

  test('towns send mail as well as passengers; a mixed train carries both and earns', () => {
    const { state, run, a, b, company, depot } = world();
    run({ type: 'buyTrain', depot, units: ['badger', 'coach_steel', 'coach_steel', 'mail_van'] });
    const t = [...state.trains.values()][0]!;
    run({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: a.id }, { kind: 'station', station: b.id }] });
    for (let i = 0; i < TICKS_PER_DAY * 10; i++) state.step();
    expect(a.waiting.mail?.[b.id]).toBeGreaterThan(0);
    expect(a.waiting.passengers?.[b.id]).toBeGreaterThan(0);
    expect(a.accepts).toEqual(['passengers', 'mail', 'goods', 'food']);
    run({ type: 'trainAction', id: t.id, action: 'start' });
    let mail = 0;
    const money = company.money;
    for (let i = 0; i < TICKS_PER_DAY * 40; i++) {
      state.step();
      mail = Math.max(mail, t.cargo.filter((p) => p.cargo === 'mail').reduce((s, p) => s + p.n, 0));
    }
    expect(mail).toBeGreaterThan(0);
    expect(company.money).toBeGreaterThan(money);
  });

  test('changing only a refit is a consist change', () => {
    const { state, exec, run, depot } = world();
    run({ type: 'buyTrain', depot, units: ['badger', 'open_wagon'] });
    const t = [...state.trains.values()][0]!;
    expect(exec({ type: 'editConsist', id: t.id, units: ['badger', 'open_wagon'] }).ok).toBe(false);
    run({ type: 'editConsist', id: t.id, units: ['badger', { type: 'open_wagon', cargo: 'wood' }] });
    expect(t.units[1]).toEqual({ type: 'open_wagon', cargo: 'wood' });
  });

  test('waiting cargo survives saves; old saves keep their waiting passengers', () => {
    const { state, run, a, b, depot } = world();
    run({ type: 'buyTrain', depot, units: ['badger', 'coach_steel', 'mail_van'] });
    const t = [...state.trains.values()][0]!;
    run({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: a.id }, { kind: 'station', station: b.id }] });
    for (let i = 0; i < TICKS_PER_DAY * 10; i++) state.step();
    const limits = { maxPlayers: 15, maxMapSize: 256 };
    const restored = restoreSnapshot(encodeSnapshot(state), limits);
    expect(restored.stations.get(a.id)!.waiting).toEqual(a.waiting);
    expect(restored.stations.get(a.id)!.waitingTotal).toBe(a.waitingTotal);
    // Before cargo types, stations saved passengers waiting by destination.
    const snap = takeSnapshot(state);
    const old = {
      ...snap,
      cargoPackets: undefined,
      stations: snap.stations!.map((s) => ({ ...s, waiting: s.id === a.id ? { [b.id]: 17 } : {} })),
    };
    const fromOld = restoreSnapshot(encode(old), limits);
    expect(fromOld.stations.get(a.id)!.waiting).toEqual({ passengers: { [b.id]: 17 } });
  });
});
