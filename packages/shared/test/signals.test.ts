import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  Edge,
  GameMap,
  GameState,
  Piece,
  TICKS_PER_DAY,
  executeCommand,
  pieceKey,
  type Command,
} from '../src/index.ts';

/**
 * A clockwise rectangular loop (45° corners of three corner pieces) with a station on the
 * top and bottom rows and a depot feeding the top row.
 */
function loop() {
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
  for (let x = 12; x <= 38; x++) pieces.push(x, 10, Piece.X, x, 25, Piece.X);
  for (let y = 12; y <= 23; y++) pieces.push(10, y, Piece.Y, 40, y, Piece.Y);
  // 45° corners: three corner pieces each (a single corner piece would be a 90° bend).
  pieces.push(39, 10, Piece.SW, 39, 11, Piece.NE, 40, 11, Piece.SW); // top right
  pieces.push(40, 24, Piece.NW, 39, 24, Piece.SE, 39, 25, Piece.NW); // bottom right
  pieces.push(11, 25, Piece.NE, 11, 24, Piece.SW, 10, 24, Piece.NE); // bottom left
  pieces.push(10, 11, Piece.SE, 11, 11, Piece.NW, 11, 10, Piece.SE); // top left
  // Branch from the depot joining the top row heading east.
  pieces.push(24, 9, Piece.NE, 25, 9, Piece.SW, 25, 10, Piece.NE);
  run({ type: 'buildTrack', pieces });
  run({ type: 'buildDepot', x: 24, y: 8, exit: Edge.S });
  run({ type: 'buildStation', x: 14, y: 10, axis: 0, platforms: 1, length: 5 });
  run({ type: 'buildStation', x: 30, y: 25, axis: 0, platforms: 1, length: 5 });
  const [top, bottom] = [0, 1];
  const buy = () => {
    run({ type: 'buyTrain', depot: map.tileIndex(24, 8), units: ['kestrel', 'coach_wood', 'coach_wood'] });
    const t = [...state.trains.values()].at(-1)!;
    run({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: top }, { kind: 'station', station: bottom }] });
    return t;
  };
  return { state, map, run, buy };
}

describe('block signals', () => {
  test('signals split the loop into blocks and are cleared with the track', () => {
    const { state, map, run } = loop();
    const k = (x: number, y: number, p: number) => map.tileIndex(x, y) * 8 + p;
    expect(state.rail.blockOfPiece(k(20, 10, Piece.X))).toBe(state.rail.blockOfPiece(k(10, 18, Piece.Y)));
    run({ type: 'setSignal', x: 22, y: 10, piece: Piece.X, dirs: 1 });
    run({ type: 'setSignal', x: 40, y: 18, piece: Piece.Y, dirs: 1 });
    expect(state.rail.blockOfPiece(k(21, 10, Piece.X))).not.toBe(state.rail.blockOfPiece(k(23, 10, Piece.X)));
    expect(state.rail.blockOfPiece(k(23, 10, Piece.X))).toBe(state.rail.blockOfPiece(k(40, 15, Piece.Y)));
    // Junction tiles can't take signals; removing track removes its signals.
    expect(executeCommand(state, { playerId: 1, companyId: 0 }, { type: 'setSignal', x: 25, y: 10, piece: Piece.X, dirs: 1 }).ok).toBe(false);
    run({ type: 'removeTrack', pieces: [22, 10, Piece.X] });
    expect(map.layers.signals[map.tileIndex(22, 10)]).toBe(0);
    expect(state.signalTiles.has(map.tileIndex(22, 10))).toBe(false);
  });

  test('two trains on a signalled loop never share a block and keep moving', () => {
    const { state, run, buy } = loop();
    run({ type: 'setSignal', x: 22, y: 10, piece: Piece.X, dirs: 1 }); // eastbound on top
    run({ type: 'setSignal', x: 40, y: 18, piece: Piece.Y, dirs: 1 }); // southbound on the right
    run({ type: 'setSignal', x: 27, y: 25, piece: Piece.X, dirs: 2 }); // westbound on the bottom
    run({ type: 'setSignal', x: 10, y: 18, piece: Piece.Y, dirs: 2 }); // northbound on the left
    const a = buy();
    const b = buy();
    run({ type: 'trainAction', id: a.id, action: 'start' });
    for (let i = 0; i < TICKS_PER_DAY * 3; i++) state.step();
    run({ type: 'trainAction', id: b.id, action: 'start' });
    const visits = new Map<number, number>([[a.id, 0], [b.id, 0]]);
    const wasLoading = new Map<number, boolean>();
    for (let i = 0; i < TICKS_PER_DAY * 90; i++) {
      state.step();
      const blocksA = new Set(a.path.map((s) => state.rail.blockOfPiece(pieceKey(s))));
      for (const s of b.path) expect(blocksA.has(state.rail.blockOfPiece(pieceKey(s)))).toBe(false);
      for (const t of [a, b]) {
        if (t.status === 'loading' && !wasLoading.get(t.id)) visits.set(t.id, visits.get(t.id)! + 1);
        wasLoading.set(t.id, t.status === 'loading');
      }
    }
    expect(visits.get(a.id)).toBeGreaterThanOrEqual(4);
    expect(visits.get(b.id)).toBeGreaterThanOrEqual(4);
  });

  test('signal aspect reflects the block beyond it', () => {
    const { state, map, run, buy } = loop();
    run({ type: 'setSignal', x: 22, y: 10, piece: Piece.X, dirs: 1 });
    run({ type: 'setSignal', x: 10, y: 18, piece: Piece.Y, dirs: 2 });
    const tile = map.tileIndex(22, 10);
    expect(state.rail.signalRed(tile, Piece.X * 2)).toBe(false);
    const t = buy();
    run({ type: 'trainAction', id: t.id, action: 'start' });
    // The train leaves the depot east of the signal, i.e. in the block beyond it.
    for (let i = 0; i < TICKS_PER_DAY; i++) state.step();
    expect(state.rail.signalRed(tile, Piece.X * 2)).toBe(true);
  });
});
