import {
  BANKRUPT_QUARTERS,
  COMPANY_COLORS,
  ECONOMY,
  LEDGER_CATEGORIES,
  LEDGER_LABELS,
  LOAN_STEP,
  ledgerTotal,
  roleAllows,
  sumLedgers,
  yearlyMaintenance,
} from '@transportsim/shared';
import { client } from '../net/client.ts';
import { openWindow, useApp, type GameWindow } from '../store.ts';
import { formatMoney } from './format.ts';
import { Win, act, useMyRole } from './windows.tsx';

const QUARTERS = ['Jan–Mar', 'Apr–Jun', 'Jul–Sep', 'Oct–Dec'];

function Money({ v }: { v: number }) {
  return <span className={`mono ${Math.round(v) < 0 ? 'neg' : ''}`}>{Math.round(v) === 0 ? '–' : formatMoney(v)}</span>;
}

/** A company's books for the last four quarters, its loan and its infrastructure. */
export function FinancesWindow({ w }: { w: GameWindow & { kind: 'finances' } }) {
  const c = useApp((s) => s.global?.companies.find((x) => x.id === w.id));
  const settings = useApp((s) => s.room?.settings);
  const my = useMyRole();
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
  const maintenance = Math.round((yearlyMaintenance(c.infrastructure) * econ.costFactor * (client.world?.state.inflation.costs ?? 1)) / 12);
  const yearTotal = ledgerTotal(sumLedgers(quarters));
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
            {LEDGER_CATEGORIES.map((cat) => (
              <tr key={cat}>
                <td>{LEDGER_LABELS[cat]}</td>
                {quarters.map((q) => (
                  <td key={`${q.year}-${q.quarter}`}>
                    <Money v={q.ledger[cat]} />
                  </td>
                ))}
              </tr>
            ))}
            <tr className="total">
              <td>Total</td>
              {quarters.map((q) => (
                <td key={`${q.year}-${q.quarter}`}>
                  <Money v={ledgerTotal(q.ledger)} />
                </td>
              ))}
            </tr>
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
        <span>Last 4 quarters</span>
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

      <h4>Infrastructure</h4>
      <div className="kv">
        <span>Track</span>
        <span className="mono">{c.infrastructure.track} pieces</span>
        <span>Station tiles</span>
        <span className="mono">{c.infrastructure.stations}</span>
        <span>Depots</span>
        <span className="mono">{c.infrastructure.depots}</span>
        <span>Signals</span>
        <span className="mono">{c.infrastructure.signals}</span>
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
