import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  Edge,
  GameMap,
  GameState,
  Piece,
  TICKS_PER_DAY,
  encodeSnapshot,
  executeCommand,
  pieceKey,
  restoreSnapshot,
  segTile,
  type Command,
  type Train,
} from '../src/index.ts';

/** Flat dry map with one company and a straight line: depot at x=2, track to x=40 on row 10. */
function line(opts: { stationsAt?: [number, number][]; length?: number } = {}) {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear: 1900 }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  const p = state.addPlayer('A', true);
  const c = state.foundCompany(p)!;
  c.money = 10_000_000;
  const ctx = { playerId: p.id, companyId: c.id };
  const run = (cmd: Command) => {
    const r = executeCommand(state, ctx, cmd);
    if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
    return r;
  };
  const end = opts.length ?? 40;
  run({ type: 'buildDepot', x: 2, y: 10, exit: Edge.E });
  const pieces: number[] = [];
  for (let x = 3; x <= end; x++) pieces.push(x, 10, Piece.X);
  run({ type: 'buildTrack', pieces });
  const stations: number[] = [];
  for (const [x, len] of opts.stationsAt ?? [[6, 4], [end - 4, 4]]) {
    run({ type: 'buildStation', x, y: 10, axis: 0, platforms: 1, length: len });
    stations.push(state.nextStationId - 1);
  }
  const depot = map.tileIndex(2, 10);
  const buy = (units = ['kestrel', 'coach_wood', 'coach_wood']) => {
    run({ type: 'buyTrain', depot, units });
    return [...state.trains.values()].at(-1)!;
  };
  const ticks = (n: number, each?: () => void) => {
    for (let i = 0; i < n; i++) {
      state.step();
      each?.();
    }
  };
  return { state, map, ctx, run, stations, buy, ticks, depot };
}

const days = (n: number) => Math.round(n * TICKS_PER_DAY);

