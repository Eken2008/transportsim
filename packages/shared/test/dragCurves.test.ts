import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS, GameMap, GameState, executeCommand, nextSegments, planTrack, seg, trackdir } from '../src/index.ts';

describe('drawing curves with drags', () => {
  test('diagonal, straight, diagonal drawn as three drags (each starting where the last ended) connects', () => {
    const broken: string[] = [];
    for (const [ax, ay] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
      for (const flip of [false, true]) {
        for (const d1 of [2, 3, 5]) {
          for (const s of [1, 2, 4]) {
            // A V: diagonal (ax, ay) for d1 tiles, straight for s tiles, then diagonal (ax, -ay) back.
            const P = (x: number, y: number) => (flip ? [60 + y, 60 + x] : [60 + x, 60 + y]) as [number, number];
            const a = P(0, 0);
            const b = P(ax * d1, ay * d1);
            const c = P(ax * (d1 + s), ay * d1);
            const d = P(ax * (2 * d1 + s), 0);
            const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128 }, new GameMap(128, 128));
            const map = state.map;
            map.heights.fill(2);
            for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
            const pl = state.addPlayer('A', true);
            const co = state.foundCompany(pl)!;
            co.money = 1e9;
            const drag = (f: [number, number], t: [number, number]) => {
              const plan = planTrack(map, f[0], f[1], t[0], t[1], { owner: co.id });
              expect(plan).not.toBeNull();
              const pieces = plan!.flatMap((q) => [q.x, q.y, q.piece]);
              expect(executeCommand(state, { playerId: pl.id, companyId: co.id }, { type: 'buildTrack', pieces }).ok).toBe(true);
            };
            drag(a, b);
            drag(b, c);
            drag(c, d);
            // A train starting at a can reach d.
            const startTile = map.tileIndex(a[0], a[1]);
            const endTile = map.tileIndex(d[0], d[1]);
            let reached = false;
            for (let p = 0; p < 6 && !reached; p++) {
              if (!((map.layers.track[startTile]! >> p) & 1)) continue;
              for (const dir of [0, 1]) {
                const st = seg(startTile, trackdir(p, dir));
                const seen = new Set([st]);
                const todo = [st];
                while (todo.length) for (const n of nextSegments(map, todo.pop()!, co.id)) if (!seen.has(n)) {
                  seen.add(n);
                  todo.push(n);
                }
                if ([...seen].some((x) => Math.floor(x / 16) === endTile)) reached = true;
              }
            }
            if (!reached) broken.push(JSON.stringify({ ax, ay, flip, d1, s }));
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });
});
