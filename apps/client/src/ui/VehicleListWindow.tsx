import { VEHICLE_MODES, baseReliability, roleAllows, vehicleMode, type BulkActionKind, type TrainInfo, type VehicleMode } from '@transportsim/shared';
import { useState } from 'react';
import { client } from '../net/client.ts';
import { openWindow, useApp, type GameWindow } from '../store.ts';
import { VEHICLE_ISSUE_TEXT, vehicleAge, vehicleIssues } from '../game/problems.ts';
import { formatMoney } from './format.ts';
import { LineSwatch, MODE_LABELS } from './LinesWindow.tsx';
import { Win, act, trainStatus, useMyRole, useTick } from './windows.tsx';

type StatusFilter = 'all' | 'problems' | 'running' | 'stopped' | 'depot' | 'broken' | 'lost';
const STATUS_FILTERS: { id: StatusFilter; label: string }[] = [
  { id: 'all', label: 'Any status' },
  { id: 'problems', label: 'With a problem' },
  { id: 'running', label: 'Running' },
  { id: 'stopped', label: 'Stopped' },
  { id: 'depot', label: 'In a depot' },
  { id: 'broken', label: 'Broken down' },
  { id: 'lost', label: 'Lost' },
];

type SortKey = 'name' | 'profit' | 'lastProfit' | 'age' | 'reliability';
const COLUMNS: { key: SortKey; label: string; title: string }[] = [
  { key: 'name', label: 'Name', title: 'Sort by name' },
  { key: 'profit', label: 'This year', title: 'Sort by profit this year' },
  { key: 'lastProfit', label: 'Last year', title: 'Sort by profit last year' },
  { key: 'age', label: 'Age', title: 'Sort by age' },
  { key: 'reliability', label: 'Rel.', title: 'Sort by reliability' },
];

const BULK: { action: BulkActionKind; label: string; title: string }[] = [
  { action: 'start', label: '▶ Start', title: 'Start the selected vehicles' },
  { action: 'stop', label: '■ Stop', title: 'Stop the selected vehicles where they are' },
  { action: 'toDepot', label: 'Go to depot', title: 'Send the selected vehicles to a depot to park' },
  { action: 'service', label: '🔧 Service', title: 'Send the selected vehicles for a service, then back to their lines' },
];

const reliability = (t: TrainInfo) => t.reliability ?? baseReliability(t.units);

function matchesStatus(t: TrainInfo, f: StatusFilter, date: number): boolean {
  switch (f) {
    case 'all':
      return true;
    case 'problems':
      return vehicleIssues(t, date).length > 0;
    case 'running':
      return (t.status === 'running' || t.status === 'loading') && !t.brokenDown;
    case 'stopped':
      return t.status === 'stopped';
    case 'depot':
      return t.status === 'depot';
    case 'broken':
      return !!t.brokenDown;
    case 'lost':
      return !!t.lost;
  }
}

function sortValue(t: TrainInfo, key: SortKey, date: number): number {
  switch (key) {
    case 'profit':
      return t.profitThisYear;
    case 'lastProfit':
      return t.profitLastYear;
    case 'age':
      return vehicleAge(t, date);
    case 'reliability':
      return reliability(t);
    case 'name':
      return 0;
  }
}

const byName = (a: TrainInfo, b: TrainInfo) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });

/**
 * The company's vehicles: filtered by transport type, line and status, sorted by any column,
 * with problems highlighted, and a selection that can be started, stopped or sent to a depot.
 */
