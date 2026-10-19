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

/** Every joint that turns more than 45°, and every switch whose branches are more than 45° apart. */
function rightAngles(map: GameMap): string[] {
  const out: string[] = [];
  for (let t = 0; t < map.layers.type.length; t++) {
    const bits = map.layers.track[t]!;
    if (!bits) continue;
    const at = `${t % map.width},${Math.floor(t / map.width)}`;
    for (let p = 0; p < 6; p++) {
      if (!((bits >> p) & 1)) continue;
      for (const e of PIECE_EDGES[p]!) {
        const opp = OPPOSITE_EDGE[e];
        const linked = linkedAcross(map, t, p, e);
        for (const q of linked) {
          if (turnSteps(headingOut(p, e), headingIn(q, opp)) > 1) out.push(`${at}: joint ${PIECE_NAMES[p]} → ${PIECE_NAMES[q]}`);
        }
        for (const a of linked) {
          for (const b of linked) {
            if (a < b && turnSteps(headingIn(a, opp), headingIn(b, opp)) > 1) out.push(`${at}: switch ${PIECE_NAMES[p]} → ${PIECE_NAMES[a]} / ${PIECE_NAMES[b]}`);
          }
        }
      }
    }
  }
  return out;
}

describe('no 90° connections', () => {
  test('random drags onto, along and across a line never make a 90° joint or switch', () => {
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

describe('switch branches', () => {
  /**
   * The joint is the east edge of (19, 20). Green: a line from the west ending there. Black: a
   * diagonal passing through it heading south-east. Red: a diagonal leaving it north-east.
   */
  function world() {
    const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128 }, new GameMap(128, 128));
    const map = state.map;
    map.heights.fill(2);
    for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
    const pl = state.addPlayer('A', true);
    const c = state.foundCompany(pl)!;
    c.money = 1e9;
    const run = (pieces: number[]) => executeCommand(state, { playerId: pl.id, companyId: c.id }, { type: 'buildTrack', pieces });
    const green = () => run(Array.from({ length: 10 }, (_, k) => [10 + k, 20, Piece.X]).flat());
    const black = () => run([18, 19, Piece.NE, 19, 19, Piece.SW, 19, 20, Piece.NE, 20, 20, Piece.SW, 20, 21, Piece.NE, 21, 21, Piece.SW]);
    const red = () => run([20, 20, Piece.NW, 20, 19, Piece.SE, 21, 19, Piece.NW, 21, 18, Piece.SE]);
    const reach = (x: number, y: number, td: number) => {
      const start = seg(map.tileIndex(x, y), td);
      const seen = new Set([start]);
      const todo = [start];
      while (todo.length) {
        for (const n of nextSegments(map, todo.pop()!, c.id)) {
          if (seen.has(n)) continue;
          seen.add(n);
          todo.push(n);
        }
      }
      return seen;
    };
    const has = (set: Set<number>, x: number, y: number) => [...set].some((s) => Math.floor(s / 16) === map.tileIndex(x, y));
    return { green, black, red, reach, has };
  }

  test('built green, black, red: red does not connect (it would branch 90° from black)', () => {
    const w = world();
    w.green();
    w.black();
    w.red();
    const fromGreen = w.reach(10, 20, trackdir(Piece.X, 0));
    expect(w.has(fromGreen, 21, 21)).toBe(true); // green joins black heading south-east
    expect(w.has(fromGreen, 21, 18)).toBe(false); // ...but not red
    // Coming down red towards the joint leads nowhere.
    const fromRed = w.reach(21, 18, trackdir(Piece.SE, 1));
    expect(w.has(fromRed, 15, 20) || w.has(fromRed, 18, 19) || w.has(fromRed, 21, 21)).toBe(false);
  });

  test('built green, red, black: green joins red; black passes through without connecting', () => {
    const w = world();
    w.green();
    w.red();
    w.black();
    const fromGreen = w.reach(10, 20, trackdir(Piece.X, 0));
    expect(w.has(fromGreen, 21, 18)).toBe(true);
    expect(w.has(fromGreen, 21, 21)).toBe(false);
    const alongBlack = w.reach(18, 19, trackdir(Piece.NE, 0));
    expect(w.has(alongBlack, 21, 21)).toBe(true);
    expect(w.has(alongBlack, 15, 20) || w.has(alongBlack, 21, 18)).toBe(false);
  });
});
