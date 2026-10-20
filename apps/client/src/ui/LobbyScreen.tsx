import {
  DEFAULT_SETTINGS,
  MAP_SIZES,
  formatDate,
  type AccidentSeverity,
  type EconomyDifficulty,
  type GameSettings,
  type TerrainRoughness,
  type TimelineMode,
} from '@transportsim/shared';
import { useEffect, useRef, useState } from 'react';
import { client } from '../net/client.ts';
import { getPlayerName, setPlayerName } from '../net/identity.ts';
import { deleteSave, exportSave, importSave, loadSaveBytes, type SaveRecord } from '../saves/saveStore.ts';
import { toast, useApp } from '../store.ts';
import { formatBytes, timeAgo } from './format.ts';

export function LobbyScreen() {
  const conn = useApp((s) => s.conn);
  const closedReason = useApp((s) => s.closedReason);
  const busy = useApp((s) => s.busy);
  const [name, setName] = useState(getPlayerName());

  useEffect(() => {
    if (conn !== 'open') return;
    const id = setInterval(() => client.listRooms(), 5000);
    return () => clearInterval(id);
  }, [conn]);

  const commitName = () => {
    const n = name.trim().slice(0, 24);
    setPlayerName(n);
    client.setName();
  };

  return (
    <div className="lobby">
      <div className="lobby-inner">
        <header className="brand">
          <img src="/favicon.svg" width={48} height={48} alt="" />
          <div>
            <h1>TransportSim</h1>
            <p>Build railways, roads, ports and airports. Compete or cooperate with friends.</p>
          </div>
          <div className="spacer" />
          <div className="row muted" title="Server connection">
            <span className={`status-dot ${conn}`} />
            {conn === 'open' ? 'Connected' : conn === 'connecting' ? 'Connecting…' : 'Offline'}
          </div>
        </header>

        {closedReason && <div className="notice">Game ended: {closedReason}</div>}

        <div className="lobby-grid">
          <div style={{ display: 'grid', gap: 18, alignContent: 'start' }}>
            <section className="panel card">
              <h2>Your name</h2>
              <div className="row">
                <input
                  value={name}
                  maxLength={24}
                  placeholder="Player name"
                  onChange={(e) => setName(e.target.value)}
                  onBlur={commitName}
                  onKeyDown={(e) => e.key === 'Enter' && commitName()}
                  style={{ flex: 1 }}
                />
              </div>
            </section>
            <JoinCard disabled={conn !== 'open' || !!busy} onBeforeJoin={commitName} />
            <SavesCard disabled={conn !== 'open' || !!busy} onBeforeHost={commitName} />
          </div>
          <HostCard disabled={conn !== 'open' || !!busy} onBeforeHost={commitName} busy={busy} />
        </div>
      </div>
    </div>
  );
}

function JoinCard({ disabled, onBeforeJoin }: { disabled: boolean; onBeforeJoin: () => void }) {
  const rooms = useApp((s) => s.rooms);
  const [code, setCode] = useState('');
  const join = (id: string) => {
    onBeforeJoin();
    client.joinRoom(id);
  };
  return (
    <section className="panel card">
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Join a game</h2>
        <div className="spacer" />
        <button className="ghost" onClick={() => client.listRooms()} disabled={disabled}>
          Refresh
        </button>
      </div>
      <div className="room-list">
        {rooms.length === 0 && <div className="empty">No public games right now. Host one!</div>}
        {rooms.map((r) => (
          <div className="room" key={r.id}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>{r.name}</b>
              <span className="muted">
                {r.hostName} · {r.mapWidth}×{r.mapHeight} · {r.year} · {r.timeline === 'era' ? 'eras' : 'sandbox'} · {r.economy} economy
              </span>
            </div>
            <span className="mono muted">
              {r.players}/{r.maxPlayers}
            </span>
            <button className="primary" disabled={disabled || r.players >= r.maxPlayers} onClick={() => join(r.id)}>
              Join
            </button>
          </div>
        ))}
      </div>
      <form
        className="row"
        style={{ marginTop: 12 }}
        onSubmit={(e) => {
          e.preventDefault();
          if (code.trim()) join(code);
        }}
      >
        <input
          className="mono"
          placeholder="Game code"
          value={code}
          maxLength={8}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          style={{ flex: 1 }}
        />
        <button disabled={disabled || !code.trim()}>Join by code</button>
      </form>
    </section>
  );
}

