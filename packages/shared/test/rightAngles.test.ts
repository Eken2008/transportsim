import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  GameMap,
  GameState,
  OPPOSITE_EDGE,
  PIECE_EDGES,
  PIECE_NAMES,
  Piece,
  Random,
  executeCommand,
  headingIn,
  headingOut,
  linkedAcross,
  nextSegments,
  seg,
  trackdir,
  planTrack,
  turnSteps,
} from '../src/index.ts';

/** Every place where track bends 90° through a corner piece (enters and leaves it > 45° apart). */
function rightAngles(map: GameMap): string[] {
  const out: string[] = [];
  for (let t = 0; t < map.layers.type.length; t++) {
    const bits = map.layers.track[t]!;
    if (!bits) continue;
    for (let p = 2; p < 6; p++) {
      if (!((bits >> p) & 1)) continue;
      const [e0, e1] = PIECE_EDGES[p]!;
      for (const r of linkedAcross(map, t, p, e0)) {
        for (const q of linkedAcross(map, t, p, e1)) {
          if (turnSteps(headingOut(r, OPPOSITE_EDGE[e0]), headingIn(q, OPPOSITE_EDGE[e1])) > 1) {
            out.push(`${t % map.width},${Math.floor(t / map.width)}: ${PIECE_NAMES[r]} → ${PIECE_NAMES[p]} → ${PIECE_NAMES[q]}`);
          }
        }
      }
    }
  }
  return out;
}

describe('no 90° connections', () => {
  test('random drags onto, along and across a line never connect at a right angle', () => {
    const rng = new Random(7);
    for (let trial = 0; trial < 120; trial++) {
      const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128 }, new GameMap(128, 128));
      const map = state.map;
      map.heights.fill(2);
      for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
      const pl = state.addPlayer('A', true);
      const c = state.foundCompany(pl)!;
      c.money = 1e9;
      const ctx = { playerId: pl.id, companyId: c.id };
      const line: number[] = [];
      for (let x = 20; x <= 60; x++) line.push(x, 40, Piece.X);
      executeCommand(state, ctx, { type: 'buildTrack', pieces: line });
      for (let k = 0; k < 5; k++) {
        const sx = rng.int(25, 55);
        const sy = rng.pick([40, rng.int(30, 50)]);
        const ex = rng.int(25, 55);
        const ey = rng.pick([39, 40, 41, rng.int(30, 50)]);
        const plan = planTrack(map, sx, sy, ex, ey, { owner: c.id });
        if (plan) executeCommand(state, ctx, { type: 'buildTrack', pieces: plan.flatMap((q) => [q.x, q.y, q.piece]) });
      }
      expect(rightAngles(map)).toEqual([]);
    }
  }, 30_000);

  test('a diagonal can turn twice in a row: diagonal, one straight tile, diagonal', () => {
    const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128 }, new GameMap(128, 128));
    const map = state.map;
    map.heights.fill(2);
    for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
    const pl = state.addPlayer('A', true);
    const c = state.foundCompany(pl)!;
    c.money = 1e9;
    // Heading south-east, then east for one tile, then north-east (a shallow V), built in one go
    // and built piece by piece.
    const vee = [40, 40, Piece.NE, 41, 40, Piece.SW, 41, 41, Piece.NE, 42, 41, Piece.X, 43, 41, Piece.NW, 43, 40, Piece.SE, 44, 40, Piece.NW];
    for (const oneGo of [true, false]) {
      for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
      if (oneGo) executeCommand(state, { playerId: pl.id, companyId: c.id }, { type: 'buildTrack', pieces: vee });
      else for (let k = 0; k < vee.length; k += 3) executeCommand(state, { playerId: pl.id, companyId: c.id }, { type: 'buildTrack', pieces: vee.slice(k, k + 3) });
      const start = seg(map.tileIndex(40, 40), trackdir(Piece.NE, 0));
      const seen = new Set([start]);
      const todo = [start];
      while (todo.length) {
        for (const n of nextSegments(map, todo.pop()!, c.id)) {
          if (seen.has(n)) continue;
          seen.add(n);
          todo.push(n);
        }
      }
      expect(seen.has(seg(map.tileIndex(44, 40), trackdir(Piece.NW, 1)))).toBe(true); // W→N
    }
  });
});
