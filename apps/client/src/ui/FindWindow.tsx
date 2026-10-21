import {
  CARGOS,
  cargoAmount,
  industryType,
  ratingPercent,
  reputationLabel,
  reputationOf,
  type CargoId,
  type Industry,
  type Station,
  type Town,
} from '@transportsim/shared';
import { useEffect, useState } from 'react';
import { client } from '../net/client.ts';
import { openWindow, useApp, type FindTab, type GameWindow } from '../store.ts';
import { LineSwatch } from './LinesWindow.tsx';
import { SortTable, type Column } from './SortTable.tsx';
import { Win, focusOn, useMyRole, useTick } from './windows.tsx';

const TABS: { id: FindTab; label: string }[] = [
  { id: 'towns', label: 'Towns' },
  { id: 'industries', label: 'Industries' },
  { id: 'stations', label: 'Your stations' },
];

const matches = (name: string, query: string) => name.toLowerCase().includes(query.trim().toLowerCase());

/** Buttons at the end of a row: move the camera there, and open its window. */
function RowActions({ x, y, open }: { x: number; y: number; open: () => void }) {
  return (
    <span className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
      <button className="ghost" title="Move the camera there" onClick={() => focusOn(x, y)}>
        Locate
      </button>
      <button onClick={open}>Open</button>
    </span>
  );
}

/** Towns, industries and the company's stations: searchable, sortable, and a click from the camera. */
export function FindWindow({ w }: { w: GameWindow & { kind: 'find' } }) {
  const [tab, setTab] = useState<FindTab>(w.tab ?? 'towns');
  const [query, setQuery] = useState('');
  // Opening the window again for another list switches to it.
  useEffect(() => {
    if (w.tab) setTab(w.tab);
  }, [w.tab]);
  return (
    <Win w={w} title="Find" width={640}>
      <div className="row wrap" style={{ gap: 8, marginBottom: 8 }}>
        <div className="seg" role="tablist" aria-label="List">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'primary' : ''} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </div>
        <input
          type="search"
          autoFocus
          placeholder="Search by name…"
          aria-label="Search by name"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ flex: 1, minWidth: 140 }}
        />
      </div>
      {tab === 'towns' && <TownList query={query} />}
      {tab === 'industries' && <IndustryList query={query} />}
      {tab === 'stations' && <StationList query={query} />}
    </Win>
  );
}

function TownList({ query }: { query: string }) {
  useTick(2000);
  const company = useMyRole().companyId;
  const towns = [...(client.world?.state.towns.values() ?? [])].filter((t) => matches(t.name, query));
  const columns: Column<Town>[] = [
    { key: 'name', label: 'Name', text: true, sort: (t) => t.name, render: (t) => <b>{t.name}</b> },
    { key: 'population', label: 'Population', width: 96, sort: (t) => t.population, render: (t) => <span className="mono">{t.population.toLocaleString('en-GB')}</span> },
    {
      key: 'growth',
      label: 'Grows',
      width: 116,
      sort: (t) => t.growthRate ?? 0,
      render: (t) => <span className="muted small">{t.growthRate ? `every ${Math.round(1 / t.growthRate)} days` : 'not growing'}</span>,
    },
  ];
  if (company !== null) {
    columns.push({
      key: 'reputation',
      label: 'Your reputation',
      width: 120,
      sort: (t) => reputationOf(t, company),
      render: (t) => {
        const r = reputationOf(t, company);
        return <span className={r < 0 ? 'neg small' : 'small'}>{reputationLabel(r)}</span>;
      },
    });
  }
  columns.push({
    key: 'go',
    label: '',
    width: 138,
    render: (t) => <RowActions x={t.x} y={t.y} open={() => openWindow({ kind: 'town', id: t.id })} />,
  });
  return <SortTable rows={towns} columns={columns} rowKey={(t) => t.id} initial="population" empty={query ? 'No town matches.' : 'No towns.'} />;
}

/** The cargo an industry made last month, with how much of it was carried away. */
function production(ind: Industry): { cargo: CargoId; made: number; carried: number }[] {
  return (Object.entries(ind.lastProduced) as [CargoId, number][]).filter(([, n]) => n > 0).map(([cargo, made]) => ({ cargo, made, carried: Math.min(made, ind.lastTransported[cargo] ?? 0) }));
}

/** Share of last month's production carried away (cargoes averaged), or null if it made nothing. */
function carriedShare(ind: Industry): number | null {
  const p = production(ind);
  return p.length ? p.reduce((s, x) => s + x.carried / x.made, 0) / p.length : null;
}

