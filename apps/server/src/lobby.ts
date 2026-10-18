import {
  GameState,
  PROTOCOL_VERSION,
  decode,
  encode,
  restoreSnapshot,
  sanitizeSettings,
  type ClientMessage,
  type GameSettings,
  type ServerLimits,
  type ServerMessage,
} from '@transportsim/shared';
import type { ServerConfig } from './config.ts';
import { Room, type Connection, type Session } from './room.ts';

const ROOM_ID_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Owns all sessions and rooms. Holds nothing on disk: rooms live only in memory. */
export class Lobby {
  readonly rooms = new Map<string, Room>();
  readonly config: ServerConfig;
  private readonly limits: ServerLimits;
  /** Sessions that said hello, keyed by connection. */
  private readonly sessions = new Map<Connection, Session>();

  constructor(config: ServerConfig) {
    this.config = config;
    this.limits = { maxPlayers: config.maxPlayers, maxMapSize: config.maxMapSize };
  }

  onMessage(conn: Connection, data: Uint8Array | ArrayBuffer): void {
    let msg: ClientMessage;
    try {
      msg = decode<ClientMessage>(data);
    } catch {
      return this.send(conn, { t: 'error', message: 'Malformed message' });
    }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

    if (msg.t === 'ping') return this.send(conn, { t: 'pong', at: msg.at });
    if (msg.t === 'hello') return this.hello(conn, msg);

    const session = this.sessions.get(conn);
    if (!session) return this.send(conn, { t: 'error', message: 'Say hello first' });

    switch (msg.t) {
      case 'listRooms':
        return this.send(conn, { t: 'roomList', rooms: this.publicRooms() });
      case 'createRoom':
        return this.createRoom(session, msg.settings ?? {}, msg.save);
      case 'joinRoom': {
        if (session.room) session.room.leave(session, true);
        const room = this.rooms.get(String(msg.roomId ?? '').toUpperCase());
        if (!room) return this.send(conn, { t: 'error', message: 'Game not found' });
        const err = room.join(session);
        if (err) this.send(conn, { t: 'error', message: err });
        return;
      }
      case 'leaveRoom':
        session.room?.leave(session, true);
        return this.send(conn, { t: 'roomList', rooms: this.publicRooms() });
      default:
        session.room?.handle(session, msg);
    }
  }

  onClose(conn: Connection): void {
    const session = this.sessions.get(conn);
    if (!session) return;
    this.sessions.delete(conn);
    session.room?.leave(session, false);
  }

  private hello(conn: Connection, msg: Extract<ClientMessage, { t: 'hello' }>): void {
    if (msg.protocol !== PROTOCOL_VERSION) {
      this.send(conn, { t: 'error', message: 'Client and server versions differ — please reload' });
      return conn.close();
    }
    const clientId = String(msg.clientId ?? '').slice(0, 64);
    if (clientId.length < 8) return this.send(conn, { t: 'error', message: 'Invalid client id' });
    const name = String(msg.name ?? '').replace(/\s+/g, ' ').trim().slice(0, 24) || 'Player';
    const existing = this.sessions.get(conn);
    if (existing) {
      existing.name = name;
    } else {
      this.sessions.set(conn, {
        conn,
        clientId,
        name,
        room: null,
        player: null,
        subscribed: new Set(),
        sentVersions: new Map(),
        cmdWindowStart: 0,
        cmdCount: 0,
      });
    }
    this.send(conn, { t: 'welcome', protocol: PROTOCOL_VERSION, limits: this.limits });
  }

  private createRoom(session: Session, settingsIn: object, save?: Uint8Array): void {
    if (this.rooms.size >= this.config.maxRooms) {
      return this.send(session.conn, { t: 'error', message: 'Server is full, try again later' });
    }
    if (session.room) session.room.leave(session, true);
    let state: GameState;
    try {
      if (save) {
        if (!(save instanceof Uint8Array)) throw new Error('Invalid save data');
        // Host may change lobby-level settings (name, slots, visibility) when resuming.
        const { name, maxPlayers, isPublic } = settingsIn as Partial<GameSettings>; // re-sanitized in restoreSnapshot
        state = restoreSnapshot(save, this.limits, stripUndefined({ name, maxPlayers, isPublic }));
      } else {
        // TODO(M8): generate large maps in a worker so creation doesn't stall other rooms.
        state = GameState.create(sanitizeSettings(settingsIn, this.limits));
      }
    } catch (e) {
      return this.send(session.conn, { t: 'error', message: `Could not create game: ${(e as Error).message}` });
    }
    const id = this.newRoomId();
    const room = new Room(id, state, session.clientId, this.config, (r) => this.rooms.delete(r.id));
    this.rooms.set(id, room);
    room.start();
    const err = room.join(session);
    if (err) {
      room.close(err);
      this.send(session.conn, { t: 'error', message: err });
    }
  }

  publicRooms() {
    return [...this.rooms.values()].filter((r) => r.state.settings.isPublic && !r.closed).map((r) => r.summary());
  }

  private newRoomId(): string {
    for (;;) {
      let id = '';
      const bytes = crypto.getRandomValues(new Uint8Array(6));
      for (const b of bytes) id += ROOM_ID_ALPHABET[b % ROOM_ID_ALPHABET.length];
      if (!this.rooms.has(id)) return id;
    }
  }

  private send(conn: Connection, msg: ServerMessage): void {
    conn.send(encode(msg));
  }

  shutdown(): void {
    for (const room of this.rooms.values()) room.close('Server is shutting down');
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}
