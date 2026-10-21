import { CLIMATE_NAMES, COMPANY_COLORS, ECONOMY, formatDate } from '@transportsim/shared';
import { useState } from 'react';
import { client } from '../net/client.ts';
import { useApp, type GameWindow } from '../store.ts';
import { formatMoney } from './format.ts';
import { Win } from './windows.tsx';

const TIMELINE = { era: 'Eras: vehicles unlock over time', sandbox: 'Sandbox: everything available' };
const ACCIDENTS = {
  off: 'Off',
  low: 'Low: trains crash only where signalling is clearly unsafe',
  realistic: 'Realistic: shorter sight, brake failures and derailments',
};
const ROUGHNESS = { flat: 'Flat', hilly: 'Hilly', mountainous: 'Mountainous' };
const CLIMATE_INFO = {
  temperate: 'green land, snow only on the highest peaks',
  arctic: 'snow above the snow line, where towns need food to grow',
  tropical: 'desert and rainforest; desert towns need food and water to grow',
};

/** Game settings and players; the host can rename the game, change slots and visibility, and remove players. */
export function GameInfoWindow({ w }: { w: GameWindow & { kind: 'game' } }) {
  const room = useApp((s) => s.room)!;
  const global = useApp((s) => s.global);
  const limits = useApp((s) => s.limits);
  const s = room.settings;
  const econ = ECONOMY[s.economy];
  const host = room.isHost;

  return (
    <Win w={w} title="Game" width={420}>
      {host ? <HostSettings key={`${s.name}|${s.maxPlayers}|${s.isPublic}`} maxSlots={limits?.maxPlayers ?? s.maxPlayers} /> : null}
      <div className="kv">
        {!host && (
          <>
            <span>Name</span>
            <b>{s.name}</b>
            <span>Players</span>
            <span className="mono">up to {s.maxPlayers}</span>
            <span>Listed</span>
            <span>{s.isPublic ? 'Publicly' : 'By code only'}</span>
          </>
        )}
        <span>Code</span>
        <b className="mono">{room.id}</b>
        <span>Map</span>
        <span className="mono">
          {s.mapWidth} × {s.mapHeight} · seed {s.seed}
        </span>
        <span>Climate</span>
        <span>
          {CLIMATE_NAMES[s.climate ?? 'temperate']}: {CLIMATE_INFO[s.climate ?? 'temperate']}
        </span>
        <span>Terrain</span>
        <span>
          {ROUGHNESS[s.roughness]}, sea level {Math.round(s.waterLevel * 100)}%, trees {Math.round(s.treeDensity * 100)}%, rivers {Math.round((s.rivers ?? 1) * 100)}%
        </span>
        <span>Timeline</span>
        <span>
          {TIMELINE[s.timeline]} (from {s.startYear})
        </span>
        <span>Economy</span>
        <span>
          {s.economy[0]!.toUpperCase() + s.economy.slice(1)}: {formatMoney(econ.startMoney)} to start, loans up to {formatMoney(econ.maxLoan)} at{' '}
          {(econ.interestRate * 100).toFixed(1)}%
        </span>
        <span>Accidents</span>
        <span>
          {ACCIDENTS[s.accidents]} <span className="muted small">(level crossings with road vehicles arrive later)</span>
        </span>
        <span>Breakdowns</span>
        <span>{s.breakdowns ? 'On' : 'Off'}</span>
        <span>Bribery</span>
        <span>{s.bribery ? 'Town councils can be bribed' : 'Off'}</span>
        <span>Inflation</span>
        <span>{s.inflation ? 'On: costs +3% and payments +2.5% a year' : 'Off'}</span>
        <span>Market prices</span>
        <span>{s.dynamicPrices ? 'On: cargo prices follow supply, demand and world events' : 'Off: every cargo pays its normal rate'}</span>
        <span>Date</span>
        <span className="mono">{global ? formatDate(global.date) : '—'}</span>
      </div>
      <h4>Players</h4>
      {(global?.players ?? []).map((p) => {
        const c = global?.companies.find((x) => x.id === p.companyId);
        return (
          <div className="list-row" key={p.id}>
            <span className={`status-dot ${p.connected ? 'open' : ''}`} title={p.connected ? 'Online' : 'Away'} />
            <b style={{ flex: 1 }}>
              {p.name}
              {p.isHost && <span className="muted small"> · host</span>}
            </b>
            {c ? (
              <span className="small row">
                <span className="company-swatch tiny" style={{ background: COMPANY_COLORS[c.color] }} /> {c.name}
              </span>
            ) : (
              <span className="muted small">Spectating</span>
            )}
            {host && !p.isHost && (
              <button className="ghost small danger" onClick={() => confirm(`Remove ${p.name} from the game? They can't rejoin it.`) && client.kick(p.id)}>
                Remove
              </button>
            )}
          </div>
        );
      })}
    </Win>
  );
}

function HostSettings({ maxSlots }: { maxSlots: number }) {
  const s = useApp((st) => st.room!.settings);
  const [name, setName] = useState(s.name);
  const [slots, setSlots] = useState(s.maxPlayers);
  const changed = name.trim() !== s.name || slots !== s.maxPlayers;
  return (
    <form
      className="host-settings"
      onSubmit={(e) => {
        e.preventDefault();
        client.updateSettings({ name, maxPlayers: slots });
      }}
    >
      <label className="field">
        <span>Game name</span>
        <input value={name} maxLength={48} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="row" style={{ marginBottom: 10 }}>
        <label className="row">
          Player slots
          <input
            type="number"
            min={1}
            max={maxSlots}
            value={slots}
            style={{ width: 64 }}
            onChange={(e) => setSlots(Math.max(1, Math.min(maxSlots, Math.round(+e.target.value || 1))))}
          />
        </label>
        <label className="row" title="Show this game in the lobby list; otherwise players join with the code">
          <input type="checkbox" checked={s.isPublic} onChange={(e) => client.updateSettings({ isPublic: e.target.checked })} />
          List publicly
        </label>
        <div className="spacer" />
        <button className="primary" disabled={!changed || !name.trim()}>
          Save
        </button>
      </div>
    </form>
  );
}
