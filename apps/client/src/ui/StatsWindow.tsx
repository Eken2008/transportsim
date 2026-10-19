import {
  CARGOS,
  CARGO_IDS,
  COMPANY_COLORS,
  cargoPayment,
  ledgerTotal,
  ymdFromDays,
  type CargoId,
  type Company,
  type MonthRecord,
} from '@transportsim/shared';
import { useState } from 'react';
import { useApp, type GameWindow } from '../store.ts';
import { formatMoney } from './format.ts';
import { Win } from './windows.tsx';

interface Series {
  name: string;
  color: string;
  points: [number, number][];
}

const W = 560;
const H = 240;
const PAD = { l: 64, r: 12, t: 12, b: 26 };

/** A plain SVG line chart: x is a game date (days) or any number, y is formatted by `fmt`. */
function LineChart({ series, fmt, xFmt }: { series: Series[]; fmt: (v: number) => string; xFmt: (v: number) => string }) {
  const pts = series.flatMap((s) => s.points);
  if (pts.length < 2) return <p className="muted">Not enough history yet: figures are recorded at the end of each month.</p>;
  let [x0, x1, y0, y1] = [Infinity, -Infinity, 0, -Infinity];
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
    y0 = Math.min(y0, y);
    y1 = Math.max(y1, y);
  }
  if (y1 <= y0) y1 = y0 + 1;
  if (x1 <= x0) x1 = x0 + 1;
  // Round the y range to a tidy step.
  const raw = (y1 - y0) / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  y0 = Math.floor(y0 / step) * step;
  y1 = Math.ceil(y1 / step) * step;
  const sx = (x: number) => PAD.l + ((x - x0) / (x1 - x0)) * (W - PAD.l - PAD.r);
  const sy = (y: number) => H - PAD.b - ((y - y0) / (y1 - y0)) * (H - PAD.t - PAD.b);
  const ticks: number[] = [];
  for (let y = y0; y <= y1 + step / 2; y += step) ticks.push(y);
  const xticks = [x0, x0 + (x1 - x0) / 2, x1];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Chart" style={{ display: 'block' }}>
      {ticks.map((y) => (
        <g key={y}>
          <line x1={PAD.l} x2={W - PAD.r} y1={sy(y)} y2={sy(y)} stroke="var(--line)" strokeWidth={y === 0 ? 1.5 : 1} />
          <text x={PAD.l - 6} y={sy(y) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">
            {fmt(y)}
          </text>
        </g>
      ))}
      {xticks.map((x, k) => (
        <text key={k} x={sx(x)} y={H - 8} textAnchor={k === 0 ? 'start' : k === 2 ? 'end' : 'middle'} fontSize="11" fill="var(--muted)">
          {xFmt(x)}
        </text>
      ))}
      {series.map((s) =>
        s.points.length > 1 ? (
          <polyline key={s.name} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" points={s.points.map(([x, y]) => `${sx(x)},${sy(y)}`).join(' ')}>
            <title>{s.name}</title>
          </polyline>
        ) : null,
      )}
    </svg>
  );
}

