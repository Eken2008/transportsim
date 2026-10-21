import { useState } from 'react';
import {
  CARGOS,
  COMPANY_COLORS,
  REPUTATION_NEW_STATION,
  TOWN_ACTIONS,
  TOWN_ACTION_INFO,
  TOWN_NEED,
  formatDate,
  reputationLabel,
  reputationOf,
  townActionCost,
  townNeeds,
  type Town,
  type TownAction,
} from '@transportsim/shared';
import { client } from '../net/client.ts';
import { useApp, type GameWindow } from '../store.ts';
import { formatMoney } from './format.ts';
import { Win, act, focusOn, useTick } from './windows.tsx';

/** A town: size, how fast it grows, what its stations handled last month, and what its council thinks of each company. */
export function TownWindow({ w }: { w: GameWindow & { kind: 'town' } }) {
  useTick(1000);
  useApp((s) => s.global?.date);
  const companies = useApp((s) => s.global?.companies ?? []);
  const myCompany = useApp((s) => s.global?.players.find((p) => p.id === s.room?.playerId)?.companyId ?? null);
  const town = client.world?.state.towns.get(w.id);
  if (!town) {
    return (
      <Win w={w} title="Town">
        <p className="muted">Unknown town.</p>
      </Win>
    );
  }
  const last = town.lastStats;
  const every = town.growthRate ? Math.round(1 / town.growthRate) : null;
  const map = client.world?.map;
  const needs = map ? townNeeds(map, town) : [];
  const lacking = needs.filter((c) => (last?.[c] ?? 0) < TOWN_NEED);
  const tropical = map?.climate.id === 'tropical';
  const served = town.served ?? 0;
  const date = client.world?.state.date ?? 0;
  const nameOf = (id: number) => companies.find((c) => c.id === id)?.name ?? 'A former company';
  const running = (g: { until: number } | undefined): g is { company: number; until: number } => g !== undefined && g.until > date;
  const shunned = myCompany === null ? undefined : town.unwanted?.[myCompany];
  const effects = [
    town.statues?.length ? `Statue${town.statues.length === 1 ? '' : 's'} of ${town.statues.map(nameOf).join(', ')}` : null,
    running(town.exclusive) ? `${nameOf(town.exclusive.company)} holds exclusive transport rights until ${formatDate(town.exclusive.until)}` : null,
    running(town.funded) ? `New buildings funded by ${nameOf(town.funded.company)} until ${formatDate(town.funded.until)}` : null,
    running(town.roadWorks) ? `Road reconstruction funded by ${nameOf(town.roadWorks.company)} until ${formatDate(town.roadWorks.until)}` : null,
    shunned !== undefined && shunned > date ? `After the bribery scandal the council won’t deal with you until ${formatDate(shunned)}` : null,
  ].filter((e): e is string => e !== null);
  return (
    <Win w={w} title={town.name} width={360}>
      <div className="kv">
        <span>Population</span>
        <b className="mono">{town.population.toLocaleString('en-GB')}</b>
        <span>Buildings</span>
        <span className="mono">{town.houses}</span>
        <span>Growth</span>
        <span>{every ? `about every ${every} days` : '—'}</span>
        {needs.length > 0 && (
          <>
            <span>Needs</span>
            <span className={lacking.length ? 'err' : undefined}>
              {needs.join(' and ')} ({map?.climate.id === 'arctic' ? 'above the snow line' : 'in the desert'})
              {lacking.length ? ` — short of ${lacking.join(' and ')}, not growing` : ''}
            </span>
          </>
        )}
        <span>Served by</span>
        <span>
          {served === 0 ? 'no busy stations' : `${served} busy station${served === 1 ? '' : 's'}`}
        </span>
      </div>
      <h4>Last month</h4>
      <div className="kv">
        <span>Passengers</span>
        <span className="mono">{last?.passengers ?? 0} picked up</span>
        <span>Mail</span>
        <span className="mono">{last?.mail ?? 0} bags picked up</span>
        <span>Goods</span>
        <span className="mono">{last?.goods ?? 0} delivered</span>
        <span>Food</span>
        <span className="mono">{last?.food ?? 0} delivered</span>
        <span>Building materials</span>
        <span className="mono">{last?.building_materials ?? 0} delivered</span>
        {tropical && (
          <>
            <span>Water</span>
            <span className="mono">{last?.water ?? 0} delivered</span>
          </>
        )}
      </div>
      {companies.length > 0 && (
        <>
          <h4>Reputation with the council</h4>
          <div className="kv">
            {[...companies]
              .sort((a, b) => Number(b.id === myCompany) - Number(a.id === myCompany))
              .map((c) => {
                const r = reputationOf(town, c.id);
                return [
                  <span key={`n${c.id}`}>
                    <span className="company-swatch tiny" style={{ background: COMPANY_COLORS[c.color % COMPANY_COLORS.length] }} /> {c.name}
                  </span>,
                  <span key={`r${c.id}`} className={r < REPUTATION_NEW_STATION ? 'err' : undefined}>
                    {c.id === myCompany ? <b>{reputationLabel(r)}</b> : reputationLabel(r)} <span className="mono muted">({r})</span>
                  </span>,
                ];
              })}
          </div>
          <p className="muted small">
            Demolishing the town's buildings and streets costs reputation; stations that vehicles call at often win it back,
            as do statues and bribes. At Poor or worse the council allows no new stations, and it refuses demolition that
            would leave a company Very poor.
          </p>
        </>
      )}
      {effects.length > 0 && (
        <>
          <h4>In effect</h4>
          <ul className="small" style={{ margin: '0 0 8px', paddingLeft: 18 }}>
            {effects.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
        </>
      )}
      {myCompany !== null && <CouncilActions town={town} />}
      <p className="muted small">
        Towns grow faster with stations that trains call at often and that are well rated, and with at least 30 crates of
        goods and 30 tonnes of food delivered a month.
        {needs.length > 0 &&
          ` This town only grows with at least ${needs.map((c) => `${TOWN_NEED} ${CARGOS[c].unit} of ${c}`).join(' and ')} delivered each month, or with funded buildings.`}
      </p>
      <button className="ghost" style={{ width: '100%' }} onClick={() => focusOn(town.x, town.y)}>
        ⌖ Locate
      </button>
    </Win>
  );
}

/** What the player's company can pay the council for; the dry run gives each action's cost or why it can't be had. */
function CouncilActions({ town }: { town: Town }) {
  const [open, setOpen] = useState<TownAction | null>(null);
  const state = client.world?.state;
  if (!state) return null;
  const actions = TOWN_ACTIONS.filter((a) => a !== 'bribe' || state.settings.bribery);
  return (
    <>
      <h4>Town council</h4>
      {actions.map((a) => {
        const cmd = { type: 'townAction', town: town.id, action: a } as const;
        const r = client.preview(cmd);
        const ok = r?.ok === true;
        const info = TOWN_ACTION_INFO[a];
        return (
          <div key={a}>
            <div className="list-row" style={{ cursor: 'pointer' }} onClick={() => setOpen(open === a ? null : a)} title={ok ? info.about : r?.error}>
              <span style={{ flex: 1 }} className={ok ? undefined : 'muted'}>
                {open === a ? '▾' : '▸'} {info.name}
              </span>
              <span className="mono small">{formatMoney(townActionCost(state, a))}</span>
            </div>
            {open === a && (
              <div className="small" style={{ padding: '6px 0 8px 14px' }}>
                <p style={{ margin: '0 0 6px' }}>{info.about}</p>
                {ok ? (
                  <button
                    className="primary"
                    onClick={() => {
                      act(cmd);
                      setOpen(null);
                    }}
                  >
                    Pay {formatMoney(r.cost)}
                  </button>
                ) : (
                  <span className="neg">{r?.error ?? 'Not available'}</span>
                )}
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
