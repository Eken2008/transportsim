import { describe, expect, test } from 'bun:test';
import {
  BRIDGE_TYPES,
  DEFAULT_SETTINGS,
  DWELL_TICKS,
  Edge,
  GameMap,
  GameState,
  Piece,
  TICKS_PER_DAY,
  curveLimits,
  executeCommand,
  isSpanTd,
  longestPlatform,
  seg,
  segTd,
  segTile,
  trackdir,
  type Command,
} from '../src/index.ts';

function world(startYear = 1925) {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  const p = state.addPlayer('A', true);
  const c = state.foundCompany(p)!;
  c.money = 1e9;
  const ctx = { playerId: p.id, companyId: c.id };
  const must = (cmd: Command) => {
    const r = executeCommand(state, ctx, cmd);
    if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
  };
  return { state, map, must };
}

const E = (x: number, y: number, w: number, p: number = Piece.X) => seg(y * w + x, trackdir(p, 0));

describe('curves', () => {
  test('straights and diagonal staircases have no limit; tighter turns are slower', () => {
    const w = 128;
    const straight = [0, 1, 2, 3, 4].map((x) => E(x, 5, w));
    expect(curveLimits(straight).every((l) => l === Infinity)).toBe(true);
    // East, then two 45° turns one corner piece apart (a tight curve to south-east and south).
    const tight = [E(0, 5, w), E(1, 5, w), seg(5 * w + 2, trackdir(Piece.SW, 1)), seg(6 * w + 2, trackdir(Piece.Y, 0))];
    const lim = curveLimits(tight);
    expect(Math.min(...lim)).toBeLessThan(60);
    expect(Math.min(...lim)).toBeGreaterThan(30);
  });

  test('a train slows for the 45° corners of a loop', () => {
    const { state, map, must } = world();
    const pieces: number[] = [];
    for (let x = 12; x <= 38; x++) pieces.push(x, 10, Piece.X, x, 25, Piece.X);
    for (let y = 12; y <= 23; y++) pieces.push(10, y, Piece.Y, 40, y, Piece.Y);
    pieces.push(39, 10, Piece.SW, 39, 11, Piece.NE, 40, 11, Piece.SW);
    pieces.push(40, 24, Piece.NW, 39, 24, Piece.SE, 39, 25, Piece.NW);
    pieces.push(11, 25, Piece.NE, 11, 24, Piece.SW, 10, 24, Piece.NE);
    pieces.push(10, 11, Piece.SE, 11, 11, Piece.NW, 11, 10, Piece.SE);
    pieces.push(24, 9, Piece.NE, 25, 9, Piece.SW, 25, 10, Piece.NE);
    must({ type: 'buildTrack', pieces });
    must({ type: 'buildDepot', x: 24, y: 8, exit: Edge.S });
    must({ type: 'buildStation', x: 14, y: 10, axis: 0, platforms: 1, length: 3 });
    must({ type: 'buildStation', x: 30, y: 25, axis: 0, platforms: 1, length: 3 });
    must({ type: 'buyTrain', depot: map.tileIndex(24, 8), units: ['atlas', 'coach_steel'] });
    const t = [...state.trains.values()][0]!;
    must({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: 0 }, { kind: 'station', station: 1 }] });
    must({ type: 'trainAction', id: t.id, action: 'start' });
    let corner = 0;
    let straight = 0;
    for (let i = 0; i < TICKS_PER_DAY * 60; i++) {
      state.step();
      if (t.path.length === 0) continue;
      const p = (segTd(t.path[0]!) >> 1) as number;
      const onCorner = t.path.some((s) => ((segTd(s) >> 1) as number) >= 2);
      if (onCorner) corner = Math.max(corner, t.speed);
      else if (p <= 1) straight = Math.max(straight, t.speed);
    }
    expect(straight).toBeGreaterThan(110);
    expect(corner).toBeGreaterThan(40);
    expect(corner).toBeLessThan(100);
  });
});

describe('bridges and platforms', () => {
  test('trains keep to the speed of a timber bridge', () => {
    const { state, map, must } = world();
    // A shallow valley between x = 10 and x = 16 (corners), bridged from x = 9 to x = 16.
    for (let y = 0; y <= map.height; y++) for (let x = 10; x <= 16; x++) map.heights[y * (map.width + 1) + x] = 1;
    must({ type: 'buildDepot', x: 2, y: 10, exit: Edge.E });
    const pieces: number[] = [];
    for (let x = 3; x <= 8; x++) pieces.push(x, 10, Piece.X);
    for (let x = 17; x <= 60; x++) pieces.push(x, 10, Piece.X);
    must({ type: 'buildTrack', pieces });
    must({ type: 'buildBridge', x0: 9, y0: 10, x1: 16, y1: 10, bridgeType: 0 });
    must({ type: 'buildStation', x: 55, y: 10, axis: 0, platforms: 1, length: 4 });
    must({ type: 'buyTrain', depot: map.tileIndex(2, 10), units: ['atlas', 'coach_steel'] });
    const t = [...state.trains.values()][0]!;
    must({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: 0 }] });
    must({ type: 'trainAction', id: t.id, action: 'start' });
    let onBridge = 0;
    let after = 0;
    for (let i = 0; i < TICKS_PER_DAY * 30 && t.status !== 'loading'; i++) {
      state.step();
      if (t.path.some((s) => isSpanTd(segTd(s)))) onBridge = Math.max(onBridge, t.speed);
      else if (segTile(t.path[0]!) % map.width > 25) after = Math.max(after, t.speed);
    }
    expect(onBridge).toBeGreaterThan(50);
    expect(onBridge).toBeLessThanOrEqual(BRIDGE_TYPES[0]!.maxSpeed + 0.5);
    expect(after).toBeGreaterThan(100);
  });

  test('a train longer than its platform loads more slowly', () => {
    const { state, map, must } = world();
    must({ type: 'buildDepot', x: 2, y: 10, exit: Edge.E });
    const pieces: number[] = [];
    for (let x = 3; x <= 40; x++) pieces.push(x, 10, Piece.X);
    must({ type: 'buildTrack', pieces });
    must({ type: 'buildStation', x: 30, y: 10, axis: 0, platforms: 1, length: 1 });
    const st = state.stations.get(0)!;
    expect(longestPlatform(map, st)).toBe(1);
    must({ type: 'buildStation', x: 31, y: 10, axis: 0, platforms: 1, length: 3 });
    expect(longestPlatform(map, st)).toBe(4);
    must({ type: 'clearArea', x0: 31, y0: 10, x1: 33, y1: 10 });
    must({ type: 'buildTrack', pieces: [31, 10, Piece.X, 32, 10, Piece.X, 33, 10, Piece.X] });
    must({ type: 'buyTrain', depot: map.tileIndex(2, 10), units: ['atlas', 'coach_steel', 'coach_steel', 'coach_steel'] });
    const t = [...state.trains.values()][0]!;
    must({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: 0 }] });
    must({ type: 'trainAction', id: t.id, action: 'start' });
    for (let i = 0; i < TICKS_PER_DAY * 30 && t.status !== 'loading'; i++) state.step();
    expect(t.status).toBe('loading');
    expect(t.loadTicks).toBeGreaterThanOrEqual(DWELL_TICKS * 2);
  });
});
