import { JUMP_CONDITIONS, type JumpCondition, type JumpOrder, type Order, type TrainInfo } from '@transportsim/shared';
import { client } from '../net/client.ts';
import { useApp } from '../store.ts';
import { act } from './windows.tsx';

const COND_LABELS: Record<JumpCondition, string> = {
  always: 'always',
  load: 'load (%)',
  age: 'age (years)',
  reliability: 'reliability (%)',
  service: 'needs service',
};

export function orderName(o: Order, index: number): string {
  const w = client.world?.state;
  switch (o.kind) {
    case 'station':
      return w?.stations.get(o.station)?.name ?? `Station #${o.station}`;
    case 'waypoint':
      return `Via ${w?.waypoints.get(o.waypoint)?.name ?? 'waypoint'}`;
    case 'depot':
      return 'Service at nearest depot';
    case 'jump':
      return o.cond === 'always'
        ? `Jump to order ${o.to + 1}`
        : `Jump to order ${o.to + 1} if ${COND_LABELS[o.cond].replace(/ \(.*\)/, '')}${o.cond === 'service' ? '' : ` ${o.op === 'ge' ? '≥' : '<'} ${o.value ?? 0}`}`;
  }
  return `Order ${index + 1}`;
}

/** Orders without index `k`: jumps after it move up; jumps to it go to the order that takes its place. */
function removeAt(orders: Order[], k: number): Order[] {
  const out = orders.filter((_, i) => i !== k);
  return out.map((o) => (o.kind === 'jump' ? { ...o, to: Math.min(o.to > k ? o.to - 1 : o.to, Math.max(0, out.length - 1)) } : o));
}

/** Orders with `i` and `j` swapped, jump targets following their orders. */
function swapAt(orders: Order[], i: number, j: number): Order[] {
  const out = orders.slice();
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out.map((o) => (o.kind === 'jump' ? { ...o, to: o.to === i ? j : o.to === j ? i : o.to } : o));
}