function HostCard({ disabled, onBeforeHost, busy }: { disabled: boolean; onBeforeHost: () => void; busy: string | null }) {
  const limits = useApp((s) => s.limits);
  const maxPlayers = limits?.maxPlayers ?? 15;
  const sizes = MAP_SIZES.filter((s) => s <= (limits?.maxMapSize ?? 2048));
  const [s, setS] = useState<GameSettings>(() => ({
    ...DEFAULT_SETTINGS,
    name: '',
    seed: Math.floor(Math.random() * 1e9),
  }));
  const set = <K extends keyof GameSettings>(k: K, v: GameSettings[K]) => setS((p) => ({ ...p, [k]: v }));

  return (
    <section className="panel card">
      <h2>Host a new game</h2>
      <label className="field">
        <span>Game name</span>
        <input value={s.name} maxLength={48} placeholder={defaultGameName()} onChange={(e) => set('name', e.target.value)} />
      </label>
      <div className="form-grid">
        <label className="field">
          <span>Map size</span>
          <select
            value={`${s.mapWidth}x${s.mapHeight}`}
            onChange={(e) => {
              const [w, h] = e.target.value.split('x').map(Number);
              setS((p) => ({ ...p, mapWidth: w!, mapHeight: h! }));
            }}
          >
            {sizes.flatMap((w) =>
              sizes
                .filter((h) => h === w || h === w * 2 || h * 2 === w)
                .map((h) => (
                  <option key={`${w}x${h}`} value={`${w}x${h}`}>
                    {w} × {h}
                  </option>
                )),
            )}
          </select>
        </label>
        <label className="field">
          <span>Terrain</span>
          <select value={s.roughness} onChange={(e) => set('roughness', e.target.value as TerrainRoughness)}>
            <option value="flat">Flat</option>
            <option value="hilly">Hilly</option>
            <option value="mountainous">Mountainous</option>
          </select>
        </label>
        <label className="field">
          <span>Sea level · {Math.round(s.waterLevel * 100)}%</span>
          <input type="range" min={0} max={0.6} step={0.02} value={s.waterLevel} onChange={(e) => set('waterLevel', +e.target.value)} />
        </label>
        <label className="field">
          <span>Trees · {Math.round(s.treeDensity * 100)}%</span>
          <input type="range" min={0} max={2} step={0.1} value={s.treeDensity} onChange={(e) => set('treeDensity', +e.target.value)} />
        </label>
        <label className="field">
          <span>Rivers · {Math.round(s.rivers * 100)}%</span>
          <input type="range" min={0} max={2} step={0.1} value={s.rivers} onChange={(e) => set('rivers', +e.target.value)} />
        </label>
        <label className="field">
          <span>Timeline</span>
          <select value={s.timeline} onChange={(e) => set('timeline', e.target.value as TimelineMode)}>
            <option value="era">Eras — vehicles unlock over time</option>
            <option value="sandbox">Sandbox — everything available</option>
          </select>
        </label>
        <label className="field">
          <span>Start year</span>
          <input
            type="number"
            min={1850}
            max={2050}
            value={s.startYear}
            onChange={(e) => set('startYear', Math.round(+e.target.value))}
          />
        </label>
        <label className="field">
          <span>Accidents</span>
          <select value={s.accidents} onChange={(e) => set('accidents', e.target.value as AccidentSeverity)}>
            <option value="off">Off</option>
            <option value="low">Low — rare, forgiving</option>
            <option value="realistic">Realistic — unsafe setups crash</option>
          </select>
        </label>
        <label className="field">
          <span>Economy</span>
          <select value={s.economy} onChange={(e) => set('economy', e.target.value as EconomyDifficulty)}>
            <option value="easy">Easy</option>
            <option value="normal">Normal</option>
            <option value="hard">Hard</option>
          </select>
        </label>
        <label className="field">
          <span>Player slots · max {maxPlayers}</span>
          <input
            type="number"
            min={1}
            max={maxPlayers}
            value={Math.min(s.maxPlayers, maxPlayers)}
            onChange={(e) => set('maxPlayers', Math.max(1, Math.min(maxPlayers, Math.round(+e.target.value))))}
          />
        </label>
        <label className="field">
          <span>Seed</span>
          <div className="row">
            <input className="mono" style={{ flex: 1 }} type="number" value={s.seed} onChange={(e) => set('seed', Math.abs(Math.round(+e.target.value)))} />
            <button type="button" title="Random seed" onClick={() => set('seed', Math.floor(Math.random() * 1e9))}>
              🎲
            </button>
          </div>
        </label>
      </div>
      <div className="row" style={{ marginBottom: 14, gap: 16 }}>
        <label className="row">
          <input type="checkbox" checked={s.breakdowns} onChange={(e) => set('breakdowns', e.target.checked)} />
          Vehicle breakdowns
        </label>
        <label className="row" title="Costs rise 3% and payments 2.5% a year">
          <input type="checkbox" checked={s.inflation} onChange={(e) => set('inflation', e.target.checked)} />
          Inflation
        </label>
        <label className="row" title="Companies can bribe town councils (and may be caught)">
          <input type="checkbox" checked={s.bribery} onChange={(e) => set('bribery', e.target.checked)} />
          Bribery
        </label>
        <label className="row">
          <input type="checkbox" checked={s.isPublic} onChange={(e) => set('isPublic', e.target.checked)} />
          List publicly
        </label>
      </div>
      <button
        className="primary"
        style={{ width: '100%', padding: '10px 12px' }}
        disabled={disabled}
        onClick={() => {
          onBeforeHost();
          client.createRoom({ ...s, name: s.name.trim() || defaultGameName(), maxPlayers: Math.min(s.maxPlayers, maxPlayers) });
        }}
      >
        {busy ?? 'Create game'}
      </button>
    </section>
  );
}

