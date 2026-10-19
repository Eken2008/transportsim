import { describe, expect, test } from 'bun:test';
import {
  PROTOCOL_VERSION,
  TICKS_PER_DAY,
  decodeFrame,
  encodeFrame,
  type ClientMessage,
  type ServerMessage,
} from '@transportsim/shared';
import type { ServerConfig } from '../src/config.ts';
import { Lobby } from '../src/lobby.ts';
import type { Connection } from '../src/room.ts';

const CONFIG: ServerConfig = {
  port: 0,
  maxPlayers: 3,
  maxMapSize: 256,
  maxRooms: 4,
  hostGraceMs: 50,
  autosaveMinIntervalMs: 0,
  staticDir: null,
};

class FakeConn implements Connection {
  inbox: ServerMessage[] = [];
  closed = false;
  send(bytes: Uint8Array) {
    this.inbox.push(decodeFrame<ServerMessage>(bytes));
  }
  close() {
    this.closed = true;
  }
  last<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }> | undefined {
    for (let i = this.inbox.length - 1; i >= 0; i--) {
      if (this.inbox[i]!.t === t) return this.inbox[i] as Extract<ServerMessage, { t: T }>;
    }
    return undefined;
  }
}

function client(lobby: Lobby, name: string, id = `${name}-client-id`) {
  const conn = new FakeConn();
  const send = (m: ClientMessage) => lobby.onMessage(conn, encodeFrame(m));
  send({ t: 'hello', protocol: PROTOCOL_VERSION, clientId: id, name });
  return { conn, send };
}

