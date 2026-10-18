import {
  GAME_SPEEDS,
  TICKS_PER_SECOND,
  encodeFrame,
  encodeSnapshot,
  executeCommand,
  extractChunk,
  findLandNear,
  ymdFromDays,
  type ClientMessage,
  type GameSpeed,
  type GameState,
  type GlobalState,
  type Player,
  type RoomSummary,
  type ServerMessage,
} from '@transportsim/shared';
import type { ServerConfig } from './config.ts';

/** Transport-agnostic connection so rooms can be tested without sockets. */
export interface Connection {
  send(bytes: Uint8Array): void;
  close(): void;
}

export interface Session {
  conn: Connection;
  clientId: string;
  name: string;
  room: Room | null;
  player: Player | null;
  /** Chunk ids the client wants. */
  subscribed: Set<number>;
  /** Chunk id → version last sent to this client. */
  sentVersions: Map<number, number>;
  /** Simple rate limiter for commands. */
  cmdWindowStart: number;
  cmdCount: number;
}

const MAX_CHUNKS_PER_FLUSH = 12;
const MAX_COMMANDS_PER_SECOND = 40;
const MAX_CATCHUP_STEPS = 60;

export class Room {
  readonly id: string;
  readonly state: GameState;
  readonly hostClientId: string;
  readonly sessions = new Set<Session>();
  speed: GameSpeed = 1;
  autosave = false;
  closed = false;

  private readonly config: ServerConfig;
  private readonly onClosed: (room: Room) => void;
  private readonly clientPlayers = new Map<string, number>();
  private chunkCache = new Map<number, { version: number; bytes: Uint8Array }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private hostCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStepAt = 0;
  private stepDebt = 0;
  private globalDirty = true;
  private lastAutosaveAt = 0;
  private hostClosesAt: number | null = null;

  constructor(
    id: string,
    state: GameState,
    hostClientId: string,
    config: ServerConfig,
    onClosed: (room: Room) => void,
  ) {
    this.id = id;
    this.state = state;
    this.hostClientId = hostClientId;
    this.config = config;
    this.onClosed = onClosed;
  }

  start(): void {
    this.lastStepAt = performance.now();
    this.timer = setInterval(() => this.update(), 1000 / TICKS_PER_SECOND);
  }

  get hostSession(): Session | undefined {
    for (const s of this.sessions) if (s.clientId === this.hostClientId) return s;
    return undefined;
  }

  get connectedCount(): number {
    return this.sessions.size;
  }

  summary(): RoomSummary {
    const host = [...this.state.players.values()].find((p) => p.isHost);
    return {
      id: this.id,
      name: this.state.settings.name,
      hostName: host?.name ?? '?',
      players: this.connectedCount,
      maxPlayers: this.state.settings.maxPlayers,
      mapWidth: this.state.map.width,
      mapHeight: this.state.map.height,
      year: ymdFromDays(this.state.date).year,
    };
  }

  // ---- membership ------------------------------------------------------------

  join(session: Session): string | null {
    if (this.closed) return 'Game has ended';
    const isHost = session.clientId === this.hostClientId;
    if (!isHost && this.connectedCount >= this.state.settings.maxPlayers) return 'Game is full';
    for (const s of this.sessions) {
      if (s.clientId === session.clientId) return 'Already connected to this game';
    }

    let player: Player | undefined;
    const existing = this.clientPlayers.get(session.clientId);
    if (existing !== undefined) player = this.state.players.get(existing);
    if (player) {
      player.connected = true;
      player.name = session.name;
    } else {
      player = this.state.addPlayer(session.name, isHost);
      this.clientPlayers.set(session.clientId, player.id);
    }
    this.state.ensureCompany(player);

    session.room = this;
    session.player = player;
    session.subscribed.clear();
    session.sentVersions.clear();
    this.sessions.add(session);
    this.globalDirty = true;

    this.send(session, {
      t: 'roomJoined',
      roomId: this.id,
      playerId: player.id,
      isHost,
      settings: this.state.settings,
      global: this.globalState(),
      autosave: this.autosave,
      spawn: this.spawnFor(player),
    });

    if (isHost && this.hostCloseTimer) {
      clearTimeout(this.hostCloseTimer);
      this.hostCloseTimer = null;
      this.hostClosesAt = null;
      this.broadcast({ t: 'hostStatus', connected: true });
      this.systemChat(`${session.name} (host) reconnected`);
    } else {
      this.systemChat(`${session.name} joined`);
      if (!isHost && !this.hostSession) {
        this.send(session, { t: 'hostStatus', connected: false, closesAt: this.hostClosesAt ?? undefined });
      }
    }
    return null;
  }

