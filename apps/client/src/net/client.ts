import {
  PROTOCOL_VERSION,
  ROLE_LABELS,
  executeCommand,
  roleAllows,
  type Command,
  type ChatChannel,
  type ClientMessage,
  type CommandResult,
  type GameSettings,
  type GameSpeed,
  type GlobalState,
  type MonthRecord,
  type QuarterRecord,
  type ServerMessage,
  HISTORY_MONTHS,
} from '@transportsim/shared';
import { ClientWorld } from '../game/clientWorld.ts';
import { downloadSave, gzip, listSaves, putSave, requestPersistentStorage } from '../saves/saveStore.ts';
import { openWindow, toast, useApp } from '../store.ts';
import { storageGet, storageSet, getClientId, getPlayerName } from './identity.ts';
import { Connection, serverUrl } from './connection.ts';

const AUTOSAVE_PREF_KEY = 'ts.autosavePref';

type Pending = (r: { ok: boolean; error?: string; cost?: number }) => void;

/** Singleton bridging the socket, the client world mirror and the UI store. */
class AppClient {
  readonly conn: Connection;
  world: ClientWorld | null = null;
  private seq = 0;
  private pending = new Map<number, Pending>();
  private worldListeners = new Set<(w: ClientWorld | null) => void>();
  /** Company books and statistics (merged into each `global`). */
  private histories = new Map<number, { finances: QuarterRecord[]; months: MonthRecord[] }>();
  private watchKey = '';

  constructor() {
    this.conn = new Connection(serverUrl(), () => ({
      t: 'hello',
      protocol: PROTOCOL_VERSION,
      clientId: getClientId(),
      name: getPlayerName() || 'Player',
    }));
    this.conn.onStatus = (status) => {
      useApp.setState({ conn: status });
      if (status === 'closed' && this.world) {
        // Connection dropped mid-game: the room may survive (we reconnect & rejoin).
        toast('Connection lost — reconnecting…', 'error');
      }
    };
    this.conn.onMessage = (m) => this.handle(m);
    void this.refreshSaves();
    // Tell the server which stations and industries have windows open.
    useApp.subscribe((s) => {
      const stations = s.windows.filter((w) => w.kind === 'station').map((w) => w.id);
      const industries = s.windows.filter((w) => w.kind === 'industry').map((w) => w.id);
      const key = `${stations}|${industries}`;
      if (key === this.watchKey || !this.world) return;
      this.watchKey = key;
      this.conn.send({ t: 'watch', stations, industries });
    });
  }

  start(): void {
    this.conn.connect();
  }

  onWorld(fn: (w: ClientWorld | null) => void): () => void {
    this.worldListeners.add(fn);
    return () => this.worldListeners.delete(fn);
  }

  private setWorld(w: ClientWorld | null): void {
    this.world = w;
    for (const l of this.worldListeners) l(w);
  }

  private rejoinRoomId: string | null = null;

  /** The global state with each company's past quarters and monthly statistics filled in. */
  private withHistory(g: GlobalState): GlobalState {
    return {
      ...g,
      companies: g.companies.map((c) => {
        const h = this.histories.get(c.id);
        if (!h) return c;
        const now = c.finances.at(-1);
        const past = h.finances.filter((q) => !now || q.year !== now.year || q.quarter !== now.quarter);
        return { ...c, finances: now ? [...past, now] : h.finances, history: h.months };
      }),
    };
  }

