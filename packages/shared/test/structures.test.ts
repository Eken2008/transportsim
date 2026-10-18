import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  Edge,
  GameMap,
  GameState,
  Piece,
  TICKS_PER_DAY,
  TileType,
  executeCommand,
  segTd,
  segTile,
  spanOver,
  type Command,
} from '../src/index.ts';

/** World whose corner height along x follows `profile(x)` (same for every row). */
function world(profile: (x: number) => number) {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear: 1950 }, new GameMap(128, 128));
  const map = state.map;
  for (let y = 0; y <= map.height; y++) for (let x = 0; x <= map.width; x++) map.heights[map.cornerIndex(x, y)] = profile(x);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  const p = state.addPlayer('A', true);
  const c = state.foundCompany(p)!;
  c.money = 1e8;
  const ctx = { playerId: p.id, companyId: c.id };
  const run = (cmd: Command) => {
    const r = executeCommand(state, ctx, cmd);
    if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
  };
  const tryRun = (cmd: Command) => executeCommand(state, ctx, cmd);
  const line = (x0: number, x1: number, y = 10) => {
    const pieces: number[] = [];
    for (let x = x0; x <= x1; x++) pieces.push(x, y, Piece.X);
    run({ type: 'buildTrack', pieces });
  };
  /** Run a train from a depot at x=2 to a station at x=30..33 and report what it drove over. */
  const drive = () => {
    run({ type: 'buildDepot', x: 2, y: 10, exit: Edge.E });
    run({ type: 'buildStation', x: 30, y: 10, axis: 0, platforms: 1, length: 4 });
    const st = [...state.stations.values()].at(-1)!;
    run({ type: 'buyTrain', depot: map.tileIndex(2, 10), units: ['badger', 'coach_steel', 'coach_steel'] });
    const t = [...state.trains.values()].at(-1)!;
    run({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: st.id }] });
    run({ type: 'trainAction', id: t.id, action: 'start' });
    const spans = new Set<number>();
    for (let i = 0; i < TICKS_PER_DAY * 30 && t.status !== 'loading'; i++) {
      state.step();
      for (const s of t.path) if (segTd(s) >= 12) spans.add(segTile(s) % map.width);
    }
    return { train: t, spans };
  };
  return { state, map, run, tryRun, line, drive };
}

// A valley: level 4, sloping down to 2 between x = 15 and x = 25.
const valley = (x: number) => (x <= 15 || x >= 25 ? 4 : Math.max(2, 4 - Math.min(x - 15, 25 - x)));
// A hill: level 2, rising to 4 between x = 11 and x = 21.
const hill = (x: number) => (x <= 10 || x >= 22 ? 2 : Math.min(4, 2 + Math.min(x - 10, 22 - x)));

describe('bridges', () => {
  test('a train crosses a bridge over a valley and a line underneath', () => {
    const { state, map, run, tryRun, line, drive } = world(valley);
    line(3, 14);
    run({ type: 'buildBridge', x0: 15, y0: 10, x1: 24, y1: 10, bridgeType: 1 });
    line(25, 40);
    expect(spanOver(map, map.tileIndex(20, 10), 0)?.level).toBe(4);
    // A line along the valley floor passes under the bridge.
    const under: number[] = [];
    for (let y = 4; y <= 16; y++) under.push(20, y, Piece.Y);
    run({ type: 'buildTrack', pieces: under });
    // ...but nothing can be raised into the deck.
    expect(tryRun({ type: 'terraform', x0: 23, y0: 13, x1: 23, y1: 13, mode: 'raise' }).ok).toBe(true); // away from the bridge
    expect(tryRun({ type: 'terraform', x0: 18, y0: 10, x1: 18, y1: 10, mode: 'raise' }).ok).toBe(true);
    expect(tryRun({ type: 'terraform', x0: 18, y0: 10, x1: 18, y1: 10, mode: 'raise' }).ok).toBe(false);
    const { train, spans } = drive();
    expect(train.status).toBe('loading');
    expect(spans.has(20)).toBe(true);
    expect(state.isPieceOccupied(map.tileIndex(20, 10), Piece.Y)).toBe(false);
  });

  test('bridges need matching ends, clearance and a long enough type', () => {
    const { tryRun, line } = world(valley);
    line(3, 14);
    expect(tryRun({ type: 'buildBridge', x0: 15, y0: 10, x1: 23, y1: 10, bridgeType: 1 }).ok).toBe(false); // ends at different heights
    expect(tryRun({ type: 'buildBridge', x0: 15, y0: 10, x1: 24, y1: 10, bridgeType: 0 }).ok).toBe(false); // timber spans ≤ 6
    expect(tryRun({ type: 'buildBridge', x0: 15, y0: 10, x1: 24, y1: 11, bridgeType: 1 }).ok).toBe(false); // not straight
  });

  test('bulldozing an end removes the whole bridge but not the line below', () => {
    const { state, map, run, line } = world(valley);
    run({ type: 'buildBridge', x0: 15, y0: 10, x1: 24, y1: 10, bridgeType: 1 });
    line(18, 21, 10);
    expect(map.type(15, 10)).toBe(TileType.Rail);
    run({ type: 'clearArea', x0: 24, y0: 10, x1: 24, y1: 10 });
    expect(map.type(15, 10)).toBe(TileType.Clear);
    expect(map.type(24, 10)).toBe(TileType.Clear);
    expect(map.type(19, 10)).toBe(TileType.Rail);
    expect(spanOver(map, map.tileIndex(19, 10), 0)).toBeNull();
    void state;
  });
});

describe('tunnels', () => {
  test('a train runs through a tunnel under a hill with track on top', () => {
    const { map, run, tryRun, line, drive } = world(hill);
    line(3, 9);
    run({ type: 'buildTunnel', x: 10, y: 10, dir: Edge.E });
    expect(map.type(21, 10)).toBe(TileType.Rail);
    expect(spanOver(map, map.tileIndex(16, 10), 0)?.kind).toBe('tunnel');
    line(22, 40);
    // Track over the hilltop is fine; digging into the tunnel is not.
    run({ type: 'buildTrack', pieces: [16, 8, Piece.Y, 16, 9, Piece.Y, 16, 10, Piece.Y, 16, 11, Piece.Y] });
    // Corner (14, 11) is on top of the tunnel (level 2): it may go down to 3, not to 2.
    expect(tryRun({ type: 'terraform', x0: 14, y0: 11, x1: 14, y1: 11, mode: 'lower' }).ok).toBe(true);
    expect(tryRun({ type: 'terraform', x0: 14, y0: 11, x1: 14, y1: 11, mode: 'lower' }).ok).toBe(false);
    const { train, spans } = drive();
    expect(train.status).toBe('loading');
    expect([...spans].some((x) => x > 10 && x < 21)).toBe(true);
  });

  test('tunnels must start on a slope into a hill', () => {
    const { tryRun } = world(hill);
    expect(tryRun({ type: 'buildTunnel', x: 5, y: 10, dir: Edge.E }).ok).toBe(false); // flat ground
    expect(tryRun({ type: 'buildTunnel', x: 10, y: 10, dir: Edge.W }).ok).toBe(false); // slope falls that way
  });
});
