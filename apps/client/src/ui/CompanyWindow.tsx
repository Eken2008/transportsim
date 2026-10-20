import {
  COMPANY_COLORS,
  COMPANY_ROLES,
  HQ_SIZE_NAMES,
  RAIL_VEHICLES,
  ROLE_LABELS,
  hqSizeFor,
  cargoesIn,
  isAvailable,
  railVehicle,
  roleAllows,
  ymdFromDays,
  type Company,
  type CompanyRole,
} from '@transportsim/shared';
import { useState } from 'react';
import { openWindow, useApp, type GameWindow } from '../store.ts';
import { formatMoney } from './format.ts';
import { Win, act, focusHq, useMyRole } from './windows.tsx';
import { SharingSection } from './SharingSection.tsx';

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
      <Headquarters c={c} canBuild={roleAllows(role, 'build')} />
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

      <SharingSection c={c} canAct={roleAllows(role, 'build')} />

      <VehiclePolicy c={c} canAct={roleAllows(role, 'build')} />

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

/** Where the company's headquarters stand, with buttons to look at them and to build or move them. */
function Headquarters({ c, canBuild }: { c: Company; canBuild: boolean }) {
  const tool = useApp((s) => s.tool);
  const placing = tool === 'headquarters';
  return (
    <>
      <div className="row" style={{ marginTop: 8 }}>
        <span style={{ flex: 1 }} className="small">
          🏢 Headquarters: {c.hq === undefined ? <span className="muted">not built yet</span> : <b>{HQ_SIZE_NAMES[hqSizeFor(c.value)]}</b>}
        </span>
        {c.hq !== undefined && (
          <button className="ghost" onClick={() => focusHq(c.hq!)}>
            ⌖ View
          </button>
        )}
        {canBuild && (
          <button
            className={placing ? 'primary' : ''}
            title="Pick a 2×2 spot of open land; headquarters grow as the company's value grows"
            onClick={() => useApp.setState({ tool: placing ? null : 'headquarters' })}
          >
            {placing ? 'Cancel' : c.hq === undefined ? 'Build…' : 'Move…'}
          </button>
        )}
      </div>
      {placing && (
        <p className="muted small" style={{ margin: '4px 0 0' }}>
          Click a 2×2 spot of open land on the map{c.hq === undefined ? '' : ' to move your headquarters there'}. Esc cancels.
        </p>
      )}
    </>
  );
}

/** Autorenew and replacement rules, applied when trains visit a depot. */
function VehiclePolicy({ c, canAct }: { c: Company; canAct: boolean }) {
  const date = useApp((s) => s.global?.date ?? 0);
  const timeline = useApp((s) => s.room?.settings.timeline ?? 'era');
  const climate = useApp((s) => s.room?.settings.climate ?? 'temperate');
  const year = ymdFromDays(date).year;
  const [from, setFrom] = useState(RAIL_VEHICLES[0]!.id);
  const fromType = railVehicle(from)!;
  const targets = RAIL_VEHICLES.filter((v) => v.kind === fromType.kind && v.id !== from && isAvailable(v, year, timeline, climate));
  const [to, setTo] = useState('');
  const target = targets.some((v) => v.id === to) ? to : (targets[0]?.id ?? '');
  const rules = Object.entries(c.replace);
  return (
    <>
      <h4>Vehicles</h4>
      <label className="row small" title="When a train older than its design life visits a depot, its vehicles are replaced with new ones of the same types">
        <input type="checkbox" disabled={!canAct} checked={c.autorenew} onChange={(e) => act({ type: 'vehicleSettings', autorenew: e.target.checked })} />
        Renew trains that outlive their design life (at a depot visit)
      </label>
      {rules.map(([f, t]) => (
        <div className="list-row" key={f}>
          <span style={{ flex: 1 }} className="small">
            Replace <b>{railVehicle(f)?.name ?? f}</b> with <b>{railVehicle(t)?.name ?? t}</b>
          </span>
          {canAct && (
            <button className="ghost small" aria-label="Remove rule" onClick={() => act({ type: 'vehicleSettings', replace: { from: f, to: null } })}>
              ✕
            </button>
          )}
        </div>
      ))}
      {canAct && (
        <div className="row wrap" style={{ marginTop: 6 }}>
          <select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Replace" style={{ flex: 1, minWidth: 0 }}>
            {RAIL_VEHICLES.filter((v) => !v.cargoes || cargoesIn(v, climate).length).map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          →
          <select value={target} onChange={(e) => setTo(e.target.value)} aria-label="With" style={{ flex: 1, minWidth: 0 }}>
            {targets.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          <button disabled={!target} onClick={() => act({ type: 'vehicleSettings', replace: { from, to: target } })}>
            Add rule
          </button>
        </div>
      )}
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
