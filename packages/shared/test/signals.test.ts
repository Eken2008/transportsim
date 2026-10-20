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
  segTile,
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

  /**
   * The bottom station gets a second platform below it, joined by switches at both ends. A
   * westbound signal stands before the east switch; the platforms have westbound exit signals
   * and, at their east ends, one-way eastbound signals that split them off the switch.
   */
  function twoPlatforms() {
    const l = loop();
    const { run, buy } = l;
    run({ type: 'buildTrack', pieces: [36, 25, Piece.SE, 36, 26, Piece.NW, 28, 26, Piece.NE, 28, 25, Piece.SW] });
    const p2: number[] = [];
    for (let x = 29; x <= 35; x++) p2.push(x, 26, Piece.X);
    run({ type: 'buildTrack', pieces: p2 });
    run({ type: 'buildStation', x: 30, y: 26, axis: 0, platforms: 1, length: 5 });
    run({ type: 'setSignal', x: 22, y: 10, piece: Piece.X, dirs: 1 }); // eastbound on top
    run({ type: 'setSignal', x: 40, y: 18, piece: Piece.Y, dirs: 1 }); // southbound on the right
    run({ type: 'setSignal', x: 37, y: 25, piece: Piece.X, dirs: 2 }); // westbound, before the switch
    for (const y of [25, 26]) {
      run({ type: 'setSignal', x: 29, y, piece: Piece.X, dirs: 2 });
      run({ type: 'setSignal', x: 35, y, piece: Piece.X, dirs: 1 });
    }
    const bottom = 1;
    /** A started train bound for the bottom station, staying there `wait` days. */
    const send = (wait?: number) => {
      const t = buy();
      run({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: bottom, wait }] });
      run({ type: 'trainAction', id: t.id, action: 'start' });
      return t;
    };
    const row = (s: number) => Math.floor(segTile(s) / l.map.width);
    return { ...l, send, row };
  }

  test('a train passing a signal takes a free platform if the one it planned for is now taken', () => {
    const { state, send, row } = twoPlatforms();
    const a = send(30);
    const b = send();
    // B leaves the depot (and plans its route) while A is still on its way: both head for the
    // straight platform, which A then occupies for a month.
    for (let i = 0; i < TICKS_PER_DAY * 15 && b.status !== 'loading'; i++) state.step();
    expect(state.trains.size).toBe(2);
    expect(a.status).toBe('loading');
    expect(row(a.path[0]!)).toBe(25);
    expect(b.status).toBe('loading');
    expect(row(b.path[0]!)).toBe(26);
  });

  test('a signal protects the way up to the next signal facing the train, not just the next block', () => {
    const { state, map, send } = twoPlatforms();
    const sig = map.tileIndex(37, 25);
    const parked = [send(30), send(30)];
    const b = send();
    let greenWithOneFree = false;
    for (let i = 0; i < TICKS_PER_DAY * 20; i++) {
      state.step();
      const loading = parked.filter((t) => t.status === 'loading').length;
      if (loading === 1 && parked.every((t) => t.path.every((s) => segTile(s) !== sig))) greenWithOneFree ||= !state.rail.signalRed(sig, Piece.X * 2 + 1);
    }
    // Both platforms taken: the switch beyond the signal is free, but the signal stays red and
    // the third train waits in front of it rather than running onto an occupied platform.
    expect(state.trains.size).toBe(3);
    for (const t of parked) expect(t.status).toBe('loading');
    expect(greenWithOneFree).toBe(true);
    expect(state.rail.signalRed(sig, Piece.X * 2 + 1)).toBe(true);
    expect(b.speed).toBe(0);
    expect(segTile(b.path[0]!)).toBe(sig);
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

describe('signal runs', () => {
  test('a drag places signals the set spacing apart up to the next junction, round curves', () => {
    const { state, map, run } = loop();
    const sig = (x: number, y: number) => map.layers.signals[map.tileIndex(x, y)]!;
    // East from just past the depot branch: along the top, down the right, to the bottom station.
    run({ type: 'setSignalRun', x: 26, y: 10, piece: Piece.X, reverse: 0, interval: 4 });
    for (const x of [26, 30, 34, 38]) expect(sig(x, 10)).toBe(1);
    for (const x of [27, 28, 29, 31, 35, 37]) expect(sig(x, 10)).toBe(0);
    // Three 45° pieces (√½ each) and two straights past (38,10) make four tiles of track.
    expect(sig(40, 12)).toBe(0);
    expect(sig(40, 13)).toBe(1 << (Piece.Y * 2));
    expect(sig(40, 17)).toBe(1 << (Piece.Y * 2));
    expect(state.signalTiles.size).toBe(8);
    for (let x = 35; x <= 38; x++) expect(sig(x, 25)).toBe(0); // the run ends before the station
    expect(executeCommand(state, { playerId: 1, companyId: 0 }, { type: 'setSignalRun', x: 26, y: 10, piece: Piece.X, reverse: 0, interval: 4 }))
      .toEqual({ ok: false, error: 'Already there' });

    // West, facing west, stops at the junction with the depot branch... and at the station.
    run({ type: 'setSignalRun', x: 24, y: 10, piece: Piece.X, reverse: 1, interval: 3, kind: 'path' });
    for (const x of [24, 21]) expect(sig(x, 10) & 0xfff).toBe(2);
    expect(sig(19, 10)).toBe(0);
    expect(executeCommand(state, { playerId: 1, companyId: 0 }, { type: 'setSignalRun', x: 25, y: 10, piece: Piece.X, reverse: 1, interval: 3 }).ok).toBe(false);

    // Ctrl-drag clears every signal on the stretch, whichever way it faces.
    run({ type: 'setSignal', x: 27, y: 10, piece: Piece.X, dirs: 2 });
    run({ type: 'setSignalRun', x: 26, y: 10, piece: Piece.X, reverse: 0, interval: 4, remove: true });
    expect([...state.signalTiles].map((i) => [i % map.width, Math.floor(i / map.width)])).toEqual([
      [24, 10],
      [21, 10],
    ]);
  });
});
