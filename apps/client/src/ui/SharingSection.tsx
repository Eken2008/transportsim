import { COMPANY_COLORS, MAX_SHARING_FEE, formatDate, type Agreement, type Company } from '@transportsim/shared';
import { useState } from 'react';
import { useApp } from '../store.ts';
import { formatMoney } from './format.ts';
import { act } from './windows.tsx';

/** Track sharing agreements of company `c`; managers and the owner can propose, answer and end them. */
export function SharingSection({ c, canAct }: { c: Company; canAct: boolean }) {
  const global = useApp((s) => s.global)!;
  const mine = global.agreements.filter((a) => a.host === c.id || a.guest === c.id);
  const others = global.companies.filter((o) => o.id !== c.id);
  return (
    <>
      <h4>Track sharing</h4>
      {mine.length === 0 && <p className="muted small">No agreements. Let another company run trains on your track for a fee, or ask to use theirs.</p>}
      {mine.map((a) => (
        <AgreementRow key={a.id} a={a} me={c.id} canAct={canAct} />
      ))}
      {canAct && others.length > 0 && <ProposeForm others={others} />}
    </>
  );
}

function AgreementRow({ a, me, canAct }: { a: Agreement; me: number; canAct: boolean }) {
  const partnerId = a.host === me ? a.guest : a.host;
  const partner = useApp((s) => s.global?.companies.find((c) => c.id === partnerId));
  const what = a.stations ? 'track and stations' : 'track';
  const text = a.host === me ? `${partner?.name ?? '?'} may use our ${what}` : `We may use ${partner?.name ?? '?'}'s ${what}`;
  const fee = a.fee > 0 ? `${formatMoney(a.fee)} per train per day` : 'free';
  const theyProposed = a.status === 'proposed' && a.proposedBy !== me;
  return (
    <div className={`list-row ${theyProposed ? 'invite' : ''}`}>
      <span className="company-swatch" style={{ background: partner ? COMPANY_COLORS[partner.color] : '#888' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>{text}</div>
        <div className="muted small">
          {fee} ·{' '}
          {a.status === 'active' ? `since ${formatDate(a.since)}` : theyProposed ? 'they propose this' : 'waiting for their answer'}
        </div>
      </div>
      {canAct && theyProposed && (
        <>
          <button className="primary" onClick={() => act({ type: 'answerSharing', id: a.id, accept: true })}>
            Accept
          </button>
          <button className="ghost" onClick={() => act({ type: 'answerSharing', id: a.id, accept: false })}>
            Decline
          </button>
        </>
      )}
      {canAct && !theyProposed && (
        <button
          className="ghost"
          onClick={() => {
            if (a.status === 'active' && !confirm(`End this agreement? ${a.host === me ? 'Their' : 'Our'} trains on ${a.host === me ? 'our' : 'their'} track are towed home.`)) return;
            act({ type: 'endSharing', id: a.id });
          }}
        >
          {a.status === 'active' ? 'End' : 'Withdraw'}
        </button>
      )}
    </div>
  );
}

function ProposeForm({ others }: { others: Company[] }) {
  const [partner, setPartner] = useState<number>(others[0]!.id);
  const [role, setRole] = useState<'host' | 'guest'>('host');
  const [stations, setStations] = useState(true);
  const [fee, setFee] = useState(500);
  const target = others.some((o) => o.id === partner) ? partner : others[0]!.id;
  return (
    <form
      className="propose"
      onSubmit={(e) => {
        e.preventDefault();
        act({ type: 'proposeSharing', partner: target, role, stations, fee });
      }}
    >
      <div className="row">
        <select value={role} onChange={(e) => setRole(e.target.value as 'host' | 'guest')} aria-label="Direction">
          <option value="host">Let</option>
          <option value="guest">Ask to use</option>
        </select>
        <select value={target} onChange={(e) => setPartner(Number(e.target.value))} style={{ flex: 1, minWidth: 0 }} aria-label="Company">
          {others.map((o) => (
            <option key={o.id} value={o.id}>
              {o.name}
            </option>
          ))}
        </select>
        <span className="muted small">{role === 'host' ? 'use our track' : "'s track"}</span>
      </div>
      <div className="row" style={{ marginTop: 6 }}>
        <label className="row small">
          <input type="checkbox" checked={stations} onChange={(e) => setStations(e.target.checked)} />
          and stations
        </label>
        <label className="row small" style={{ flex: 1, justifyContent: 'flex-end' }}>
          Fee £
          <input
            type="number"
            min={0}
            max={MAX_SHARING_FEE}
            step={50}
            value={fee}
            style={{ width: 80 }}
            aria-label="Fee per train per day"
            onChange={(e) => setFee(Math.max(0, Math.min(MAX_SHARING_FEE, Math.round(+e.target.value || 0))))}
          />
          /train/day
        </label>
        <button>Propose</button>
      </div>
    </form>
  );
}
