import type { GameMap } from '../world/map.ts';
import { TileType } from '../world/constants.ts';
import { nextSegments, segLength, segTd, segTile, type Access } from './network.ts';
import { TD_HEADING } from './track.ts';

export interface PathGoal {
  /** Is this segment a goal? */
  isGoal(s: number): boolean;
  /** Admissible distance estimate (tiles) from a tile to the goal. */
  estimate(x: number, y: number): number;
}

export interface PathOptions {
  /** Whose track the train may use. */
  access: Access;
  /** Extra cost for entering a segment (e.g. occupied track). */
  penalty?: (s: number) => number;
  maxNodes?: number;
}

/** Binary min-heap keyed by f-score. */
class Heap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(key: number, val: number) {
    const k = this.keys;
    const v = this.vals;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p]! <= key) break;
      k[i] = k[p]!;
      v[i] = v[p]!;
      i = p;
    }
    k[i] = key;
    v[i] = val;
  }
  pop(): number {
    const k = this.keys;
    const v = this.vals;
    const top = v[0]!;
    const lk = k.pop()!;
    const lv = v.pop()!;
    if (k.length > 0) {
      let i = 0;
      const n = k.length;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= n) break;
        const r = l + 1;
        const c = r < n && k[r]! < k[l]! ? r : l;
        if (k[c]! >= lk) break;
        k[i] = k[c]!;
        v[i] = v[c]!;
        i = c;
      }
      k[i] = lk;
      v[i] = lv;
    }
    return top;
  }
}

const CURVE_PENALTY = 0.15;

/**
 * A* over track segments from (after) `start` to any goal segment. Returns the segments to
 * drive, excluding `start`, or null if unreachable within the node budget.
 */
export function findPath(map: GameMap, start: number, goal: PathGoal, opts: PathOptions): number[] | null {
  const maxNodes = opts.maxNodes ?? 60_000;
  const g = new Map<number, number>();
  const parent = new Map<number, number>();
  const open = new Heap();
  const w = map.width;
  const h0 = (s: number) => {
    const t = segTile(s);
    const x = t % w;
    return goal.estimate(x, (t - x) / w);
  };
  g.set(start, 0);
  open.push(h0(start), start);
  const next: number[] = [];
  let expanded = 0;
  while (open.size > 0) {
    const cur = open.pop();
    if (cur !== start && goal.isGoal(cur)) {
      const path: number[] = [];
      for (let s = cur; s !== start; s = parent.get(s)!) path.push(s);
      return path.reverse();
    }
    if (++expanded > maxNodes) return null;
    const gc = g.get(cur)!;
    const heading = TD_HEADING[segTd(cur)]!;
    for (const n of nextSegments(map, cur, opts.access, next)) {
      let cost = gc + segLength(n);
      if (TD_HEADING[segTd(n)] !== heading) cost += CURVE_PENALTY;
      if (opts.penalty) cost += opts.penalty(n);
      const old = g.get(n);
      if (old !== undefined && old <= cost) continue;
      g.set(n, cost);
      parent.set(n, cur);
      open.push(cost + h0(n), n);
    }
  }
  return null;
}

/** Goal: any platform segment of a station (stopping happens at the platform's far end). */
export function stationGoal(map: GameMap, stationId: number, box: { x0: number; y0: number; x1: number; y1: number }): PathGoal {
  return {
    isGoal(s) {
      const t = segTile(s);
      return map.layers.type[t] === TileType.Station && map.layers.data[t] === stationId;
    },
    estimate(x, y) {
      const dx = x < box.x0 ? box.x0 - x : x > box.x1 ? x - box.x1 : 0;
      const dy = y < box.y0 ? box.y0 - y : y > box.y1 ? y - box.y1 : 0;
      return Math.hypot(dx, dy) * 0.95;
    },
  };
}

/** Goal: drive into one of the given depot tiles through its door. */
export function depotGoal(map: GameMap, depots: number[]): PathGoal {
  const set = new Set(depots);
  const w = map.width;
  return {
    isGoal(s) {
      return set.has(segTile(s));
    },
    estimate(x, y) {
      let best = Infinity;
      for (const d of depots) {
        const dx = d % w;
        best = Math.min(best, Math.hypot(dx - x, (d - dx) / w - y));
      }
      return best * 0.95;
    },
  };
}

/**
 * Extend a route that ends on a station platform to the platform's far end, following the
 * same station's tiles straight ahead (so the whole train fits and stops at the end).
 */
export function extendThroughPlatform(map: GameMap, route: number[], access: Access): void {
  if (route.length === 0) return;
  const next: number[] = [];
  for (let guard = 0; guard < 64; guard++) {
    const last = route[route.length - 1]!;
    const t = segTile(last);
    if (map.layers.type[t] !== TileType.Station) return;
    const id = map.layers.data[t];
    const cand = nextSegments(map, last, access, next).filter(
      (s) => map.layers.type[segTile(s)] === TileType.Station && map.layers.data[segTile(s)] === id,
    );
    if (cand.length !== 1) return;
    route.push(cand[0]!);
  }
}
