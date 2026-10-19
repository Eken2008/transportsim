import {
  GAME_SPEEDS,
  TICKS_PER_SECOND,
  encodeFrame,
  encodeSnapshot,
  executeCommand,
  extractChunk,
  findLandNear,
  segTile,
  trainInfo,
  CHUNK_SIZE,
  ymdFromDays,
  type ClientMessage,
  type GameSpeed,
  type GameState,
  type Industry,
  type Station,
  type GlobalState,
  type Player,
  type RoomSummary,
  type ServerMessage,
} from '@transportsim/shared';
import type { ServerConfig } from './config.ts';
import { LinkGraphWorker } from './linkGraphWorker.ts';

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
  /** Last signal aspects sent (to send only changes). */
  lastSignals?: string;
  /** Stations and industries shown in the client's windows. */
  watchStations?: Set<number>;
  watchIndustries?: Set<number>;
}

const MAX_CHUNKS_PER_FLUSH = 12;

/** What every player must hear about when it changes (the rest only goes to those looking). */
const stationSig = (s: Station) => `${s.name}|${s.owner}|${s.x0},${s.y0},${s.x1},${s.y1}|${s.airport?.kind ?? ''}|${s.townId}`;
const industrySig = (i: Industry) => `${i.level}|${i.name}`;
const MAX_COMMANDS_PER_SECOND = 40;
const MAX_CATCHUP_STEPS = 60;
const POS_INTERVAL_MS = 100;
const NEWS_ON_JOIN = 50;

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
  /** Clients the host removed; they can't rejoin. */
  private readonly banned = new Set<string>();
  private chunkCache = new Map<number, { version: number; bytes: Uint8Array }>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Load figures for /health and the load test: smoothed ms per sim step, bytes sent. */
  readonly stats = { stepMs: 0, steps: 0, bytesOut: 0 };
  private hostCloseTimer: ReturnType<typeof setTimeout> | null = null;
  private lastStepAt = 0;
  private stepDebt = 0;
  private globalDirty = true;
  private lastAutosaveAt = 0;
  private hostClosesAt: number | null = null;
  private lastPosAt = 0;
  /** Cargodist link graphs are solved in a worker. */
  private readonly linkGraph = new LinkGraphWorker();

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
    this.state.cargo.runner = this.linkGraph.runner;
    // Joining players get every station and industry in full, so start from what they have.
    for (const s of this.state.stations.values()) this.stationSigs.set(s.id, stationSig(s));
    for (const i of this.state.industries.values()) this.industrySigs.set(i.id, industrySig(i));
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
      timeline: this.state.settings.timeline,
      economy: this.state.settings.economy,
    };
  }

  // ---- membership ------------------------------------------------------------

  join(session: Session): string | null {
    if (this.closed) return 'Game has ended';
    if (this.banned.has(session.clientId)) return 'The host removed you from this game';
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
      this.state.renamePlayer(player, this.uniqueName(session.name, player));
    } else {
      player = this.state.addPlayer(this.uniqueName(session.name), isHost);
      this.clientPlayers.set(session.clientId, player.id);
    }
    // Membership follows names, so names are unique within a game.
    session.name = player.name;

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
    this.send(session, { t: 'towns', towns: [...this.state.towns.values()], full: true });
    this.send(session, { t: 'industries', industries: [...this.state.industries.values()], removed: [], full: true });
    this.send(session, { t: 'stations', stations: [...this.state.stations.values()], removed: [], full: true });
    this.send(session, { t: 'trains', trains: [...this.state.trains.values()].map(trainInfo), removed: [], full: true });
    this.send(session, { t: 'news', items: this.state.news.slice(-NEWS_ON_JOIN), full: true });
    this.send(session, { t: 'history', companies: [...this.state.companies.values()].map((c) => ({ id: c.id, finances: c.finances, months: c.history })), full: true });

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

  /** `name`, or `name 2`, `name 3`… if another player in this game already uses it. */
  private uniqueName(name: string, self?: Player): string {
    const taken = new Set([...this.state.players.values()].filter((p) => p !== self).map((p) => p.name));
    if (!taken.has(name)) return name;
    for (let n = 2; ; n++) {
      const candidate = `${name.slice(0, 20)} ${n}`;
      if (!taken.has(candidate)) return candidate;
    }
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
    this.linkGraph.terminate();
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
      case 'watch': {
        const ids = (a: unknown) => new Set((Array.isArray(a) ? a : []).filter((n): n is number => Number.isInteger(n)).slice(0, 64));
        session.watchStations = ids(msg.stations);
        session.watchIndustries = ids(msg.industries);
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
        if (!isHost && !msg.export) return;
        this.sendSave(session, 'manual', msg.export === true);
        return;
      case 'updateSettings': {
        if (!isHost || !msg.settings || typeof msg.settings !== 'object') return;
        const s = this.state.settings;
        const { name, maxPlayers, isPublic } = msg.settings;
        if (typeof name === 'string' && name.trim()) s.name = name.replace(/\s+/g, ' ').trim().slice(0, 48);
        if (typeof maxPlayers === 'number' && Number.isFinite(maxPlayers)) {
          s.maxPlayers = Math.max(1, Math.min(this.config.maxPlayers, Math.round(maxPlayers)));
        }
        if (typeof isPublic === 'boolean') s.isPublic = isPublic;
        this.broadcast({ t: 'settings', settings: s });
        return;
      }
      case 'kick': {
        const target = this.state.players.get(msg.playerId);
        if (!isHost || !target || target.isHost) return;
        for (const [clientId, id] of this.clientPlayers) {
          if (id !== target.id) continue;
          this.banned.add(clientId);
          this.clientPlayers.delete(clientId);
        }
        for (const s of [...this.sessions]) {
          if (s.player !== target) continue;
          this.send(s, { t: 'roomClosed', reason: 'The host removed you from the game' });
          this.sessions.delete(s);
          s.room = null;
          s.player = null;
        }
        this.state.kickPlayer(target);
        this.globalDirty = true;
        this.systemChat(`${target.name} was removed by the host`);
        return;
      }
      case 'chat': {
        const text = String(msg.text ?? '').trim().slice(0, 300);
        if (!text) return;
        if (msg.channel === 'company') {
          const company = session.player?.companyId;
          if (company == null) return;
          const line: ServerMessage = { t: 'chat', from: session.name, text, at: Date.now(), channel: 'company' };
          for (const s of this.sessions) if (s.player?.companyId === company) this.send(s, line);
          return;
        }
        this.broadcast({ t: 'chat', from: session.name, text, at: Date.now() });
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
        const t0 = performance.now();
        const ev = this.state.step();
        const ms = performance.now() - t0;
        this.stats.stepMs = this.stats.steps === 0 ? ms : this.stats.stepMs * 0.98 + ms * 0.02;
        this.stats.steps++;
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

  private sendSave(session: Session, kind: 'auto' | 'manual', exportFile = false): void {
    this.send(session, {
      t: 'saveData',
      kind,
      name: this.state.settings.name,
      date: this.state.date,
      snapshot: encodeSnapshot(this.state),
      export: exportFile || undefined,
    });
  }

  /** Send globals if changed and any out-of-date subscribed chunks (bounded per flush). */
  flush(): void {
    if (this.globalDirty) {
      this.globalDirty = false;
      this.broadcast({ t: 'global', global: this.globalState() });
    }
    const st = this.state;
    const map = st.map;
    if (st.dirtyStations.size > 0 || st.removedStations.size > 0) {
      // Everyone hears about new, moved or renamed stations; day-to-day changes (waiting cargo,
      // ratings) only go to players looking at them.
      const all: Station[] = [];
      const local: Station[] = [];
      for (const id of st.dirtyStations) {
        const s = st.stations.get(id);
        if (!s) continue;
        const sig = stationSig(s);
        if (this.stationSigs.get(id) !== sig) {
          this.stationSigs.set(id, sig);
          all.push(s);
        } else local.push(s);
      }
      for (const id of st.removedStations) this.stationSigs.delete(id);
      const removed = [...st.removedStations];
      for (const session of this.sessions) {
        const near = local.filter((s) => session.watchStations?.has(s.id) || this.sees(session, s.x, s.y));
        if (all.length || near.length || removed.length) this.send(session, { t: 'stations', stations: [...all, ...near], removed, full: false });
      }
      st.dirtyStations.clear();
      st.removedStations.clear();
    }
    if (st.dirtyTowns.size > 0) {
      const towns = [...st.dirtyTowns].map((id) => st.towns.get(id)).filter((t) => t !== undefined);
      this.broadcast({ t: 'towns', towns, full: false });
      st.dirtyTowns.clear();
    }
    if (st.dirtyIndustries.size > 0 || st.removedIndustries.size > 0) {
      // New industries and level changes go to everyone; production figures only to players
      // looking at the industry.
      const all: Industry[] = [];
      const local: Industry[] = [];
      for (const id of st.dirtyIndustries) {
        const ind = st.industries.get(id);
        if (!ind) continue;
        const sig = industrySig(ind);
        if (this.industrySigs.get(id) !== sig) {
          this.industrySigs.set(id, sig);
          all.push(ind);
        } else local.push(ind);
      }
      for (const id of st.removedIndustries) this.industrySigs.delete(id);
      const removed = [...st.removedIndustries];
      for (const session of this.sessions) {
        const near = local.filter((i) => session.watchIndustries?.has(i.id) || this.sees(session, i.x + i.w / 2, i.y + i.h / 2));
        if (all.length || near.length || removed.length) this.send(session, { t: 'industries', industries: [...all, ...near], removed, full: false });
      }
      st.dirtyIndustries.clear();
      st.removedIndustries.clear();
    }
    if (st.historyChanged.size > 0) {
      const companies = [...st.historyChanged]
        .map((id) => st.companies.get(id))
        .filter((c) => c !== undefined)
        .map((c) => ({ id: c.id, finances: c.finances, months: c.history.slice(-1) }));
      if (companies.length) this.broadcast({ t: 'history', companies, full: false });
      st.historyChanged.clear();
    }
    if (st.dirtyTrains.size > 0 || st.removedTrains.size > 0) {
      const trains = [...st.dirtyTrains].map((id) => st.trains.get(id)).filter((t) => t !== undefined).map(trainInfo);
      this.broadcast({ t: 'trains', trains, removed: [...st.removedTrains], full: false });
      st.dirtyTrains.clear();
      st.removedTrains.clear();
    }
    if (st.pendingNews.length > 0) this.broadcast({ t: 'news', items: st.pendingNews.splice(0), full: false });
    const events = this.state.cargo.events;
    if (events.length > 0) {
      for (const ev of events) {
        const x = ev.tile % map.width;
        const chunk = Math.floor((ev.tile - x) / map.width / CHUNK_SIZE) * map.chunksX + Math.floor(x / CHUNK_SIZE);
        for (const s of this.sessions) if (s.subscribed.has(chunk)) this.send(s, { t: 'income', tile: ev.tile, amount: ev.amount });
      }
      events.length = 0;
      this.globalDirty = true;
    }
    const now = performance.now();
    if (now - this.lastPosAt >= POS_INTERVAL_MS) {
      this.lastPosAt = now;
      this.sendPositions();
    }
    const versions = this.state.map.chunkVersions;
    for (const s of this.sessions) {
      let budget = MAX_CHUNKS_PER_FLUSH;
      for (const c of s.subscribed) {
        const v = versions[c]!;
        if (s.sentVersions.get(c) === v) continue;
        const bytes = this.chunkBytes(c, v);
        this.stats.bytesOut += bytes.length;
        s.conn.send(bytes);
        s.sentVersions.set(c, v);
        if (--budget === 0) break;
      }
    }
  }

  /** Stream positions of trains touching each client's subscribed chunks, and signal aspects. */
  private sendPositions(): void {
    this.sendSignals();
    const map = this.state.map;
    const running = [...this.state.trains.values()].filter((t) => t.path.length > 0 || ((t.air || t.ship) && t.status !== 'depot'));
    if (running.length === 0 || this.sessions.size === 0) return;
    const chunksOf = running.map((t) => {
      const set = new Set<number>();
      const free = t.air ?? t.ship;
      if (free) {
        const cx = Math.max(0, Math.min(map.chunksX - 1, Math.floor(free.x / CHUNK_SIZE)));
        const cy = Math.max(0, Math.min(map.chunksY - 1, Math.floor(free.y / CHUNK_SIZE)));
        set.add(cy * map.chunksX + cx);
        return set;
      }
      for (const s of [t.path[0]!, t.path[t.path.length - 1]!]) {
        const tile = segTile(s);
        const x = tile % map.width;
        set.add(Math.floor((tile - x) / map.width / CHUNK_SIZE) * map.chunksX + Math.floor(x / CHUNK_SIZE));
      }
      return set;
    });
    for (const s of this.sessions) {
      const trains = running.filter((_, i) => [...chunksOf[i]!].some((c) => s.subscribed.has(c)));
      if (trains.length) this.send(s, { t: 'trainPos', trains: trains.map((t) => this.state.systemOf(t).motion(t)) });
    }
  }

  private sendSignals(): void {
    const map = this.state.map;
    const rail = this.state.rail;
    for (const s of this.sessions) {
      const tiles: number[] = [];
      const red: number[] = [];
      for (const tile of this.state.signalTiles) {
        const x = tile % map.width;
        const chunk = Math.floor((tile - x) / map.width / CHUNK_SIZE) * map.chunksX + Math.floor(x / CHUNK_SIZE);
        if (!s.subscribed.has(chunk)) continue;
        const bits = map.layers.signals[tile]!;
        let mask = 0;
        for (let td = 0; td < 12; td++) if ((bits >> td) & 1 && rail.signalRed(tile, td)) mask |= 1 << td;
        tiles.push(tile);
        red.push(mask);
      }
      const reserved: number[] = [];
      for (const k of rail.reservedPieces()) {
        const tile = Math.floor(k / 8);
        const x = tile % map.width;
        const chunk = Math.floor((tile - x) / map.width / CHUNK_SIZE) * map.chunksX + Math.floor(x / CHUNK_SIZE);
        if (s.subscribed.has(chunk)) reserved.push(k);
      }
      const key = tiles.join(',') + '|' + red.join(',') + '|' + reserved.join(',');
      if (key === s.lastSignals) continue;
      s.lastSignals = key;
      this.send(s, { t: 'signals', tiles, red, reserved });
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
      // Past quarters and monthly statistics travel in `history` messages.
      companies: [...this.state.companies.values()].map((c) => ({ ...c, finances: c.finances.slice(-1), history: [] })),
      players: [...this.state.players.values()],
      agreements: [...this.state.agreements.values()],
      waypoints: [...this.state.waypoints.values()],
      wrecks: this.state.rail.wreckTiles(),
      inflation: { ...this.state.inflation },
    };
  }

  /** Start each player at a town (largest first), falling back to land near the centre. */
  private spawnFor(player: Player): { x: number; y: number } {
    const towns = [...this.state.towns.values()].sort((a, b) => b.population - a.population);
    if (towns.length > 0) {
      const t = towns[(player.id - 1) % Math.min(towns.length, Math.max(4, this.state.settings.maxPlayers))]!;
      return { x: t.x, y: t.y };
    }
    const { width, height } = this.state.map;
    return findLandNear(this.state.map, width / 2, height / 2);
  }

  // ---- helpers ---------------------------------------------------------------

  /** Last shape of each station/industry sent to everyone (see flush). */
  private stationSigs = new Map<number, string>();
  private industrySigs = new Map<number, string>();

  /** Is the tile at (x, y) in a chunk this session is looking at? */
  private sees(session: Session, x: number, y: number): boolean {
    const map = this.state.map;
    const cx = Math.max(0, Math.min(map.chunksX - 1, Math.floor(x / CHUNK_SIZE)));
    const cy = Math.max(0, Math.min(map.chunksY - 1, Math.floor(y / CHUNK_SIZE)));
    return session.subscribed.has(cy * map.chunksX + cx);
  }

  send(session: Session, msg: ServerMessage): void {
    const bytes = encodeFrame(msg);
    this.stats.bytesOut += bytes.length;
    session.conn.send(bytes);
  }

  broadcast(msg: ServerMessage): void {
    if (this.sessions.size === 0) return;
    const bytes = encodeFrame(msg);
    this.stats.bytesOut += bytes.length * this.sessions.size;
    for (const s of this.sessions) s.conn.send(bytes);
  }

  private systemChat(text: string): void {
    this.broadcast({ t: 'chat', from: '', text, at: Date.now(), system: true });
  }
}