function Legend({ series }: { series: Series[] }) {
  return (
    <div className="row wrap small" style={{ gap: 12, marginTop: 6 }}>
      {series.map((s) => (
        <span key={s.name} className="row" style={{ gap: 4 }}>
          <span className="company-swatch" style={{ background: s.color }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthLabel = (days: number) => {
  const d = ymdFromDays(days - 1);
  return `${MONTHS[d.month - 1]} ${d.year}`;
};
const short = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e6) return `£${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e3) return `£${(v / 1e3).toFixed(0)}k`;
  return `£${Math.round(v)}`;
};

type Tab = 'value' | 'money' | 'profit' | 'income' | 'vehicles' | 'cargo' | 'rates';
const TABS: { id: Tab; label: string }[] = [
  { id: 'value', label: 'Company value' },
  { id: 'money', label: 'Money' },
  { id: 'profit', label: 'Monthly profit' },
  { id: 'income', label: 'Monthly income' },
  { id: 'vehicles', label: 'Vehicles' },
  { id: 'cargo', label: 'Cargo delivered' },
  { id: 'rates', label: 'Payment rates' },
];

const perCompany = (companies: Company[], pick: (m: MonthRecord) => number): Series[] =>
  companies.map((c) => ({ name: c.name, color: COMPANY_COLORS[c.color % COMPANY_COLORS.length]!, points: c.history.map((m) => [m.date, pick(m)] as [number, number]) }));

/** Company statistics over time, compared across companies, and what each cargo pays. */
export function StatsWindow({ w }: { w: GameWindow & { kind: 'stats' } }) {
  const companies = useApp((s) => s.global?.companies ?? []);
  const myCompany = useApp((s) => s.global?.players.find((p) => p.id === s.room?.playerId)?.companyId ?? null);
  const [tab, setTab] = useState<Tab>('value');
  const [cargoOf, setCargoOf] = useState<number | null>(null);
  const focus = companies.find((c) => c.id === (cargoOf ?? myCompany)) ?? companies[0];

  let body: React.ReactNode;
  if (tab === 'rates') {
    // What a load of 10 units pays over 20 tiles, by days in transit.
    const series = CARGO_IDS.map((c: CargoId) => ({
      name: CARGOS[c].name,
      color: CARGOS[c].color,
      points: Array.from({ length: 31 }, (_, d) => [d * 3, cargoPayment(c, 10, 20, d * 3)] as [number, number]),
    }));
    body = (
      <>
        <p className="muted small" style={{ marginTop: 0 }}>
          Payment for 10 units carried 20 tiles, by days on the way. Slow deliveries pay less, sooner for impatient cargo.
        </p>
        <LineChart series={series} fmt={short} xFmt={(d) => `${Math.round(d)} days`} />
        <Legend series={series} />
      </>
    );
  } else if (tab === 'cargo') {
    const months = focus?.history ?? [];
    const series = CARGO_IDS.filter((c) => months.some((m) => (m.delivered[c] ?? 0) > 0)).map((c) => ({
      name: CARGOS[c].name,
      color: CARGOS[c].color,
      points: months.map((m) => [m.date, m.delivered[c] ?? 0] as [number, number]),
    }));
    body = (
      <>
        <label className="field" style={{ maxWidth: 260 }}>
          <span>Company</span>
          <select value={focus?.id ?? ''} onChange={(e) => setCargoOf(Number(e.target.value))}>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {series.length ? (
          <>
            <LineChart series={series} fmt={(v) => Math.round(v).toLocaleString('en-GB')} xFmt={monthLabel} />
            <Legend series={series} />
          </>
        ) : (
          <p className="muted">Nothing delivered yet.</p>
        )}
      </>
    );
  } else {
    const pick: Record<Exclude<Tab, 'rates' | 'cargo'>, (m: MonthRecord) => number> = {
      value: (m) => m.value,
      money: (m) => m.money - m.loan,
      profit: (m) => ledgerTotal(m.ledger) - m.ledger.construction - m.ledger.vehicles,
      income: (m) => m.ledger.income + m.ledger.sharing,
      vehicles: (m) => m.vehicles,
    };
    const series = perCompany(companies, pick[tab]);
    body = (
      <>
        {tab === 'money' && <p className="muted small" style={{ marginTop: 0 }}>Money less the loan, at the end of each month.</p>}
        {tab === 'profit' && <p className="muted small" style={{ marginTop: 0 }}>Income less running costs, maintenance, interest and accidents (building and buying left out).</p>}
        <LineChart series={series} fmt={tab === 'vehicles' ? (v) => String(Math.round(v)) : short} xFmt={monthLabel} />
        <Legend series={series} />
      </>
    );
  }

  return (
    <Win w={w} title="Statistics" width={620}>
      <div className="seg" role="tablist" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'primary' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      {body}
      {tab !== 'rates' && companies.length > 0 && (
        <p className="muted small" style={{ marginBottom: 0 }}>
          {companies.length === 1 ? '' : 'Compare companies by colour. '}Latest month: {formatMoney(focus?.history.at(-1)?.value ?? focus?.value ?? 0)} company value for {focus?.name}.
        </p>
      )}
    </Win>
  );
}
