import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS, Edge, GameMap, GameState, Piece, TICKS_PER_DAY, executeCommand, type Command } from '../src/index.ts';

/**
 * A line on row 10 from x=3 to x=60, stations west (x=5..8) and east (x=50..53). A depot on
 * the line north of it at x=26, and another closer to the west station at the end of a long
 * branch heading south from x=10.
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
  const pieces: number[] = [];
  for (let x = 3; x <= 60; x++) pieces.push(x, 10, Piece.X);
  pieces.push(25, 10, Piece.NW, 25, 9, Piece.SE, 26, 9, Piece.NW);
  pieces.push(10, 10, Piece.SW, 10, 11, Piece.NE, 11, 11, Piece.SW);
  for (let y = 12; y <= 22; y++) pieces.push(11, y, Piece.Y);
  run({ type: 'buildTrack', pieces });
  run({ type: 'buildDepot', x: 26, y: 8, exit: Edge.S });
  run({ type: 'buildDepot', x: 11, y: 23, exit: Edge.N });
  run({ type: 'buildStation', x: 5, y: 10, axis: 0, platforms: 1, length: 4 });
  run({ type: 'buildStation', x: 50, y: 10, axis: 0, platforms: 1, length: 4 });
  const onLine = map.tileIndex(26, 8);
  const branch = map.tileIndex(11, 23);
  run({ type: 'buyTrain', depot: onLine, units: ['kestrel', 'coach_wood'] });
  const t = [...state.trains.values()].at(-1)!;
  run({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: 0 }, { kind: 'station', station: 1 }] });
  run({ type: 'trainAction', id: t.id, action: 'start' });
  // Run to the west station.
  for (let i = 0; i < TICKS_PER_DAY * 30 && t.status !== 'loading'; i++) state.step();
  expect(t.status).toBe('loading');
  expect(t.lastStation).toBe(0);
  return { state, run, t, onLine, branch };
}

/** Run until the train enters a depot; returns which. */
function nextDepot(state: GameState, t: { status: string; depot: number; lastService?: number }): number {
  const before = t.lastService;
  for (let i = 0; i < TICKS_PER_DAY * 60; i++) {
    state.step();
    if (t.lastService !== before) return t.depot;
  }
  return -1;
}

describe('service depots', () => {
  test('a train due for service is serviced at a depot on its line, not a closer one off it', () => {
    const { state, t, onLine } = layout();
    t.lastService = state.date - 1000;
    expect(nextDepot(state, t)).toBe(onLine);
    // And it carries on to the east station afterwards.
    for (let i = 0; i < TICKS_PER_DAY * 30 && t.lastStation !== 1; i++) state.step();
    expect(t.lastStation).toBe(1);
  });

  test('a train sent to a depot goes to the nearest', () => {
    const { state, run, t, branch } = layout();
    run({ type: 'trainAction', id: t.id, action: 'toDepot' });
    expect(nextDepot(state, t)).toBe(branch);
  });
});
