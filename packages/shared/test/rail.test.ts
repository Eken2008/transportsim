import { describe, expect, test } from 'bun:test';
import {
  COSTS,
  DEFAULT_SETTINGS,
  Edge,
  GameMap,
  GameState,
  Ground,
  Piece,
  ROAD_E,
  ROAD_W,
  TD_HEADING,
  TileType,
  autorailPath,
  executeCommand,
  nearestPiece,
  pieceFitsSlope,
  tdEntry,
  tdExit,
  trackdir,
  turnSteps,
} from '../src/index.ts';

function setup() {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 64, mapHeight: 64 }, new GameMap(64, 64));
  const map = state.map;
  // Raise everything to height 2 so the map is dry land.
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  const a = state.addPlayer('A', true);
  const b = state.addPlayer('B', false);
  const ca = state.foundCompany(a)!;
  const cb = state.foundCompany(b)!;
  return {
    state,
    map,
    A: { playerId: a.id, companyId: ca.id },
    B: { playerId: b.id, companyId: cb.id },
  };
}

const flat = (pieces: { x: number; y: number; piece: number }[]) => pieces.flatMap((p) => [p.x, p.y, p.piece]);

describe('track geometry', () => {
  test('trackdir edges and headings', () => {
    expect(tdEntry(trackdir(Piece.X, 0))).toBe(Edge.W);
    expect(tdExit(trackdir(Piece.X, 0))).toBe(Edge.E);
    expect(TD_HEADING[trackdir(Piece.X, 0)]).toBe(0); // east
    expect(TD_HEADING[trackdir(Piece.Y, 0)]).toBe(2); // south
    expect(TD_HEADING[trackdir(Piece.NE, 0)]).toBe(1); // N→E heads south-east
    expect(TD_HEADING[trackdir(Piece.SW, 1)]).toBe(1); // W→S heads south-east
    expect(turnSteps(0, 7)).toBe(1);
    expect(turnSteps(1, 3)).toBe(2);
  });

  test('slope rules', () => {
    // X climbs one level west→east: allowed. Y across the same slope: not.
    expect(pieceFitsSlope([0, 1, 1, 0], Piece.X)).toBe(true);
    expect(pieceFitsSlope([0, 1, 1, 0], Piece.Y)).toBe(false);
    // Corner piece with its free corner raised (half-tile foundation) is fine.
    expect(pieceFitsSlope([0, 0, 0, 1], Piece.NE)).toBe(true);
    expect(pieceFitsSlope([0, 1, 0, 0], Piece.NE)).toBe(false);
  });

  test('nearest piece picks by sub-tile position', () => {
    expect(nearestPiece(0.5, 0.5)).toBeOneOf([Piece.X, Piece.Y]);
    expect(nearestPiece(0.8, 0.2)).toBe(Piece.NE);
    expect(nearestPiece(0.1, 0.5)).toBe(Piece.X);
  });

  test('autorail builds straight lines and connected staircases', () => {
    expect(autorailPath(2, 2, Piece.X, 6, 3)).toEqual([2, 3, 4, 5, 6].map((x) => ({ x, y: 2, piece: Piece.X })));
    expect(autorailPath(2, 2, Piece.X, 2, 0).map((p) => p.y)).toEqual([2, 1, 0]);
    const diag = autorailPath(5, 5, Piece.NE, 8, 8);
    expect(diag).toHaveLength(7);
    // Each consecutive pair must connect: exit edge of one touches the entry of the next.
    for (let i = 1; i < diag.length; i++) {
      const a = diag[i - 1]!;
      const b = diag[i]!;
      expect(Math.abs(a.x - b.x) + Math.abs(a.y - b.y)).toBe(1);
      expect(a.piece).not.toBe(b.piece);
    }
    expect(diag.at(-1)).toMatchObject({ x: 8, y: 8 });
    const up = autorailPath(5, 5, Piece.SE, 8, 2);
    expect(up.every((p) => p.piece === Piece.SE || p.piece === Piece.NW)).toBe(true);
  });
});