  private handle(m: ServerMessage): void {
    switch (m.t) {
      case 'welcome':
        useApp.setState({ limits: m.limits });
        if (this.rejoinRoomId) this.conn.send({ t: 'joinRoom', roomId: this.rejoinRoomId });
        else this.conn.send({ t: 'listRooms' });
        return;
      case 'error':
        useApp.setState({ busy: null });
        toast(m.message, 'error');
        if (this.rejoinRoomId && /not found|ended/i.test(m.message)) this.leaveLocal('The game is no longer running');
        return;
      case 'roomList':
        useApp.setState({ rooms: m.rooms });
        return;
      case 'roomJoined': {
        const sameRoom = this.world && useApp.getState().room?.id === m.roomId;
        if (!sameRoom) this.setWorld(new ClientWorld(m.settings));
        this.watchKey = '';
        m.global = this.withHistory(m.global);
        this.world!.applyGlobal(m.global);
        this.rejoinRoomId = m.roomId;
        useApp.setState({
          room: { id: m.roomId, playerId: m.playerId, isHost: m.isHost, settings: m.settings, spawn: m.spawn },
          global: m.global,
          autosave: m.autosave,
          busy: null,
          closedReason: null,
          hostStatus: { connected: true },
          chat: sameRoom ? useApp.getState().chat : [],
        });
        if (sameRoom) this.resubscribe?.();
        if (m.isHost && !m.autosave && !sameRoom) this.askAutosave();
        if (!sameRoom && m.global.players.find((p) => p.id === m.playerId)?.companyId == null) {
          openWindow({ kind: 'company', id: 0 });
        }
        return;
      }
      case 'roomClosed':
        this.leaveLocal(m.reason);
        return;
      case 'chunk':
        this.world?.applyChunk(m.data);
        return;
      case 'towns':
        this.world?.applyTowns(m.towns, m.full);
        return;
      case 'industries':
        this.world?.applyIndustries(m.industries, m.removed, m.full);
        return;
      case 'stations':
        this.world?.applyStations(m.stations, m.removed, m.full);
        return;
      case 'trains':
        this.world?.applyTrains(m.trains, m.removed, m.full);
        useApp.setState((s) => ({ trainsRev: s.trainsRev + 1 }));
        return;
      case 'trainPos':
        this.world?.applyTrainPositions(m.trains);
        return;
      case 'signals':
        this.world?.applySignals(m.tiles, m.red, m.reserved ?? []);
        return;
      case 'income':
        this.world?.onIncome?.(m.tile, m.amount);
        return;
      case 'global': {
        const g = this.withHistory(m.global);
        this.notifyMembership(useApp.getState().global, g);
        this.world?.applyGlobal(g);
        useApp.setState({ global: g });
        return;
      }
      case 'history': {
        if (m.full) this.histories.clear();
        for (const c of m.companies) {
          const had = this.histories.get(c.id);
          const months = m.full || !had ? c.months : [...had.months, ...c.months].slice(-HISTORY_MONTHS);
          this.histories.set(c.id, { finances: c.finances, months });
        }
        const g = useApp.getState().global;
        if (g) {
          const merged = this.withHistory(g);
          this.world?.applyGlobal(merged);
          useApp.setState({ global: merged });
        }
        return;
      }
      case 'commandResult': {
        const p = this.pending.get(m.seq);
        this.pending.delete(m.seq);
        p?.(m);
        return;
      }
      case 'settings': {
        const room = useApp.getState().room;
        if (!room) return;
        if (this.world) Object.assign(this.world.state.settings, m.settings);
        useApp.setState({ room: { ...room, settings: m.settings } });
        return;
      }
      case 'hostStatus':
        useApp.setState({ hostStatus: { connected: m.connected, closesAt: m.closesAt } });
        return;
      case 'autosaveStatus':
        useApp.setState({ autosave: m.enabled });
        return;
      case 'saveData':
        void this.storeSave(m);
        return;
      case 'chat':
        useApp.setState((s) => ({ chat: [...s.chat.slice(-199), m] }));
        return;
      case 'news':
        useApp.setState((s) => {
          const known = new Set((m.full ? [] : s.news).map((n) => n.id));
          const fresh = m.items.filter((n) => !known.has(n.id));
          return {
            news: [...(m.full ? [] : s.news), ...fresh].slice(-100),
            ticker: !m.full && fresh.length > 0 ? fresh[fresh.length - 1]! : s.ticker,
          };
        });
        return;
      case 'pong':
        return;
    }
  }

  /** Toasts for membership changes that concern the local player. */
  private notifyMembership(prev: GlobalState | null, next: GlobalState): void {
    const playerId = useApp.getState().room?.playerId;
    if (!prev || playerId === undefined) return;
    const me = next.players.find((p) => p.id === playerId);
    const before = prev.players.find((p) => p.id === playerId);
    if (!me || !before) return;
    const company = next.companies.find((c) => c.id === me.companyId);
    const was = prev.companies.find((c) => c.id === before.companyId);
    const role = company?.members.find((x) => x.name === me.name)?.role;
    const oldRole = was?.members.find((x) => x.name === before.name)?.role;
    if (me.companyId !== before.companyId) {
      if (company && role) toast(`You joined ${company.name} as ${ROLE_LABELS[role].toLowerCase()}`, 'success');
      else if (was) toast(`You are no longer a member of ${was.name}`);
    } else if (company && role && oldRole && role !== oldRole) {
      toast(`You are now ${role === 'owner' ? 'the owner' : `a ${ROLE_LABELS[role].toLowerCase()}`} of ${company.name}`, 'success');
    }
    if (company && roleAllows(role, 'members')) {
      const old = new Set(was?.id === company.id ? was.requests : []);
      for (const name of company.requests) if (!old.has(name)) toast(`${name} asks to join ${company.name} — press C to answer`, 'info', 8000);
    }
    if (company && roleAllows(role, 'build')) {
      const known = new Set(prev.agreements.map((a) => a.id));
      for (const a of next.agreements) {
        if (known.has(a.id) || a.proposedBy === company.id || (a.host !== company.id && a.guest !== company.id)) continue;
        const from = next.companies.find((c) => c.id === a.proposedBy)?.name ?? 'Another company';
        toast(`${from} proposes ${a.host === company.id ? 'using your track' : 'letting you use their track'} — press C to answer`, 'info', 8000);
      }
    }
    for (const c of next.companies) {
      const invited = c.invites.some((x) => x.name === me.name);
      const wasInvited = prev.companies.find((o) => o.id === c.id)?.invites.some((x) => x.name === me.name);
      if (invited && !wasInvited) toast(`${c.name} invites you to join — press C to answer`, 'info', 8000);
    }
  }

