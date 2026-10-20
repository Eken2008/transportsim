import {
  BANKRUPT_QUARTERS,
  COMPANY_COLORS,
  ECONOMY,
  LEDGER_CATEGORIES,
  LEDGER_LABELS,
  LOAN_STEP,
  VEHICLE_MODES,
  ledgerOf,
  ledgerTotal,
  roleAllows,
  sumLedgers,
  yearlyMaintenance,
  type Infrastructure,
  type VehicleMode,
} from '@transportsim/shared';
import { useState } from 'react';
import { client } from '../net/client.ts';
import { openWindow, useApp, type GameWindow } from '../store.ts';
import { formatMoney } from './format.ts';
import { Win, act, useMyRole } from './windows.tsx';
import { MODE_LABELS } from './LinesWindow.tsx';

const QUARTERS = ['Jan–Mar', 'Apr–Jun', 'Jul–Sep', 'Oct–Dec'];

function Money({ v }: { v: number }) {
  return <span className={`mono ${Math.round(v) < 0 ? 'neg' : ''}`}>{Math.round(v) === 0 ? '–' : formatMoney(v)}</span>;
}

/**
 * A company's books for the last four quarters, in total or for one transport type, with what
 * each type earned; its loan and its infrastructure.
 */
export function FinancesWindow({ w }: { w: GameWindow & { kind: 'finances' } }) {
  const c = useApp((s) => s.global?.companies.find((x) => x.id === w.id));
  const settings = useApp((s) => s.room?.settings);
  const my = useMyRole();
  const [mode, setMode] = useState<VehicleMode | undefined>(undefined);
  if (!c || !settings) {
    return (
      <Win w={w} title="Finances">
        <p className="muted">This company no longer exists.</p>
      </Win>
    );
  }
  const econ = ECONOMY[settings.economy];
  const maxLoan = client.world?.state.maxLoan() ?? econ.maxLoan;
  const canBorrow = my.companyId === c.id && roleAllows(my.role, 'build');
  const quarters = c.finances.slice(-4);
  const infra: Infrastructure = mode ? (c.infrastructure.modes?.[mode] ?? { track: 0, stations: 0, depots: 0, signals: 0 }) : c.infrastructure;
  const maintenance = Math.round((yearlyMaintenance(infra) * econ.costFactor * (client.world?.state.inflation.costs ?? 1)) / 12);
  const yearTotal = ledgerTotal(sumLedgers(quarters, mode));
  // Categories that can't happen for a transport type are left out of its books.
  const categories = LEDGER_CATEGORIES.filter((cat) => !mode || (cat !== 'interest' && cat !== 'councils' && (cat !== 'sharing' || mode === 'rail')));
  const repayAll = Math.min(c.loan, Math.floor(Math.max(0, c.money) / LOAN_STEP) * LOAN_STEP);

  return (
    <Win
      w={w}
      width={520}
      title={
        <span className="row">
          <span className="company-swatch" style={{ background: COMPANY_COLORS[c.color] }} /> {c.name} — finances
        </span>
      }
    >
      {c.badQuarters > 0 && (
        <div className="notice warn">
          {c.name} ended {c.badQuarters === 1 ? 'a quarter' : `${c.badQuarters} quarters in a row`} with negative money. After{' '}
          {BANKRUPT_QUARTERS} it goes bankrupt and everything it owns is removed.
        </div>
      )}
      <div className="seg" role="tablist" aria-label="Transport type" style={{ flexWrap: 'wrap', marginBottom: 10 }}>
        {[undefined, ...VEHICLE_MODES].map((m) => (
          <button key={m ?? 'all'} role="tab" aria-selected={mode === m} className={mode === m ? 'primary' : ''} onClick={() => setMode(m)}>
            {m ? MODE_LABELS[m] : 'All'}
          </button>
        ))}
      </div>
      <div className="table-scroll">
        <table className="ledger">
          <thead>
            <tr>
              <th />
              {quarters.map((q) => (
                <th key={`${q.year}-${q.quarter}`}>
                  {QUARTERS[q.quarter]}
                  <br />
                  <span className="muted">{q.year}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {categories.map((cat) => (
              <tr key={cat}>
                <td>{LEDGER_LABELS[cat]}</td>
                {quarters.map((q) => (
                  <td key={`${q.year}-${q.quarter}`}>
                    <Money v={ledgerOf(q, mode)[cat]} />
                  </td>
                ))}
              </tr>
            ))}
            <tr className="total">
              <td>{mode ? `${MODE_LABELS[mode]} total` : 'Total'}</td>
              {quarters.map((q) => (
                <td key={`${q.year}-${q.quarter}`}>
                  <Money v={ledgerTotal(ledgerOf(q, mode))} />
                </td>
              ))}
            </tr>
            {!mode &&
              VEHICLE_MODES.map((m) => (
                <tr key={m} className="by-mode">
                  <td>
                    <button className="ghost small" onClick={() => setMode(m)} title={`Show the ${MODE_LABELS[m].toLowerCase()} books`}>
                      {MODE_LABELS[m]}
                    </button>
                  </td>
                  {quarters.map((q) => (
                    <td key={`${q.year}-${q.quarter}`}>
                      <Money v={ledgerTotal(ledgerOf(q, m))} />
                    </td>
                  ))}
                </tr>
              ))}
            {!mode && (
              <tr className="by-mode">
                <td title="Not tied to a transport type: terraforming, clearing land, loan interest and town councils">Other</td>
                {quarters.map((q) => (
                  <td key={`${q.year}-${q.quarter}`}>
                    <Money v={ledgerTotal(q.ledger) - VEHICLE_MODES.reduce((sum, m) => sum + ledgerTotal(ledgerOf(q, m)), 0)} />
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="kv" style={{ marginTop: 12 }}>
        <span>Money</span>
        <Money v={c.money} />
        <span>Loan</span>
        <span className="mono">
          {formatMoney(c.loan)} <span className="muted">of {formatMoney(maxLoan)} at {(econ.interestRate * 100).toFixed(1)}% a year</span>
        </span>
        <span>Last 4 quarters{mode ? ` (${MODE_LABELS[mode].toLowerCase()})` : ''}</span>
        <Money v={yearTotal} />
        <span>Company value</span>
        <span className="mono">{formatMoney(c.value)}</span>
      </div>
      {canBorrow && (
        <div className="row wrap" style={{ marginTop: 10 }}>
          <button disabled={c.loan + LOAN_STEP > maxLoan} onClick={() => act({ type: 'loan', action: 'borrow', amount: LOAN_STEP })}>
            Borrow {formatMoney(LOAN_STEP)}
          </button>
          <button disabled={c.loan < LOAN_STEP || c.money < LOAN_STEP} onClick={() => act({ type: 'loan', action: 'repay', amount: LOAN_STEP })}>
            Repay {formatMoney(LOAN_STEP)}
          </button>
          <button disabled={c.loan >= maxLoan} onClick={() => act({ type: 'loan', action: 'borrow', amount: maxLoan - c.loan })}>
            Borrow the most
          </button>
          <button disabled={repayAll === 0} onClick={() => act({ type: 'loan', action: 'repay', amount: repayAll })}>
            Repay {repayAll === c.loan ? 'all' : formatMoney(repayAll)}
          </button>
        </div>
      )}

      <h4>Infrastructure{mode ? ` (${MODE_LABELS[mode].toLowerCase()})` : ''}</h4>
      <div className="kv">
        {(!mode || mode === 'rail' || mode === 'water') && (
          <>
            <span>{mode === 'water' ? 'Canals and locks' : 'Track'}</span>
            <span className="mono">{infra.track} {mode === 'water' ? 'tiles' : 'pieces'}</span>
          </>
        )}
        <span>Station tiles</span>
        <span className="mono">{infra.stations}</span>
        {mode !== 'air' && (
          <>
            <span>Depots</span>
            <span className="mono">{infra.depots}</span>
          </>
        )}
        {(!mode || mode === 'rail') && (
          <>
            <span>Signals</span>
            <span className="mono">{infra.signals}</span>
          </>
        )}
        <span>Maintenance</span>
        <span className="mono">{formatMoney(maintenance)} a month</span>
      </div>
    </Win>
  );
}

/** Every company ranked by value. */
export function LeagueWindow({ w }: { w: GameWindow & { kind: 'league' } }) {
  const companies = useApp((s) => s.global?.companies ?? []);
  const ranked = [...companies].sort((a, b) => b.value - a.value);
  return (
    <Win w={w} title="Company league" width={440}>
      {ranked.length === 0 && <p className="muted">No companies yet.</p>}
      {ranked.map((c, i) => {
        const profit = ledgerTotal(sumLedgers(c.finances.slice(-4)));
        const owner = c.members.find((m) => m.role === 'owner')?.name;
        return (
          <div className="list-row" key={c.id}>
            <b className="mono" style={{ width: 22 }}>
              {i + 1}.
            </b>
            <span className="company-swatch" style={{ background: COMPANY_COLORS[c.color] }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>{c.name}</b>
              <div className="muted small">
                {owner ?? 'No members'} · profit <Money v={profit} />
              </div>
            </div>
            <span className="mono" title="Company value">
              {formatMoney(c.value)}
            </span>
            <button onClick={() => openWindow({ kind: 'finances', id: c.id })}>Books</button>
          </div>
        );
      })}
    </Win>
  );
}
