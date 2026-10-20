import { describe, expect, test } from 'bun:test';
import {
  COSTS,
  DEFAULT_SETTINGS,
  Edge,
  Foundation,
  GameMap,
  GameState,
  Piece,
  ROAD_E,
  ROAD_N,
  ROAD_S,
  ROAD_W,
  TileType,
  encodeSnapshot,
  executeCommand,
  isLinked,
  planTrack,
  restoreSnapshot,
  roadNext,
  roadSeg,
  segHeights,
  trackdir,
  type Command,
} from '../src/index.ts';

/** Dry land at height 2, with corner (11,10) raised to 3 so the four tiles around it slope gently. */
function setup() {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128 }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  map.heights[map.cornerIndex(11, 10)] = 3;
  const p = state.addPlayer('A', true);
  const c = state.foundCompany(p)!;
  c.money = 1e7;
  const exec = (cmd: Command) => executeCommand(state, { playerId: p.id, companyId: c.id }, cmd);
  return { state, map, exec, company: c };
}

describe('foundations', () => {
  test('straight track over one raised corner climbs on a ramp', () => {
    const { state, map, exec, company } = setup();
    const before = company.money;
    expect(exec({ type: 'buildTrack', pieces: [10, 10, Piece.X] }).ok).toBe(true);
    expect(map.layers.foundation[map.tileIndex(10, 10)]).toBe(Foundation.InclineX);
    expect(map.rawCorners(10, 10)).toEqual([2, 3, 2, 2]);
    expect(map.tileCorners(10, 10)).toEqual([2, 3, 3, 2]);
    expect(map.heightAt(10.25, 10.8)).toBeCloseTo(2.25);
    expect(segHeights(map, map.tileIndex(10, 10), trackdir(Piece.X, 0))).toEqual([2, 3]);
    expect(before - company.money).toBe(state.cost(COSTS.railPiece + COSTS.foundation));
    // Track that fits the slope as it is needs no foundation.
    expect(exec({ type: 'buildTrack', pieces: [11, 9, Piece.NE] }).ok).toBe(true);
    expect(map.layers.foundation[map.tileIndex(11, 9)]).toBe(Foundation.None);
  });

  test('a line over the bump joins up all the way: up one ramp and down the next', () => {
    const { map, exec } = setup();
    expect(exec({ type: 'buildTrack', pieces: [9, 10, Piece.X, 10, 10, Piece.X, 11, 10, Piece.X, 12, 10, Piece.X] }).ok).toBe(true);
    const t = (x: number) => map.tileIndex(x, 10);
    expect(map.tileCorners(11, 10)).toEqual([3, 2, 2, 3]);
    for (const x of [9, 10, 11]) expect(isLinked(map, t(x), Piece.X, Edge.E, Piece.X)).toBe(true);
  });

  test('a corner piece at the raised corner stands on a half-tile foundation', () => {
    const { map, exec } = setup();
    // (11,10) has its NW corner raised: the NW piece runs on the raised half.
    expect(exec({ type: 'buildTrack', pieces: [11, 10, Piece.NW] }).ok).toBe(true);
    expect(map.layers.foundation[map.tileIndex(11, 10)]).toBe(Foundation.HalfNW);
    expect([Edge.N, Edge.E, Edge.S, Edge.W].map((e) => map.edgeLevel(11, 10, e))).toEqual([3, 2, 2, 3]);
    expect(map.heightAt(11.3, 10.3)).toBe(3); // the raised half
    expect(map.heightAt(11.7, 10.7)).toBe(2); // below the diagonal cliff
    // The opposite corner piece fits on the low half, and nothing crosses the cliff.
    expect(exec({ type: 'buildTrack', pieces: [11, 10, Piece.SE] }).ok).toBe(true);
    expect(exec({ type: 'buildTrack', pieces: [11, 10, Piece.X] }).ok).toBe(false);
  });

  test('a half-tile foundation can go under a corner piece beside existing track below', () => {
    const { map, exec } = setup();
    expect(exec({ type: 'buildTrack', pieces: [10, 10, Piece.SW] }).ok).toBe(true);
    expect(map.layers.foundation[map.tileIndex(10, 10)]).toBe(Foundation.None);
    expect(exec({ type: 'buildTrack', pieces: [10, 10, Piece.NE] }).ok).toBe(true);
    expect(map.layers.foundation[map.tileIndex(10, 10)]).toBe(Foundation.HalfNE);
    expect(map.edgeLevel(10, 10, Edge.W)).toBe(2);
  });

  test('track only joins across an edge where both sides are at the same height', () => {
    const { map, exec } = setup();
    // The depot is levelled up to 3; the track beside it stays at 2.
    expect(exec({ type: 'buildTrack', pieces: [9, 10, Piece.X] }).ok).toBe(true);
    expect(exec({ type: 'buildDepot', x: 10, y: 10, exit: Edge.W }).ok).toBe(true);
    expect(map.layers.foundation[map.tileIndex(10, 10)]).toBe(Foundation.Level);
    expect(isLinked(map, map.tileIndex(9, 10), Piece.X, Edge.E, Piece.X)).toBe(false);
  });

  test('dragged track goes straight over slopes on foundations instead of around them', () => {
    const { map, company } = setup();
    // A ridge of single raised corners across the row, and a raised corner beside it.
    map.heights[map.cornerIndex(15, 10)] = 3;
    map.heights[map.cornerIndex(18, 11)] = 3;
    const plan = planTrack(map, 5, 10, 22, 10, { owner: company.id })!;
    expect(plan.every((p) => p.y === 10 && p.piece === Piece.X)).toBe(true);
    expect(plan.length).toBe(18);
  });

  test('the route planner never lays track down a cliff', () => {
    const { map, exec, company } = setup();
    const plan = planTrack(map, 5, 10, 15, 10, { owner: company.id });
    expect(plan).not.toBeNull();
    expect(exec({ type: 'buildTrack', pieces: plan!.flatMap((p) => [p.x, p.y, p.piece]) }).ok).toBe(true);
    // Every step of the route joins the next one.
    for (let k = 1; k < plan!.length; k++) {
      const a = plan![k - 1]!;
      const b = plan![k]!;
      const e = b.x > a.x ? Edge.E : b.x < a.x ? Edge.W : b.y > a.y ? Edge.S : Edge.N;
      expect(isLinked(map, map.tileIndex(a.x, a.y), a.piece, e, b.piece)).toBe(true);
    }
  });

  test("steep slopes, and foundations that would move existing track, aren't built", () => {
    const { map, exec } = setup();
    map.heights[map.cornerIndex(31, 30)] = 3;
    map.heights[map.cornerIndex(30, 31)] = 1;
    expect(exec({ type: 'buildTrack', pieces: [30, 30, Piece.X] }).ok).toBe(false);
    // A corner piece on the low half fits as it is; a ramp or level top would lift it.
    expect(exec({ type: 'buildTrack', pieces: [11, 10, Piece.SE] }).ok).toBe(true);
    expect(exec({ type: 'buildTrack', pieces: [11, 10, Piece.X] }).ok).toBe(false);
  });

  test('foundations go when the tile is cleared, and block terraforming meanwhile', () => {
    const { map, exec } = setup();
    exec({ type: 'buildTrack', pieces: [10, 10, Piece.X] });
    expect(exec({ type: 'terraform', x0: 10, y0: 10, x1: 10, y1: 10, mode: 'raise' }).ok).toBe(false);
    expect(exec({ type: 'removeTrack', pieces: [10, 10, Piece.X] }).ok).toBe(true);
    expect(map.type(10, 10)).toBe(TileType.Clear);
    expect(map.layers.foundation[map.tileIndex(10, 10)]).toBe(Foundation.None);
    expect(map.tileCorners(10, 10)).toEqual([2, 3, 2, 2]);
  });

  test('stations and depots level gentle slopes up to their height', () => {
    const { map, exec } = setup();
    // Tiles (10,10) and (11,10) both rise to 3 at the raised corner between them.
    expect(exec({ type: 'buildStation', x: 10, y: 10, axis: 0, platforms: 1, length: 2 }).ok).toBe(true);
    expect(map.layers.foundation[map.tileIndex(10, 10)]).toBe(Foundation.Level);
    expect(map.surfaceHeight(11, 10)).toBe(3);
    // A flat tile at 2 can't share a platform at 3.
    expect(exec({ type: 'buildStation', x: 10, y: 9, axis: 0, platforms: 1, length: 3 }).ok).toBe(false);
    expect(exec({ type: 'buildDepot', x: 10, y: 9, exit: Edge.W }).ok).toBe(true);
    expect(map.layers.foundation[map.tileIndex(10, 9)]).toBe(Foundation.Level);
  });

  test('roads ramp over a raised corner', () => {
    const { map, exec } = setup();
    expect(exec({ type: 'buildRoad', x0: 9, y0: 10, x1: 12, y1: 10 }).ok).toBe(true);
    expect(map.layers.foundation[map.tileIndex(10, 10)]).toBe(Foundation.InclineX);
    expect(map.layers.foundation[map.tileIndex(11, 10)]).toBe(Foundation.InclineX);
    expect(roadNext(map, roadSeg(map.tileIndex(10, 10), Edge.W, Edge.E)).length).toBe(1);
    // Up the other axis too, with a ramp along Y.
    expect(exec({ type: 'buildRoad', x0: 10, y0: 8, x1: 10, y1: 9 }).ok).toBe(true);
    expect(map.layers.foundation[map.tileIndex(10, 9)]).toBe(Foundation.InclineY);
  });

  test('roads refuse cliffs, and road vehicles stop at one', () => {
    const { map, exec } = setup();
    // A street on a levelled tile (laid by hand) stands a level above the land beside it.
    const j = map.tileIndex(10, 10);
    map.layers.type[j] = TileType.Road;
    map.layers.data[j] = ROAD_E | ROAD_W;
    map.layers.foundation[j] = Foundation.Level;
    const r = exec({ type: 'buildRoad', x0: 8, y0: 10, x1: 10, y1: 10 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('cliff');
    const i = map.tileIndex(9, 10);
    map.layers.type[i] = TileType.Road;
    map.layers.data[i] = ROAD_E | ROAD_W;
    expect(roadNext(map, roadSeg(i, Edge.W, Edge.E))).toEqual([]);
    // A road depot doesn't open onto a road below its foundation.
    expect(exec({ type: 'buildRoad', x0: 11, y0: 11, x1: 11, y1: 12 }).ok).toBe(true);
    expect(map.layers.data[map.tileIndex(11, 11)]! & ROAD_S).toBe(ROAD_S);
    expect(exec({ type: 'buildRoadDepot', x: 11, y: 10, exit: Edge.S }).ok).toBe(true);
    expect(map.layers.foundation[map.tileIndex(11, 10)]).toBe(Foundation.Level);
    expect(map.layers.data[map.tileIndex(11, 11)]! & ROAD_N).toBe(0);
  });

  test('build previews report the foundations they would lay', () => {
    const { state, map } = setup();
    const ctx = { playerId: [...state.players.values()][0]!.id, companyId: [...state.companies.values()][0]!.id };
    const r = executeCommand(state, ctx, { type: 'buildTrack', pieces: [10, 10, Piece.X, 11, 10, Piece.NW] }, true);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.foundations?.get(map.tileIndex(10, 10))).toBe(Foundation.InclineX);
      expect(r.foundations?.get(map.tileIndex(11, 10))).toBe(Foundation.HalfNW);
    }
    expect(map.layers.foundation[map.tileIndex(10, 10)]).toBe(Foundation.None);
  });

  test('foundations survive a save', () => {
    const { state, exec } = setup();
    exec({ type: 'buildTrack', pieces: [10, 10, Piece.X] });
    const restored = restoreSnapshot(encodeSnapshot(state), { maxPlayers: 15, maxMapSize: 256 });
    expect(restored.map.layers.foundation[restored.map.tileIndex(10, 10)]).toBe(Foundation.InclineX);
  });
});
