import type { GameMap } from '../world/map.ts';
import { TileType } from '../world/constants.ts';
import { nextSegments, segLength, segReverse, segTd, segTile, type Access } from './network.ts';
import { TD_HEADING } from './track.ts';
import { MinHeap } from '../util/heap.ts';

export interface PathGoal {
  /** Is this segment a goal? */
  isGoal(s: number): boolean;
  /** Admissible distance estimate (tiles) from a tile to the goal. */
  estimate(x: number, y: number): number;
  /** Extra cost (tiles) of ending on this goal segment, to prefer some goals over others. */
  cost?(s: number): number;
}

export interface PathOptions {
  /** Whose track the train may use. */
  access: Access;
  /** Extra cost for entering a segment (e.g. occupied track). */
  penalty?: (s: number) => number;
  maxNodes?: number;
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
  const open = new MinHeap();
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
      if (goal.cost && goal.isGoal(n)) cost += goal.cost(n);
      const old = g.get(n);
      if (old !== undefined && old <= cost) continue;
      g.set(n, cost);
      parent.set(n, cur);
      open.push(cost + h0(n), n);
    }
  }
  return null;
}

/** Extra cost (tiles) of stopping to reverse on the way. */
const REVERSE_PENALTY = 4;

/**
 * A* for a train of `length` tiles that can only reach `goal` by turning round: drive on from
 * `start` until the whole train is past where it began (clear of a depot, say), stop and
 * reverse. Returns the segments to drive up to the reversal point, or null.
 */
export function findTurnaround(map: GameMap, start: number, goal: PathGoal, length: number, opts: PathOptions): number[] | null {
  const maxNodes = opts.maxNodes ?? 60_000;
  // Nodes are segment * 2 + phase: 0 while driving out, 1 after reversing.
  const g = new Map<number, number>();
  const driven = new Map<number, number>();
  const parent = new Map<number, number>();
  const open = new MinHeap();
  const w = map.width;
  const h = (node: number) => {
    const t = segTile(Math.floor(node / 2));
    const x = t % w;
    return goal.estimate(x, (t - x) / w);
  };
  const root = start * 2;
  const push = (node: number, from: number, cost: number) => {
    const old = g.get(node);
    if (old !== undefined && old <= cost) return false;
    g.set(node, cost);
    parent.set(node, from);
    open.push(cost + h(node), node);
    return true;
  };
  g.set(root, 0);
  driven.set(root, 0);
  open.push(h(root), root);
  const next: number[] = [];
  let expanded = 0;
  while (open.size > 0) {
    const cur = open.pop();
    const s = Math.floor(cur / 2);
    const phase = cur % 2;
    if (phase === 1 && goal.isGoal(s)) {
      const path: number[] = [];
      for (let n = cur; n !== root; n = parent.get(n)!) if (n % 2 === 0) path.push(n / 2);
      return path.reverse();
    }
    if (++expanded > maxNodes) return null;
    const gc = g.get(cur)!;
    if (phase === 0 && driven.get(cur)! >= length + 1e-6) {
      // The whole train is out: reverse here. The new head is the tail's segment, turned round.
      let n = cur;
      for (let covered = segLength(s); covered < length; covered += segLength(Math.floor(n / 2))) n = parent.get(n)!;
      push(segReverse(Math.floor(n / 2)) * 2 + 1, cur, gc + REVERSE_PENALTY);
    }
    const heading = TD_HEADING[segTd(s)]!;
    for (const n of nextSegments(map, s, opts.access, next)) {
      // Turning round inside a depot would be parking there.
      if (phase === 0 && map.layers.type[segTile(n)] === TileType.Depot) continue;
      let cost = gc + segLength(n);
      if (TD_HEADING[segTd(n)] !== heading) cost += CURVE_PENALTY;
      if (opts.penalty) cost += opts.penalty(n);
      if (phase === 1 && goal.cost && goal.isGoal(n)) cost += goal.cost(n);
      if (push(n * 2 + phase, cur, cost) && phase === 0) driven.set(n * 2, driven.get(cur)! + segLength(n));
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

/**
 * Goal: drive into one of the given depot tiles through its door. With `extra`, reaching a
 * depot costs that much more (say, the way on from it), so the search weighs depots by it.
 */
export function depotGoal(map: GameMap, depots: number[], extra?: (depot: number) => number): PathGoal {
  const costs = new Map(depots.map((d) => [d, extra?.(d) ?? 0]));
  const w = map.width;
  return {
    isGoal(s) {
      return costs.has(segTile(s));
    },
    estimate(x, y) {
      if (extra && costs.has(y * w + x)) return 0; // the extra is already paid on arrival
      let best = Infinity;
      for (const [d, c] of costs) {
        const dx = d % w;
        best = Math.min(best, Math.hypot(dx - x, (d - dx) / w - y) + c);
      }
      return best * 0.95;
    },
    cost: extra ? (s) => costs.get(segTile(s)) ?? 0 : undefined,
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
