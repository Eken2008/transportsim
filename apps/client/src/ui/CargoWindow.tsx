import { useEffect, useMemo, useState } from 'react';
import {
  CARGOS,
  cargoAmount,
  cargoDestinations,
  cargoSources,
  climateCargos,
  eventsFor,
  formatPrice,
  industryType,
  townAcceptsAt,
  transportedShare,
  typesFor,
  ymdFromDays,
  type CargoId,
  type Climate,
  type Industry,
  type RouteEnd,
} from '@transportsim/shared';
import { client } from '../net/client.ts';
import { openWindow, useApp, type GameWindow } from '../store.ts';
import { ChainDiagram, chainGraph, type ChainGraph } from './ChainDiagram.tsx';
import { Win, focusOn, useTick } from './windows.tsx';

/** Open an industry's or town's window and look at it. */
function show(end: { kind: 'industry' | 'town'; id: number; x: number; y: number }): void {
  openWindow({ kind: end.kind, id: end.id });
  focusOn(end.x, end.y);
}

/** A place to carry cargo from or to: its name (opens it) and how far away it is. */
export function RouteEndRow({ end }: { end: RouteEnd }) {
  return (
    <div className="list-row">
      <span className="muted small" style={{ width: 14 }}>{end.kind === 'town' ? '🏠' : '🏭'}</span>
      <button className="link" style={{ flex: 1, textAlign: 'left' }} onClick={() => show(end)}>
        {end.name}
      </button>
      <span className="muted small">{end.dist} tiles</span>
    </div>
  );
}

const asEnd = (ind: Industry): RouteEnd => ({ kind: 'industry', id: ind.id, name: ind.name, x: ind.x + Math.floor(ind.w / 2), y: ind.y + Math.floor(ind.h / 2), dist: 0 });

/** How many alternatives to list after the nearest one. */
const OTHERS = 2;

/** One suggested route: an industry and the nearest places to send its cargo to (or, for one that makes nothing, to bring it from). */
interface RouteRow {
  ind: Industry;
  cargo: CargoId;
  send: boolean;
  ends: RouteEnd[];
}

const names = (list: readonly string[]) => (list.length ? list.join(', ') : 'nothing on the map');

/** What the selected node takes and gives, in words. */
function describe(g: ChainGraph, key: string, climate: Climate): string {
  const node = g.nodes.get(key);
  if (!node) return '';
  const nameOf = (k: string) => {
    const n = g.nodes.get(k)!;
    return n.kind === 'type' ? n.type.name : n.kind === 'cargo' ? CARGOS[n.cargo].name : 'towns';
  };
  const into = (k: string) => g.edges.filter((e) => e.to === k).map((e) => e.from);
  const outOf = (k: string) => g.edges.filter((e) => e.from === k).map((e) => e.to);
  if (node.kind === 'cargo') return `${CARGOS[node.cargo].name} is made by ${names(into(key).map(nameOf))} and taken by ${names(outOf(key).map(nameOf))}.`;
  const takes = into(key).map((c) => `${nameOf(c).toLowerCase()} from ${names(into(c).map(nameOf))}`);
  const sends = outOf(key).map((c) => `${nameOf(c).toLowerCase()} to ${names(outOf(c).map(nameOf))}`);
  const who = node.kind === 'towns' ? 'Towns' : node.type.name;
  const parts = [takes.length ? `takes ${takes.join('; ')}` : '', sends.length ? `sends ${sends.join('; ')}` : ''].filter(Boolean);
  const needs = climateCargos(climate).flatMap((c) => {
    const n = townAcceptsAt(c);
    return n === undefined ? [] : [`${n} for ${CARGOS[c].name.toLowerCase()}`];
  });
  const extra = node.kind === 'towns' ? ` A station needs residents in reach: ${needs.join(', ')}.` : '';
  return `${who} ${parts.join(', and ')}.${extra}`;
}

/** What a cargo pays on the market now, and the world events moving its price. */
function CargoPrice({ cargo }: { cargo: CargoId }) {
  const m = useApp((s) => s.global?.market);
  const on = useApp((s) => s.room?.settings.dynamicPrices ?? true);
  if (!on || !m) return null;
  const price = m.cargos[cargo]?.price ?? 1;
  const events = eventsFor(m.events, cargo);
  return (
    <p className="small">
      {CARGOS[cargo].name} pays <b className={price >= 1.005 ? 'pos' : price <= 0.995 ? 'neg' : undefined}>{formatPrice(price)}</b> of its normal rate now.
      {events.map((e) => ` ${e.text}.`).join('')}{' '}
      <button className="link" onClick={() => openWindow({ kind: 'stats', id: 0, tab: 'market' })}>
        Market
      </button>
    </p>
  );
}

