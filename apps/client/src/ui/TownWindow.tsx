import { client } from '../net/client.ts';
import { useApp, type GameWindow } from '../store.ts';
import { Win, focusOn, useTick } from './windows.tsx';

/** A town: size, how fast it grows, and what its stations handled last month. */
export function TownWindow({ w }: { w: GameWindow & { kind: 'town' } }) {
  useTick(1000);
  useApp((s) => s.global?.date);
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
