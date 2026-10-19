import {
  BRIDGE_TYPES,
  COMPANY_COLORS,
  GAME_SPEEDS,
  MAX_PLATFORMS,
  MAX_PLATFORM_LENGTH,
  SIGNAL_KINDS,
  RAIL_TYPES,
  availableRailTypes,
  ymdFromDays,
  formatDate,
  type GameSpeed,
  type SignalKind,
} from '@transportsim/shared';
import { useEffect, useRef, useState } from 'react';
import { client } from '../net/client.ts';
import { installDebugHook } from '../render/debugHook.ts';
import { availableBridges } from '../tools/structureTools.ts';
import { WindowLayer, useMyRole } from './windows.tsx';
import { NewsTicker } from './NewsWindow.tsx';
import { GameRenderer } from '../render/gameRenderer.ts';
import { openWindow, useApp, type ToolId } from '../store.ts';
import { formatMoney } from './format.ts';

export function GameScreen() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stats, setStats] = useState({ fps: 0, chunks: 0 });
  const [showHelp, setShowHelp] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    const world = client.world;
    if (!canvas || !world) return;
    const r = new GameRenderer(canvas, world);
    const spawn = useApp.getState().room?.spawn;
    if (spawn) r.lookAt(spawn.x + 0.5, spawn.y + 0.5);
    r.onStats = setStats;
    const removeHook = installDebugHook(r);
    return () => {
      removeHook();
      r.dispose();
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const tools: Record<string, ToolId> = Object.fromEntries(TOOLS.map((t) => [/\d/.test(t.key) ? 'Digit' + t.key : 'Key' + t.key, t.id]));
      if (tools[e.code]) {
        const t = tools[e.code]!;
        useApp.setState((s) => ({ tool: s.tool === t ? null : t }));
      } else if (e.code === 'KeyR' && useApp.getState().tool === 'station') {
        useApp.setState((s) => ({ stationOpts: { ...s.stationOpts, axis: s.stationOpts.axis === 0 ? 1 : 0 } }));
      } else if (e.code === 'KeyT') {
        openWindow({ kind: 'trains', id: 0 });
      } else if (e.code === 'KeyC') {
        openWindow({ kind: 'company', id: 0 });
      } else if (e.code === 'KeyL') {
        openWindow({ kind: 'league', id: 0 });
      } else if (e.code === 'KeyF') {
        const g = useApp.getState().global;
        const id = g?.players.find((p) => p.id === useApp.getState().room?.playerId)?.companyId;
        if (id != null) openWindow({ kind: 'finances', id });
      } else if (e.code === 'Slash' || e.key === '?') setShowHelp((v) => !v);
      else if (e.code === 'Space' && useApp.getState().room?.isHost) {
        e.preventDefault();
        const g = useApp.getState().global;
        client.setSpeed(g?.speed === 0 ? 1 : 0);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="game">
      <canvas ref={canvasRef} />
      <TopBar onHelp={() => setShowHelp((v) => !v)} />
      <HostBanner />
      <NewsTicker />
      {showHelp && <Help onClose={() => setShowHelp(false)} />}
      <WindowLayer />
      <StationOptions />
      <SignalOptions />
      <BridgeOptions />
      <RailTypeOptions />
      <Toolbar />
      <Chat />
      <StatusBar fps={stats.fps} chunks={stats.chunks} />
      <AutosavePrompt />
    </div>
  );
}

