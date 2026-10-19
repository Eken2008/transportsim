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
  signalKindOf,
  type Command,
  type SignalKind,
} from '../src/index.ts';

/** The clockwise loop from the block signal tests: stations top and bottom, depot feeding the top row eastbound. */
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
  pieces.push(39, 10, Piece.SW, 39, 11, Piece.NE, 40, 11, Piece.SW);
  pieces.push(40, 24, Piece.NW, 39, 24, Piece.SE, 39, 25, Piece.NW);
  pieces.push(11, 25, Piece.NE, 11, 24, Piece.SW, 10, 24, Piece.NE);
  pieces.push(10, 11, Piece.SE, 11, 11, Piece.NW, 11, 10, Piece.SE);
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
  /** Clockwise signals: eastbound top, southbound right, westbound bottom, northbound left. */
  const signals = (kind: SignalKind) => {
    run({ type: 'setSignal', x: 22, y: 10, piece: Piece.X, dirs: 1, kind });
    run({ type: 'setSignal', x: 40, y: 18, piece: Piece.Y, dirs: 1, kind });
    run({ type: 'setSignal', x: 27, y: 25, piece: Piece.X, dirs: 2, kind });
    run({ type: 'setSignal', x: 10, y: 18, piece: Piece.Y, dirs: 2, kind });
  };
  return { state, map, run, buy, signals, top, bottom };
}

describe('signal kinds', () => {
  test('the kind is stored per tile and can be changed in place', () => {
    const { map, run } = loop();
    run({ type: 'setSignal', x: 22, y: 10, piece: Piece.X, dirs: 1, kind: 'path', oneWay: true });
    const i = map.tileIndex(22, 10);
    expect(signalKindOf(map.layers.signals[i]!)).toBe('path');
    run({ type: 'setSignal', x: 22, y: 10, piece: Piece.X, dirs: 1, kind: 'entry' });
    expect(signalKindOf(map.layers.signals[i]!)).toBe('entry');
    expect(map.layers.signals[i]! & 0x1000).toBe(0);
  });

  test('an entry signal stays red while every exit signal out of its block is red', () => {
    const { state, map, run, buy, top } = loop();
    run({ type: 'setSignal', x: 22, y: 10, piece: Piece.X, dirs: 1, kind: 'entry' });
    run({ type: 'setSignal', x: 40, y: 18, piece: Piece.Y, dirs: 1, kind: 'exit' });
    const entry = map.tileIndex(22, 10);
    expect(state.rail.signalRed(entry, Piece.X * 2)).toBe(false);
    const t = buy();
    run({ type: 'trainAction', id: t.id, action: 'start' });
    // Round the loop to the top station: then the train is in the block beyond the exit signal.
    for (let i = 0; i < TICKS_PER_DAY * 60 && !(t.status === 'loading' && t.lastStation === top); i++) state.step();
    expect(t.status).toBe('loading');
    const beyondEntry = state.rail.blockOfPiece(map.tileIndex(30, 10) * 8 + Piece.X)!;
    expect(t.path.some((s) => state.rail.blockOfPiece(pieceKey(s)) === beyondEntry)).toBe(false);
    expect(state.rail.signalRed(map.tileIndex(40, 18), Piece.Y * 2)).toBe(true);
    expect(state.rail.signalRed(entry, Piece.X * 2)).toBe(true);
    // As a plain block signal it would be green.
    run({ type: 'setSignal', x: 22, y: 10, piece: Piece.X, dirs: 1, kind: 'block' });
    expect(state.rail.signalRed(entry, Piece.X * 2)).toBe(false);
  });

  test('path signals: three trains share the loop without ever sharing a piece', () => {
    const { state, run, buy, signals } = loop();
    signals('path');
    const trains = [buy(), buy(), buy()];
    const visits = new Map(trains.map((t) => [t.id, 0]));
    const wasLoading = new Map<number, boolean>();
    let pbsSeen = false;
    for (let i = 0; i < TICKS_PER_DAY * 150; i++) {
      if (i % (TICKS_PER_DAY * 4) === 0) {
        const t = trains[i / (TICKS_PER_DAY * 4)];
        if (t) run({ type: 'trainAction', id: t.id, action: 'start' });
      }
      state.step();
      const seen = new Map<number, number>();
      for (const t of trains) {
        for (const s of t.path) {
          const k = pieceKey(s);
          expect(seen.get(k) ?? t.id).toBe(t.id);
          seen.set(k, t.id);
        }
        pbsSeen ||= t.pbs === true;
        if (t.status === 'loading' && !wasLoading.get(t.id)) visits.set(t.id, visits.get(t.id)! + 1);
        wasLoading.set(t.id, t.status === 'loading');
      }
    }
    expect(pbsSeen).toBe(true);
    for (const t of trains) expect(visits.get(t.id)).toBeGreaterThanOrEqual(3);
  });

  test('a path signal shows green only while a train holds a reservation through it', () => {
    const { state, map, run, buy, signals } = loop();
    signals('path');
    const sig = map.tileIndex(40, 18);
    expect(state.rail.signalRed(sig, Piece.Y * 2)).toBe(true);
    const t = buy();
    run({ type: 'trainAction', id: t.id, action: 'start' });
    let green = false;
    for (let i = 0; i < TICKS_PER_DAY * 20; i++) {
      state.step();
      green ||= !state.rail.signalRed(sig, Piece.Y * 2);
    }
    expect(green).toBe(true);
    // Reservations are released behind the train: only pieces it covers or will reach stay reserved.
    const mine = [...state.rail.reservedPieces()];
    expect(mine.length).toBeLessThan(80);
  });
});