/** A number field that commits on blur or Enter. */
function NumberField({ value, onCommit, label, width = 52 }: { value: number | undefined; onCommit: (v: number | undefined) => void; label: string; width?: number }) {
  return (
    <input
      key={value ?? ''}
      type="number"
      min={0}
      step={0.5}
      aria-label={label}
      title={label}
      defaultValue={value ?? ''}
      placeholder="–"
      style={{ width }}
      onBlur={(e) => {
        const v = e.target.value === '' ? undefined : Number(e.target.value);
        if (v !== value) onCommit(v);
      }}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}

/** Orders and timetable of a train: stations, waypoints, depot visits and conditional jumps. */
export function OrdersEditor({ t, mine, warn }: { t: TrainInfo; mine: boolean; warn: (o: Order) => React.ReactNode }) {
  const editing = useApp((s) => s.ordersFor === t.id);
  const setOrders = (orders: Order[]) => act({ type: 'setOrders', id: t.id, orders });
  const patch = (i: number, p: Partial<Order>) => setOrders(t.orders.map((o, k) => (k === i ? ({ ...o, ...p } as Order) : o)));
  const timetabled = t.orders.some((o) => o.kind !== 'jump' && (o.travel || (o.kind === 'station' && o.wait)));
  const total = t.orders.reduce((s, o) => s + (o.kind !== 'jump' ? (o.travel ?? 0) + (o.kind === 'station' ? (o.wait ?? 0) : 0) : 0), 0);

  return (
    <>
      <div className="row" style={{ marginTop: 14 }}>
        <h4 style={{ margin: 0, flex: 1 }}>Orders</h4>
        {timetabled && (
          <span className={`small ${t.lateness && t.lateness > 0.5 ? 'neg' : 'muted'}`} title="Against the timetabled travel times">
            {t.lateness === undefined ? '' : Math.abs(t.lateness) < 0.5 ? 'on time · ' : t.lateness > 0 ? `${t.lateness} d late · ` : `${-t.lateness} d early · `}
            round trip {total.toFixed(1)} d
          </span>
        )}
        {mine && (
          <button
            className={`ghost small ${t.autofill ? 'active-text' : ''}`}
            title="Record travel times into the timetable as the train runs"
            aria-pressed={!!t.autofill}
            onClick={() => act({ type: 'trainAction', id: t.id, action: 'autofill' })}
          >
            ⏱ {t.autofill ? 'Recording…' : 'Autofill'}
          </button>
        )}
      </div>
      {t.orders.length === 0 && <p className="muted">No orders yet. Add the stations this train should serve.</p>}
      <ol className="orders">
        {t.orders.map((o, i) => (
          <li key={i} className={`${i === t.orderIndex ? 'current' : ''} kind-${o.kind}`}>
            <div className="order-main">
              <span className="order-name">
                {orderName(o, i)}
                {warn(o)}
              </span>
              {mine && (
                <>
                  <button className="ghost small" disabled={i === 0} aria-label="Move up" onClick={() => setOrders(swapAt(t.orders, i, i - 1))}>
                    ↑
                  </button>
                  <button className="ghost small" aria-label="Remove order" onClick={() => setOrders(removeAt(t.orders, i))}>
                    ✕
                  </button>
                </>
              )}
            </div>
            {o.kind !== 'jump' && (mine || o.travel || (o.kind === 'station' && (o.wait || o.fullLoad))) && (
              <div className="order-detail small">
                {o.kind === 'station' &&
                  (mine ? (
                    <label className="row" title="Wait until full before leaving">
                      <input type="checkbox" checked={!!o.fullLoad} onChange={(e) => patch(i, { fullLoad: e.target.checked || undefined })} />
                      full load
                    </label>
                  ) : (
                    o.fullLoad && <span>full load</span>
                  ))}
                {o.kind === 'station' &&
                  (mine ? (
                    <label className="row" title="Stay at least this many days">
                      wait <NumberField value={o.wait} label="Wait (days)" onCommit={(v) => patch(i, { wait: v })} /> d
                    </label>
                  ) : (
                    o.wait && <span>wait {o.wait} d</span>
                  ))}
                {mine ? (
                  <label className="row" title="Timetabled travel time to here from the previous order">
                    travel <NumberField value={o.travel} label="Travel (days)" onCommit={(v) => patch(i, { travel: v })} /> d
                  </label>
                ) : (
                  o.travel && <span>travel {o.travel} d</span>
                )}
              </div>
            )}
            {o.kind === 'jump' && mine && <JumpEditor o={o} count={t.orders.length} onChange={(p) => patch(i, p)} />}
          </li>
        ))}
      </ol>
      {mine && (
        <div className="row wrap">
          <button
            className={editing ? 'primary' : ''}
            style={{ flex: 1 }}
            onClick={() => (editing ? useApp.setState({ ordersFor: null, tool: null }) : useApp.setState({ ordersFor: t.id, tool: 'orders' }))}
          >
            {editing ? 'Done adding' : '+ Add stations, waypoints, depots (click them)'}
          </button>
          <button title="Visit the nearest depot for a service, then carry on" onClick={() => setOrders([...t.orders, { kind: 'depot' }])}>
            + Service
          </button>
          <button
            title="Jump to another order when a condition holds"
            disabled={t.orders.length === 0}
            onClick={() => setOrders([...t.orders, { kind: 'jump', to: 0, cond: 'load', op: 'lt', value: 50 }])}
          >
            + Jump
          </button>
        </div>
      )}
    </>
  );
}

function JumpEditor({ o, count, onChange }: { o: JumpOrder; count: number; onChange: (p: Partial<JumpOrder>) => void }) {
  return (
    <div className="order-detail small">
      to
      <select value={o.to} onChange={(e) => onChange({ to: Number(e.target.value) })} aria-label="Jump to order">
        {Array.from({ length: count }, (_, k) => (
          <option key={k} value={k}>
            {k + 1}
          </option>
        ))}
      </select>
      if
      <select value={o.cond} onChange={(e) => onChange({ cond: e.target.value as JumpCondition })} aria-label="Condition">
        {JUMP_CONDITIONS.map((c) => (
          <option key={c} value={c}>
            {COND_LABELS[c]}
          </option>
        ))}
      </select>
      {o.cond !== 'always' && o.cond !== 'service' && (
        <>
          <select value={o.op ?? 'lt'} onChange={(e) => onChange({ op: e.target.value as 'lt' | 'ge' })} aria-label="Comparison">
            <option value="lt">&lt;</option>
            <option value="ge">≥</option>
          </select>
          <NumberField value={o.value} label="Value" onCommit={(v) => onChange({ value: v ?? 0 })} />
        </>
      )}
    </div>
  );
}
