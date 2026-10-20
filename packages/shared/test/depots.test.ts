import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS, Edge, GameMap, GameState, Piece, TICKS_PER_DAY, executeCommand, pieceKey, segTile, type Command, type Train } from '../src/index.ts';

/**
 * A line on row 10 from a depot at x=2 (facing east) to a dead end at x=40, stations west
 * (x=5..8) and east (x=34..37), and a second depot north of the line joining it eastbound at x=25.
 */
function layout() {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear: 1900 }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  const p = state.addPlayer('A', true);
  const c = state.foundCompany(p)!;
  c.money = 1e8;
  const ctx = { playerId: p.id, companyId: c.id };
  const run = (cmd: Command) => {
    const r = executeCommand(state, ctx, cmd);
    if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
  };
  run({ type: 'buildDepot', x: 2, y: 10, exit: Edge.E });
  const pieces: number[] = [];
  for (let x = 3; x <= 40; x++) pieces.push(x, 10, Piece.X);
  pieces.push(24, 9, Piece.NE, 25, 9, Piece.SW, 25, 10, Piece.NE);
  run({ type: 'buildTrack', pieces });
  run({ type: 'buildDepot', x: 24, y: 8, exit: Edge.S });
  run({ type: 'buildStation', x: 5, y: 10, axis: 0, platforms: 1, length: 4 });
  run({ type: 'buildStation', x: 34, y: 10, axis: 0, platforms: 1, length: 4 });
  const [west, east] = [0, 1];
  const buy = (depot: number, orders: { station: number; wait?: number }[]) => {
    run({ type: 'buyTrain', depot, units: ['kestrel', 'coach_wood'] });
    const t = [...state.trains.values()].at(-1)!;
    run({ type: 'setOrders', id: t.id, orders: orders.map((o) => ({ kind: 'station' as const, ...o })) });
    run({ type: 'trainAction', id: t.id, action: 'start' });
    return t;
  };
  return { state, map, run, buy, west, east, depot0: map.tileIndex(2, 10), depot1: map.tileIndex(24, 8) };
}

/** Fail if two trains are ever on the same piece of track. */
function expectApart(trains: Train[]) {
  const seen = new Map<number, number>();
  for (const t of trains) {
    for (const s of t.path) {
      expect(seen.get(pieceKey(s)) ?? t.id).toBe(t.id);
      seen.set(pieceKey(s), t.id);
    }
  }
}

describe('leaving depots', () => {
  test('a train whose depot faces away from its destination drives out, reverses and goes there', () => {
    const { state, map, buy, west, depot1 } = layout();
    const t = buy(depot1, [{ station: west }]);
    let east = 0;
    for (let i = 0; i < TICKS_PER_DAY * 30 && t.status !== 'loading'; i++) {
      state.step();
      if (t.path.length) east = Math.max(east, segTile(t.path[0]!) % map.width);
    }
    expect(t.status).toBe('loading');
    expect(t.lastStation).toBe(west);
    expect(t.lost).toBeFalsy();
    // It turned round soon after clearing the junction, not at the end of the line.
    expect(east).toBeLessThan(34);
  });

  test('into a path-signalled block, the door opens once the way ahead is reserved', () => {
    const { state, run, buy, west, east, depot0, depot1 } = layout();
    run({ type: 'setSignal', x: 30, y: 10, piece: Piece.X, dirs: 1, kind: 'path' });
    // A waits at the west platform, in the block the depot opens into, for two months.
    const a = buy(depot0, [{ station: west, wait: 60 }]);
    for (let i = 0; i < TICKS_PER_DAY * 10 && a.status !== 'loading'; i++) state.step();
    expect(a.status).toBe('loading');
    const b = buy(depot1, [{ station: east }]);
    for (let i = 0; i < TICKS_PER_DAY * 20 && b.status !== 'loading'; i++) {
      state.step();
      expectApart([a, b]);
    }
    expect(a.status).toBe('loading');
    expect(b.status).toBe('loading');
    expect(b.lastStation).toBe(east);
  });

  test('a door into a path-signalled block stays shut while a train passes it', () => {
    const { state, map, run, buy, west, east, depot0, depot1 } = layout();
    run({ type: 'setSignal', x: 30, y: 10, piece: Piece.X, dirs: 1, kind: 'path' });
    const a = buy(depot0, [{ station: east, wait: 30 }]);
    // B is started just as A comes up to the junction: it must wait for A to pass, then turn
    // round behind it and head west.
    for (let i = 0; i < TICKS_PER_DAY * 10 && !(a.path.length && segTile(a.path[0]!) % map.width >= 22); i++) state.step();
    const b = buy(depot1, [{ station: west }]);
    let waited = false;
    for (let i = 0; i < TICKS_PER_DAY * 60 && b.status !== 'loading'; i++) {
      state.step();
      waited ||= b.path.length === 0 && a.status === 'running';
      expectApart([a, b]);
    }
    expect(waited).toBe(true);
    expect(b.status).toBe('loading');
    expect(b.lastStation).toBe(west);
  });
});
