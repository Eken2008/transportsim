import { COMPANY_COLORS, COMPANY_ROLES, ROLE_LABELS, roleAllows, type Company, type CompanyRole } from '@transportsim/shared';
import { useState } from 'react';
import { openWindow, useApp, type GameWindow } from '../store.ts';
import { formatMoney } from './format.ts';
import { Win, act, useMyRole } from './windows.tsx';

/** Membership: found or join a company, answer requests, invite players, manage roles. */
export function CompanyWindow({ w }: { w: GameWindow & { kind: 'company' } }) {
  const global = useApp((s) => s.global);
  const room = useApp((s) => s.room);
  const my = useMyRole();
  if (!global || !room) return null;
  const me = global.players.find((p) => p.id === room.playerId);
  const mine = global.companies.find((c) => c.id === my.companyId);
  const invites = global.companies.filter((c) => c.invites.some((m) => m.name === me?.name));
  const others = global.companies.filter((c) => c !== mine).sort((a, b) => a.id - b.id);

  return (
    <Win w={w} title={mine ? mine.name : 'Companies'} width={400}>
      {invites.map((c) => (
        <div className="list-row invite" key={c.id}>
          <Swatch color={c.color} />
          <span style={{ flex: 1 }}>
            <b>{c.name}</b> invites you to join as {ROLE_LABELS[c.invites.find((m) => m.name === me?.name)!.role].toLowerCase()}
          </span>
          <button className="primary" onClick={() => act({ type: 'joinCompany', company: c.id })}>
            Accept
          </button>
          <button className="ghost" onClick={() => act({ type: 'cancelJoin', company: c.id })}>
            Decline
          </button>
        </div>
      ))}
      {mine && my.role ? <MyCompany c={mine} role={my.role} /> : <FoundCompany />}
      <h4>{mine ? 'Other companies' : 'Join a company'}</h4>
      {others.length === 0 && <p className="muted">No other companies yet.</p>}
      {others.map((c) => {
        const asked = !!me && c.requests.includes(me.name);
        const owner = c.members.find((m) => m.role === 'owner');
        return (
          <div className="list-row" key={c.id}>
            <Swatch color={c.color} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>{c.name}</b>
              <div className="muted small">
                {c.members.length === 0 ? 'No members' : `${owner?.name ?? '?'}${c.members.length > 1 ? ` + ${c.members.length - 1}` : ''}`}
              </div>
            </div>
            {c.members.length === 0 ? (
              <button title="Nobody runs this company: become its owner" onClick={() => act({ type: 'joinCompany', company: c.id })}>
                Take over
              </button>
            ) : asked ? (
              <button className="ghost" title="Withdraw your request" onClick={() => act({ type: 'cancelJoin', company: c.id })}>
                Asked ✓
              </button>
            ) : (
              <button onClick={() => act({ type: 'joinCompany', company: c.id })}>Ask to join</button>
            )}
          </div>
        );
      })}
    </Win>
  );
}

function MyCompany({ c, role }: { c: Company; role: CompanyRole }) {
  const global = useApp((s) => s.global)!;
  const isOwner = role === 'owner';
  const canManage = roleAllows(role, 'members');
  const online = new Set(global.players.filter((p) => p.connected).map((p) => p.name));
  const outsiders = global.players.filter((p) => !c.members.some((m) => m.name === p.name) && !c.invites.some((m) => m.name === p.name));
  const joinRoles = COMPANY_ROLES.filter((r) => r !== 'owner' && (isOwner || r !== 'manager'));

  return (
    <>
      <div className="kv">
        <span>Your role</span>
        <b>{ROLE_LABELS[role]}</b>
        <span>Money</span>
        <b className={`mono ${c.money < 0 ? 'neg' : ''}`}>{formatMoney(c.money)}</b>
      </div>
      <div className="row" style={{ marginTop: 8 }}>
        <button style={{ flex: 1 }} onClick={() => openWindow({ kind: 'finances', id: c.id })} title="Finances (F)">
          💰 Finances
        </button>
        <button style={{ flex: 1 }} onClick={() => openWindow({ kind: 'league', id: 0 })} title="Company league (L)">
          🏆 League
        </button>
      </div>
      {isOwner && <CompanySettings c={c} />}

      <h4>Members</h4>
      {c.members.map((m) => (
        <div className="list-row" key={m.name}>
          <span className={`status-dot ${online.has(m.name) ? 'open' : ''}`} title={online.has(m.name) ? 'Online' : 'Away'} />
          <b style={{ flex: 1 }}>{m.name}</b>
          {isOwner && m.role !== 'owner' ? (
            <>
              <select
                value={m.role}
                aria-label={`Role of ${m.name}`}
                onChange={(e) => {
                  const r = e.target.value as CompanyRole;
                  if (r === 'owner' && !confirm(`Hand over ownership of ${c.name} to ${m.name}? You become a manager.`)) return;
                  act({ type: 'setMemberRole', name: m.name, role: r });
                }}
              >
                {COMPANY_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
              <button className="ghost small" aria-label={`Remove ${m.name}`} onClick={() => confirm(`Remove ${m.name} from ${c.name}?`) && act({ type: 'removeMember', name: m.name })}>
                ✕
              </button>
            </>
          ) : (
            <span className="muted small">{ROLE_LABELS[m.role]}</span>
          )}
        </div>
      ))}

      {canManage && c.requests.length > 0 && (
        <>
          <h4>Asking to join</h4>
          {c.requests.map((name) => (
            <RequestRow key={name} name={name} roles={joinRoles} />
          ))}
        </>
      )}

      {canManage && <InviteForm outsiders={outsiders.map((p) => p.name)} roles={joinRoles} c={c} />}

      <button
        className="danger"
        style={{ width: '100%', marginTop: 12 }}
        onClick={() => {
          const last = c.members.length === 1;
          const msg = last
            ? `Leave ${c.name}? It keeps running without members, and anyone can take it over.`
            : isOwner
              ? `Leave ${c.name}? Ownership passes to the most senior member.`
              : `Leave ${c.name}?`;
          if (confirm(msg)) act({ type: 'leaveCompany' });
        }}
      >
        Leave company
      </button>
    </>
  );
}

function RequestRow({ name, roles }: { name: string; roles: CompanyRole[] }) {
  const [role, setRole] = useState<CompanyRole>('operator');
  return (
    <div className="list-row">
      <b style={{ flex: 1 }}>{name}</b>
      <select value={role} onChange={(e) => setRole(e.target.value as CompanyRole)} aria-label={`Role for ${name}`}>
        {roles.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABELS[r]}
          </option>
        ))}
      </select>
      <button className="primary" onClick={() => act({ type: 'answerJoin', name, accept: true, role })}>
        Accept
      </button>
      <button className="ghost" onClick={() => act({ type: 'answerJoin', name, accept: false })}>
        Decline
      </button>
    </div>
  );
}

