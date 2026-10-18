import {
  PROTOCOL_VERSION,
  executeCommand,
  type Command,
  type CommandResult,
  type GameSettings,
  type GameSpeed,
  type ServerMessage,
} from '@transportsim/shared';
import { ClientWorld } from '../game/clientWorld.ts';
import { listSaves, putSave, requestPersistentStorage } from '../saves/saveStore.ts';
import { toast, useApp } from '../store.ts';
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
        this.world?.applySignals(m.tiles, m.red);
        return;
      case 'global':
        this.world?.applyGlobal(m.global);
        useApp.setState({ global: m.global });
        return;
      case 'commandResult': {
        const p = this.pending.get(m.seq);
        this.pending.delete(m.seq);
        p?.(m);
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
      case 'pong':
        return;
    }
  }

  /** Called by the renderer so we can re-send our chunk subscription after a reconnect. */
  resubscribe: (() => void) | null = null;

  private leaveLocal(reason: string | null): void {
    this.rejoinRoomId = null;
    this.setWorld(null);
    for (const p of this.pending.values()) p({ ok: false, error: 'Left game' });
    this.pending.clear();
    useApp.setState({ room: null, global: null, closedReason: reason, tool: null, hover: null, autosavePrompt: false, windows: [], ordersFor: null });
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

  chat(text: string): void {
    this.conn.send({ t: 'chat', text });
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