function IndustryList({ query }: { query: string }) {
  useApp((s) => s.summaryRev);
  useTick(2000);
  const [type, setType] = useState('');
  const [unserved, setUnserved] = useState(false);
  const all = [...(client.world?.state.industries.values() ?? [])];
  const types = [...new Set(all.map((i) => i.type))].map((id) => industryType(id)!).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const rows = all.filter((i) => (!type || i.type === type) && matches(i.name, query) && (!unserved || carriedShare(i) === 0));
  const columns: Column<Industry>[] = [
    {
      key: 'name',
      label: 'Name',
      text: true,
      sort: (i) => i.name,
      render: (i) => (
        <>
          <b>{i.name}</b>
          <div className="muted small">{industryType(i.type)?.name}</div>
        </>
      ),
    },
    {
      key: 'made',
      label: 'Made last month',
      text: true,
      width: 170,
      sort: (i) => production(i).reduce((s, x) => s + x.made, 0),
      render: (i) => {
        const p = production(i);
        if (!p.length) return <span className="muted small">nothing</span>;
        return (
          <div className="small">
            {p.map((x) => (
              <div key={x.cargo} className="row" style={{ gap: 4 }}>
                <span className="cargo-dot" style={{ background: CARGOS[x.cargo].color }} title={CARGOS[x.cargo].name} />
                {cargoAmount(x.cargo, x.made)}
              </div>
            ))}
          </div>
        );
      },
    },
    {
      key: 'carried',
      label: 'Carried',
      width: 80,
      sort: (i) => carriedShare(i) ?? -1,
      render: (i) => {
        const s = carriedShare(i);
        return s === null ? <span className="muted">—</span> : <span className={`mono ${s === 0 ? 'neg' : ''}`}>{Math.round(s * 100)}%</span>;
      },
    },
    {
      key: 'go',
      label: '',
      width: 138,
      render: (i) => <RowActions x={i.x + i.w / 2} y={i.y + i.h / 2} open={() => openWindow({ kind: 'industry', id: i.id })} />,
    },
  ];
  return (
    <>
      <div className="row wrap" style={{ gap: 10, marginBottom: 8 }}>
        <select aria-label="Industry type" value={type} onChange={(e) => setType(e.target.value)}>
          <option value="">Every type</option>
          {types.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <label className="row" title="Industries that made cargo last month and nobody carried any of it">
          <input type="checkbox" checked={unserved} onChange={(e) => setUnserved(e.target.checked)} />
          Only producers nobody serves
        </label>
      </div>
      <SortTable rows={rows} columns={columns} rowKey={(i) => i.id} initial="name" empty={all.length ? 'No industry matches.' : 'No industries.'} />
    </>
  );
}

function StationList({ query }: { query: string }) {
  useApp((s) => s.summaryRev);
  useApp((s) => s.linesRev);
  useTick(2000);
  const company = useMyRole().companyId;
  if (company === null) return <p className="muted">Found or join a company to list its stations.</p>;
  const world = client.world;
  const lines = [...(world?.state.lines.values() ?? [])].filter((l) => l.owner === company);
  const callingAt = (st: Station) => lines.filter((l) => l.orders.some((o) => o.kind === 'station' && o.station === st.id));
  const stations = [...(world?.state.stations.values() ?? [])].filter((s) => s.owner === company && matches(s.name, query));
  const columns: Column<Station>[] = [
    { key: 'name', label: 'Name', text: true, sort: (s) => s.name, render: (s) => <b>{s.name}</b> },
    {
      key: 'lines',
      label: 'Lines calling',
      text: true,
      width: 150,
      sort: (s) => callingAt(s).length,
      render: (s) => {
        const ls = callingAt(s);
        if (!ls.length) return <span className="neg small">none</span>;
        return (
          <span className="row small" style={{ gap: 4, overflow: 'hidden' }} title={ls.map((l) => l.name).join('\n')}>
            {ls.slice(0, 6).map((l) => (
              <LineSwatch key={l.id} line={l} />
            ))}
            <span className="muted">{ls.length === 1 ? ls[0]!.name : `${ls.length} lines`}</span>
          </span>
        );
      },
    },
    { key: 'waiting', label: 'Waiting', width: 80, sort: (s) => s.waitingTotal, render: (s) => <span className="mono">{s.waitingTotal.toLocaleString('en-GB')}</span> },
    {
      key: 'rating',
      label: 'Rating',
      width: 92,
      sort: (s) => s.rating,
      render: (s) => {
        const now = ratingPercent(s.rating);
        const target = world?.ratingTargets.get(s.id);
        const to = target === undefined ? now : ratingPercent(target);
        return (
          <span className={`mono ${now < 40 ? 'neg' : ''}`} title={to !== now ? `Moving towards ${to}%` : undefined}>
            {now}%{to < now ? ' ↘' : to > now ? ' ↗' : ''}
          </span>
        );
      },
    },
    { key: 'go', label: '', width: 138, render: (s) => <RowActions x={s.x} y={s.y} open={() => openWindow({ kind: 'station', id: s.id })} /> },
  ];
  return <SortTable rows={stations} columns={columns} rowKey={(s) => s.id} initial="name" empty={query ? 'No station matches.' : 'You have no stations yet.'} />;
}