function TopBar({ onHelp }: { onHelp: () => void }) {
  const room = useApp((s) => s.room)!;
  const global = useApp((s) => s.global);
  const autosave = useApp((s) => s.autosave);
  const me = global?.players.find((p) => p.id === room.playerId);
  const company = global?.companies.find((c) => c.id === me?.companyId);
  const online = global?.players.filter((p) => p.connected).length ?? 0;
  const speed = global?.speed ?? 1;

  return (
    <div className="hud-top">
      <div className="panel hud-box">
        {company ? (
          <button className="ghost company-btn" title="Your company (C)" onClick={() => openWindow({ kind: 'company', id: 0 })}>
            <span className="company-swatch" style={{ background: COMPANY_COLORS[company.color] }} />
            <b>{company.name}</b>
            <span className={`mono money ${company.money < 0 ? 'neg' : ''}`}>{formatMoney(company.money)}</span>
          </button>
        ) : (
          <>
            <span className="muted">Spectating</span>
            <button className="primary" title="Found or join a company (C)" onClick={() => openWindow({ kind: 'company', id: 0 })}>
              🏢 Start or join a company
            </button>
          </>
        )}
      </div>
      <div className="spacer" />
      <div className="panel hud-box">
        <span className="mono" style={{ minWidth: 96, textAlign: 'center' }}>
          {global ? formatDate(global.date) : '—'}
        </span>
        <div className="speed-group" role="group" aria-label="Game speed">
          {GAME_SPEEDS.map((sp: GameSpeed) => (
            <button
              key={sp}
              className={speed === sp ? 'active' : ''}
              disabled={!room.isHost}
              title={room.isHost ? (sp === 0 ? 'Pause (Space)' : `${sp}× speed`) : 'Only the host can change speed'}
              onClick={() => client.setSpeed(sp)}
            >
              {sp === 0 ? '❚❚' : `${sp}×`}
            </button>
          ))}
        </div>
      </div>
      <div className="spacer" />
      <div className="panel hud-box">
        <button
          className="ghost muted"
          aria-label="Game and players"
          title={`Game settings and players\n${global?.players.map((p) => `${p.name}${p.connected ? '' : ' (away)'}`).join('\n') ?? ''}`}
          onClick={() => openWindow({ kind: 'game', id: 0 })}
        >
          👥 {online}/{room.settings.maxPlayers}
        </button>
        <button
          className="ghost mono"
          title="Copy game code"
          onClick={() => {
            void navigator.clipboard?.writeText(room.id);
          }}
        >
          {room.id}
        </button>
        {room.isHost && (
          <>
            <button title="Save to this browser" aria-label="💾 Save" onClick={() => client.requestSave()}>
              💾<span className="lbl"> Save</span>
            </button>
            <label className="row" title="Autosave to this browser every in-game month">
              <input type="checkbox" checked={autosave} onChange={(e) => client.setAutosave(e.target.checked)} />
              <span className="muted">Autosave</span>
            </label>
          </>
        )}
        <button title="Download this game as a .tsave file" aria-label="⤓ Export" onClick={() => client.exportGame()}>
          ⤓<span className="lbl"> Export</span>
        </button>
        <button title="Your trains (T)" aria-label="🚆 Trains" onClick={() => openWindow({ kind: 'trains', id: 0 })}>
          🚆<span className="lbl"> Trains</span>
        </button>
        <button title="News" aria-label="📰 News" onClick={() => openWindow({ kind: 'news', id: 0 })}>
          📰<span className="lbl"> News</span>
        </button>
        <button className="ghost" title="Controls (?)" onClick={onHelp}>
          ?
        </button>
        <button
          className="danger"
          onClick={() => {
            if (room.isHost && !confirm('Leaving ends the game for everyone. Leave?')) return;
            client.leaveRoom();
          }}
        >
          {room.isHost ? 'End game' : 'Leave'}
        </button>
      </div>
    </div>
  );
}