function SavesCard({ disabled, onBeforeHost }: { disabled: boolean; onBeforeHost: () => void }) {
  const saves = useApp((s) => s.saves);
  const fileRef = useRef<HTMLInputElement>(null);

  const host = async (rec: SaveRecord) => {
    try {
      onBeforeHost();
      const bytes = await loadSaveBytes(rec.id);
      client.createRoom({ name: rec.name }, bytes);
    } catch (e) {
      toast(`Could not load save: ${(e as Error).message}`, 'error');
    }
  };

  return (
    <section className="panel card">
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>Saved games</h2>
        <span className="muted" style={{ fontSize: 12 }}>
          stored in this browser
        </span>
        <div className="spacer" />
        <button className="ghost" onClick={() => fileRef.current?.click()}>
          Import…
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".tsave"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            try {
              await importSave(f);
              await client.refreshSaves();
              toast('Save imported', 'success');
            } catch {
              toast('That file is not a valid save', 'error');
            }
          }}
        />
      </div>
      <div className="save-list">
        {saves.length === 0 && <div className="empty">No saves yet. Host a game and allow autosaves, or import a .tsave file.</div>}
        {saves.map((rec) => (
          <div className="save" key={rec.id}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <b>
                {rec.name} <span className="muted" style={{ fontWeight: 400, fontSize: 12 }}>· {rec.kind}</span>
              </b>
              <span className="muted" style={{ fontSize: 12 }}>
                {rec.gameDate ? `${formatDate(rec.gameDate)} · ` : ''}
                {timeAgo(rec.createdAt)} · {formatBytes(rec.size)}
              </span>
            </div>
            <button className="primary" disabled={disabled} onClick={() => void host(rec)}>
              Host
            </button>
            <button className="ghost" title="Download as a .tsave file" onClick={() => exportSave(rec)}>
              ⤓ Export
            </button>
            <button
              className="ghost danger"
              title="Delete"
              onClick={async () => {
                if (!confirm(`Delete save "${rec.name}"?`)) return;
                await deleteSave(rec.id);
                await client.refreshSaves();
              }}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </section>
  );
}

function defaultGameName(): string {
  const n = getPlayerName().trim();
  return n ? `${n}'s railway` : 'New railway';
}