  /** Called by the renderer so we can re-send our chunk subscription after a reconnect. */
  resubscribe: (() => void) | null = null;

  private leaveLocal(reason: string | null): void {
    this.rejoinRoomId = null;
    this.setWorld(null);
    for (const p of this.pending.values()) p({ ok: false, error: 'Left game' });
    this.pending.clear();
    useApp.setState({ room: null, global: null, news: [], ticker: null, closedReason: reason, tool: null, hover: null, autosavePrompt: false, windows: [], ordersFor: null });
    this.conn.send({ t: 'listRooms' });
  }

  private askAutosave(): void {
    const pref = storageGet(AUTOSAVE_PREF_KEY);
    if (pref === 'yes') this.setAutosave(true);
    else if (pref !== 'no') useApp.setState({ autosavePrompt: true });
  }

  answerAutosave(enabled: boolean, remember: boolean): void {
    if (remember) storageSet(AUTOSAVE_PREF_KEY, enabled ? 'yes' : 'no');
    useApp.setState({ autosavePrompt: false });
    this.setAutosave(enabled);
  }

  setAutosave(enabled: boolean): void {
    if (enabled) void requestPersistentStorage();
    this.conn.send({ t: 'autosave', enabled });
  }

  private async storeSave(m: Extract<ServerMessage, { t: 'saveData' }>): Promise<void> {
    const room = useApp.getState().room;
    if (!room) return;
    if (m.export) {
      try {
        downloadSave(m.name, await gzip(m.snapshot));
        toast('Save file downloaded', 'success', 2500);
      } catch (e) {
        toast(`Export failed: ${(e as Error).message}`, 'error');
      }
      return;
    }
    if (m.kind === 'auto' && !useApp.getState().autosave) return; // consent revoked meanwhile
    try {
      const s = room.settings;
      await putSave(
        { gameKey: `${s.seed}:${s.mapWidth}x${s.mapHeight}`, name: m.name, kind: m.kind, gameDate: m.date },
        m.snapshot,
      );
      await this.refreshSaves();
      toast(m.kind === 'auto' ? 'Autosaved to this browser' : 'Game saved to this browser', 'success', 2500);
    } catch (e) {
      toast(`Saving failed: ${(e as Error).message}`, 'error');
    }
  }

  async refreshSaves(): Promise<void> {
    useApp.setState({ saves: await listSaves() });
  }

  // ---- actions ---------------------------------------------------------------

  setName(): void {
    // Re-send hello so the server picks up the new name.
    this.conn.send({ t: 'hello', protocol: PROTOCOL_VERSION, clientId: getClientId(), name: getPlayerName() || 'Player' });
  }

  listRooms(): void {
    this.conn.send({ t: 'listRooms' });
  }

  createRoom(settings: Partial<GameSettings>, save?: Uint8Array): void {
    useApp.setState({ busy: save ? 'Uploading save…' : 'Generating world…' });
    this.conn.send({ t: 'createRoom', settings, save });
  }

  joinRoom(roomId: string): void {
    useApp.setState({ busy: 'Joining…' });
    this.conn.send({ t: 'joinRoom', roomId: roomId.trim().toUpperCase() });
  }

  leaveRoom(): void {
    this.conn.send({ t: 'leaveRoom' });
    this.leaveLocal(null);
  }

  subscribe(chunks: number[]): void {
    this.conn.send({ t: 'subscribe', chunks });
  }

  setSpeed(speed: GameSpeed): void {
    this.conn.send({ t: 'setSpeed', speed });
  }

  requestSave(): void {
    this.conn.send({ t: 'requestSave' });
  }

  /** Download the current game as a .tsave file (any player). */
  exportGame(): void {
    toast('Preparing save file…', 'info', 1500);
    this.conn.send({ t: 'requestSave', export: true });
  }

  updateSettings(settings: Extract<ClientMessage, { t: 'updateSettings' }>['settings']): void {
    this.conn.send({ t: 'updateSettings', settings });
  }

  kick(playerId: number): void {
    this.conn.send({ t: 'kick', playerId });
  }

  chat(text: string, channel: ChatChannel = 'all'): void {
    this.conn.send({ t: 'chat', text, channel });
  }

  /** Local validation against the mirrored state (for cursor previews). */
  preview(cmd: Command): CommandResult | null {
    const w = this.world;
    const room = useApp.getState().room;
    if (!w || !room) return null;
    const player = w.state.players.get(room.playerId);
    return executeCommand(w.state, { playerId: room.playerId, companyId: player?.companyId ?? null }, cmd, true);
  }

  command(cmd: Command): Promise<{ ok: boolean; error?: string; cost?: number }> {
    const seq = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(seq, resolve);
      this.conn.send({ t: 'command', seq, cmd });
    });
  }
}

export const client = new AppClient();
