import { CARGOS, cargoAmount, cargoDestinations, cargoSources, industryType, transportedShare, type CargoId, type RouteEnd } from '@transportsim/shared';
import { client } from '../net/client.ts';
import { openWindow, useApp, type GameWindow } from '../store.ts';
import { RouteEndRow } from './CargoWindow.tsx';
import { Win, focusOn, useTick } from './windows.tsx';

/** Nearest places listed for each cargo an industry takes or makes. */
const NEAREST = 3;

/** What an industry produces and accepts, how much of it was carried last month, and where to bring it from or take it to. */
export function IndustryWindow({ w }: { w: GameWindow & { kind: 'industry' } }) {
  useTick(1000);
  useApp((s) => s.global?.date);
  const ind = client.world?.state.industries.get(w.id);
  if (!ind) {
    return (
      <Win w={w} title="Industry">
        <p className="muted">This industry has closed.</p>
      </Win>
    );
  }
  const type = industryType(ind.type)!;
  const primary = type.production > 0;
  const industries = [...client.world!.state.industries.values()];
  const towns = [...client.world!.state.towns.values()];
  return (
    <Win w={w} title={ind.name} width={360}>
      {type.produces.length > 0 && (
        <>
          <h4 style={{ marginTop: 0 }}>Production last month</h4>
          {type.produces.map((c) => (
            <div className="list-row" key={c}>
              <span className="cargo-dot" style={{ background: CARGOS[c].color }} />
              <span style={{ flex: 1 }}>{cargoAmount(c, ind.lastProduced[c] ?? 0)}</span>
              <span className="muted small">{Math.round(transportedShare(ind, c) * 100)}% transported</span>
            </div>
          ))}
          {primary && <p className="muted small">Production level {ind.level.toFixed(2)}×. Good service makes industries grow.</p>}
          {!primary && <p className="muted small">Makes its output from the cargo delivered to it.</p>}
        </>
      )}
      {type.accepts.length > 0 && (
        <>
          <h4>Accepts</h4>
          {type.accepts.map((c) => (
            <div className="list-row" key={c}>
              <span className="cargo-dot" style={{ background: CARGOS[c].color }} />
              <span style={{ flex: 1 }}>{CARGOS[c].name}</span>
              <span className="muted small">{cargoAmount(c, ind.lastDelivered[c] ?? 0)} last month</span>
            </div>
          ))}
        </>
      )}
      {type.accepts.length > 0 && (
        <>
          <h4>Bring input from</h4>
          {type.accepts.map((c) => (
            <RouteList key={c} cargo={c} ends={cargoSources(ind, c, industries, NEAREST)} none="Nothing on the map makes it." />
          ))}
        </>
      )}
      {type.produces.length > 0 && (
        <>
          <h4>Send output to</h4>
          {type.produces.map((c) => (
            <RouteList key={c} cargo={c} ends={cargoDestinations(ind, c, industries, towns, NEAREST)} none="Nothing on the map takes it yet." />
          ))}
        </>
      )}
      <button className="ghost" style={{ marginTop: 10, width: '100%' }} onClick={() => openWindow({ kind: 'cargo', id: 0, select: `t:${type.id}` })}>
        ⛓ Cargo chain
      </button>
      <button className="ghost" style={{ marginTop: 6, width: '100%' }} onClick={() => focusOn(ind.x + Math.floor(ind.w / 2), ind.y + Math.floor(ind.h / 2))}>
        ⌖ Locate
      </button>
    </Win>
  );
}

/** A cargo and the nearest places it comes from or goes to. */
function RouteList({ cargo, ends, none }: { cargo: CargoId; ends: RouteEnd[]; none: string }) {
  return (
    <div style={{ marginBottom: 6 }}>
      <div className="small">
        <span className="cargo-dot" style={{ background: CARGOS[cargo].color }} /> {CARGOS[cargo].name}
      </div>
      {ends.length === 0 && <p className="muted small" style={{ margin: '2px 0' }}>{none}</p>}
      {ends.map((e) => (
        <RouteEndRow key={`${e.kind}:${e.id}`} end={e} />
      ))}
    </div>
  );
}
