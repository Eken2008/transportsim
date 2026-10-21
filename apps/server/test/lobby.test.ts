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

  test("stations: new ones go to everyone, daily changes only to players who see or watch them", () => {
    const lobby = new Lobby(CONFIG);
    const { host, joined, room } = hostGame(lobby);
    const guest = client(lobby, 'Guest');
    guest.send({ t: 'joinRoom', roomId: joined.roomId });
    host.send({ t: 'subscribe', chunks: [0] }); // the north-west corner, where the station is
    guest.send({ t: 'subscribe', chunks: [3] });
    const st = { id: 99, name: 'Test Halt', owner: 0, x: 10, y: 10, x0: 10, y0: 10, x1: 10, y1: 10, tiles: 1, townId: null, builtDays: 0, waiting: {}, waitingTotal: 0, rating: 175 };
    room.state.stations.set(st.id, st);
    const got = (c: FakeConn) => c.inbox.some((m) => m.t === 'stations' && m.stations.some((s) => s.id === st.id));
    const update = () => {
      host.conn.inbox = [];
      guest.conn.inbox = [];
      room.state.markStationDirty(st.id);
      room.flush();
    };
    update();
    expect(got(host.conn)).toBe(true);
    expect(got(guest.conn)).toBe(true);
    st.waitingTotal = 12;
    update();
    expect(got(host.conn)).toBe(true);
    expect(got(guest.conn)).toBe(false);
    guest.send({ t: 'watch', stations: [st.id], industries: [] });
    update();
    expect(got(guest.conn)).toBe(true);
    guest.send({ t: 'watch', stations: [], industries: [] });
    st.name = 'Test Central';
    update();
    expect(got(guest.conn)).toBe(true);
    lobby.shutdown();
  });

  test('company books: the daily global carries the current quarter; history comes on its own', () => {
    const lobby = new Lobby(CONFIG);
    const { host, room } = hostGame(lobby);
    host.send({ t: 'command', seq: 1, cmd: { type: 'foundCompany', name: 'H Rail', color: 1 } });
    const c = [...room.state.companies.values()][0]!;
    c.finances.unshift({ year: 1899, quarter: 3, ledger: { ...c.finances[0]!.ledger, income: 500 }, modes: {} });
    c.history.push({ date: 1, money: 1, loan: 0, value: 1, vehicles: 0, ledger: { ...c.finances[0]!.ledger }, modes: {}, delivered: {} });
    expect(room.globalState().companies[0]!.finances).toHaveLength(1);
    expect(room.globalState().companies[0]!.history).toHaveLength(0);
    const late = client(lobby, 'Late');
    late.send({ t: 'joinRoom', roomId: room.id });
    const h = late.conn.last('history')!;
    expect(h.full).toBe(true);
    expect(h.companies[0]!.finances).toHaveLength(2);
    expect(h.companies[0]!.months).toHaveLength(1);
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

  test('news reaches everyone; company chat only reaches members', () => {
    const lobby = new Lobby(CONFIG);
    const { host, room } = hostGame(lobby);
    const ally = client(lobby, 'Ally');
    const rival = client(lobby, 'Rival');
    ally.send({ t: 'joinRoom', roomId: room.id });
    rival.send({ t: 'joinRoom', roomId: room.id });
    expect(rival.conn.last('news')).toMatchObject({ full: true, items: [] });
    host.send({ t: 'command', seq: 1, cmd: { type: 'foundCompany', name: 'Host Rail', color: 0 } });
    room.flush();
    expect(rival.conn.last('news')).toMatchObject({ full: false, items: [{ text: 'Host founds Host Rail' }] });
    host.send({ t: 'command', seq: 2, cmd: { type: 'invitePlayer', name: 'Ally', role: 'operator' } });
    ally.send({ t: 'command', seq: 1, cmd: { type: 'joinCompany', company: 0 } });
    expect(ally.conn.last('commandResult')).toMatchObject({ ok: true });

    for (const c of [host, ally, rival]) c.conn.inbox = [];
    ally.send({ t: 'chat', text: 'secret plan', channel: 'company' });
    expect(host.conn.last('chat')).toMatchObject({ from: 'Ally', text: 'secret plan', channel: 'company' });
    expect(ally.conn.last('chat')?.text).toBe('secret plan');
    expect(rival.conn.last('chat')).toBeUndefined();
    // Without a company, company chat goes nowhere
    rival.send({ t: 'chat', text: 'hello?', channel: 'company' });
    expect(host.conn.last('chat')?.text).toBe('secret plan');
    lobby.shutdown();
  });

  test('the host changes live settings and removes players, who cannot rejoin', () => {
    const lobby = new Lobby(CONFIG);
    const { host, room } = hostGame(lobby);
    const guest = client(lobby, 'Guest');
    guest.send({ t: 'joinRoom', roomId: room.id });
    expect(lobby.publicRooms()[0]).toMatchObject({ timeline: 'era', economy: 'normal' });

    // Only the host changes settings; slots are clamped to the server limit
    guest.send({ t: 'updateSettings', settings: { name: 'Hijacked' } });
    expect(room.state.settings.name).not.toBe('Hijacked');
    host.send({ t: 'updateSettings', settings: { name: '  Renamed  ', maxPlayers: 99, isPublic: false } });
    expect(room.state.settings).toMatchObject({ name: 'Renamed', maxPlayers: CONFIG.maxPlayers, isPublic: false });
    expect(guest.conn.last('settings')?.settings.name).toBe('Renamed');
    expect(lobby.publicRooms()).toHaveLength(0);

    // The guest joins a company, then the host removes them
    guest.send({ t: 'command', seq: 1, cmd: { type: 'foundCompany', name: 'Guest Co', color: 1 } });
    const guestId = [...room.state.players.values()].find((p) => p.name === 'Guest')!.id;
    guest.send({ t: 'kick', playerId: room.state.players.values().next().value!.id });
    expect(room.state.players.size).toBe(2); // guests can't kick
    host.send({ t: 'kick', playerId: guestId });
    expect(guest.conn.last('roomClosed')?.reason).toContain('removed');
    expect(room.state.players.has(guestId)).toBe(false);
    expect(room.state.companies.get(0)!.members).toEqual([]);
    guest.send({ t: 'joinRoom', roomId: room.id });
    expect(guest.conn.last('error')?.message).toContain('removed');
    expect(room.sessions.size).toBe(1);
    lobby.shutdown();
  });

  test('members hear their stations’ figures wherever they are; everyone hears industries monthly', () => {
    const lobby = new Lobby(CONFIG);
    const { host, room } = hostGame(lobby);
    const guest = client(lobby, 'Guest');
    guest.send({ t: 'joinRoom', roomId: room.id });
    host.send({ t: 'command', seq: 1, cmd: { type: 'foundCompany', name: 'Host Rail', color: 0 } });
    const company = [...room.state.companies.values()][0]!;
    const st = { id: 5, name: 'Far', owner: company.id, x: 100, y: 100, x0: 100, y0: 100, x1: 100, y1: 100, tiles: 1, townId: null, builtDays: room.state.date, waiting: {}, waitingTotal: 42, rating: 200 };
    room.state.stations.set(st.id, st);
    host.conn.inbox = [];
    guest.conn.inbox = [];
    room.flush();
    const [id, rating, target, waiting] = host.conn.last('summary')!.stations!;
    expect([id, rating, waiting]).toEqual([5, 200, 42]);
    expect(target).toBeGreaterThan(0);
    // Not to players outside the company, and only again once something changed.
    expect(guest.conn.last('summary')).toBeUndefined();
    host.conn.inbox = [];
    (room as unknown as { lastStationStatsAt: number }).lastStationStatsAt = -Infinity;
    room.flush();
    expect(host.conn.last('summary')).toBeUndefined();
    st.waitingTotal = 50;
    (room as unknown as { lastStationStatsAt: number }).lastStationStatsAt = -Infinity;
    room.flush();
    expect(host.conn.last('summary')!.stations).toEqual([5, 200, target, 50]);

    const ind = [...room.state.industries.values()][0]!;
    const month = new Date(room.state.date * 86400000).getUTCMonth();
    let now = 0;
    while (new Date(room.state.date * 86400000).getUTCMonth() === month) room.update((now += 2000));
    room.flush();
    const rows = guest.conn.last('summary')!.industries!;
    expect(rows).toHaveLength(room.state.industries.size);
    expect(rows.find((r) => r[0] === ind.id)).toBeDefined();
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
