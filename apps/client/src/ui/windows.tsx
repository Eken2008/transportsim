import {
  MAX_TRAIN_LENGTH,
  RAIL_VEHICLES,
  cargoCount,
  isAvailable,
  railVehicle,
  roleAllows,
  segTile,
  trainStats,
  ymdFromDays,
  type CompanyRole,
  type TrainInfo,
} from '@transportsim/shared';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { client } from '../net/client.ts';
import { closeWindow, openWindow, toast, useApp, windowKey, type GameWindow } from '../store.ts';
import { formatMoney } from './format.ts';
import { catchmentRect, residentsIn } from '../game/catchment.ts';
import { CompanyWindow } from './CompanyWindow.tsx';
import { NewsWindow } from './NewsWindow.tsx';
import { FinancesWindow, LeagueWindow } from './FinancesWindow.tsx';

/** Re-render periodically (for live values read from the non-reactive world mirror). */
export function useTick(ms: number): void {
  const [, set] = useState(0);
  useEffect(() => {
    const id = setInterval(() => set((n) => n + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

function useMyCompany(): number | null {
  return useMyRole().companyId;
}

/** The local player's company and role in it. */
export function useMyRole(): { companyId: number | null; role: CompanyRole | null } {
  const room = useApp((s) => s.room);
  const global = useApp((s) => s.global);
  const me = global?.players.find((p) => p.id === room?.playerId);
  const company = global?.companies.find((c) => c.id === me?.companyId);
  const role = (me && company?.members.find((m) => m.name === me.name)?.role) || null;
  return { companyId: company ? company.id : null, role };
}

export function act(cmd: Parameters<typeof client.command>[0]): void {
  void client.command(cmd).then((r) => {
    if (!r.ok && r.error) toast(r.error, 'error');
  });
}

export function focusOn(x: number, y: number): void {
  useApp.setState((s) => ({ focus: { x, y, seq: (s.focus?.seq ?? 0) + 1 } }));
}

// ---- window shell ------------------------------------------------------------

let zTop = 10;

export function Win({ w, title, children, width = 340 }: { w: GameWindow; title: ReactNode; children: ReactNode; width?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(() => {
    const n = useApp.getState().windows.length;
    return { x: 70 + (n % 6) * 28, y: 80 + (n % 6) * 28 };
  });
  const [z, setZ] = useState(() => ++zTop);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  return (
    <div
      ref={ref}
      className="panel window"
      style={{ left: pos.x, top: pos.y, width, zIndex: z }}
      onPointerDown={() => setZ(++zTop)}
      role="dialog"
      aria-label={typeof title === 'string' ? title : undefined}
    >
      <div
        className="window-title"
        onPointerDown={(e) => {
          drag.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
          (e.target as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          const x = Math.max(0, Math.min(window.innerWidth - 80, e.clientX - drag.current.dx));
          const y = Math.max(0, Math.min(window.innerHeight - 40, e.clientY - drag.current.dy));
          setPos({ x, y });
        }}
        onPointerUp={() => (drag.current = null)}
      >
        <span className="window-name">{title}</span>
        <button className="ghost" aria-label="Close" onClick={() => closeWindow(w)}>
          ✕
        </button>
      </div>
      <div className="window-body">{children}</div>
    </div>
  );
}

export function WindowLayer() {
  const windows = useApp((s) => s.windows);
  return (
    <>
      {windows.map((w) => {
        const key = windowKey(w);
        switch (w.kind) {
          case 'train':
            return <TrainWindow key={key} w={w} />;
          case 'depot':
            return <DepotWindow key={key} w={w} />;
          case 'station':
            return <StationWindow key={key} w={w} />;
          case 'trains':
            return <TrainListWindow key={key} w={w} />;
          case 'company':
            return <CompanyWindow key={key} w={w} />;
          case 'news':
            return <NewsWindow key={key} w={w} />;
          case 'finances':
            return <FinancesWindow key={key} w={w} />;
          case 'league':
            return <LeagueWindow key={key} w={w} />;
        }
      })}
    </>
  );
}

// ---- trains ------------------------------------------------------------------

function stationName(id: number): string {
  return client.world?.state.stations.get(id)?.name ?? `Station #${id}`;
}

export function trainStatus(t: TrainInfo): string {
  if (t.status === 'depot') return 'In depot';
  if (t.status === 'loading') return `Loading at ${stationName(t.lastStation)}`;
  if (t.status === 'stopped') return 'Stopped';
  if (t.depot >= 0) return 'Waiting to leave the depot';
  if (t.toDepot) return 'Heading for depot';
  const o = t.orders[t.orderIndex];
  if (!o) return 'No orders';
  return o.kind === 'station' ? `Heading to ${stationName(o.station)}` : 'Heading for depot';
}

function useTrain(id: number): TrainInfo | undefined {
  useApp((s) => s.trainsRev);
  return client.world?.trains.get(id);
}

function TrainWindow({ w }: { w: GameWindow & { kind: 'train' } }) {
  useTick(400);
  const t = useTrain(w.id);
  const ordersFor = useApp((s) => s.ordersFor);
  const my = useMyRole();
  const mine = my.companyId === t?.owner && roleAllows(my.role, 'operate');
  const canBuild = mine && roleAllows(my.role, 'build');
  if (!t) {
    return (
      <Win w={w} title="Train">
        <p className="muted">This train no longer exists.</p>
      </Win>
    );
  }
  const stats = trainStats(t.units);
  const motion = client.world?.motions.get(t.id)?.m;
  const aboard = cargoCount(t);
  const editing = ordersFor === t.id;
  const setOrders = (orders: TrainInfo['orders']) => act({ type: 'setOrders', id: t.id, orders });

  return (
    <Win w={w} title={t.name} width={360}>
      <div className="kv">
        <span>Status</span>
        <b>{trainStatus(t)}</b>
        <span>Speed</span>
        <b className="mono">
          {Math.round(motion?.speed ?? 0)} / {stats.maxSpeed} km/h
        </b>
        <span>Passengers</span>
        <b className="mono">
          {aboard} / {stats.capacity}
        </b>
        <span>Profit</span>
        <b className="mono">
          {formatMoney(t.profitThisYear)} <span className="muted">(last year {formatMoney(t.profitLastYear)})</span>
        </b>
        <span>Consist</span>
        <span className="muted">
          {t.units.length} vehicles · {stats.length.toFixed(1)} tiles · {stats.power.toLocaleString()} kW
        </span>
      </div>
      {mine && (
        <div className="row wrap" style={{ marginTop: 10 }}>
          {t.status === 'depot' || t.status === 'stopped' ? (
            <button className="primary" onClick={() => act({ type: 'trainAction', id: t.id, action: 'start' })}>
              ▶ Start
            </button>
          ) : (
            <button onClick={() => act({ type: 'trainAction', id: t.id, action: 'stop' })}>■ Stop</button>
          )}
          {t.status !== 'depot' && (
            <>
              <button onClick={() => act({ type: 'trainAction', id: t.id, action: 'toDepot' })}>{t.toDepot ? 'Cancel depot' : 'Go to depot'}</button>
              <button onClick={() => act({ type: 'trainAction', id: t.id, action: 'reverse' })} title="Only when stopped">
                ⇄ Reverse
              </button>
            </>
          )}
          {t.orders.length > 1 && <button onClick={() => act({ type: 'trainAction', id: t.id, action: 'skip' })}>Skip order</button>}
          {t.status === 'depot' && canBuild && (
            <button className="danger" onClick={() => confirm(`Sell ${t.name}?`) && act({ type: 'trainAction', id: t.id, action: 'sell' })}>
              Sell
            </button>
          )}
          {motion && motion.path.length > 0 && (
            <button
              className="ghost"
              onClick={() => {
                const tile = segTile(motion.path[0]!);
                const width = client.world!.map.width;
                focusOn(tile % width, Math.floor(tile / width));
              }}
            >
              ⌖ Locate
            </button>
          )}
        </div>
      )}
      <ConsistEditor t={t} mine={canBuild} />
      <h4>Orders</h4>
      {t.orders.length === 0 && <p className="muted">No orders yet. Add the stations this train should serve.</p>}
      <ol className="orders">
        {t.orders.map((o, i) => (
          <li key={i} className={i === t.orderIndex ? 'current' : ''}>
            <span className="order-name">{o.kind === 'station' ? stationName(o.station) : 'Go to depot'}</span>
            {mine && o.kind === 'station' && (
              <label className="row small" title="Wait until full before leaving">
                <input
                  type="checkbox"
                  checked={!!o.fullLoad}
                  onChange={(e) => setOrders(t.orders.map((x, k) => (k === i && x.kind === 'station' ? { ...x, fullLoad: e.target.checked } : x)))}
                />
                full load
              </label>
            )}
            {mine && (
              <>
                <button className="ghost small" disabled={i === 0} aria-label="Move up" onClick={() => setOrders(swap(t.orders, i, i - 1))}>
                  ↑
                </button>
                <button className="ghost small" aria-label="Remove order" onClick={() => setOrders(t.orders.filter((_, k) => k !== i))}>
                  ✕
                </button>
              </>
            )}
          </li>
        ))}
      </ol>
      {mine && (
        <button
          className={editing ? 'primary' : ''}
          style={{ width: '100%' }}
          onClick={() =>
            editing ? useApp.setState({ ordersFor: null, tool: null }) : useApp.setState({ ordersFor: t.id, tool: 'orders' })
          }
        >
          {editing ? 'Done adding stations' : '+ Add stations (click them on the map)'}
        </button>
      )}
    </Win>
  );
}

function swap<T>(a: T[], i: number, j: number): T[] {
  const out = a.slice();
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

function DepotWindow({ w }: { w: GameWindow & { kind: 'depot' } }) {
  useApp((s) => s.trainsRev);
  const global = useApp((s) => s.global);
  const settings = useApp((s) => s.room?.settings);
  const my = useMyRole();
  const company = my.companyId;
  const map = client.world?.map;
  const year = global ? ymdFromDays(global.date).year : 1900;
  const timeline = settings?.timeline ?? 'era';
  const engines = RAIL_VEHICLES.filter((v) => v.kind === 'loco' && isAvailable(v, year, timeline));
  const wagons = RAIL_VEHICLES.filter((v) => v.kind === 'wagon' && v.cargo === 'passengers' && isAvailable(v, year, timeline));
  const [engine, setEngine] = useState(engines.at(-1)?.id ?? '');
  const [wagon, setWagon] = useState(wagons.at(-1)?.id ?? '');
  const [count, setCount] = useState(4);
  const units = useMemo(() => [engine, ...Array.from({ length: count }, () => wagon)].filter(Boolean), [engine, wagon, count]);
  const stats = trainStats(units.map((type) => ({ type })));
  const price = units.reduce((s, id) => s + (railVehicle(id)?.cost ?? 0), 0);
  const inDepot = [...(client.world?.trains.values() ?? [])].filter((t) => t.status === 'depot' && t.depot === w.id);
  const x = map ? w.id % map.width : 0;
  const y = map ? Math.floor(w.id / map.width) : 0;
  const ours = map?.layers.owner[w.id] === company;
  const mine = ours && roleAllows(my.role, 'build');
  const canStart = ours && roleAllows(my.role, 'operate');

  return (
    <Win w={w} title={`Train depot (${x}, ${y})`} width={380}>
      <h4 style={{ marginTop: 0 }}>Inside</h4>
      {inDepot.length === 0 && <p className="muted">No trains in this depot.</p>}
      {inDepot.map((t) => (
        <div className="list-row" key={t.id}>
          <b style={{ flex: 1 }}>{t.name}</b>
          <span className="muted small">{t.orders.length} orders</span>
          <button onClick={() => openWindow({ kind: 'train', id: t.id })}>Open</button>
          {canStart && (
            <button className="primary" disabled={t.orders.length === 0} title={t.orders.length ? '' : 'Give it orders first'} onClick={() => act({ type: 'trainAction', id: t.id, action: 'start' })}>
              ▶
            </button>
          )}
        </div>
      ))}
      {mine && (
        <>
          <h4>Buy a train</h4>
          <label className="field">
            <span>Engine</span>
            <select value={engine} onChange={(e) => setEngine(e.target.value)}>
              {engines.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} — {v.maxSpeed} km/h, {v.power} kW, {formatMoney(v.cost)}
                </option>
              ))}
            </select>
          </label>
          <div className="row" style={{ gap: 10 }}>
            <label className="field" style={{ flex: 1 }}>
              <span>Carriages</span>
              <select value={wagon} onChange={(e) => setWagon(e.target.value)}>
                {wagons.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name} — {v.capacity} seats, {v.maxSpeed} km/h
                  </option>
                ))}
              </select>
            </label>
            <label className="field" style={{ width: 80 }}>
              <span>Count</span>
              <input type="number" min={0} max={20} value={count} onChange={(e) => setCount(Math.max(0, Math.min(20, Math.round(+e.target.value))))} />
            </label>
          </div>
          <p className="muted small" style={{ margin: '0 0 10px' }}>
            {stats.capacity} seats · max {stats.maxSpeed} km/h · {stats.length.toFixed(1)} tiles long
            {stats.length > MAX_TRAIN_LENGTH ? ' (too long!)' : ''} · running cost {formatMoney(stats.runningCost)}/yr
          </p>
          <button className="primary" style={{ width: '100%' }} disabled={!engine} onClick={() => act({ type: 'buyTrain', depot: w.id, units })}>
            Buy for {formatMoney(price)}
          </button>
        </>
      )}
    </Win>
  );
}

function StationWindow({ w }: { w: GameWindow & { kind: 'station' } }) {
  useTick(1000);
  useApp((s) => s.trainsRev);
  const st = client.world?.state.stations.get(w.id);
  if (!st) {
    return (
      <Win w={w} title="Station">
        <p className="muted">This station no longer exists.</p>
      </Win>
    );
  }
  const company = client.world?.state.companies.get(st.owner);
  const serving = [...(client.world?.trains.values() ?? [])].filter((t) => t.orders.some((o) => o.kind === 'station' && o.station === st.id));
  const waiting = Object.entries(st.waiting)
    .map(([dest, n]) => ({ dest: Number(dest), n }))
    .sort((a, b) => b.n - a.n);
  return (
    <Win w={w} title={st.name}>
      <div className="kv">
        <span>Owner</span>
        <b>{company?.name ?? '—'}</b>
        <span>Platforms</span>
        <b className="mono">{st.tiles} tiles</b>
        <span>Rating</span>
        <b className="mono">{Math.round((st.rating / 255) * 100)}%</b>
        <span>Waiting</span>
        <b className="mono">{st.waitingTotal} passengers</b>
        <span>Catchment</span>
        <b className="mono">{client.world ? residentsIn(client.world.map, catchmentRect(client.world.map, st)).toLocaleString('en-GB') : 0} residents</b>
      </div>
      <CatchmentToggle id={st.id} />
      {waiting.length > 0 && (
        <ul className="plain small">
          {waiting.slice(0, 8).map((x) => (
            <li key={x.dest}>
              {x.n} → {stationName(x.dest)}
            </li>
          ))}
        </ul>
      )}
      <h4>Trains calling here</h4>
      {serving.length === 0 && <p className="muted">None yet.</p>}
      {serving.map((t) => (
        <div className="list-row" key={t.id}>
          <b style={{ flex: 1 }}>{t.name}</b>
          <span className="muted small">{trainStatus(t)}</span>
          <button onClick={() => openWindow({ kind: 'train', id: t.id })}>Open</button>
        </div>
      ))}
    </Win>
  );
}

function TrainListWindow({ w }: { w: GameWindow & { kind: 'trains' } }) {
  useTick(1000);
  useApp((s) => s.trainsRev);
  const company = useMyCompany();
  const trains = [...(client.world?.trains.values() ?? [])].filter((t) => t.owner === company).sort((a, b) => a.id - b.id);
  return (
    <Win w={w} title="Your trains" width={420}>
      {trains.length === 0 && <p className="muted">No trains yet. Build a depot (7), click it, and buy one.</p>}
      {trains.map((t) => (
        <div className="list-row" key={t.id}>
          <b style={{ width: 70 }}>{t.name}</b>
          <span className="muted small" style={{ flex: 1 }}>
            {trainStatus(t)}
          </span>
          <span className={`mono small ${t.profitThisYear < 0 ? 'neg' : ''}`}>{formatMoney(t.profitThisYear)}</span>
          <button onClick={() => openWindow({ kind: 'train', id: t.id })}>Open</button>
        </div>
      ))}
    </Win>
  );
}

function CatchmentToggle({ id }: { id: number }) {
  const shown = useApp((s) => s.catchmentFor === id);
  return (
    <button style={{ marginTop: 10, width: '100%' }} className={shown ? 'primary' : ''} aria-pressed={shown} onClick={() => useApp.setState({ catchmentFor: shown ? null : id })}>
      {shown ? 'Hide catchment area' : 'Show catchment area'}
    </button>
  );
}

/** Vehicles of a train; editable (reorder, add, remove) while it's parked in a depot. */
function ConsistEditor({ t, mine }: { t: TrainInfo; mine: boolean }) {
  const current = t.units.map((u) => u.type);
  const currentKey = current.join(',');
  const [draft, setDraft] = useState<string[]>(current);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const global = useApp((st) => st.global);
  const timeline = useApp((st) => st.room?.settings.timeline ?? 'era');
  const year = global ? ymdFromDays(global.date).year : 1900;
  const available = RAIL_VEHICLES.filter((v) => isAvailable(v, year, timeline));
  const [toAdd, setToAdd] = useState(available.find((v) => v.kind === 'wagon')?.id ?? available[0]?.id ?? '');
  useEffect(() => setDraft(currentKey ? currentKey.split(',') : []), [currentKey]);

  const editable = mine && t.status === 'depot';
  const changed = draft.join(',') !== currentKey;
  const preview = changed ? client.preview({ type: 'editConsist', id: t.id, units: draft }) : null;
  const stats = trainStats(draft.map((type) => ({ type })));
  const move = (from: number, to: number) => {
    if (to < 0 || to >= draft.length || from === to) return;
    const next = draft.slice();
    const [u] = next.splice(from, 1);
    next.splice(to, 0, u!);
    setDraft(next);
  };

  return (
    <>
      <h4>Vehicles</h4>
      {!editable && mine && <p className="muted small" style={{ margin: '0 0 6px' }}>Send the train to a depot to rearrange or change its vehicles.</p>}
      <ol className="consist">
        {draft.map((id, i) => {
          const v = railVehicle(id);
          return (
            <li
              key={i + id}
              draggable={editable}
              className={dragFrom === i ? 'dragging' : ''}
              onDragStart={(e) => {
                setDragFrom(i);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onDragOver={(e) => editable && e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                if (dragFrom !== null) move(dragFrom, i);
                setDragFrom(null);
              }}
              onDragEnd={() => setDragFrom(null)}
            >
              {editable && <span className="grip" aria-hidden>⋮⋮</span>}
              <span className={`unit-kind ${v?.kind ?? ''}`}>{v?.kind === 'loco' ? 'Engine' : v?.cargo === 'mail' ? 'Mail' : 'Coach'}</span>
              <span className="order-name">{v?.name ?? id}</span>
              {editable && (
                <>
                  <button className="ghost small" disabled={i === 0} aria-label="Move forward" onClick={() => move(i, i - 1)}>
                    ↑
                  </button>
                  <button className="ghost small" disabled={i === draft.length - 1} aria-label="Move back" onClick={() => move(i, i + 1)}>
                    ↓
                  </button>
                  <button className="ghost small" aria-label="Remove vehicle" onClick={() => setDraft(draft.filter((_, k) => k !== i))}>
                    ✕
                  </button>
                </>
              )}
            </li>
          );
        })}
      </ol>
      {editable && (
        <>
          <div className="row" style={{ marginBottom: 8 }}>
            <select value={toAdd} onChange={(e) => setToAdd(e.target.value)} style={{ flex: 1, minWidth: 0 }} aria-label="Vehicle to add">
              {available.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name} — {formatMoney(v.cost)}
                </option>
              ))}
            </select>
            <button onClick={() => toAdd && setDraft([...draft, toAdd])}>+ Add</button>
            <button className="ghost" title="Reverse the order of all vehicles" onClick={() => setDraft(draft.slice().reverse())}>
              ⇄
            </button>
          </div>
          {changed && (
            <div className="row wrap">
              <span className={`small ${preview && !preview.ok ? 'neg' : 'muted'}`} style={{ flex: 1 }}>
                {preview && !preview.ok
                  ? preview.error
                  : `${stats.capacity} seats · ${stats.maxSpeed} km/h · ${stats.length.toFixed(1)} tiles · ${preview && preview.ok ? (preview.cost >= 0 ? 'costs ' + formatMoney(preview.cost) : 'refund ' + formatMoney(-preview.cost)) : ''}`}
              </span>
              <button className="ghost" onClick={() => setDraft(current)}>
                Reset
              </button>
              <button className="primary" disabled={!preview?.ok} onClick={() => act({ type: 'editConsist', id: t.id, units: draft })}>
                Apply
              </button>
            </div>
          )}
        </>
      )}
    </>
  );
}