function InviteForm({ outsiders, roles, c }: { outsiders: string[]; roles: CompanyRole[]; c: Company }) {
  const [name, setName] = useState('');
  const [role, setRole] = useState<CompanyRole>('operator');
  const target = outsiders.includes(name) ? name : (outsiders[0] ?? '');
  return (
    <>
      <h4>Invite a player</h4>
      {outsiders.length === 0 ? (
        <p className="muted small">Everyone in this game is already a member or invited.</p>
      ) : (
        <div className="row">
          <select value={target} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 0 }} aria-label="Player to invite">
            {outsiders.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
          <select value={role} onChange={(e) => setRole(e.target.value as CompanyRole)} aria-label="Role">
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </select>
          <button onClick={() => target && act({ type: 'invitePlayer', name: target, role })}>Invite</button>
        </div>
      )}
      {c.invites.map((m) => (
        <div className="list-row" key={m.name}>
          <span style={{ flex: 1 }}>
            {m.name} <span className="muted small">invited as {ROLE_LABELS[m.role].toLowerCase()}</span>
          </span>
          <button className="ghost small" aria-label={`Withdraw invitation to ${m.name}`} onClick={() => act({ type: 'invitePlayer', name: m.name, cancel: true })}>
            ✕
          </button>
        </div>
      ))}
    </>
  );
}

function CompanySettings({ c }: { c: Company }) {
  const [name, setName] = useState(c.name);
  return (
    <>
      <h4>Company</h4>
      <form
        className="row"
        onSubmit={(e) => {
          e.preventDefault();
          act({ type: 'companySettings', name });
        }}
      >
        <input value={name} maxLength={40} onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 0 }} aria-label="Company name" />
        <button disabled={name.trim() === c.name || !name.trim()}>Rename</button>
      </form>
      <Palette value={c.color} self={c.id} onPick={(color) => act({ type: 'companySettings', color })} />
    </>
  );
}

function FoundCompany() {
  const global = useApp((s) => s.global)!;
  const room = useApp((s) => s.room)!;
  const me = global.players.find((p) => p.id === room.playerId);
  const used = new Set(global.companies.map((c) => c.color));
  const [name, setName] = useState(() => (me ? `${me.name} Transport` : ''));
  const [color, setColor] = useState(() => Math.max(0, COMPANY_COLORS.findIndex((_, i) => !used.has(i))));
  return (
    <>
      <p className="muted" style={{ marginTop: 0 }}>
        You are spectating. Found your own company, or ask to join one below.
      </p>
      <h4>Found a company</h4>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          act({ type: 'foundCompany', name, color });
        }}
      >
        <div className="row">
          <input value={name} maxLength={40} placeholder="Company name" onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 0 }} aria-label="Company name" />
          <button className="primary" disabled={!name.trim() || used.has(color)}>
            Found
          </button>
        </div>
        <Palette value={color} onPick={setColor} />
      </form>
    </>
  );
}

function Palette({ value, self, onPick }: { value: number; self?: number; onPick: (color: number) => void }) {
  const companies = useApp((s) => s.global?.companies ?? []);
  return (
    <div className="palette" role="radiogroup" aria-label="Company colour">
      {COMPANY_COLORS.map((hex, i) => {
        const takenBy = companies.find((c) => c.color === i && c.id !== self);
        return (
          <button
            type="button"
            key={hex}
            role="radio"
            aria-checked={value === i}
            aria-label={takenBy ? `Colour ${i + 1} (used by ${takenBy.name})` : `Colour ${i + 1}`}
            title={takenBy ? `Used by ${takenBy.name}` : undefined}
            className={value === i ? 'sel' : ''}
            disabled={!!takenBy}
            style={{ background: hex }}
            onClick={() => onPick(i)}
          />
        );
      })}
    </div>
  );
}

function Swatch({ color }: { color: number }) {
  return <span className="company-swatch" style={{ background: COMPANY_COLORS[color % COMPANY_COLORS.length] }} />;
}
