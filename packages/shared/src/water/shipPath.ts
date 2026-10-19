import { TileType } from '../world/constants.ts';
import type { GameMap } from '../world/map.ts';
import { shipStep } from './waterways.ts';

/** Most tiles a ship route search looks at before giving up. */
const MAX_EXPANSIONS = 120_000;
const DIAG = Math.SQRT2;

/** Binary min-heap of [priority, tile]. */
class Heap {
  private p: number[] = [];
  private v: number[] = [];
  get size() {
    return this.v.length;
  }
  push(prio: number, val: number): void {
    const p = this.p;
    const v = this.v;
    let i = v.length;
    p.push(prio);
    v.push(val);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (p[parent]! <= prio) break;
      p[i] = p[parent]!;
      v[i] = v[parent]!;
      i = parent;
    }
    p[i] = prio;
    v[i] = val;
  }
  pop(): number {
    const p = this.p;
    const v = this.v;
    const top = v[0]!;
    const lp = p.pop()!;
    const lv = v.pop()!;
    if (v.length) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        if (l >= v.length) break;
        const r = l + 1;
        const c = r < v.length && p[r]! < p[l]! ? r : l;
        if (p[c]! >= lp) break;
        p[i] = p[c]!;
        v[i] = v[c]!;
        i = c;
      }
      p[i] = lp;
      v[i] = lv;
    }
    return top;
  }
}

/**
 * Shortest sailing route from `start` to any of `targets` (tiles), as the tiles after `start`
 * (ending at the target reached), or null if none can be reached. Ships move to the four
 * neighbours (through locks and depots only lengthways) and diagonally across open water.
 * `blocked` tiles (wrecks) can't be entered.
 */
export function findShipPath(map: GameMap, start: number, targets: ReadonlySet<number>, blocked?: (tile: number) => boolean): number[] | null {
  if (targets.size === 0) return null;
  if (targets.has(start)) return [];
  const w = map.width;
  const tx: number[] = [];
  const ty: number[] = [];
  for (const t of targets) {
    tx.push(t % w);
    ty.push(Math.floor(t / w));
  }
  const h = (i: number) => {
    const x = i % w;
    const y = (i - x) / w;
    let best = Infinity;
    for (let k = 0; k < tx.length; k++) {
      const dx = Math.abs(tx[k]! - x);
      const dy = Math.abs(ty[k]! - y);
      const d = Math.max(dx, dy) + (DIAG - 1) * Math.min(dx, dy);
      if (d < best) best = d;
    }
    return best;
  };
  const g = new Map<number, number>([[start, 0]]);
  const from = new Map<number, number>();
  const closed = new Set<number>();
  const open = new Heap();
  open.push(h(start), start);
  const water = (i: number) => map.layers.type[i] === TileType.Water && !blocked?.(i);
  let expanded = 0;
  while (open.size) {
    const i = open.pop();
    if (closed.has(i)) continue;
    if (targets.has(i)) {
      const out: number[] = [];
      for (let c = i; c !== start; c = from.get(c)!) out.push(c);
      return out.reverse();
    }
    closed.add(i);
    if (++expanded > MAX_EXPANSIONS) return null;
    const gi = g.get(i)!;
    const relax = (n: number, cost: number) => {
      if (n < 0 || closed.has(n) || blocked?.(n)) return;
      const gn = gi + cost;
      if (gn < (g.get(n) ?? Infinity)) {
        g.set(n, gn);
        from.set(n, i);
        open.push(gn + h(n), n);
      }
    };
    // Depots can only be entered as a destination.
    for (let e = 0; e < 4; e++) {
      const n = shipStep(map, i, e, true);
      if (n >= 0 && (map.layers.type[n] !== TileType.ShipDepot || targets.has(n))) relax(n, 1);
    }
    if (!water(i)) continue;
    const x = i % w;
    const y = (i - x) / w;
    for (const [dx, dy] of [
      [1, 1],
      [1, -1],
      [-1, 1],
      [-1, -1],
    ] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (!map.inBounds(nx, ny)) continue;
      const n = ny * w + nx;
      if (water(n) && water(y * w + nx) && water(ny * w + x)) relax(n, DIAG);
    }
  }
  return null;
}
