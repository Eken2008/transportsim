import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  Edge,
  GameMap,
  GameState,
  Piece,
  TICKS_PER_DAY,
  encode,
  executeCommand,
  restoreSnapshot,
  takeSnapshot,
  type Command,
} from '../src/index.ts';

function world(startYear = 2000) {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  const p = state.addPlayer('A', true);
  const c = state.foundCompany(p)!;
  c.money = 1e9;
  const ctx = { playerId: p.id, companyId: c.id };
  const run = (cmd: Command) => executeCommand(state, ctx, cmd);
  const must = (cmd: Command) => {
    const r = run(cmd);
    if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
    return r;
  };
  const line = (y: number, x0: number, x1: number, railType: number) => {
    const pieces: number[] = [];
    for (let x = x0; x <= x1; x++) pieces.push(x, y, Piece.X);
    return must({ type: 'buildTrack', pieces, railType });
  };
  return { state, map, run, must, line };
}

describe('track types', () => {
  test('new track takes the chosen type and costs more; existing track keeps its type', () => {
    const { map, line, must } = world();
    const std = line(10, 3, 12, 0);
    const el = line(12, 3, 12, 1);
    expect(el.ok && std.ok && el.cost > std.cost * 1.5).toBe(true);
    expect(map.layers.railType[map.tileIndex(5, 12)]).toBe(1);
    // A junction piece on electrified track stays electrified
    must({ type: 'buildTrack', pieces: [7, 12, Piece.NE], railType: 0 });
    expect(map.layers.railType[map.tileIndex(7, 12)]).toBe(1);
  });

  test('high-speed track is not available before its time in era games', () => {
    const { run } = world(1900);
    expect(run({ type: 'buildTrack', pieces: [5, 5, Piece.X], railType: 2 })).toMatchObject({ ok: false, error: expect.stringContaining('arrives in') });
    expect(run({ type: 'buildTrack', pieces: [5, 5, Piece.X], railType: 9 }).ok).toBe(false);
  });

  test('electric engines need an electrified depot and electrified track', () => {
    const { state, map, run, must, line } = world();
    must({ type: 'buildDepot', x: 2, y: 10, exit: Edge.E });
    line(10, 3, 30, 1);
    must({ type: 'buildStation', x: 25, y: 10, axis: 0, platforms: 1, length: 4 });
    expect(run({ type: 'buyTrain', depot: map.tileIndex(2, 10), units: ['volta', 'coach_modern'] })).toMatchObject({
      ok: false,
      error: 'Electric engines need an electrified depot',
    });
    must({ type: 'convertRail', x0: 2, y0: 10, x1: 2, y1: 10, railType: 1 });
    must({ type: 'buyTrain', depot: map.tileIndex(2, 10), units: ['volta', 'coach_modern'] });
    const t = [...state.trains.values()][0]!;
    must({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: 0 }] });
    // Take the wires down from part of the line: the train can't get through.
    must({ type: 'convertRail', x0: 15, y0: 10, x1: 16, y1: 10, railType: 0 });
    must({ type: 'trainAction', id: t.id, action: 'start' });
    for (let i = 0; i < TICKS_PER_DAY * 20; i++) state.step();
    expect(t.status).not.toBe('loading');
    for (const s of t.path) expect(Math.floor(s / 16) % map.width).toBeLessThan(15);
    // Wires back up: it gets there.
    must({ type: 'convertRail', x0: 15, y0: 10, x1: 16, y1: 10, railType: 1 });
    for (let i = 0; i < TICKS_PER_DAY * 20 && t.status !== 'loading'; i++) state.step();
    expect(t.status).toBe('loading');
    // Can't take the wires away from under an electric train (other tiles in the area convert)
    const under = t.path.map((s) => Math.floor(s / 16) % map.width);
    const [ux0, ux1] = [Math.min(...under), Math.max(...under)];
    expect(run({ type: 'convertRail', x0: ux0, y0: 10, x1: ux1, y1: 10, railType: 0 })).toMatchObject({ ok: false, error: expect.stringContaining('electric train') });
    run({ type: 'convertRail', x0: 20, y0: 10, x1: 28, y1: 10, railType: 0 });
    for (const x of under) expect(map.layers.railType[map.tileIndex(x, 10)]).toBe(1);
    expect(map.layers.railType[map.tileIndex(20, 10)]).toBe(0);
  });

  test('trains keep to the speed limit of the track', () => {
    const { state, map, must, line } = world();
    must({ type: 'buildDepot', x: 2, y: 10, exit: Edge.E });
    must({ type: 'convertRail', x0: 2, y0: 10, x1: 2, y1: 10, railType: 2 });
    line(10, 3, 125, 1);
    must({ type: 'buildStation', x: 120, y: 10, axis: 0, platforms: 1, length: 4 });
    must({ type: 'buyTrain', depot: map.tileIndex(2, 10), units: ['swift', 'coach_hs', 'coach_hs'] });
    const t = [...state.trains.values()][0]!;
    must({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: 0 }] });
    const top = () => {
      let max = 0;
      for (let i = 0; i < TICKS_PER_DAY * 12 && t.status !== 'loading'; i++) {
        state.step();
        max = Math.max(max, t.speed);
      }
      return max;
    };
    must({ type: 'trainAction', id: t.id, action: 'start' });
    const onElectrified = top();
    expect(onElectrified).toBeGreaterThan(180);
    expect(onElectrified).toBeLessThanOrEqual(200.5);
    // Upgrade to high-speed track, send it back to the depot end and run again
    must({ type: 'convertRail', x0: 3, y0: 10, x1: 34, y1: 10, railType: 2 });
    must({ type: 'convertRail', x0: 35, y0: 10, x1: 66, y1: 10, railType: 2 });
    must({ type: 'convertRail', x0: 67, y0: 10, x1: 98, y1: 10, railType: 2 });
    must({ type: 'convertRail', x0: 99, y0: 10, x1: 125, y1: 10, railType: 2 });
    must({ type: 'buildStation', x: 8, y: 10, axis: 0, platforms: 1, length: 4 });
    must({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: 1 }] });
    for (let i = 0; i < TICKS_PER_DAY * 3; i++) state.step();
    expect(top()).toBeGreaterThan(210);
  });

  test('saves from before track types come back electrified', () => {
    const { state, map, line } = world();
    line(10, 3, 12, 0);
    const snap = takeSnapshot(state);
    const { railType: _gone, ...layers } = snap.layers;
    const restored = restoreSnapshot(encode({ ...snap, layers }), { maxPlayers: 15, maxMapSize: 256 });
    expect(restored.map.layers.railType[map.tileIndex(5, 10)]).toBe(1);
    expect(restored.map.layers.railType[map.tileIndex(5, 11)]).toBe(0);
  });
});
