import { createNoise2D } from 'simplex-noise';
import { MinHeap } from '../util/heap.ts';
import { Random } from '../util/random.ts';

/** Rivers per 256×256 tiles at the default setting. */
const RIVERS_PER_AREA = 3;
/** Shortest river worth keeping (tiles). */
const MIN_LENGTH = 12;
/** Deepest a river may cut below the land it runs through (height levels). */
const MAX_CUT = 3;
/** Most corners one river may reshape (cuts and raised banks) before it is given up. */
const MAX_RESHAPE = 1500;
const MAX_EXPANSIONS = 80_000;

const DX = [0, 1, 0, -1] as const;
const DY = [-1, 0, 1, 0] as const;

/**
 * Carve rivers into a corner height field (which already satisfies the slope rule). Each river
 * runs from a spring in the hills down to the sea (tiles whose corners are all 0), into another
 * river, or off the map edge. River tiles are flat; where a river drops a level it does so on
 * rapids, a straight slope along the flow. Banks are raised a level where needed so every river
 * runs in a channel. Returns river tiles, mapped to whether each is rapids.
 */
export function carveRivers(heights: Uint8Array, w: number, h: number, seed: number, density: number, springMin: number): Map<number, boolean> {
  const rivers = new Map<number, boolean>();
  const count = Math.round(((w * h) / 65536) * RIVERS_PER_AREA * density);
  if (count <= 0) return rivers;
  const rng = new Random(seed ^ 0x51ae7);
  const meander = createNoise2D(() => rng.next());
  const cw = w + 1;
  const corner = (x: number, y: number) => heights[y * cw + x]!;
  const tileMin = (t: number) => {
    const x = t % w;
    const y = (t - x) / w;
    return Math.min(corner(x, y), corner(x + 1, y), corner(x, y + 1), corner(x + 1, y + 1));
  };
  const tileMax = (t: number) => {
    const x = t % w;
    const y = (t - x) / w;
    return Math.max(corner(x, y), corner(x + 1, y), corner(x, y + 1), corner(x + 1, y + 1));
  };
  const nearRiver = (x: number, y: number, r: number) => {
    for (let ty = Math.max(0, y - r); ty <= Math.min(h - 1, y + r); ty++) {
      for (let tx = Math.max(0, x - r); tx <= Math.min(w - 1, x + r); tx++) if (rivers.has(ty * w + tx)) return true;
    }
    return false;
  };

  for (let attempt = 0, made = 0; attempt < count * 8 && made < count; attempt++) {
    const sx = rng.int(4, w - 5);
    const sy = rng.int(4, h - 5);
    const spring = sy * w + sx;
    if (tileMin(spring) < springMin || nearRiver(sx, sy, 6)) continue;
    const route = findRoute(spring);
    if (!route) continue;
    let { path } = route;
    const target = route.target;
    // Levels: trim the upper course until the river nowhere cuts deeper than MAX_CUT.
    let levels = assignLevels(path, target);
    while (levels) {
      let cut = -1;
      for (let k = 0; k < path.length; k++) if (tileMin(path[k]!) - levels.exit[k]! > MAX_CUT) cut = k;
      if (cut < 0) break;
      path = path.slice(cut + 1);
      levels = path.length >= MIN_LENGTH ? assignLevels(path, target) : null;
    }
    if (!levels || path.length < MIN_LENGTH) continue;
    if (carve(path, target, levels)) made++;
  }
  return rivers;

  /** Cheapest way downhill from the spring: tiles in order, and what the river ends in. */
  function findRoute(spring: number): { path: number[]; target: number } | null {
    const g = new Map<number, number>([[spring, 0]]);
    const from = new Map<number, number>();
    const closed = new Set<number>();
    const open = new MinHeap();
    open.push(0, spring);
    let expanded = 0;
    while (open.size) {
      const c = open.pop();
      if (closed.has(c)) continue;
      closed.add(c);
      if (++expanded > MAX_EXPANSIONS) return null;
      const cx = c % w;
      const cy = (c - cx) / w;
      const path = () => {
        const out: number[] = [];
        for (let t = c; t !== spring; t = from.get(t)!) out.push(t);
        out.push(spring);
        return out.reverse();
      };
      // Off the map edge: the edge tile is the river's last.
      if (cx === 0 || cy === 0 || cx === w - 1 || cy === h - 1) return { path: path(), target: -1 };
      for (let d = 0; d < 4; d++) {
        const n = (cy + DY[d]!) * w + cx + DX[d]!;
        if (closed.has(n)) continue;
        // Into the sea, or into another river's flat stretch.
        if (tileMax(n) === 0 || rivers.get(n) === false) {
          if (c === spring) return null;
          return { path: path(), target: n };
        }
        if (rivers.has(n)) continue; // rapids
        const nx = cx + DX[d]!;
        const ny = cy + DY[d]!;
        let cost = 1 + 4 * Math.max(0, tileMin(n) - tileMin(c)) + 1.2 * (meander(nx / 7, ny / 7) * 0.5 + 0.5);
        // Keep apart from other rivers rather than running alongside them.
        if (nearRiver(nx, ny, 1)) cost += 6;
        const gn = g.get(c)! + cost;
        if (gn < (g.get(n) ?? Infinity)) {
          g.set(n, gn);
          from.set(n, c);
          open.push(gn, n);
        }
      }
    }
    return null;
  }

  /** Does any tile around corner `c` satisfy `fn`? */
  function touches(c: number, fn: (t: number) => boolean): boolean {
    const x = c % cw;
    const y = (c - x) / cw;
    for (let ty = Math.max(0, y - 1); ty <= Math.min(h - 1, y); ty++) {
      for (let tx = Math.max(0, x - 1); tx <= Math.min(w - 1, x); tx++) if (fn(ty * w + tx)) return true;
    }
    return false;
  }

  /** Flow direction (0-3) out of path tile k. */
  function flowDir(path: number[], target: number, k: number): number {
    const a = path[k]!;
    const b = k + 1 < path.length ? path[k + 1]! : target;
    if (b < 0) return k > 0 ? flowDir(path, target, k - 1) : 1;
    if (b === a + 1) return 1;
    if (b === a - 1) return 3;
    return b > a ? 2 : 0;
  }

  /**
   * Entry and exit level of each tile: never above the land (running minimum going downstream),
   * reaching the target's level, rising at most one level per straight tile going upstream.
   */
  function assignLevels(path: number[], target: number): { entry: number[]; exit: number[] } | null {
    const n = path.length;
    const run: number[] = [];
    let m = Infinity;
    for (const t of path) run.push((m = Math.min(m, tileMin(t))));
    const end = target < 0 ? run[n - 1]! : tileMin(target);
    if (end > run[n - 1]!) return null;
    const entry = new Array<number>(n);
    const exit = new Array<number>(n);
    let b = end;
    for (let k = n - 1; k >= 0; k--) {
      const straight = k === 0 || flowDir(path, target, k - 1) === flowDir(path, target, k);
      exit[k] = b;
      entry[k] = Math.min(run[k]!, straight ? b + 1 : b);
      b = entry[k]!;
    }
    return { entry, exit };
  }

  /** Reshape the land for a river; false (and nothing changed) if the result would be inconsistent. */
  function carve(path: number[], target: number, levels: { entry: number[]; exit: number[] }): boolean {
    const undo: number[] = [];
    const set = (c: number, v: number) => {
      undo.push(c, heights[c]!);
      heights[c] = v;
    };
    // Designed height of every corner of the river's tiles (per tile, and merged).
    const design: number[] = [];
    const want = new Map<number, number>();
    path.forEach((t, k) => {
      const x = t % w;
      const y = (t - x) / w;
      const d = flowDir(path, target, k);
      for (const [ox, oy] of [[0, 0], [1, 0], [0, 1], [1, 1]] as const) {
        const along = (ox - 0.5) * DX[d]! + (oy - 0.5) * DY[d]!;
        const v = along < 0 ? levels.entry[k]! : levels.exit[k]!;
        const c = (y + oy) * cw + x + ox;
        design.push(c, v);
        want.set(c, Math.min(v, want.get(c) ?? Infinity));
      }
    });
    const neighbours = (c: number, fn: (n: number) => void) => {
      const x = c % cw;
      const y = (c - x) / cw;
      if (x > 0) fn(c - 1);
      if (x < w) fn(c + 1);
      if (y > 0) fn(c - cw);
      if (y < h) fn(c + cw);
    };
    // Cut the bed, lowering the land around it to keep slopes within one level.
    const queue: number[] = [];
    for (const [c, v] of want) {
      if (heights[c]! > v) {
        set(c, v);
        queue.push(c);
      }
    }
    while (queue.length && undo.length < MAX_RESHAPE * 2) {
      const c = queue.pop()!;
      neighbours(c, (n) => {
        if (heights[n]! > heights[c]! + 1) {
          set(n, heights[c]! + 1);
          queue.push(n);
        }
      });
    }
    // Banks a level above the water, raising the land behind them as needed (not the seabed or
    // another river's bed, which are water already).
    const bank = new Map<number, number>();
    for (const [c, v] of want) {
      neighbours(c, (n) => {
        if (!want.has(n) && !touches(n, (t) => tileMax(t) === 0 || rivers.has(t))) bank.set(n, Math.min(v + 1, bank.get(n) ?? Infinity));
      });
    }
    for (const [c, v] of bank) {
      if (heights[c]! < v) {
        set(c, v);
        queue.push(c);
      }
    }
    let seabed = false;
    while (queue.length && undo.length < MAX_RESHAPE * 2) {
      const c = queue.pop()!;
      neighbours(c, (n) => {
        if (heights[n]! < heights[c]! - 1) {
          if (heights[n] === 0 && touches(n, (t) => tileMax(t) === 0)) seabed = true;
          set(n, heights[c]! - 1);
          queue.push(n);
        }
      });
    }
    // Every tile exactly as designed, no other river touched and the coast unchanged.
    let ok = queue.length === 0 && !seabed;
    for (let k = 0; k < design.length; k += 2) if (heights[design[k]!] !== design[k + 1]) ok = false;
    for (let k = 0; k < undo.length && ok; k += 2) if (touches(undo[k]!, (t) => rivers.has(t))) ok = false;
    if (!ok) {
      for (let k = undo.length - 2; k >= 0; k -= 2) heights[undo[k]!] = undo[k + 1]!;
      return false;
    }
    path.forEach((t, k) => rivers.set(t, levels.entry[k] !== levels.exit[k]));
    return true;
  }
}
