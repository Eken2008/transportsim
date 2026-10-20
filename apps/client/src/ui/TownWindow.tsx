import { COMPANY_COLORS, REPUTATION_NEW_STATION, reputationLabel, reputationOf } from '@transportsim/shared';
import { client } from '../net/client.ts';
import { useApp, type GameWindow } from '../store.ts';
import { Win, focusOn, useTick } from './windows.tsx';

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
  const served = town.served ?? 0;
  return (
    <Win w={w} title={town.name} width={330}>
      <div className="kv">
        <span>Population</span>
        <b className="mono">{town.population.toLocaleString('en-GB')}</b>
        <span>Buildings</span>
        <span className="mono">{town.houses}</span>
        <span>Growth</span>
        <span>{every ? `about every ${every} days` : '—'}</span>
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
            Demolishing the town's buildings and streets costs reputation; stations that vehicles call at often win it back.
            At Poor or worse the council allows no new stations, and it refuses demolition that would leave a company Very
            poor.
          </p>
        </>
      )}
      <p className="muted small">
        Towns grow faster with stations that trains call at often and that are well rated, and with at least 30 crates of
        goods and 30 tonnes of food delivered a month.
      </p>
      <button className="ghost" style={{ width: '100%' }} onClick={() => focusOn(town.x, town.y)}>
        ⌖ Locate
      </button>
    </Win>
  );
}