export function VehicleListWindow({ w }: { w: GameWindow & { kind: 'trains' } }) {
  useTick(1000);
  useApp((s) => s.trainsRev);
  useApp((s) => s.linesRev);
  const date = useApp((s) => s.global?.date ?? 0);
  const my = useMyRole();
  const canOperate = roleAllows(my.role, 'operate');
  const [mode, setMode] = useState<VehicleMode | null>(null);
  const [line, setLine] = useState<number | 'none' | null>(null);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'name', desc: false });
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());

  const all = [...(client.world?.trains.values() ?? [])].filter((t) => t.owner === my.companyId);
  const lines = [...(client.world?.state.lines.values() ?? [])]
    .filter((l) => l.owner === my.companyId && (mode === null || l.mode === mode))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const shown = all
    .filter((t) => (mode === null || vehicleMode(t) === mode) && (line === null || (line === 'none' ? t.line === undefined : t.line === line)) && matchesStatus(t, status, date))
    .sort((a, b) => {
      const d = sort.key === 'name' ? byName(a, b) : sortValue(a, sort.key, date) - sortValue(b, sort.key, date) || byName(a, b);
      return sort.desc ? -d : d;
    });
  // The selection only counts vehicles still shown (filters may hide some).
  const chosen = shown.filter((t) => selected.has(t.id));
  const allChosen = shown.length > 0 && chosen.length === shown.length;
  const toggle = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      if (!n.delete(id)) n.add(id);
      return n;
    });
  const count = (m: VehicleMode | null) => all.filter((t) => m === null || vehicleMode(t) === m).length;

  return (
    <Win w={w} title="Your vehicles" width={640}>
      <div className="row wrap" style={{ gap: 8, marginBottom: 8 }}>
        <div className="seg" role="tablist" aria-label="Transport type">
          {[null, ...VEHICLE_MODES].map((m) => (
            <button
              key={m ?? 'all'}
              role="tab"
              aria-selected={mode === m}
              className={mode === m ? 'primary' : ''}
              onClick={() => {
                setMode(m);
                setLine(null);
              }}
            >
              {m === null ? 'All' : MODE_LABELS[m]} <span className="muted small">{count(m)}</span>
            </button>
          ))}
        </div>
        <div className="spacer" />
        <button onClick={() => openWindow({ kind: 'lines', id: 0 })}>Lines…</button>
      </div>
      <div className="row wrap" style={{ gap: 8, marginBottom: 8 }}>
        <select aria-label="Line" value={line ?? ''} onChange={(e) => setLine(e.target.value === '' ? null : e.target.value === 'none' ? 'none' : Number(e.target.value))}>
          <option value="">Any line</option>
          <option value="none">No line</option>
          {lines.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)}>
          {STATUS_FILTERS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.label}
            </option>
          ))}
        </select>
        <span className="muted small">
          {shown.length === all.length ? `${all.length} vehicles` : `${shown.length} of ${all.length} vehicles`}
        </span>
      </div>
      {canOperate && chosen.length > 0 && (
        <div className="row wrap bulk-bar" role="toolbar" aria-label="Selected vehicles">
          <b>{chosen.length} selected</b>
          {BULK.map((b) => (
            <button key={b.action} title={b.title} onClick={() => act({ type: 'vehiclesAction', ids: chosen.map((t) => t.id), action: b.action })}>
              {b.label}
            </button>
          ))}
          <button className="ghost" onClick={() => setSelected(new Set())}>
            Clear
          </button>
        </div>
      )}
      {all.length === 0 ? (
        <p className="muted">No vehicles yet. Build a depot (7 for trains, J for road vehicles), click it, and buy one.</p>
      ) : shown.length === 0 ? (
        <p className="muted">No vehicles match.</p>
      ) : (
        <div className="table-scroll">
          <table className="vlist">
            <thead>
              <tr>
                {canOperate && (
                  <th className="check">
                    <input
                      type="checkbox"
                      aria-label="Select every vehicle shown"
                      checked={allChosen}
                      onChange={() => setSelected(allChosen ? new Set() : new Set(shown.map((t) => t.id)))}
                    />
                  </th>
                )}
                {COLUMNS.map((c) => (
                  <th key={c.key} className={c.key === 'name' ? 'left' : ''} aria-sort={sort.key === c.key ? (sort.desc ? 'descending' : 'ascending') : 'none'}>
                    <button
                      className="ghost sort"
                      title={c.title}
                      onClick={() => setSort((s) => (s.key === c.key ? { key: c.key, desc: !s.desc } : { key: c.key, desc: c.key !== 'name' }))}
                    >
                      {c.label}
                      {sort.key === c.key && (sort.desc ? ' ▾' : ' ▴')}
                    </button>
                  </th>
                ))}
                <th />
              </tr>
            </thead>
            <tbody>
              {shown.map((t) => (
                <VehicleRow key={t.id} t={t} date={date} canOperate={canOperate} checked={selected.has(t.id)} onCheck={() => toggle(t.id)} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Win>
  );
}

function VehicleRow({ t, date, canOperate, checked, onCheck }: { t: TrainInfo; date: number; canOperate: boolean; checked: boolean; onCheck: () => void }) {
  const issues = vehicleIssues(t, date);
  const line = t.line !== undefined ? client.world?.state.lines.get(t.line) : undefined;
  const age = vehicleAge(t, date);
  const rel = Math.round(reliability(t) * 100);
  return (
    <tr className={issues.length ? 'issue' : undefined}>
      {canOperate && (
        <td className="check">
          <input type="checkbox" aria-label={`Select ${t.name}`} checked={checked} onChange={onCheck} />
        </td>
      )}
      <td className="left">
        <div className="row" style={{ gap: 6, minWidth: 0 }}>
          <b className="vname">{t.name}</b>
          {issues.length > 0 && (
            <span className="issue-tag" title={issues.map((i) => VEHICLE_ISSUE_TEXT[i]).join('\n')}>
              ⚠ {VEHICLE_ISSUE_TEXT[issues[0]!]}
            </span>
          )}
        </div>
        <div className="muted small row" style={{ gap: 4, minWidth: 0 }}>
          {line && <LineSwatch line={line} />}
          <span className="vstatus">
            {line ? `${line.name} · ` : ''}
            {trainStatus(t)}
          </span>
        </div>
      </td>
      <td className={`mono ${t.profitThisYear < 0 ? 'neg' : ''}`}>{formatMoney(t.profitThisYear)}</td>
      <td className={`mono ${t.profitLastYear < 0 ? 'neg' : ''}`}>{formatMoney(t.profitLastYear)}</td>
      <td className={`mono ${issues.includes('old') ? 'neg' : ''}`}>{age.toFixed(1)}</td>
      <td className={`mono ${rel < 50 ? 'neg' : ''}`}>{rel}%</td>
      <td>
        <button onClick={() => openWindow({ kind: 'train', id: t.id })}>Open</button>
      </td>
    </tr>
  );
}
