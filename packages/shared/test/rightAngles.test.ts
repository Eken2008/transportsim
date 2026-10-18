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
  planTrack,
  turnSteps,
} from '../src/index.ts';

/** Every place where track entering a piece and track leaving it differ by more than 45°. */
function rightAngles(map: GameMap): string[] {
  const out: string[] = [];
  for (let t = 0; t < map.layers.type.length; t++) {
    const bits = map.layers.track[t]!;
    if (!bits) continue;
    for (let p = 0; p < 6; p++) {
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

  test('a second track joining the point where a diagonal meets a line does not connect at 90°', () => {
    const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128 }, new GameMap(128, 128));
    const map = state.map;
    map.heights.fill(2);
    for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
    const pl = state.addPlayer('A', true);
    const c = state.foundCompany(pl)!;
    c.money = 1e9;
    const run = (pieces: number[]) => executeCommand(state, { playerId: pl.id, companyId: c.id }, { type: 'buildTrack', pieces });
    // Line, then a diagonal from the south-west ending in a corner piece on the line at x = 44
    // (joining the line heading east), then a diagonal leaving the line eastwards to the south-east.
    const line: number[] = [];
    for (let x = 30; x <= 60; x++) line.push(x, 41, Piece.X);
    run(line);
    run([40, 45, Piece.SE, 41, 45, Piece.NW, 41, 44, Piece.SE, 42, 44, Piece.NW, 42, 43, Piece.SE, 43, 43, Piece.NW, 43, 42, Piece.SE, 44, 42, Piece.NW, 44, 41, Piece.SE]);
    run([45, 41, Piece.SW, 45, 42, Piece.NE, 46, 42, Piece.SW, 46, 43, Piece.NE]);
    expect(rightAngles(map)).toEqual([]);
  });
});
