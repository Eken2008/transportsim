import { CARGOS, cargoAmount, industryType, transportedShare } from '@transportsim/shared';
import { client } from '../net/client.ts';
import { useApp, type GameWindow } from '../store.ts';
import { Win, focusOn, useTick } from './windows.tsx';

/** What an industry produces and accepts, and how much of it was carried last month. */
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
      <button className="ghost" style={{ marginTop: 10, width: '100%' }} onClick={() => focusOn(ind.x + Math.floor(ind.w / 2), ind.y + Math.floor(ind.h / 2))}>
        ⌖ Locate
      </button>
    </Win>
  );
}