  /** Session went away. `explicit` = the player chose to leave (vs. a dropped connection). */
  leave(session: Session, explicit: boolean): void {
    if (!this.sessions.delete(session)) return;
    const player = session.player;
    session.room = null;
    session.player = null;
    if (player) player.connected = false;
    this.globalDirty = true;

    if (session.clientId === this.hostClientId) {
      if (explicit) {
        this.close('The host ended the game');
        return;
      }
      this.hostClosesAt = Date.now() + this.config.hostGraceMs;
      this.broadcast({ t: 'hostStatus', connected: false, closesAt: this.hostClosesAt });
      this.systemChat(`${session.name} (host) disconnected`);
      this.hostCloseTimer = setTimeout(() => this.close('The host left the game'), this.config.hostGraceMs);
    } else {
      this.systemChat(`${session.name} left`);
    }
  }

  close(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.hostCloseTimer) clearTimeout(this.hostCloseTimer);
    this.timer = null;
    this.hostCloseTimer = null;
    for (const s of this.sessions) {
      this.send(s, { t: 'roomClosed', reason });
      s.room = null;
      s.player = null;
    }
    this.sessions.clear();
    this.chunkCache.clear();
    this.onClosed(this);
  }

  // ---- messages --------------------------------------------------------------

  handle(session: Session, msg: ClientMessage): void {
    const isHost = session.clientId === this.hostClientId;
    switch (msg.t) {
      case 'subscribe': {
        if (!Array.isArray(msg.chunks)) return;
        const total = this.state.map.chunksX * this.state.map.chunksY;
        const next = new Set<number>();
        for (const c of msg.chunks.slice(0, total)) {
          if (Number.isInteger(c) && c >= 0 && c < total) next.add(c);
        }
        for (const c of session.sentVersions.keys()) if (!next.has(c)) session.sentVersions.delete(c);
        session.subscribed = next;
        return;
      }
      case 'command': {
        const now = Date.now();
        if (now - session.cmdWindowStart > 1000) {
          session.cmdWindowStart = now;
          session.cmdCount = 0;
        }
        if (++session.cmdCount > MAX_COMMANDS_PER_SECOND) {
          this.send(session, { t: 'commandResult', seq: msg.seq, ok: false, error: 'Too many commands' });
          return;
        }
        const player = session.player!;
        const result = executeCommand(this.state, { playerId: player.id, companyId: player.companyId }, msg.cmd);
        this.send(session, {
          t: 'commandResult',
          seq: msg.seq,
          ok: result.ok,
          error: result.ok ? undefined : result.error,
          cost: result.ok ? result.cost : undefined,
        });
        if (result.ok) this.globalDirty = true;
        return;
      }
      case 'setSpeed':
        if (!isHost || !GAME_SPEEDS.includes(msg.speed)) return;
        this.speed = msg.speed;
        this.globalDirty = true;
        return;
      case 'autosave':
        if (!isHost) return;
        this.autosave = !!msg.enabled;
        this.lastAutosaveAt = Date.now();
        this.send(session, { t: 'autosaveStatus', enabled: this.autosave });
        return;
      case 'requestSave':
        if (!isHost) return;
        this.sendSave(session, 'manual');
        return;
      case 'chat': {
        const text = String(msg.text ?? '').trim().slice(0, 300);
        if (text) this.broadcast({ t: 'chat', from: session.name, text, at: Date.now() });
        return;
      }
      default:
        return;
    }
  }

  // ---- simulation loop --------------------------------------------------------

  /** Called at TICKS_PER_SECOND; runs as many sim steps as the speed requires, then syncs. */
  update(now = performance.now()): void {
    if (this.closed) return;
    const dt = now - this.lastStepAt;
    this.lastStepAt = now;
    if (this.speed > 0) {
      this.stepDebt = Math.min(this.stepDebt + (dt / 1000) * TICKS_PER_SECOND * this.speed, MAX_CATCHUP_STEPS);
      while (this.stepDebt >= 1) {
        this.stepDebt--;
        const ev = this.state.step();
        if (ev.newDay) this.globalDirty = true;
        if (ev.newMonth) this.maybeAutosave();
      }
    }
    this.flush();
  }

  private maybeAutosave(): void {
    if (!this.autosave) return;
    const host = this.hostSession;
    if (!host || Date.now() - this.lastAutosaveAt < this.config.autosaveMinIntervalMs) return;
    this.lastAutosaveAt = Date.now();
    this.sendSave(host, 'auto');
  }

  private sendSave(session: Session, kind: 'auto' | 'manual'): void {
    this.send(session, {
      t: 'saveData',
      kind,
      name: this.state.settings.name,
      date: this.state.date,
      snapshot: encodeSnapshot(this.state),
    });
  }

  /** Send globals if changed and any out-of-date subscribed chunks (bounded per flush). */
  flush(): void {
    if (this.globalDirty) {
      this.globalDirty = false;
      this.broadcast({ t: 'global', global: this.globalState() });
    }
    const versions = this.state.map.chunkVersions;
    for (const s of this.sessions) {
      let budget = MAX_CHUNKS_PER_FLUSH;
      for (const c of s.subscribed) {
        const v = versions[c]!;
        if (s.sentVersions.get(c) === v) continue;
        s.conn.send(this.chunkBytes(c, v));
        s.sentVersions.set(c, v);
        if (--budget === 0) break;
      }
    }
  }

  private chunkBytes(c: number, version: number): Uint8Array {
    const cached = this.chunkCache.get(c);
    if (cached && cached.version === version) return cached.bytes;
    const map = this.state.map;
    const cx = c % map.chunksX;
    const cy = (c - cx) / map.chunksX;
    const bytes = encodeFrame({ t: 'chunk', data: extractChunk(map, cx, cy) } satisfies ServerMessage);
    this.chunkCache.set(c, { version, bytes });
    return bytes;
  }

  globalState(): GlobalState {
    return {
      tick: this.state.tick,
      date: this.state.date,
      dayTick: this.state.dayTick,
      speed: this.speed,
      companies: [...this.state.companies.values()],
      players: [...this.state.players.values()],
    };
  }

  /** Spread players around the map so they don't all start in the same spot. */
  private spawnFor(player: Player): { x: number; y: number } {
    const { width, height } = this.state.map;
    const r = player.isHost ? 0 : Math.min(width, height) * 0.22;
    const a = player.id * 2.39996; // golden angle
    return findLandNear(this.state.map, width / 2 + Math.cos(a) * r, height / 2 + Math.sin(a) * r);
  }

  // ---- helpers ---------------------------------------------------------------

  send(session: Session, msg: ServerMessage): void {
    session.conn.send(encodeFrame(msg));
  }

  broadcast(msg: ServerMessage): void {
    if (this.sessions.size === 0) return;
    const bytes = encodeFrame(msg);
    for (const s of this.sessions) s.conn.send(bytes);
  }

  private systemChat(text: string): void {
    this.broadcast({ t: 'chat', from: '', text, at: Date.now(), system: true });
  }
}