describe('track commands', () => {
  test('build charges money, skips existing pieces, supports junctions', () => {
    const { state, map, A } = setup();
    const money = state.companies.get(A.companyId)!.money;
    const r = executeCommand(state, A, { type: 'buildTrack', pieces: flat(autorailPath(1, 1, Piece.X, 10, 1)) });
    expect(r.ok).toBe(true);
    expect(state.companies.get(A.companyId)!.money).toBeLessThan(money);
    expect(map.type(5, 1)).toBe(TileType.Rail);
    expect(map.layers.owner[map.tileIndex(5, 1)]).toBe(A.companyId);
    const v = state.trackVersion;
    // Junction: add a corner piece to an existing X tile
    expect(executeCommand(state, A, { type: 'buildTrack', pieces: [5, 1, Piece.SW] }).ok).toBe(true);
    expect(map.layers.track[map.tileIndex(5, 1)]).toBe((1 << Piece.X) | (1 << Piece.SW));
    expect(state.trackVersion).toBe(v + 1);
    // Re-building everything is "Already built"
    const again = executeCommand(state, A, { type: 'buildTrack', pieces: flat(autorailPath(1, 1, Piece.X, 10, 1)) });
    expect(again).toEqual({ ok: false, error: 'Already built' });
  });

  test('building through a field costs more than open land', () => {
    const { state, map, A } = setup();
    const line = (y: number) => ({ type: 'buildTrack' as const, pieces: flat([0, 1, 2, 3].map((x) => ({ x: 10 + x, y, piece: Piece.X }))) });
    const open = executeCommand(state, A, line(10), true);
    for (let x = 10; x < 14; x++) map.setClear(map.tileIndex(x, 20), Ground.Field, 0);
    const field = executeCommand(state, A, line(20), true);
    expect(open.ok && field.ok).toBe(true);
    if (open.ok && field.ok) expect(field.cost - open.cost).toBe(state.cost(4 * COSTS.clearField));
  });

  test("can't build on others' track, water, or wrong slopes", () => {
    const { state, map, A, B } = setup();
    executeCommand(state, A, { type: 'buildTrack', pieces: [3, 3, Piece.X] });
    const r = executeCommand(state, B, { type: 'buildTrack', pieces: [3, 3, Piece.Y] });
    expect(r.ok).toBe(false);
    map.setWater(map.tileIndex(7, 7));
    expect(executeCommand(state, A, { type: 'buildTrack', pieces: [7, 7, Piece.X] }).ok).toBe(false);
    map.heights[map.cornerIndex(11, 10)] = 3; // NE corner of tile (10,10)
    expect(executeCommand(state, A, { type: 'buildTrack', pieces: [10, 10, Piece.X] }).ok).toBe(false);
    expect(executeCommand(state, A, { type: 'buildTrack', pieces: [10, 10, Piece.SW] }).ok).toBe(true);
  });

  test('terraforming is blocked by track', () => {
    const { state, A } = setup();
    executeCommand(state, A, { type: 'buildTrack', pieces: [4, 4, Piece.X] });
    expect(executeCommand(state, A, { type: 'terraform', x0: 4, y0: 4, x1: 4, y1: 4, mode: 'raise' }).ok).toBe(false);
  });

  test('remove track clears the tile and level crossings revert to road', () => {
    const { state, map, A, B } = setup();
    executeCommand(state, A, { type: 'buildTrack', pieces: [2, 2, Piece.X, 3, 2, Piece.X] });
    expect(executeCommand(state, B, { type: 'removeTrack', pieces: [2, 2, Piece.X] }).ok).toBe(false);
    expect(executeCommand(state, A, { type: 'removeTrack', pieces: [2, 2, Piece.X] }).ok).toBe(true);
    expect(map.type(2, 2)).toBe(TileType.Clear);
    expect(map.type(3, 2)).toBe(TileType.Rail);

    const i = map.tileIndex(6, 6);
    map.layers.type[i] = TileType.Road;
    map.layers.data[i] = ROAD_E | ROAD_W;
    expect(executeCommand(state, A, { type: 'buildTrack', pieces: [6, 6, Piece.X] }).ok).toBe(false); // parallel
    expect(executeCommand(state, A, { type: 'buildTrack', pieces: [6, 6, Piece.Y] }).ok).toBe(true);
    expect(map.type(6, 6)).toBe(TileType.Rail);
    expect(executeCommand(state, A, { type: 'removeTrack', pieces: [6, 6, Piece.Y] }).ok).toBe(true);
    expect(map.type(6, 6)).toBe(TileType.Road);
    expect(map.layers.data[i]).toBe(ROAD_E | ROAD_W);
  });

  test('rejects malformed input', () => {
    const { state, A } = setup();
    for (const pieces of [[], [1, 2], [1, 2, 9], [-1, 0, 0], [1.5, 0, 0], 'x' as unknown as number[]]) {
      expect(executeCommand(state, A, { type: 'buildTrack', pieces }).ok).toBe(false);
    }
  });
});

