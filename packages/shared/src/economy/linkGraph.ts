import type { CargoId } from './cargo.ts';
import { MinHeap } from '../util/heap.ts';

/**
 * Cargodist: who sends cargo where, and by which route. The input is plain data so it can be
 * solved in a worker.
 */
export interface LinkGraphInput {
  cargo: CargoId;
  /** Symmetric cargo (passengers, mail): demand follows the destination's own supply. */
  symmetric: boolean;
  stations: { id: number; x: number; y: number; supply: number; accepts: boolean }[];
  /** Directed links: a train carrying the cargo calls at `from`, then at `to`. */
  links: { from: number; to: number; capacity: number }[];
}

export interface LinkGraphResult {
  cargo: CargoId;
  /** Destinations each station sends cargo to, with relative weights. */
  demand: [number, [number, number][]][];
  /** next hop: [station, [destination, next station][]][] */
  nextHop: [number, [number, number][]][];
}

/** Destinations further than this (tiles) get less demand. */
const DISTANCE_SCALE = 150;

/**
 * Solve one cargo's link graph: demand between stations that can reach each other, then
 * routes on shortest paths. Links that the first assignment loads beyond their capacity cost
 * more in a second pass, spreading flow over alternatives.
 */
export function solveLinkGraph(input: LinkGraphInput): LinkGraphResult {
  const byId = new Map(input.stations.map((s) => [s.id, s]));
  const out = new Map<number, { to: number; capacity: number; dist: number }[]>();
  for (const l of input.links) {
    const a = byId.get(l.from);
    const b = byId.get(l.to);
    if (!a || !b || l.from === l.to) continue;
    const list = out.get(l.from) ?? [];
    const same = list.find((e) => e.to === l.to);
    if (same) same.capacity += l.capacity;
    else list.push({ to: l.to, capacity: l.capacity, dist: Math.max(1, Math.abs(a.x - b.x) + Math.abs(a.y - b.y)) });
    out.set(l.from, list);
  }
  const sources = input.stations.filter((s) => s.supply > 0 && out.has(s.id));

  // Demand: every reachable accepting station, weighted by its supply (symmetric) or evenly, less with distance.
  const demand = new Map<number, [number, number][]>();
  for (const s of sources) {
    const seen = new Set<number>([s.id]);
    const stack = [s.id];
    while (stack.length) {
      for (const e of out.get(stack.pop()!) ?? []) {
        if (seen.has(e.to)) continue;
        seen.add(e.to);
        stack.push(e.to);
      }
    }
    seen.delete(s.id);
    const dests: [number, number][] = [];
    for (const d of seen) {
      const st = byId.get(d)!;
      if (!st.accepts) continue;
      const base = input.symmetric ? Math.max(1, st.supply) : 1;
      const dist = Math.abs(st.x - s.x) + Math.abs(st.y - s.y);
      dests.push([d, base / (1 + dist / DISTANCE_SCALE)]);
    }
    if (dests.length) demand.set(s.id, dests);
  }

  // Routing: shortest paths (Dijkstra from every station that has links), twice.
  const load = new Map<string, number>();
  const cost = (from: number, e: { to: number; capacity: number; dist: number }, congested: boolean) => {
    if (!congested) return e.dist;
    const over = (load.get(`${from}>${e.to}`) ?? 0) / Math.max(1, e.capacity);
    return e.dist * (1 + Math.max(0, over - 0.75) * 2);
  };
  const tree = (src: number, congested: boolean) => {
    const dist = new Map<number, number>([[src, 0]]);
    const first = new Map<number, number>();
    const prev = new Map<number, number>();
    const done = new Set<number>();
    const queue = new MinHeap();
    queue.push(0, src);
    while (queue.size) {
      const d = queue.peekKey();
      const u = queue.pop();
      if (done.has(u)) continue;
      done.add(u);
      for (const e of out.get(u) ?? []) {
        const nd = d + cost(u, e, congested);
        if (nd < (dist.get(e.to) ?? Infinity)) {
          dist.set(e.to, nd);
          prev.set(e.to, u);
          first.set(e.to, u === src ? e.to : first.get(u)!);
          queue.push(nd, e.to);
        }
      }
    }
    return { first, prev };
  };
  const nodes = [...out.keys()];
  for (const congested of [false, true]) {
    const trees = new Map(nodes.map((n) => [n, tree(n, congested)]));
    if (!congested) {
      // Assign each source's supply along its paths to estimate link loads.
      for (const s of sources) {
        const dests = demand.get(s.id) ?? [];
        const total = dests.reduce((a, [, w]) => a + w, 0);
        const t = trees.get(s.id)!;
        for (const [d, w] of dests) {
          const vol = (s.supply * w) / Math.max(1e-9, total);
          for (let v = d; v !== s.id && t.prev.has(v); v = t.prev.get(v)!) {
            const k = `${t.prev.get(v)}>${v}`;
            load.set(k, (load.get(k) ?? 0) + vol);
          }
        }
      }
      continue;
    }
    const nextHop: [number, [number, number][]][] = [];
    for (const [n, t] of trees) {
      const hops: [number, number][] = [];
      for (const [d, h] of t.first) hops.push([d, h]);
      if (hops.length) nextHop.push([n, hops]);
    }
    return { cargo: input.cargo, demand: [...demand.entries()], nextHop };
  }
  throw new Error('unreachable');
}
