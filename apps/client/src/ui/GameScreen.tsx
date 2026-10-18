import { COMPANY_COLORS, GAME_SPEEDS, formatDate, type GameSpeed } from '@transportsim/shared';
import { useEffect, useRef, useState } from 'react';
import { client } from '../net/client.ts';
import { installDebugHook } from '../render/debugHook.ts';
import { GameRenderer } from '../render/gameRenderer.ts';
import { useApp, type ToolId } from '../store.ts';
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
      const tools: Record<string, ToolId> = Object.fromEntries(TOOLS.map((t) => ['Digit' + t.key, t.id]));
      if (tools[e.code]) {
        const t = tools[e.code]!;
        useApp.setState((s) => ({ tool: s.tool === t ? null : t }));
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
      {showHelp && <Help onClose={() => setShowHelp(false)} />}
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
          <>
            <span className="company-swatch" style={{ background: COMPANY_COLORS[company.color] }} />
            <b>{company.name}</b>
            <span className={`mono money ${company.money < 0 ? 'neg' : ''}`}>{formatMoney(company.money)}</span>
          </>
        ) : (
          <span className="muted">Spectating</span>
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
        <span className="muted" title={global?.players.map((p) => `${p.name}${p.connected ? '' : ' (away)'}`).join('\n')}>
          👥 {online}/{room.settings.maxPlayers}
        </span>
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
            <button title="Save to this browser" onClick={() => client.requestSave()}>
              💾 Save
            </button>
            <label className="row" title="Autosave to this browser every in-game month">
              <input type="checkbox" checked={autosave} onChange={(e) => client.setAutosave(e.target.checked)} />
              <span className="muted">Autosave</span>
            </label>
          </>
        )}
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

const TOOLS: { id: ToolId; icon: string; label: string; key: string; group: number }[] = [
  { id: 'raise', icon: '⛰', label: 'Raise land (drag for area)', key: '1', group: 0 },
  { id: 'lower', icon: '⛏', label: 'Lower land (drag for area)', key: '2', group: 0 },
  { id: 'level', icon: '▭', label: 'Level land (drag an area)', key: '3', group: 0 },
  { id: 'rail', icon: '🛤', label: 'Build railway (drag; Ctrl removes)', key: '4', group: 1 },
  { id: 'removeRail', icon: '✂', label: 'Remove railway', key: '5', group: 1 },
];

function Toolbar() {
  const tool = useApp((s) => s.tool);
  return (
    <div className="panel toolbar" role="toolbar" aria-label="Build tools">
      {TOOLS.map((t, i) => [
        i > 0 && TOOLS[i - 1]!.group !== t.group ? <div className="sep" key={'sep' + i} /> : null,
        <button
          key={t.id}
          className={`tool-btn ${tool === t.id ? 'active' : ''}`}
          data-tip={t.label}
          aria-label={t.label}
          aria-pressed={tool === t.id}
          onClick={() => useApp.setState({ tool: tool === t.id ? null : t.id })}
        >
          <span style={{ fontSize: 20 }}>{t.icon}</span>
          <span className="key">{t.key}</span>
        </button>,
      ])}
      <div className="sep" />
      <button className="tool-btn" disabled data-tip="Roads — planned" aria-label="Roads (planned)">
        <span style={{ fontSize: 20 }}>🛣</span>
      </button>
      <button className="tool-btn" disabled data-tip="Airports — planned" aria-label="Airports (planned)">
        <span style={{ fontSize: 20 }}>✈</span>
      </button>
      <button className="tool-btn" disabled data-tip="Docks — planned" aria-label="Docks (planned)">
        <span style={{ fontSize: 20 }}>⚓</span>
      </button>
    </div>
  );
}

function Chat() {
  const chat = useApp((s) => s.chat);
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
            <div key={i}>
              <b>{c.from}:</b> {c.text}
            </div>
          ),
        )}
      </div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) client.chat(text);
          setText('');
        }}
      >
        <input
          value={text}
          maxLength={300}
          placeholder="Say something… (Enter)"
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
        <kbd>E</kbd> rotate · <kbd>R</kbd>
        <kbd>F</kbd> tilt
      </div>
      <div>
        <kbd>Scroll</kbd> / <kbd>+</kbd>
        <kbd>-</kbd> zoom
      </div>
      <div>
        <kbd>1</kbd> raise · <kbd>2</kbd> lower · <kbd>3</kbd> level land
      </div>
      <div>
        <kbd>4</kbd> railway (drag; hold <kbd>Ctrl</kbd> to remove) · <kbd>5</kbd> remove railway · <kbd>Esc</kbd> deselect
      </div>
      <div>
        <kbd>Space</kbd> pause (host)
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