describe('stations and depots', () => {
  test('build a station, extend it, and name it after the nearest town', () => {
    const { state, map, A, B } = setup();
    state.towns.set(0, { id: 0, name: 'Testford', x: 20, y: 20, population: 100, houses: 5 });
    const r = executeCommand(state, A, { type: 'buildStation', x: 10, y: 10, axis: 0, platforms: 2, length: 4 });
    expect(r.ok).toBe(true);
    expect(state.stations.size).toBe(1);
    const st = [...state.stations.values()][0]!;
    expect(st.name).toBe('Testford');
    expect(st.tiles).toBe(8);
    expect(map.type(13, 11)).toBe(TileType.Station);
    expect(map.layers.track[map.tileIndex(13, 11)]).toBe(1 << Piece.X);
    // Adjacent platform joins the same station
    expect(executeCommand(state, A, { type: 'buildStation', x: 10, y: 12, axis: 0, platforms: 1, length: 4 }).ok).toBe(true);
    expect(state.stations.size).toBe(1);
    expect(st.tiles).toBe(12);
    // A separate station gets a distinct name; other companies can't join ours
    expect(executeCommand(state, B, { type: 'buildStation', x: 10, y: 14, axis: 0, platforms: 1, length: 3 }).ok).toBe(true);
    expect(state.stations.size).toBe(2);
    const names = [...state.stations.values()].map((s) => s.name);
    expect(new Set(names).size).toBe(2);
  });

  test('stations need level ground and can convert straight track', () => {
    const { state, map, A } = setup();
    map.heights[map.cornerIndex(31, 30)] = 3;
    expect(executeCommand(state, A, { type: 'buildStation', x: 28, y: 30, axis: 0, platforms: 1, length: 4 }).ok).toBe(false);
    executeCommand(state, A, { type: 'buildTrack', pieces: [5, 30, Piece.X, 6, 30, Piece.X, 7, 30, Piece.SW] });
    expect(executeCommand(state, A, { type: 'buildStation', x: 5, y: 30, axis: 0, platforms: 1, length: 2 }).ok).toBe(true);
    expect(executeCommand(state, A, { type: 'buildStation', x: 7, y: 30, axis: 0, platforms: 1, length: 1 }).ok).toBe(false);
  });

  test('depots and clearing an area', () => {
    const { state, map, A, B } = setup();
    expect(executeCommand(state, A, { type: 'buildDepot', x: 3, y: 3, exit: Edge.E }).ok).toBe(true);
    expect(map.type(3, 3)).toBe(TileType.Depot);
    expect(map.layers.track[map.tileIndex(3, 3)]).toBe(1 << Piece.X);
    executeCommand(state, A, { type: 'buildTrack', pieces: [4, 3, Piece.X, 5, 3, Piece.X] });
    executeCommand(state, A, { type: 'buildStation', x: 6, y: 3, axis: 0, platforms: 1, length: 3 });
    expect(state.stations.size).toBe(1);
    // Someone else can't bulldoze our stuff
    expect(executeCommand(state, B, { type: 'clearArea', x0: 3, y0: 3, x1: 8, y1: 3 }).ok).toBe(false);
    const v = state.trackVersion;
    expect(executeCommand(state, A, { type: 'clearArea', x0: 3, y0: 3, x1: 8, y1: 3 }).ok).toBe(true);
    for (let x = 3; x <= 8; x++) expect(map.type(x, 3)).toBe(TileType.Clear);
    expect(state.stations.size).toBe(0);
    expect(state.removedStations.size).toBe(1);
    expect(state.trackVersion).toBeGreaterThan(v);
  });
});