/** The production chain as a diagram, and for the selected part of it, the nearest places to carry cargo between. */
export function CargoWindow({ w }: { w: GameWindow & { kind: 'cargo' } }) {
  useTick(2000);
  const date = useApp((s) => s.global?.date ?? 0);
  const climate = useApp((s) => s.room?.settings.climate ?? 'temperate');
  const [sel, setSel] = useState<string>(w.select ?? `c:${climateCargos(climate).find((c) => c !== 'passengers' && c !== 'mail')}`);
  useEffect(() => {
    if (w.select) setSel(w.select);
  }, [w.select]);
  const state = client.world?.state;
  const industries = [...(state?.industries.values() ?? [])];
  const towns = [...(state?.towns.values() ?? [])];
  const year = ymdFromDays(date).year;
  // Types that exist this year, or on the map from a save.
  const typeKey = [...new Set([...typesFor(year, climate).map((t) => t.id), ...industries.map((i) => i.type)])].sort().join();
  const graph = useMemo(() => chainGraph(typeKey.split(',').flatMap((id) => industryType(id) ?? [])), [typeKey]);
  const counts = new Map<string, number>([['towns', towns.length]]);
  for (const i of industries) counts.set(`t:${i.type}`, (counts.get(`t:${i.type}`) ?? 0) + 1);

  const node = graph.nodes.get(sel);
  const rows: RouteRow[] = [];
  const sendFrom = (ind: Industry, cargo: CargoId) => rows.push({ ind, cargo, send: true, ends: cargoDestinations(ind, cargo, industries, towns, 1 + OTHERS) });
  if (node?.kind === 'cargo') {
    for (const ind of industries) if (industryType(ind.type)?.produces.includes(node.cargo)) sendFrom(ind, node.cargo);
  } else if (node?.kind === 'towns') {
    for (const ind of industries) for (const c of industryType(ind.type)?.produces ?? []) if (townAcceptsAt(c) !== undefined) sendFrom(ind, c);
  } else if (node?.kind === 'type') {
    for (const ind of industries) {
      if (ind.type !== node.type.id) continue;
      for (const c of node.type.produces) sendFrom(ind, c);
      // An industry that makes nothing (a power station): where to bring its input from instead.
      if (!node.type.produces.length) for (const c of node.type.accepts) rows.push({ ind, cargo: c, send: false, ends: cargoSources(ind, c, industries, 1 + OTHERS) });
    }
  }
  rows.sort((a, b) => (a.ends[0]?.dist ?? Infinity) - (b.ends[0]?.dist ?? Infinity));
  const mixed = new Set(rows.map((r) => r.cargo)).size > 1;

  return (
    <Win w={w} title="Cargo routes" width={510}>
      <p className="muted small" style={{ marginTop: 0 }}>
        Cargo flows down the chain. Click an industry, cargo or the towns to see what it takes and where it goes.
      </p>
      <ChainDiagram graph={graph} counts={counts} selected={sel} onSelect={setSel} />
      <p className="small">{describe(graph, sel, climate)}</p>
      {node?.kind === 'cargo' && <CargoPrice cargo={node.cargo} />}
      <h4>Nearest routes, shortest first</h4>
      {rows.length === 0 && <p className="muted small">None of these on the map yet.</p>}
      {rows.map(({ ind, cargo, send, ends }) => {
        const [best, ...others] = ends;
        const made = send ? (ind.lastProduced[cargo] ?? 0) : 0;
        const here = (
          <button className="link" style={{ textAlign: 'left' }} onClick={() => show(asEnd(ind))}>
            {ind.name}
          </button>
        );
        const there = best ? (
          <button className="link" style={{ textAlign: 'left' }} onClick={() => show(best)}>
            {best.name}
          </button>
        ) : (
          <span className="muted">{send ? 'nowhere takes it yet' : 'nothing makes it yet'}</span>
        );
        return (
          <div key={`${ind.id}:${cargo}`} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2 }}>
            <div className="row" style={{ gap: 6 }}>
              {mixed && <span className="cargo-dot" title={CARGOS[cargo].name} style={{ background: CARGOS[cargo].color }} />}
              {send ? here : there}
              <span>→</span>
              {send ? there : here}
              <span className="spacer" />
              {best && <span className="muted small">{best.dist} tiles</span>}
            </div>
            {(made > 0 || others.length > 0) && (
              <div className="muted small">
                {made > 0 && `${cargoAmount(cargo, made)} last month, ${Math.round(transportedShare(ind, cargo) * 100)}% transported. `}
                {others.length > 0 && `Also ${send ? 'to' : 'from'} ${others.map((o) => `${o.name} (${o.dist})`).join(', ')}`}
              </div>
            )}
          </div>
        );
      })}
      <p className="muted small">Deliveries pay by distance, so a longer route earns more per load if it stays quick.</p>
    </Win>
  );
}