describe('trains', () => {
  test('buying requires an engine, availability and money', () => {
    const { state, ctx, depot } = line();
    expect(executeCommand(state, ctx, { type: 'buyTrain', depot, units: ['coach_wood'] }).ok).toBe(false);
    expect(executeCommand(state, ctx, { type: 'buyTrain', depot, units: ['swift'] }).ok).toBe(false); // 1990s
    const r = executeCommand(state, ctx, { type: 'buyTrain', depot, units: ['kestrel', 'coach_wood'] });
    expect(r.ok).toBe(true);
    const t = [...state.trains.values()][0]!;
    expect(t.status).toBe('depot');
    // Can't start without orders
    expect(executeCommand(state, ctx, { type: 'trainAction', id: t.id, action: 'start' }).ok).toBe(false);
  });

  test('a train shuttles between two stations, reversing at the termini', () => {
    const { state, run, stations, buy, ticks } = line();
    const t = buy();
    run({ type: 'setOrders', id: t.id, orders: stations.map((s) => ({ kind: 'station' as const, station: s })) });
    run({ type: 'trainAction', id: t.id, action: 'start' });
    expect(t.status).toBe('running');

    const visits: number[] = [];
    let maxSpeed = 0;
    ticks(days(60), () => {
      maxSpeed = Math.max(maxSpeed, t.speed);
      if (t.status === 'loading' && visits.at(-1) !== t.lastStation) visits.push(t.lastStation);
    });
    // A → B → A → B ...
    expect(visits.length).toBeGreaterThanOrEqual(4);
    for (let i = 1; i < visits.length; i++) expect(visits[i]).not.toBe(visits[i - 1]);
    expect(maxSpeed).toBeGreaterThan(40);
    expect(maxSpeed).toBeLessThanOrEqual(90.01); // wooden coaches limit the train to 90 km/h
  });

  test('stops at the far end of the platform', () => {
    const { state, map, run, stations, buy, ticks } = line({ stationsAt: [[20, 5]] });
    const t = buy();
    run({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: stations[0]! }] });
    run({ type: 'trainAction', id: t.id, action: 'start' });
    for (let i = 0; i < days(25) && t.status !== 'loading'; i++) state.step();
    expect(t.status).toBe('loading');
    // Station spans x = 20..24; heading east the head stops at the end of x = 24.
    const head = segTile(t.path[0]!);
    expect(head % map.width).toBe(24);
    expect(t.speed).toBe(0);
  });

  test('a train never overlaps another train', () => {
    const { state, run, stations, buy, ticks } = line();
    const a = buy();
    const b = buy();
    for (const t of [a, b]) run({ type: 'setOrders', id: t.id, orders: stations.map((s) => ({ kind: 'station' as const, station: s })) });
    run({ type: 'trainAction', id: a.id, action: 'start' });
    ticks(days(3));
    run({ type: 'trainAction', id: b.id, action: 'start' });
    ticks(days(40), () => {
      const pa = new Set(a.path.map(pieceKey));
      for (const s of b.path) expect(pa.has(pieceKey(s))).toBe(false);
    });
  });

  test('send to depot, sell, and occupancy blocks removing track', () => {
    const { state, map, run, stations, buy, ticks, ctx } = line();
    const t = buy();
    run({ type: 'setOrders', id: t.id, orders: stations.map((s) => ({ kind: 'station' as const, station: s })) });
    run({ type: 'trainAction', id: t.id, action: 'start' });
    ticks(days(4));
    expect(t.path.length).toBeGreaterThan(0);
    const under = segTile(t.path[0]!);
    const ux = under % map.width;
    if (map.type(ux, 10) === 2) {
      expect(executeCommand(state, ctx, { type: 'removeTrack', pieces: [ux, 10, Piece.X] }).ok).toBe(false);
    }
    expect(executeCommand(state, ctx, { type: 'trainAction', id: t.id, action: 'sell' }).ok).toBe(false);
    run({ type: 'trainAction', id: t.id, action: 'toDepot' });
    for (let i = 0; i < days(40) && t.status !== 'depot'; i++) state.step();
    expect(t.status).toBe('depot');
    expect(state.isPieceOccupied(map.tileIndex(3, 10), Piece.X)).toBe(false);
    const money = state.companies.get(ctx.companyId)!.money;
    run({ type: 'trainAction', id: t.id, action: 'sell' });
    expect(state.trains.size).toBe(0);
    expect(state.companies.get(ctx.companyId)!.money).toBeGreaterThan(money);
  });

  test('climbing slows a heavy train', () => {
    const flat = line({ stationsAt: [[30, 4]] });
    const hill = line({ stationsAt: [[30, 4]] });
    // A 16-tile ramp climbing one level per tile from x = 8, then level again.
    const m = hill.map;
    for (let y = 0; y <= m.height; y++) {
      for (let x = 0; x <= m.width; x++) m.heights[m.cornerIndex(x, y)] = 2 + Math.max(0, Math.min(16, x - 8));
    }
    const time = (env: ReturnType<typeof line>) => {
      const t = env.buy(['puffin', 'coach_wood', 'coach_wood', 'coach_wood', 'coach_wood']);
      env.run({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: env.stations[0]! }] });
      env.run({ type: 'trainAction', id: t.id, action: 'start' });
      let n = 0;
      while (t.status !== 'loading' && n < days(80)) {
        env.state.step();
        n++;
      }
      return n;
    };
    expect(time(hill)).toBeGreaterThan(time(flat) * 1.15);
  });

  test('trains survive save and load', () => {
    const { state, run, stations, buy, ticks } = line();
    const t: Train = buy();
    run({ type: 'setOrders', id: t.id, orders: stations.map((s) => ({ kind: 'station' as const, station: s })) });
    run({ type: 'trainAction', id: t.id, action: 'start' });
    ticks(days(5));
    const restored = restoreSnapshot(encodeSnapshot(state), { maxPlayers: 15, maxMapSize: 2048 });
    const r = restored.trains.get(t.id)!;
    expect(r.path).toEqual(t.path);
    expect(r.orders).toEqual(t.orders);
    expect(restored.isPieceOccupied(segTile(r.path[0]!), r.path[0]! % 16 >> 1)).toBe(true);
    for (let i = 0; i < days(20); i++) restored.step();
    expect(r.lastStation).toBeGreaterThanOrEqual(0);
  });
});