function HostBanner() {
  const host = useApp((s) => s.hostStatus);
  const [, force] = useState(0);
  useEffect(() => {
    if (host.connected) return;
    const id = setInterval(() => force((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [host.connected]);
  if (host.connected) return null;
  const left = host.closesAt ? Math.max(0, Math.ceil((host.closesAt - Date.now()) / 1000)) : null;
  return (
    <div className="panel banner">
      ⚠ The host disconnected. {left !== null ? `The game ends in ${left}s unless they return.` : ''}
    </div>
  );
}

type ToolDef = { id: ToolId; icon: string; label: string; key: string; menu: 'main' | 'rail' };

const TOOLS: ToolDef[] = [
  { id: 'raise', icon: '⛰', label: 'Raise land (drag for area)', key: '1', menu: 'main' },
  { id: 'lower', icon: '⛏', label: 'Lower land (drag for area)', key: '2', menu: 'main' },
  { id: 'level', icon: '▭', label: 'Level land (drag an area)', key: '3', menu: 'main' },
  { id: 'rail', icon: '🛤', label: 'Build railway (drag a route; Ctrl removes)', key: '4', menu: 'rail' },
  { id: 'removeRail', icon: '✂', label: 'Remove railway', key: '5', menu: 'rail' },
  { id: 'signal', icon: '🚦', label: 'Signals (click: place, turn round, remove)', key: '9', menu: 'rail' },
  { id: 'station', icon: '🚉', label: 'Station (R rotates)', key: '6', menu: 'rail' },
  { id: 'depot', icon: '🏚', label: 'Train depot', key: '7', menu: 'rail' },
  { id: 'bridge', icon: '🌉', label: 'Bridge (drag end to end)', key: 'B', menu: 'rail' },
  { id: 'tunnel', icon: '⛰️', label: 'Tunnel (click a slope into a hill)', key: 'N', menu: 'rail' },
  { id: 'waypoint', icon: '📍', label: 'Waypoint (click straight track; click again to remove)', key: 'P', menu: 'rail' },
  { id: 'convert', icon: '⚡', label: 'Convert track type (drag an area)', key: 'V', menu: 'rail' },
  { id: 'bulldoze', icon: '💥', label: 'Bulldoze (drag an area)', key: '8', menu: 'main' },
];

function ToolButton({ t }: { t: ToolDef }) {
  const tool = useApp((s) => s.tool);
  return (
    <button
      className={`tool-btn ${tool === t.id ? 'active' : ''}`}
      data-tip={t.label}
      aria-label={t.label}
      aria-pressed={tool === t.id}
      onClick={() => useApp.setState({ tool: tool === t.id ? null : t.id })}
    >
      <span style={{ fontSize: 20 }}>{t.icon}</span>
      <span className="key">{t.key}</span>
    </button>
  );
}

function Toolbar() {
  const tool = useApp((s) => s.tool);
  const [railOpen, setRailOpen] = useState(false);
  const railTool = TOOLS.some((t) => t.menu === 'rail' && t.id === tool);
  const open = railOpen || railTool;
  return (
    <>
      {open && (
        <div className="panel toolbar submenu" role="toolbar" aria-label="Rail tools">
          {TOOLS.filter((t) => t.menu === 'rail').map((t) => (
            <ToolButton key={t.id} t={t} />
          ))}
        </div>
      )}
      <div className="panel toolbar" role="toolbar" aria-label="Build tools">
        {TOOLS.filter((t) => t.menu === 'main' && t.id !== 'bulldoze').map((t) => (
          <ToolButton key={t.id} t={t} />
        ))}
        <div className="sep" />
        <button
          className={`tool-btn menu-btn ${open ? 'active' : ''}`}
          data-tip="Railways"
          aria-label="Railway tools"
          aria-expanded={open}
          onClick={() => {
            if (open) {
              setRailOpen(false);
              if (railTool) useApp.setState({ tool: null });
            } else setRailOpen(true);
          }}
        >
          <span style={{ fontSize: 20 }}>🚆</span>
          <span className="key">▴</span>
        </button>
        <button className="tool-btn" disabled data-tip="Roads — planned" aria-label="Roads (planned)">
          <span style={{ fontSize: 20 }}>🛣</span>
        </button>
        <button className="tool-btn" disabled data-tip="Airports — planned" aria-label="Airports (planned)">
          <span style={{ fontSize: 20 }}>✈</span>
        </button>
        <button className="tool-btn" disabled data-tip="Docks — planned" aria-label="Docks (planned)">
          <span style={{ fontSize: 20 }}>⚓</span>
        </button>
        <div className="sep" />
        <ToolButton t={TOOLS.find((t) => t.id === 'bulldoze')!} />
      </div>
    </>
  );
}

const SIGNAL_HELP: Record<SignalKind, string> = {
  block: 'Green when the block beyond is empty',
  entry: 'Pre-signal: like block, but also needs a green exit signal out of its block (e.g. into a station with free platforms)',
  exit: 'Pre-signal: a block signal that entry signals before it look at',
  combo: 'Pre-signal: both entry and exit, for chains of pre-signals',
  path: 'Lets a train in when it can reserve its route to the next signal; trains on paths that do not cross can share a block',
};

function SignalOptions() {
  const tool = useApp((s) => s.tool);
  const oneWay = useApp((s) => s.signalOneWay);
  const kind = useApp((s) => s.signalKind);
  const showRes = useApp((s) => s.showReservations);
  if (tool !== 'signal') return null;
  return (
    <div className="panel tool-options wrap">
      <div className="seg" role="radiogroup" aria-label="Signal kind">
        {SIGNAL_KINDS.map((k) => (
          <button key={k} className={kind === k ? 'primary' : ''} aria-pressed={kind === k} title={SIGNAL_HELP[k]} onClick={() => useApp.setState({ signalKind: k })}>
            {k[0]!.toUpperCase() + k.slice(1)}
          </button>
        ))}
      </div>
      <label className="row" title="Trains may not pass it from behind">
        <input type="checkbox" checked={oneWay} onChange={(e) => useApp.setState({ signalOneWay: e.target.checked })} />
        One-way
      </label>
      <label className="row" title="Draw the paths trains have reserved through path signals">
        <input type="checkbox" checked={showRes} onChange={(e) => useApp.setState({ showReservations: e.target.checked })} />
        Show reservations
      </label>
    </div>
  );
}

function Chat() {
  const chat = useApp((s) => s.chat);
  const inCompany = useMyRole().companyId !== null;
  const [toCompany, setToCompany] = useState(false);
  const channel = inCompany && toCompany ? 'company' : 'all';
  const [text, setText] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const logRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [chat]);
  return (
    <div className={`panel chat ${collapsed ? 'collapsed' : ''}`}>
      <div className="chat-log" ref={logRef}>
        {chat.length === 0 && <span className="muted">Chat with other players here.</span>}
        {chat.map((c, i) =>
          c.system ? (
            <div key={i} className="sys">
              {c.text}
            </div>
          ) : (
            <div key={i} className={c.channel === 'company' ? 'company-line' : undefined}>
              {c.channel === 'company' && <span className="chan">Company</span>}
              <b>{c.from}:</b> {c.text}
            </div>
          ),
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) client.chat(text, channel);
          setText('');
        }}
      >
        {inCompany && (
          <button
            type="button"
            className={`ghost chan-btn ${channel === 'company' ? 'active' : ''}`}
            title={channel === 'company' ? 'Talking to your company only (click for everyone)' : 'Talking to everyone (click for your company only)'}
            onClick={() => setToCompany((v) => !v)}
          >
            {channel === 'company' ? 'Company' : 'All'}
          </button>
        )}
        <input
          value={text}
          maxLength={300}
          placeholder={channel === 'company' ? 'To your company… (Enter)' : 'Say something… (Enter)'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && (e.target as HTMLInputElement).blur()}
        />
        <button type="button" className="ghost" onClick={() => setCollapsed((v) => !v)} title={collapsed ? 'Show chat' : 'Hide chat'}>
          {collapsed ? '▴' : '▾'}
        </button>
      </form>
    </div>
  );
}

function StatusBar({ fps, chunks }: { fps: number; chunks: number }) {
  const hover = useApp((s) => s.hover);
  const conn = useApp((s) => s.conn);
  return (
    <div className="statusbar">
      {hover ? (
        <>
          <span className="mono">
            {hover.x}, {hover.y} · height {hover.height}
          </span>
          {hover.cost !== undefined && <span className="cost mono">Cost {formatMoney(hover.cost)}</span>}
          {hover.error && <span className="err">{hover.error}</span>}
          {hover.info && <span className="info">{hover.info}</span>}
        </>
      ) : (
        <span>Right-drag to pan · middle-drag to rotate · scroll to zoom · press ? for help</span>
      )}
      <div className="spacer" />
      {conn !== 'open' && <span className="err">Reconnecting…</span>}
      <span className="mono">{fps} fps</span>
      <span className="mono">{chunks} chunks</span>
    </div>
  );
}

function Help({ onClose }: { onClose: () => void }) {
  return (
    <div className="panel help" onClick={onClose}>
      <b>Controls</b>
      <div>
        <kbd>Right-drag</kbd> pan · <kbd>Middle-drag</kbd> / <kbd>Alt</kbd>+<kbd>Right-drag</kbd> rotate & tilt
      </div>
      <div>
        <kbd>W</kbd>
        <kbd>A</kbd>
        <kbd>S</kbd>
        <kbd>D</kbd> / arrows move · <kbd>Q</kbd>
        <kbd>E</kbd> rotate · <kbd>PgUp</kbd>
        <kbd>PgDn</kbd> tilt
      </div>
      <div>
        <kbd>Scroll</kbd> / <kbd>+</kbd>
        <kbd>-</kbd> zoom
      </div>
      <div>
        <kbd>1</kbd> raise · <kbd>2</kbd> lower · <kbd>3</kbd> level land
      </div>
      <div>
        <kbd>4</kbd> railway (drag; hold <kbd>Ctrl</kbd> to remove) · <kbd>5</kbd> remove railway
      </div>
      <div>
        <kbd>6</kbd> station (<kbd>R</kbd> rotates) · <kbd>7</kbd> depot · <kbd>9</kbd> signals · <kbd>B</kbd> bridge · <kbd>N</kbd> tunnel · <kbd>8</kbd> bulldoze · <kbd>Esc</kbd> deselect
      </div>
      <div>
        Click a depot, station or train to open it · <kbd>T</kbd> train list · <kbd>C</kbd> company · <kbd>F</kbd> finances · <kbd>L</kbd> league · <kbd>Space</kbd> pause (host) · ⤓ Export downloads the game
      </div>
    </div>
  );
}

function AutosavePrompt() {
  const open = useApp((s) => s.autosavePrompt);
  const [remember, setRemember] = useState(false);
  if (!open) return null;
  return (
    <div className="modal-backdrop">
      <div className="panel modal" role="dialog" aria-modal="true" aria-labelledby="autosave-title">
        <h3 id="autosave-title">Allow autosaves?</h3>
        <p>
          You are hosting this game. The server keeps nothing, so if you leave, the game ends. With autosaves on, the game is
          saved to <b>this browser</b> every in-game month (last 3 kept), so you can resume it later.
        </p>
        <label className="row" style={{ marginBottom: 16 }}>
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember my choice
        </label>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button onClick={() => client.answerAutosave(false, remember)}>Not now</button>
          <button className="primary" onClick={() => client.answerAutosave(true, remember)}>
            Allow autosaves
          </button>
        </div>
      </div>
    </div>
  );
}

function Stepper({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="stepper">
      <span className="muted">{label}</span>
      <button className="ghost" disabled={value <= min} onClick={() => onChange(value - 1)} aria-label={"Fewer " + label.toLowerCase()}>
        −
      </button>
      <b className="mono">{value}</b>
      <button className="ghost" disabled={value >= max} onClick={() => onChange(value + 1)} aria-label={"More " + label.toLowerCase()}>
        +
      </button>
    </div>
  );
}

function StationOptions() {
  const tool = useApp((s) => s.tool);
  const opts = useApp((s) => s.stationOpts);
  if (tool !== 'station') return null;
  const set = (patch: Partial<typeof opts>) => useApp.setState({ stationOpts: { ...opts, ...patch } });
  return (
    <div className="panel tool-options">
      <Stepper label="Platforms" value={opts.platforms} min={1} max={MAX_PLATFORMS} onChange={(v) => set({ platforms: v })} />
      <Stepper label="Length" value={opts.length} min={1} max={MAX_PLATFORM_LENGTH} onChange={(v) => set({ length: v })} />
      <button onClick={() => set({ axis: opts.axis === 0 ? 1 : 0 })} title="Rotate (R)">
        ⟲ {opts.axis === 0 ? 'East–west' : 'North–south'}
      </button>
    </div>
  );
}

const RAIL_TOOLS: ToolId[] = ['rail', 'station', 'depot', 'bridge', 'tunnel', 'convert'];

function RailTypeOptions() {
  const tool = useApp((s) => s.tool);
  const chosen = useApp((s) => s.railType);
  const date = useApp((s) => s.global?.date);
  const timeline = useApp((s) => s.room?.settings.timeline ?? 'era');
  if (!tool || !RAIL_TOOLS.includes(tool)) return null;
  const types = availableRailTypes(date ? ymdFromDays(date).year : 1900, timeline);
  const upper = tool === 'station' || tool === 'bridge';
  return (
    <div className={`panel tool-options ${upper ? 'upper' : ''}`} role="radiogroup" aria-label="Track type">
      <span className="muted">{tool === 'convert' ? 'Convert to' : 'Track'}</span>
      <div className="seg">
        {types.map((i) => (
          <button
            key={i}
            className={chosen === i ? 'primary' : ''}
            aria-pressed={chosen === i}
            title={`${RAIL_TYPES[i]!.name}: up to ${RAIL_TYPES[i]!.maxSpeed} km/h${RAIL_TYPES[i]!.electrified ? ', electrified' : ''}, ${RAIL_TYPES[i]!.costFactor}× cost`}
            onClick={() => useApp.setState({ railType: i })}
          >
            {RAIL_TYPES[i]!.electrified ? '⚡ ' : ''}
            {RAIL_TYPES[i]!.name}
          </button>
        ))}
      </div>
    </div>
  );
}

function BridgeOptions() {
  const tool = useApp((s) => s.tool);
  const chosen = useApp((s) => s.bridgeType);
  useApp((s) => s.global?.date);
  if (tool !== 'bridge') return null;
  return (
    <div className="panel tool-options">
      <span className="muted">Bridge</span>
      <select value={chosen ?? ''} onChange={(e) => useApp.setState({ bridgeType: e.target.value === '' ? null : Number(e.target.value) })}>
        <option value="">Automatic (cheapest that fits)</option>
        {availableBridges().map((i) => (
          <option key={i} value={i}>
            {BRIDGE_TYPES[i]!.name} — up to {BRIDGE_TYPES[i]!.maxSpan} tiles, {BRIDGE_TYPES[i]!.maxSpeed} km/h
          </option>
        ))}
      </select>
    </div>
  );
}
