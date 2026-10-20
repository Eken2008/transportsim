import { LINE_COLORS, VEHICLE_MODES, roleAllows, vehicleMode, type Line, type Order, type TrainInfo, type VehicleMode } from '@transportsim/shared';
import { useEffect, useRef } from 'react';
import { client } from '../net/client.ts';
import { openWindow, useApp, type GameWindow } from '../store.ts';
import { formatMoney } from './format.ts';
import { OrdersEditor, orderName } from './OrdersEditor.tsx';
import { Win, act, trainStatus, useMyRole, useTick } from './windows.tsx';

export const MODE_LABELS: Record<VehicleMode, string> = { rail: 'Rail', road: 'Road', air: 'Air', water: 'Water' };
const VEHICLE_WORD: Record<VehicleMode, string> = { rail: 'trains', road: 'road vehicles', air: 'aircraft', water: 'ships' };

function useLines(): Line[] {
  useApp((s) => s.linesRev);
  return [...(client.world?.state.lines.values() ?? [])];
}

export function LineSwatch({ line }: { line: Line }) {
  return <span className="company-swatch" style={{ background: LINE_COLORS[line.color] }} aria-hidden />;
}

/** "Hilltown – Ashford – Bayport": the stations a line calls at. */
export function lineStops(line: Line): string {
  const stops = line.orders.filter((o): o is Extract<Order, { kind: 'station' }> => o.kind === 'station').map((o, i) => orderName(o, i));
  return stops.length ? stops.join(' – ') : 'no stops yet';
}

/**
 * In a vehicle's window: which line it runs on and where it is going next. The line's stops
 * are edited in the line's own window.
 */
