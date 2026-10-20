import { useState } from 'react';
import { CARGOS, FREIGHT_CARGOS, cargoAmount, cargoChain, cargoDestinations, industryType, townAcceptsAt, transportedShare, type CargoId, type RouteEnd } from '@transportsim/shared';
import { client } from '../net/client.ts';
import { openWindow, useApp, type GameWindow } from '../store.ts';
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

/** How many alternatives to list after the nearest destination. */
const OTHERS = 2;

/** Every freight cargo: which industries make it, where it can go, and the nearest destination for each producer. */
export function CargoWindow({ w }: { w: GameWindow & { kind: 'cargo' } }) {
  useTick(2000);
  useApp((s) => s.global?.date);
  const [cargo, setCargo] = useState<CargoId>('coal');
  const state = client.world?.state;
  const industries = [...(state?.industries.values() ?? [])];
  const towns = [...(state?.towns.values() ?? [])];
  const chain = cargoChain(cargo);
  const count = (id: string) => industries.filter((i) => i.type === id).length;
  const need = townAcceptsAt(cargo);

  const routes = industries
    .filter((i) => industryType(i.type)?.produces.includes(cargo))
    .map((ind) => ({ ind, to: cargoDestinations(ind, cargo, industries, towns, 1 + OTHERS) }))
    .sort((a, b) => (a.to[0]?.dist ?? Infinity) - (b.to[0]?.dist ?? Infinity));

  return (
    <Win w={w} title="Cargo routes" width={430}>
      <div className="row" style={{ flexWrap: 'wrap', gap: 4 }}>
        {FREIGHT_CARGOS.map((c) => (
          <button key={c} className={c === cargo ? 'primary small' : 'small'} aria-pressed={c === cargo} onClick={() => setCargo(c)}>
            <span className="cargo-dot" style={{ background: CARGOS[c].color }} /> {CARGOS[c].name}
          </button>
        ))}
      </div>
      <p className="small" style={{ marginBottom: 0 }}>
        <b>Made by</b> {chain.producers.map((t) => `${t.name} (${count(t.id)})`).join(', ') || 'nothing'}
      </p>
      <p className="small" style={{ marginTop: 4 }}>
        <b>Taken by</b>{' '}
        {[...chain.acceptors.map((t) => `${t.name} (${count(t.id)})`), ...(need !== undefined ? [`towns with ${need}+ residents near a station`] : [])].join(', ') || 'nothing'}
      </p>
      <h4>Routes from each producer, shortest first</h4>
      {routes.length === 0 && <p className="muted small">Nothing on the map makes {CARGOS[cargo].name.toLowerCase()}.</p>}
      {routes.map(({ ind, to }) => {
        const made = ind.lastProduced[cargo] ?? 0;
        const [best, ...others] = to;
        const from = { kind: 'industry' as const, id: ind.id, x: ind.x + Math.floor(ind.w / 2), y: ind.y + Math.floor(ind.h / 2) };
        return (
          <div key={ind.id} className="list-row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 2 }}>
            <div className="row" style={{ gap: 6 }}>
              <button className="link" style={{ textAlign: 'left' }} onClick={() => show(from)}>
                {ind.name}
              </button>
              <span>→</span>
              {best ? (
                <button className="link" style={{ textAlign: 'left', flex: 1 }} onClick={() => show(best)}>
                  {best.name}
                </button>
              ) : (
                <span className="muted" style={{ flex: 1 }}>
                  nowhere takes it yet
                </span>
              )}
              {best && <span className="muted small">{best.dist} tiles</span>}
            </div>
            <div className="muted small">
              {made > 0 && `${cargoAmount(cargo, made)} last month, ${Math.round(transportedShare(ind, cargo) * 100)}% transported. `}
              {others.length > 0 && `Also: ${others.map((o) => `${o.name} (${o.dist})`).join(', ')}`}
            </div>
          </div>
        );
      })}
      <p className="muted small">Deliveries pay by distance, so a longer route earns more per load if it stays quick.</p>
    </Win>
  );
}
