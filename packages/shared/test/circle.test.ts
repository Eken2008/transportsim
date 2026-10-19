import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS, GameMap, GameState, Piece, executeCommand, nextSegments, seg, trackdir } from '../src/index.ts';

/**
 * The smallest circle: eight pieces round a 3×3 ring, straight and corner alternating, so every
 * joint is a 45° turn. Placed one piece per command, as clicking does.
 */
const RING: readonly [number, number, Piece][] = [
  [1, 0, Piece.X],
  [2, 0, Piece.SW],
  [2, 1, Piece.Y],
  [2, 2, Piece.NW],
  [1, 2, Piece.X],
  [0, 2, Piece.NE],
  [0, 1, Piece.Y],
  [0, 0, Piece.SE],
];

function world() {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128 }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  const pl = state.addPlayer('A', true);
  const co = state.foundCompany(pl)!;
  co.money = 1e9;
  const click = (x: number, y: number, piece: Piece) =>
    executeCommand(state, { playerId: pl.id, companyId: co.id }, { type: 'buildTrack', pieces: [x, y, piece] });
  return { map, click, owner: co.id };
}

/** Follow the track from the first ring piece; true if it runs all the way round with no choices. */
function closedLoop(map: GameMap, owner: number, ox: number, oy: number, dir: number): boolean {
  const start = seg(map.tileIndex(ox + 1, oy), trackdir(Piece.X, dir));
  let s = start;
  for (let step = 0; step < 8; step++) {
    const next = nextSegments(map, s, owner);
    if (next.length !== 1) return false;
    s = next[0]!;
  }
  return s === start;
}

function shuffled<T>(xs: readonly T[], seed: number): T[] {
  const out = [...xs];
  let r = seed;
  for (let i = out.length - 1; i > 0; i--) {
    r = (r * 1103515245 + 12345) & 0x7fffffff;
    const j = r % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe('a circle of eight pieces', () => {
  test('placed piece by piece in any order, it connects all the way round both ways', () => {
    const orders = [RING, [...RING].reverse(), ...Array.from({ length: 60 }, (_, k) => shuffled(RING, k + 1))];
    for (const order of orders) {
      const { map, click, owner } = world();
      for (const [x, y, p] of order) expect(click(40 + x, 40 + y, p).ok).toBe(true);
      expect(closedLoop(map, owner, 40, 40, 0)).toBe(true);
      expect(closedLoop(map, owner, 40, 40, 1)).toBe(true);
    }
  });
});