export function VehicleLine({ t, mine, warn }: { t: TrainInfo; mine: boolean; warn: (o: Order) => React.ReactNode }) {
  const lines = useLines();
  const mode = vehicleMode(t);
  const line = t.line !== undefined ? lines.find((l) => l.id === t.line) : undefined;
  const choices = lines.filter((l) => l.owner === t.owner && l.mode === mode).sort((a, b) => a.name.localeCompare(b.name));
  // A line just started from here opens, so its stops can be added.
  const opening = useRef(false);
  useEffect(() => {
    if (opening.current && t.line !== undefined) {
      opening.current = false;
      openWindow({ kind: 'line', id: t.line });
    }
  }, [t.line]);
  const next = nextStop(t);
  const timetabled = !!line?.orders.some((o) => o.kind !== 'jump' && (o.travel || (o.kind === 'station' && o.wait)));
  return (
    <>
      <h4>Line</h4>
      <div className="row">
        {line && <LineSwatch line={line} />}
        {mine ? (
          <select
            style={{ flex: 1, minWidth: 0 }}
            aria-label="Line"
            value={line?.id ?? ''}
            onChange={(e) => act({ type: 'assignLine', vehicle: t.id, line: e.target.value === '' ? null : Number(e.target.value) })}
          >
            <option value="">No line</option>
            {choices.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        ) : (
          <b style={{ flex: 1 }}>{line?.name ?? 'No line'}</b>
        )}
        {mine && (
          <button
            title="Start a new line for this vehicle"
            onClick={() => {
              opening.current = true;
              act({ type: 'createLine', mode, vehicle: t.id });
            }}
          >
            + New line
          </button>
        )}
        {line && (
          <button className="ghost" onClick={() => openWindow({ kind: 'line', id: line.id })}>
            Open
          </button>
        )}
      </div>
      {line ? (
        <div className="kv" style={{ marginTop: 8 }}>
          <span>Next stop</span>
          <span>
            <b>{next ? orderName(next, t.orderIndex) : line.orders.length ? '—' : 'The line has no stops yet'}</b>
            {next && warn(next)}
          </span>
          {timetabled && (
            <>
              <span>Timetable</span>
              <span className={`small ${t.lateness && t.lateness > 0.5 ? 'neg' : 'muted'}`}>
                {t.lateness === undefined || Math.abs(t.lateness) < 0.5 ? 'on time' : t.lateness > 0 ? `${t.lateness} d late` : `${-t.lateness} d early`}
              </span>
            </>
          )}
        </div>
      ) : (
        <p className="muted small">Not on a line, so it has nowhere to go. Pick a line, or start a new one and add its stops.</p>
      )}
      {line && mine && (
        <button
          className={`ghost small ${t.autofill ? 'active-text' : ''}`}
          style={{ marginTop: 6 }}
          title="Record this vehicle's travel times into the line's timetable as it runs"
          aria-pressed={!!t.autofill}
          onClick={() => act({ type: 'trainAction', id: t.id, action: 'autofill' })}
        >
          ⏱ {t.autofill ? 'Recording travel times…' : 'Autofill the timetable'}
        </button>
      )}
    </>
  );
}

/** The order a vehicle is heading for, skipping jumps; undefined if it has none. */
function nextStop(t: TrainInfo): Order | undefined {
  const o = t.orders[t.orderIndex];
  return o && o.kind !== 'jump' ? o : undefined;
}

/** A line: its name and colour, stops, and the vehicles running on it. */
export function LineWindow({ w }: { w: GameWindow & { kind: 'line' } }) {
  useTick(1000);
  useApp((s) => s.trainsRev);
  const lines = useLines();
  const my = useMyRole();
  const line = lines.find((l) => l.id === w.id);
  if (!line) {
    return (
      <Win w={w} title="Line">
        <p className="muted">This line no longer exists.</p>
      </Win>
    );
  }
  const mine = my.companyId === line.owner && roleAllows(my.role, 'operate');
  const all = [...(client.world?.trains.values() ?? [])];
  const vehicles = all.filter((t) => t.line === line.id).sort((a, b) => a.id - b.id);
  const spare = all.filter((t) => t.owner === line.owner && vehicleMode(t) === line.mode && t.line !== line.id).sort((a, b) => a.id - b.id);
  const profit = vehicles.reduce((s, t) => s + t.profitThisYear, 0);
  return (
    <Win
      w={w}
      width={380}
      title={
        <span className="row">
          <LineSwatch line={line} /> {line.name}
        </span>
      }
    >
      {mine && (
        <div className="row">
          <input
            key={line.name}
            defaultValue={line.name}
            aria-label="Line name"
            maxLength={40}
            style={{ flex: 1, minWidth: 0 }}
            onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== line.name && act({ type: 'editLine', id: line.id, name: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <button className="danger" onClick={() => confirm(`Delete ${line.name}? Its ${vehicles.length} vehicles will have nowhere to go.`) && act({ type: 'deleteLine', id: line.id })}>
            Delete
          </button>
        </div>
      )}
      {mine && (
        <div className="row wrap" style={{ marginTop: 8, gap: 4 }} role="radiogroup" aria-label="Line colour">
          {LINE_COLORS.map((c, i) => (
            <button
              key={c}
              role="radio"
              aria-checked={line.color === i}
              aria-label={`Colour ${i + 1}`}
              className="ghost"
              style={{ padding: 2, outline: line.color === i ? '2px solid var(--text)' : undefined }}
              onClick={() => act({ type: 'editLine', id: line.id, color: i })}
            >
              <span className="company-swatch" style={{ background: c, display: 'block' }} />
            </button>
          ))}
        </div>
      )}
      <div className="kv" style={{ marginTop: 8 }}>
        <span>Type</span>
        <span>{MODE_LABELS[line.mode]}</span>
        <span>Vehicles</span>
        <b className="mono">{vehicles.length}</b>
        <span>Profit this year</span>
        <b className={`mono ${profit < 0 ? 'neg' : ''}`}>{formatMoney(profit)}</b>
      </div>
      <OrdersEditor line={line} mine={mine} />
      <h4>Vehicles on this line</h4>
      {vehicles.length === 0 && <p className="muted small">None yet.</p>}
      {vehicles.map((t) => (
        <div className="list-row" key={t.id}>
          <b style={{ width: 80 }}>{t.name}</b>
          <span className="muted small" style={{ flex: 1 }}>
            {trainStatus(t)}
          </span>
          <button onClick={() => openWindow({ kind: 'train', id: t.id })}>Open</button>
          {mine && (
            <button className="ghost" title="Take it off this line" aria-label={`Take ${t.name} off the line`} onClick={() => act({ type: 'assignLine', vehicle: t.id, line: null })}>
              ✕
            </button>
          )}
        </div>
      ))}
      {mine && spare.length > 0 && (
        <select
          style={{ width: '100%', marginTop: 6 }}
          aria-label="Add a vehicle to this line"
          value=""
          onChange={(e) => e.target.value !== '' && act({ type: 'assignLine', vehicle: Number(e.target.value), line: line.id })}
        >
          <option value="">+ Put one of your {VEHICLE_WORD[line.mode]} on this line…</option>
          {spare.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
              {t.line !== undefined ? ` (now on ${lines.find((l) => l.id === t.line)?.name ?? 'another line'})` : ''}
            </option>
          ))}
        </select>
      )}
    </Win>
  );
}

/** All of the company's lines, by kind. */
export function LinesWindow({ w }: { w: GameWindow & { kind: 'lines' } }) {
  useApp((s) => s.trainsRev);
  const lines = useLines();
  const my = useMyRole();
  const company = my.companyId;
  const canEdit = roleAllows(my.role, 'operate');
  const trains = [...(client.world?.trains.values() ?? [])];
  const ours = lines.filter((l) => l.owner === company);
  return (
    <Win w={w} title="Your lines" width={440}>
      {company === null && <p className="muted">Found or join a company first.</p>}
      {company !== null &&
        VEHICLE_MODES.map((mode) => {
          const list = ours.filter((l) => l.mode === mode).sort((a, b) => a.name.localeCompare(b.name));
          return (
            <section key={mode}>
              <div className="row" style={{ marginTop: 10 }}>
                <h4 style={{ margin: 0, flex: 1 }}>{MODE_LABELS[mode]}</h4>
                {canEdit && (
                  <button className="ghost small" onClick={() => act({ type: 'createLine', mode })}>
                    + New {MODE_LABELS[mode].toLowerCase()} line
                  </button>
                )}
              </div>
              {list.length === 0 && <p className="muted small">No {MODE_LABELS[mode].toLowerCase()} lines.</p>}
              {list.map((l) => {
                const n = trains.filter((t) => t.line === l.id).length;
                return (
                  <div className="list-row" key={l.id}>
                    <LineSwatch line={l} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <b>{l.name}</b>
                      <div className="muted small" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {lineStops(l)}
                      </div>
                    </div>
                    <span className="muted small mono" title="Vehicles on the line">
                      {n} {n === 1 ? 'vehicle' : 'vehicles'}
                    </span>
                    <button onClick={() => openWindow({ kind: 'line', id: l.id })}>Open</button>
                  </div>
                );
              })}
            </section>
          );
        })}
    </Win>
  );
}
