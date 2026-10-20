import { useMemo } from 'react';
import { CARGOS, FREIGHT_CARGOS, chainTiers, townAcceptsAt, type CargoId, type IndustryType } from '@transportsim/shared';

/** A node: an industry type (`t:<id>`), a cargo (`c:<id>`) or the towns (`towns`). */
export type ChainNode = { key: string; kind: 'type'; type: IndustryType } | { key: string; kind: 'cargo'; cargo: CargoId } | { key: 'towns'; kind: 'towns' };

export interface ChainGraph {
  nodes: Map<string, ChainNode>;
  /** Cargo flows from `from` to `to`: an industry type to a cargo, or a cargo to a type or the towns. */
  edges: { from: string; to: string }[];
  /** Rows of node keys, top (raw materials) to bottom (towns). */
  rows: string[][];
}

/** The production chain of the given industry types, as rows of industries and the cargo between them. */
export function chainGraph(types: readonly IndustryType[]): ChainGraph {
  const tiers = chainTiers(types);
  const nodes = new Map<string, ChainNode>();
  const edges: ChainGraph['edges'] = [];
  const layer = new Map<string, number>();
  for (const t of types) {
    nodes.set(`t:${t.id}`, { key: `t:${t.id}`, kind: 'type', type: t });
    layer.set(`t:${t.id}`, 2 * tiers.get(t.id)!);
  }
  let townsLayer = 0;
  for (const c of FREIGHT_CARGOS) {
    const makers = types.filter((t) => t.produces.includes(c));
    if (!makers.length) continue;
    const key = `c:${c}`;
    nodes.set(key, { key, kind: 'cargo', cargo: c });
    layer.set(key, 2 * Math.max(...makers.map((t) => tiers.get(t.id)!)) + 1);
    for (const t of makers) edges.push({ from: `t:${t.id}`, to: key });
    for (const t of types) if (t.accepts.includes(c)) edges.push({ from: key, to: `t:${t.id}` });
    if (townAcceptsAt(c) !== undefined) {
      edges.push({ from: key, to: 'towns' });
      townsLayer = Math.max(townsLayer, layer.get(key)! + 1);
    }
  }
  nodes.set('towns', { key: 'towns', kind: 'towns' });
  layer.set('towns', townsLayer);
  const rows: string[][] = [];
  for (const key of nodes.keys()) (rows[layer.get(key)!] ??= []).push(key);
  return { nodes, edges, rows: rows.filter((r) => r?.length) };
}

const TYPE_W = 88;
const TYPE_H = 38;
const CARGO_W = 68;
const CARGO_H = 22;
/** Width kept clear for a link passing through a row. */
const PASS_W = 8;
const GAP_X = 6;
const GAP_Y = 26;