function hostGame(lobby: Lobby, extra: object = {}) {
  const host = client(lobby, 'Host');
  host.send({ t: 'createRoom', settings: { mapWidth: 128, mapHeight: 128, seed: 7, maxPlayers: 99, ...extra } });
  const joined = host.conn.last('roomJoined')!;
  const room = lobby.rooms.get(joined.roomId)!;
  return { host, joined, room };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('lobby & rooms', () => {
  test('creating a game clamps player slots to MAX_PLAYERS', () => {
    const lobby = new Lobby(CONFIG);
    const { joined, room } = hostGame(lobby);
    expect(joined.isHost).toBe(true);
    expect(room.state.settings.maxPlayers).toBe(3);
    expect(lobby.publicRooms()).toHaveLength(1);
    lobby.shutdown();
  });

  test('rooms refuse players beyond the slot count', () => {
    const lobby = new Lobby(CONFIG);
    const { joined } = hostGame(lobby);
    const a = client(lobby, 'A');
    const b = client(lobby, 'B');
    const c = client(lobby, 'C');
    a.send({ t: 'joinRoom', roomId: joined.roomId });
    b.send({ t: 'joinRoom', roomId: joined.roomId });
    c.send({ t: 'joinRoom', roomId: joined.roomId });
    expect(a.conn.last('roomJoined')).toBeDefined();
    expect(b.conn.last('roomJoined')).toBeDefined();
    expect(c.conn.last('error')?.message).toBe('Game is full');
    lobby.shutdown();
  });

  test('host disconnect closes the room after the grace period', async () => {
    const lobby = new Lobby(CONFIG);
    const { host, joined } = hostGame(lobby);
    const guest = client(lobby, 'Guest');
    guest.send({ t: 'joinRoom', roomId: joined.roomId });
    lobby.onClose(host.conn);
    expect(guest.conn.last('hostStatus')?.connected).toBe(false);
    expect(lobby.rooms.has(joined.roomId)).toBe(true);
    await wait(80);
    expect(guest.conn.last('roomClosed')?.reason).toContain('host');
    expect(lobby.rooms.has(joined.roomId)).toBe(false);
  });

  test('host reconnecting within the grace period keeps the room', async () => {
    const lobby = new Lobby(CONFIG);
    const { host, joined } = hostGame(lobby);
    lobby.onClose(host.conn);
    const again = client(lobby, 'Host'); // same clientId
    again.send({ t: 'joinRoom', roomId: joined.roomId });
    expect(again.conn.last('roomJoined')?.isHost).toBe(true);
    await wait(80);
    expect(lobby.rooms.has(joined.roomId)).toBe(true);
    lobby.shutdown();
  });

  test('host leaving explicitly ends the game immediately', () => {
    const lobby = new Lobby(CONFIG);
    const { host, joined } = hostGame(lobby);
    host.send({ t: 'leaveRoom' });
    expect(lobby.rooms.has(joined.roomId)).toBe(false);
  });

  test('commands apply, chunks sync to subscribers, and saves resume', () => {
    const lobby = new Lobby(CONFIG);
    const { host, room } = hostGame(lobby, { seed: 11 });
    const map = room.state.map;
    host.send({ t: 'subscribe', chunks: [0, 1, 2, 3] });
    room.flush();
    expect(host.conn.inbox.filter((m) => m.t === 'chunk')).toHaveLength(4);

    // Players join without a company and found one
    host.send({ t: 'command', seq: 0, cmd: { type: 'terraform', x0: 5, y0: 5, x1: 5, y1: 5, mode: 'raise' } });
    expect(host.conn.last('commandResult')).toMatchObject({ seq: 0, ok: false });
    host.send({ t: 'command', seq: 0, cmd: { type: 'foundCompany', name: 'Host Rail', color: 2 } });
    expect(host.conn.last('commandResult')).toMatchObject({ seq: 0, ok: true });

    // Find a land corner and raise it
    let x = 5;
    const y = 5;
    while (map.cornerHeight(x, y) === 0 && x < 120) x++;
    const h = map.cornerHeight(x, y);
    host.send({ t: 'command', seq: 1, cmd: { type: 'terraform', x0: x, y0: y, x1: x, y1: y, mode: 'raise' } });
    expect(host.conn.last('commandResult')).toMatchObject({ seq: 1, ok: true });
    expect(map.cornerHeight(x, y)).toBe(h + 1);
    host.conn.inbox = [];
    room.flush();
    expect(host.conn.inbox.some((m) => m.t === 'chunk' && m.data.cx === 0 && m.data.cy === 0)).toBe(true);

    // Guests cannot change speed
    const guest = client(lobby, 'Guest');
    guest.send({ t: 'joinRoom', roomId: room.id });
    guest.send({ t: 'setSpeed', speed: 8 });
    expect(room.speed).toBe(1);

    // Manual save goes to the host only, and resumes into a new room
    for (let i = 0; i < TICKS_PER_DAY * 3; i++) room.state.step();
    host.send({ t: 'requestSave' });
    const save = host.conn.last('saveData')!;
    expect(guest.conn.last('saveData')).toBeUndefined();
    host.send({ t: 'leaveRoom' });
    host.send({ t: 'createRoom', settings: { name: 'Resumed' }, save: save.snapshot });
    const resumed = lobby.rooms.get(host.conn.last('roomJoined')!.roomId)!;
    expect(resumed.state.settings.name).toBe('Resumed');
    expect(resumed.state.date).toBe(save.date);
    expect(resumed.state.map.cornerHeight(x, y)).toBe(h + 1);
    // Host rejoins their old company by name
    expect(resumed.state.players.values().next().value!.companyId).toBe(0);
    lobby.shutdown();
  });

  test('autosave is opt-in and only sent to the host', () => {
    const lobby = new Lobby(CONFIG);
    const { host, room } = hostGame(lobby);
    const guest = client(lobby, 'Guest');
    guest.send({ t: 'joinRoom', roomId: room.id });
    // Drive the loop with a fake clock; the test never yields, so the real timer can't interfere.
    let now = performance.now();
    const runDays = (days: number) => {
      const target = room.state.tick + days * TICKS_PER_DAY;
      while (room.state.tick < target) room.update((now += 1000));
    };
    room.speed = 8;
    runDays(35);
    expect(host.conn.last('saveData')).toBeUndefined();
    host.send({ t: 'autosave', enabled: true });
    expect(host.conn.last('autosaveStatus')?.enabled).toBe(true);
    runDays(35);
    expect(host.conn.last('saveData')?.kind).toBe('auto');
    expect(guest.conn.last('saveData')).toBeUndefined();
    lobby.shutdown();
  });

  test('player names are unique within a game, and players start without a company', () => {
    const lobby = new Lobby(CONFIG);
    const { room } = hostGame(lobby);
    const a = client(lobby, 'Guest', 'guest-a-client');
    const b = client(lobby, 'Guest', 'guest-b-client');
    a.send({ t: 'joinRoom', roomId: room.id });
    b.send({ t: 'joinRoom', roomId: room.id });
    const names = [...room.state.players.values()].map((p) => p.name);
    expect(names).toEqual(['Host', 'Guest', 'Guest 2']);
    expect([...room.state.players.values()].every((p) => p.companyId === null)).toBe(true);
    // Reconnecting keeps the player's name
    a.send({ t: 'leaveRoom' });
    a.send({ t: 'joinRoom', roomId: room.id });
    expect([...room.state.players.values()].map((p) => p.name)).toEqual(names);
    lobby.shutdown();
  });

  test('rejects garbage and wrong protocol', () => {
    const lobby = new Lobby(CONFIG);
    const conn = new FakeConn();
    lobby.onMessage(conn, new Uint8Array([0xc1, 0xff, 0x00]));
    lobby.onMessage(conn, encodeFrame({ t: 'listRooms' }));
    expect(conn.last('error')).toBeDefined();
    lobby.onMessage(conn, encodeFrame({ t: 'hello', protocol: -1, clientId: 'abcdefghij', name: 'x' }));
    expect(conn.closed).toBe(true);
  });
});
