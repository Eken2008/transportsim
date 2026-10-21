import {
  AIRPORT_TYPES,
  BRIDGE_TYPES,
  COMPANY_COLORS,
  GAME_SPEEDS,
  MAX_PLATFORMS,
  MAX_PLATFORM_LENGTH,
  MAX_SIGNAL_INTERVAL,
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
import { Tutorial } from './Tutorial.tsx';
import { sound } from '../audio/sound.ts';
import { NewsTicker } from './NewsWindow.tsx';
import { GameRenderer } from '../render/gameRenderer.ts';
import { nextViewMode, openWindow, useApp, type ToolId, type ViewMode } from '../store.ts';
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
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyF') {
        e.preventDefault();
        openWindow({ kind: 'find', id: 0 });
      } else if (e.ctrlKey || e.metaKey) {
        return;
      } else if (e.shiftKey && e.code === 'KeyT') {
        useApp.setState((s) => ({ treeView: nextViewMode(s.treeView) }));
      } else if (e.shiftKey && e.code === 'KeyB') {
        useApp.setState((s) => ({ buildingView: nextViewMode(s.buildingView) }));
      } else if (tools[e.code]) {
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
      {!showHelp && <Tutorial />}
      <WindowLayer />
      <StationOptions />
      <SignalOptions />
      <BridgeOptions />
      <RailTypeOptions />
      <RoadStopOptions />
      <AirportOptions />
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
        <button title="Your lines: the stops your vehicles serve" aria-label="〰 Lines" onClick={() => openWindow({ kind: 'lines', id: 0 })}>
          〰<span className="lbl"> Lines</span>
        </button>
        <button title="Find a town, industry or station (Ctrl+F)" aria-label="🔍 Find" onClick={() => openWindow({ kind: 'find', id: 0 })}>
          🔍<span className="lbl"> Find</span>
        </button>
        <button title="Cargo routes: where each industry's cargo comes from and can go" aria-label="⛓ Cargo" onClick={() => openWindow({ kind: 'cargo', id: 0 })}>
          ⛓<span className="lbl"> Cargo</span>
        </button>
        <button title="News" aria-label="📰 News" onClick={() => openWindow({ kind: 'news', id: 0 })}>
          📰<span className="lbl"> News</span>
        </button>
        <button title="Statistics: graphs of every company's history" aria-label="📈 Graphs" onClick={() => openWindow({ kind: 'stats', id: 0 })}>
          📈<span className="lbl"> Graphs</span>
        </button>
        <ViewModeButton field="treeView" icon="🌳" what="Trees" shortcut="Shift+T" />
        <ViewModeButton field="buildingView" icon="🏠" what="Houses and industries" shortcut="Shift+B" />
        <VolumeButton />
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

type ToolDef = { id: ToolId; icon: string; label: string; key: string; menu: 'main' | 'rail' | 'road' | 'air' | 'water' };

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
  { id: 'road', icon: '🛣', label: 'Build road (drag a straight line; Ctrl removes)', key: 'G', menu: 'road' },
  { id: 'removeRoad', icon: '✂', label: 'Remove road (drag along it)', key: 'Z', menu: 'road' },
  { id: 'roadStop', icon: '🚏', label: 'Bus or truck stop (on straight road)', key: 'H', menu: 'road' },
  { id: 'roadDepot', icon: '🅿', label: 'Road vehicle depot', key: 'J', menu: 'road' },
  { id: 'oneWay', icon: '⬆', label: 'One-way road (click to cycle)', key: 'K', menu: 'road' },
  { id: 'airport', icon: '🛫', label: 'Airport (flat land or gentle slopes; click its north-west corner)', key: 'Y', menu: 'air' },
  { id: 'canal', icon: '〰', label: 'Canal (drag over flat land)', key: 'U', menu: 'water' },
  { id: 'lock', icon: '🪜', label: 'Lock (on a straight slope between two water levels)', key: 'I', menu: 'water' },
  { id: 'dock', icon: '⚓', label: 'Dock (on the shore; faces the water nearest the cursor)', key: 'O', menu: 'water' },
  { id: 'shipDepot', icon: '🛳', label: 'Ship depot (on water, off the main channel)', key: 'M', menu: 'water' },
  { id: 'buoy', icon: '🔴', label: 'Buoy (a waypoint for ships)', key: 'X', menu: 'water' },
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

type Menu = 'rail' | 'road' | 'air' | 'water';
const MENUS: { id: Menu; icon: string; label: string }[] = [
  { id: 'rail', icon: '🚆', label: 'Railways' },
  { id: 'road', icon: '🛣', label: 'Roads' },
  { id: 'air', icon: '✈', label: 'Airports' },
  { id: 'water', icon: '⚓', label: 'Waterways' },
];
const MENU_NAMES: Record<Menu, string> = { rail: 'Rail', road: 'Road', air: 'Air', water: 'Water' };

function Toolbar() {
  const tool = useApp((s) => s.tool);
  const [chosen, setChosen] = useState<Menu | null>(null);
  const toolMenu = TOOLS.find((t) => t.id === tool)?.menu;
  const open: Menu | null = toolMenu && toolMenu !== 'main' ? toolMenu : chosen;
  return (
    <>
      {open && (
        <div className="panel toolbar submenu" role="toolbar" aria-label={`${MENU_NAMES[open]} tools`}>
          {TOOLS.filter((t) => t.menu === open).map((t) => (
            <ToolButton key={t.id} t={t} />
          ))}
        </div>
      )}
      <div className="panel toolbar" role="toolbar" aria-label="Build tools">
        {TOOLS.filter((t) => t.menu === 'main' && t.id !== 'bulldoze').map((t) => (
          <ToolButton key={t.id} t={t} />
        ))}
        <div className="sep" />
        {MENUS.map((m) => (
          <button
            key={m.id}
            className={`tool-btn menu-btn ${open === m.id ? 'active' : ''}`}
            data-tip={m.label}
            aria-label={`${m.label} tools`}
            aria-expanded={open === m.id}
            onClick={() => {
              if (open === m.id) {
                setChosen(null);
                if (toolMenu === m.id) useApp.setState({ tool: null });
              } else {
                setChosen(m.id);
                if (toolMenu && toolMenu !== 'main') useApp.setState({ tool: null });
              }
            }}
          >
            <span style={{ fontSize: 20 }}>{m.icon}</span>
            <span className="key">▴</span>
          </button>
        ))}
        <div className="sep" />
        <ToolButton t={TOOLS.find((t) => t.id === 'bulldoze')!} />
      </div>
    </>
  );
}

function AirportOptions() {
  const tool = useApp((s) => s.tool);
  const kind = useApp((s) => s.airportKind);
  if (tool !== 'airport') return null;
  return (
    <div className="panel tool-options" role="radiogroup" aria-label="Airport kind">
      <span className="muted">Airport</span>
      <div className="seg">
        {(['small', 'large'] as const).map((k) => {
          const t = AIRPORT_TYPES[k];
          return (
            <button
              key={k}
              className={kind === k ? 'primary' : ''}
              aria-pressed={kind === k}
              title={`${t.w}×${t.h} tiles, ${t.gates} gates, from ${t.intro}${k === 'large' ? '; heavy jets need one' : ''}`}
              onClick={() => useApp.setState({ airportKind: k })}
            >
              {t.name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RoadStopOptions() {
  const tool = useApp((s) => s.tool);
  const kind = useApp((s) => s.roadStopKind);
  if (tool !== 'roadStop') return null;
  return (
    <div className="panel tool-options" role="radiogroup" aria-label="Stop kind">
      <span className="muted">Stop</span>
      <div className="seg">
        <button className={kind === 'bus' ? 'primary' : ''} aria-pressed={kind === 'bus'} title="For passengers and mail" onClick={() => useApp.setState({ roadStopKind: 'bus' })}>
          🚌 Bus stop
        </button>
        <button className={kind === 'truck' ? 'primary' : ''} aria-pressed={kind === 'truck'} title="For freight" onClick={() => useApp.setState({ roadStopKind: 'truck' })}>
          🚚 Truck stop
        </button>
      </div>
    </div>
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
  const interval = useApp((s) => s.signalInterval);
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
      <label className="row" title="Drag along track to place signals this many tiles apart, up to the next junction. Ctrl-drag removes the signals there.">
        Drag spacing
        <input
          type="number"
          min={1}
          max={MAX_SIGNAL_INTERVAL}
          value={interval}
          style={{ width: '3.5em' }}
          onChange={(e) => useApp.setState({ signalInterval: Math.max(1, Math.min(MAX_SIGNAL_INTERVAL, Math.round(+e.target.value) || 1)) })}
        />
        tiles
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

/** Sound on/off, with a volume slider on hover or focus. */
const VIEW_MODE_NAMES: Record<ViewMode, string> = { normal: 'shown', transparent: 'see-through', hidden: 'hidden' };

/** Cycles trees or buildings between shown, see-through and hidden. */
function ViewModeButton({ field, icon, what, shortcut }: { field: 'treeView' | 'buildingView'; icon: string; what: string; shortcut: string }) {
  const mode = useApp((s) => s[field]);
  const next = nextViewMode(mode);
  return (
    <button
      className={`ghost view-mode ${mode}`}
      title={`${what}: ${VIEW_MODE_NAMES[mode]} (click or ${shortcut}: ${VIEW_MODE_NAMES[next]})`}
      aria-label={`${what}: ${VIEW_MODE_NAMES[mode]}`}
      onClick={() => useApp.setState({ [field]: next })}
    >
      {icon}
    </button>
  );
}

function VolumeButton() {
  const [, rerender] = useState(0);
  useEffect(() => sound.onChange(() => rerender((n) => n + 1)), []);
  return (
    <span className="volume">
      <button className="ghost" title={sound.muted ? 'Sound off (click for on)' : 'Sound on (click for off)'} aria-label={sound.muted ? 'Unmute' : 'Mute'} onClick={() => sound.setMuted(!sound.muted)}>
        {sound.muted || sound.volume === 0 ? '🔇' : '🔊'}
      </button>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={sound.volume}
        aria-label="Volume"
        onChange={(e) => {
          sound.setVolume(Number(e.target.value));
          if (sound.muted) sound.setMuted(false);
        }}
      />
    </span>
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
        <kbd>6</kbd> station (<kbd>R</kbd> rotates) · <kbd>7</kbd> depot · <kbd>9</kbd> signals · <kbd>B</kbd> bridge · <kbd>N</kbd> tunnel · <kbd>P</kbd> waypoint ·{' '}
        <kbd>V</kbd> convert track · <kbd>8</kbd> bulldoze · <kbd>Esc</kbd> deselect
      </div>
      <div>
        Roads: <kbd>G</kbd> build · <kbd>Z</kbd> remove · <kbd>H</kbd> stop · <kbd>J</kbd> depot · <kbd>K</kbd> one-way · Air: <kbd>Y</kbd> airport · Water: <kbd>U</kbd> canal ·{' '}
        <kbd>I</kbd> lock · <kbd>O</kbd> dock · <kbd>M</kbd> ship depot · <kbd>X</kbd> buoy
      </div>
      <div>
        <kbd>Shift</kbd>+<kbd>T</kbd> trees · <kbd>Shift</kbd>+<kbd>B</kbd> houses and industries: shown, see-through, hidden
      </div>
      <div>
        Click a depot, station, headquarters or vehicle to open it · <kbd>T</kbd> vehicle list · <kbd>C</kbd> company (and its headquarters) · <kbd>F</kbd> finances · <kbd>L</kbd> league · 📈 graphs ·{' '}
        <kbd>Ctrl</kbd>+<kbd>F</kbd> find a town, industry or station ·{' '}
        <kbd>Space</kbd> pause (host) · ⤓ Export downloads the game
      </div>
      <div>
        <button
          className="link"
          onClick={(e) => {
            e.stopPropagation();
            onClose();
            useApp.setState({ tutorial: true });
          }}
        >
          Show the getting-started guide
        </button>
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