interface Placed {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Layout {
  at: Map<string, Placed>;
  /** For each edge, the points it passes through between its ends (one per row it crosses). */
  via: { x: number; top: number; bottom: number }[][];
  width: number;
  height: number;
}

/**
 * Place the rows (layered layout): a link that skips rows gets a waypoint in each row it
 * crosses, so it runs between the boxes rather than behind them, and each row is ordered to keep
 * links short (a few passes of the barycentre heuristic).
 */
function layout(g: ChainGraph): Layout {
  const rowOf = new Map<string, number>();
  g.rows.forEach((r, i) => r.forEach((k) => rowOf.set(k, i)));
  const rows = g.rows.map((r) => [...r]);
  const sizeOf = new Map<string, { w: number; h: number }>();
  for (const n of g.nodes.values()) sizeOf.set(n.key, n.kind === 'cargo' ? { w: CARGO_W, h: CARGO_H } : { w: TYPE_W, h: TYPE_H });
  // Each edge as a chain of items, one per row, from its source to its target.
  const chains = g.edges.map((e, i) => {
    const chain = [e.from];
    for (let r = rowOf.get(e.from)! + 1; r < rowOf.get(e.to)!; r++) {
      const key = `pass:${i}:${r}`;
      rows[r]!.push(key);
      sizeOf.set(key, { w: PASS_W, h: 0 });
      chain.push(key);
    }
    chain.push(e.to);
    return chain;
  });
  const up = new Map<string, string[]>();
  const down = new Map<string, string[]>();
  for (const chain of chains) {
    for (let j = 1; j < chain.length; j++) {
      (up.get(chain[j]!) ?? up.set(chain[j]!, []).get(chain[j]!)!).push(chain[j - 1]!);
      (down.get(chain[j - 1]!) ?? down.set(chain[j - 1]!, []).get(chain[j - 1]!)!).push(chain[j]!);
    }
  }
  const rowWidth = (row: string[]) => row.reduce((s, k) => s + sizeOf.get(k)!.w + GAP_X, -GAP_X);
  const width = Math.max(...rows.map(rowWidth));
  const at = new Map<string, Placed>();
  const rowTop: number[] = [];
  const rowHeight: number[] = [];
  const place = () => {
    let y = 0;
    rows.forEach((row, r) => {
      const rowH = Math.max(...row.map((k) => sizeOf.get(k)!.h));
      let x = (width - rowWidth(row)) / 2;
      for (const k of row) {
        const { w, h } = sizeOf.get(k)!;
        at.set(k, { x, y: y + (rowH - h) / 2, w, h });
        x += w + GAP_X;
      }
      rowTop[r] = y;
      rowHeight[r] = rowH;
      y += rowH + GAP_Y;
    });
    return y - GAP_Y;
  };
  const centre = (k: string) => at.get(k)!.x + at.get(k)!.w / 2;
  const sortBy = (row: string[], linked: Map<string, string[]>) => {
    const key = new Map<string, number>();
    for (const k of row) {
      const ns = linked.get(k) ?? [];
      key.set(k, ns.length ? ns.reduce((s, n) => s + centre(n), 0) / ns.length : centre(k));
    }
    row.sort((a, b) => key.get(a)! - key.get(b)!);
  };
  place();
  for (let pass = 0; pass < 4; pass++) {
    for (let r = 1; r < rows.length; r++) {
      sortBy(rows[r]!, up);
      place();
    }
    for (let r = rows.length - 2; r >= 0; r--) {
      sortBy(rows[r]!, down);
      place();
    }
  }
  const height = place();
  const via = chains.map((chain) =>
    chain.slice(1, -1).map((k) => {
      const r = Number(k.split(':')[2]);
      return { x: centre(k), top: rowTop[r]!, bottom: rowTop[r]! + rowHeight[r]! };
    }),
  );
  return { at, via, width, height };
}

/** The edges to highlight for a selected node: what it receives and where it sends it. */
export function linksOf(g: ChainGraph, sel: string | null): Set<number> {
  const out = new Set<number>();
  if (!sel) return out;
  const node = g.nodes.get(sel);
  g.edges.forEach((e, i) => {
    if (e.from === sel || e.to === sel) out.add(i);
  });
  if (node?.kind !== 'cargo') {
    // One step further for industries and towns: who makes their inputs, who takes their outputs.
    const inputs = new Set(g.edges.filter((e) => e.to === sel).map((e) => e.from));
    const outputs = new Set(g.edges.filter((e) => e.from === sel).map((e) => e.to));
    g.edges.forEach((e, i) => {
      if (inputs.has(e.to) || outputs.has(e.from)) out.add(i);
    });
  }
  return out;
}

/** The chain drawn as a diagram: industry types and towns, with the cargo flowing down between them. */
export function ChainDiagram({ graph, counts, selected, onSelect }: { graph: ChainGraph; counts: Map<string, number>; selected: string | null; onSelect: (key: string) => void }) {
  const { at, via, width, height } = useMemo(() => layout(graph), [graph]);
  const lit = linksOf(graph, selected);
  const related = new Set<string>(selected ? [selected] : []);
  for (const i of lit) {
    related.add(graph.edges[i]!.from);
    related.add(graph.edges[i]!.to);
  }
  /** A smooth path down from the bottom of one box to the top of another, through its waypoints. */
  const path = (i: number) => {
    const e = graph.edges[i]!;
    const a = at.get(e.from)!;
    const b = at.get(e.to)!;
    const points = [{ x: a.x + a.w / 2, top: a.y, bottom: a.y + a.h }, ...via[i]!, { x: b.x + b.w / 2, top: b.y, bottom: b.y + b.h }];
    let d = `M${points[0]!.x},${points[0]!.bottom}`;
    for (let j = 1; j < points.length; j++) {
      const p = points[j - 1]!;
      const q = points[j]!;
      const dy = (q.top - p.bottom) / 2;
      d += ` C${p.x},${p.bottom + dy} ${q.x},${q.top - dy} ${q.x},${q.top}`;
      if (j < points.length - 1) d += ` L${q.x},${q.bottom}`;
    }
    return d;
  };
  // Lit edges last, so they draw on top.
  const order = graph.edges.map((_, i) => i).sort((a, b) => Number(lit.has(a)) - Number(lit.has(b)));
  return (
    <div className="chain-scroll">
      <div className="chain" style={{ width, height }}>
        <svg width={width} height={height} aria-hidden="true">
          <defs>
            <marker id="chain-arrow" viewBox="0 0 6 6" refX="5" refY="3" markerWidth="6" markerHeight="6" orient="auto">
              <path d="M0,0 L6,3 L0,6 z" fill="var(--accent)" />
            </marker>
          </defs>
          {order.map((i) => {
            const on = lit.has(i);
            return <path key={i} d={path(i)} fill="none" stroke={on ? 'var(--accent)' : 'var(--line-strong)'} strokeWidth={on ? 2 : 1.25} markerEnd={on ? 'url(#chain-arrow)' : undefined} />;
          })}
        </svg>
        {[...graph.nodes.values()].map((n) => {
          const p = at.get(n.key)!;
          const count = counts.get(n.key) ?? 0;
          const cls = ['chain-node', n.kind === 'cargo' ? 'cargo' : '', selected === n.key ? 'selected' : '', selected && !related.has(n.key) ? 'dim' : '', n.kind !== 'cargo' && count === 0 ? 'absent' : ''].join(' ');
          const name = n.kind === 'type' ? n.type.name : n.kind === 'cargo' ? CARGOS[n.cargo].name : 'Towns';
          return (
            <button
              key={n.key}
              className={cls}
              style={{ left: p.x, top: p.y, width: p.w, height: p.h }}
              aria-pressed={selected === n.key}
              title={n.kind === 'cargo' ? name : `${name}: ${count} on the map`}
              onClick={() => onSelect(n.key)}
            >
              {n.kind === 'cargo' && <span className="cargo-dot" style={{ background: CARGOS[n.cargo].color }} />}
              <span>{name}</span>
              {n.kind !== 'cargo' && <span className="chain-count">×{count}</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
}
