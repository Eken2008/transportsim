/**
 * Load test: starts a server (or uses --url), has bot players join one game over WebSockets,
 * each build a signalled rail loop with trains, then keep issuing commands and moving their view
 * around. Reports server tick time, bytes per player per second and command latency.
 *
 *   bun scripts/loadtest.ts [--bots 15] [--map 1024] [--seconds 60] [--speed 4] [--url ws://host:port]
 */
import { spawn } from 'node:child_process';
import {
  CHUNK_SIZE,
  Edge,
  PROTOCOL_VERSION,
  Piece,
  decodeFrame,
  encodeFrame,
  type ClientMessage,
  type Command,
  type ServerMessage,
} from '../packages/shared/src/index.ts';

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const urlArg = process.argv.includes('--url') ? process.argv[process.argv.indexOf('--url') + 1]! : null;
const BOTS = arg('bots', 15);
const SIZE = arg('map', 1024);
const SECONDS = arg('seconds', 60);
const SPEED = arg('speed', 4);
const PORT = 8791;
const base = urlArg ?? `ws://localhost:${PORT}`;
const httpBase = base.replace(/^ws/, 'http');

const server = urlArg
  ? null
  : spawn(process.execPath, ['apps/server/src/index.ts'], {
      env: { ...process.env, PORT: String(PORT), MAX_PLAYERS: String(Math.max(15, BOTS)), MAX_MAP_SIZE: String(Math.max(2048, SIZE)) },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
if (server) await new Promise((r) => setTimeout(r, 1200));

class Bot {
  ws!: WebSocket;
  bytes = 0;
  byType = new Map<string, number>();
  pending = new Map<number, { at: number; resolve: (r: { ok: boolean; error?: string }) => void }>();
  latencies: number[] = [];
  failures = 0;
  seq = 0;
  joined: Extract<ServerMessage, { t: 'roomJoined' }> | null = null;
  readonly stations = new Map<number, { id: number; owner: number; x0: number; y0: number }>();
  readonly trains = new Map<number, { id: number; owner: number; status: string }>();
  companyId: number | null = null;
  private waiters: ((m: ServerMessage) => boolean)[] = [];

  constructor(readonly name: string) {}

  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`${base}/ws`);
      this.ws.binaryType = 'arraybuffer';
      this.ws.onopen = () => {
        this.send({ t: 'hello', protocol: PROTOCOL_VERSION, clientId: `bot-${this.name}-${Math.random().toString(36).slice(2)}`, name: this.name });
        resolve();
      };
      this.ws.onerror = (e) => reject(e);
      this.ws.onmessage = (e) => {
        const data = e.data as ArrayBuffer;
        this.bytes += data.byteLength;
        const m = decodeFrame<ServerMessage>(data);
        this.byType.set(m.t, (this.byType.get(m.t) ?? 0) + data.byteLength);
        if (m.t === 'stations') {
          if (m.full) this.stations.clear();
          for (const st of m.stations) this.stations.set(st.id, st);
          for (const id of m.removed) this.stations.delete(id);
        } else if (m.t === 'trains') {
          if (m.full) this.trains.clear();
          for (const t of m.trains) this.trains.set(t.id, t);
          for (const id of m.removed) this.trains.delete(id);
        } else if (m.t === 'global' || m.t === 'roomJoined') {
          const me = m.global.players.find((p) => p.id === (m.t === 'roomJoined' ? m.playerId : this.joined?.playerId));
          if (me) this.companyId = me.companyId;
        }
        if (m.t === 'commandResult') {
          const p = this.pending.get(m.seq);
          if (p) {
            this.latencies.push(performance.now() - p.at);
            this.pending.delete(m.seq);
            if (!m.ok) this.failures++;
            p.resolve({ ok: m.ok, error: m.error });
          }
        }
        this.waiters = this.waiters.filter((w) => !w(m));
      };
    });
  }

  send(msg: ClientMessage): void {
    this.ws.send(encodeFrame(msg));
  }

  wait<T extends ServerMessage['t']>(t: T, timeoutMs = 60_000): Promise<Extract<ServerMessage, { t: T }>> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${this.name}: no ${t}`)), timeoutMs);
      this.waiters.push((m) => {
        if (m.t !== t) return false;
        clearTimeout(timer);
        resolve(m as Extract<ServerMessage, { t: T }>);
        return true;
      });
    });
  }

  command(cmd: Command): Promise<{ ok: boolean; error?: string }> {
    const seq = ++this.seq;
    return new Promise((resolve) => {
      this.pending.set(seq, { at: performance.now(), resolve });
      this.send({ t: 'command', seq, cmd });
    });
  }

  /** Look at an area: subscribe to the chunks around a tile, as the client does. */
  look(x: number, y: number): void {
    const n = SIZE / CHUNK_SIZE;
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    const chunks: number[] = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (cx + dx >= 0 && cy + dy >= 0 && cx + dx < n && cy + dy < n) chunks.push((cy + dy) * n + cx + dx);
    this.send({ t: 'subscribe', chunks });
  }
}

/** A clockwise signalled loop with two stations and a depot at (ox, oy) (as in the benchmark). */
async function buildLoop(bot: Bot, ox: number, oy: number, trains: number): Promise<boolean> {
  const P: number[] = [];
  for (let x = 12; x <= 38; x++) P.push(ox + x, oy + 10, Piece.X, ox + x, oy + 25, Piece.X);
  for (let y = 12; y <= 23; y++) P.push(ox + 10, oy + y, Piece.Y, ox + 40, oy + y, Piece.Y);
  for (const [x, y, p] of [
    [39, 10, Piece.SW], [39, 11, Piece.NE], [40, 11, Piece.SW], [40, 24, Piece.NW], [39, 24, Piece.SE], [39, 25, Piece.NW],
    [11, 25, Piece.NE], [11, 24, Piece.SW], [10, 24, Piece.NE], [10, 11, Piece.SE], [11, 11, Piece.NW], [11, 10, Piece.SE],
    [24, 9, Piece.NE], [25, 9, Piece.SW], [25, 10, Piece.NE],
  ] as const) P.push(ox + x, oy + y, p);
  if (!(await bot.command({ type: 'buildTrack', pieces: P })).ok) return false;
  await bot.command({ type: 'buildDepot', x: ox + 24, y: oy + 8, exit: Edge.S });
  await bot.command({ type: 'buildStation', x: ox + 14, y: oy + 10, axis: 0, platforms: 1, length: 5 });
  await bot.command({ type: 'buildStation', x: ox + 30, y: oy + 25, axis: 0, platforms: 1, length: 5 });
  for (const x of [20, 29, 34]) await bot.command({ type: 'setSignal', x: ox + x, y: oy + 10, piece: Piece.X, dirs: 1 });
  for (const x of [15, 22, 27]) await bot.command({ type: 'setSignal', x: ox + x, y: oy + 25, piece: Piece.X, dirs: 2 });
  return trains > 0;
}

const started = performance.now();
const bots = Array.from({ length: BOTS }, (_, k) => new Bot(`Bot${k}`));
await bots[0]!.connect();
bots[0]!.send({ t: 'createRoom', settings: { name: 'Load test', mapWidth: SIZE, mapHeight: SIZE, maxPlayers: Math.max(15, BOTS), seed: 77, startYear: 1950, economy: 'easy' } });
const hostJoin = await bots[0]!.wait('roomJoined', 120_000);
bots[0]!.joined = hostJoin;
bots[0]!.send({ t: 'autosave', enabled: false });
await Promise.all(
  bots.slice(1).map(async (b) => {
    await b.connect();
    b.send({ t: 'joinRoom', roomId: hostJoin.roomId });
    b.joined = await b.wait('roomJoined', 120_000);
  }),
);
console.log(`${BOTS} bots joined a ${SIZE}² game in ${((performance.now() - started) / 1000).toFixed(1)} s`);

// Each bot founds a company, finds land it can level, and builds a loop with trains.
const spots: { x: number; y: number }[] = [];
await Promise.all(
  bots.map(async (b, k) => {
    await b.command({ type: 'foundCompany', name: `${b.name} Rail`, color: k % 16 });
    await b.command({ type: 'loan', action: 'borrow', amount: 1_000_000 });
    const cols = Math.ceil(Math.sqrt(BOTS));
    const cellW = Math.floor(SIZE / cols);
    for (let attempt = 0; attempt < 12; attempt++) {
      const x = (k % cols) * cellW + 8 + ((attempt * 37) % Math.max(1, cellW - 60));
      const y = Math.floor(k / cols) * cellW + 8 + ((attempt * 53) % Math.max(1, cellW - 40));
      if (x + 50 >= SIZE || y + 34 >= SIZE) continue;
      const lv = await b.command({ type: 'terraform', x0: x + 8, y0: y + 7, x1: x + 42, y1: y + 27, mode: 'level', level: 6 });
      if (!lv.ok && lv.error !== 'Already level') continue;
      if (await buildLoop(b, x, y, 3)) {
        spots[k] = { x, y };
        b.look(x + 25, y + 17);
        break;
      }
    }
  }),
);
console.log(`${spots.filter(Boolean).length}/${BOTS} bots built a loop`);
bots[0]!.send({ t: 'setSpeed', speed: SPEED as 0 | 1 | 2 | 4 | 8 });

// Trains: buy and start them (station ids come from the station list).
const health = async () => (await (await fetch(`${httpBase}/health`)).json()) as { games: { stepMs: number; bytesOut: number; vehicles: number; steps: number }[] };
for (const b of bots) b.bytes = 0;
const before = (await health()).games[0]!;
const t0 = performance.now();
let ticks = 0;
const loop = setInterval(() => {
  ticks++;
  bots.forEach((b, k) => {
    const s = spots[k];
    if (!s) return;
    if (ticks === 1) {
      void (async () => {
        for (let n = 0; n < 3; n++) {
          const r = await b.command({ type: 'buyTrain', depot: (s.y + 8) * SIZE + s.x + 24, units: ['badger', 'coach_steel', 'coach_steel'] as never });
          if (!r.ok) break;
        }
        await new Promise((r) => setTimeout(r, 1500));
        const mine = [...b.stations.values()].filter((st) => st.owner === b.companyId && st.x0 >= s.x && st.x0 < s.x + 48 && st.y0 >= s.y && st.y0 < s.y + 34);
        const [top, bottom] = [mine.find((st) => st.y0 === s.y + 10), mine.find((st) => st.y0 === s.y + 25)];
        if (!top || !bottom) return;
        let delay = 0;
        for (const t of [...b.trains.values()].filter((t) => t.owner === b.companyId && t.status === 'depot')) {
          await b.command({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: top.id }, { kind: 'station', station: bottom.id }] });
          setTimeout(() => void b.command({ type: 'trainAction', id: t.id, action: 'start' }), delay);
          delay += 4000;
        }
      })();
    }
    // Every few seconds: some building, a look elsewhere, a chat line.
    if (ticks % 5 === k % 5) {
      const x = s.x + 2 + Math.floor(Math.random() * 40);
      const y = s.y + 29 + Math.floor(Math.random() * 3);
      void b.command({ type: 'buildRoad', x0: x, y0: y, x1: x + 3, y1: y });
    }
    if (ticks % 10 === k % 10) b.look(s.x + Math.random() * 200 - 100, s.y + Math.random() * 200 - 100);
    if (ticks % 10 === (k + 5) % 10) b.look(s.x + 25, s.y + 17);
    if (ticks % 15 === k % 15) b.send({ t: 'chat', text: `hello from ${b.name}` });
  });
}, 1000);
await new Promise((r) => setTimeout(r, SECONDS * 1000));
clearInterval(loop);
const after = (await health()).games[0]!;
const secs = (performance.now() - t0) / 1000;

const lat = bots.flatMap((b) => b.latencies).sort((a, b) => a - b);
const perBot = bots.map((b) => b.bytes / secs).sort((a, b) => a - b);
const types = new Map<string, number>();
for (const b of bots) for (const [t, n] of b.byType) types.set(t, (types.get(t) ?? 0) + n);
console.log(`ran ${secs.toFixed(0)} s at speed ${SPEED}: ${after.vehicles} vehicles, ${after.steps - before.steps} sim steps`);
console.log(`server step: ${after.stepMs.toFixed(3)} ms (smoothed); ${(((after.steps - before.steps) / secs) * after.stepMs / 10).toFixed(1)}% of a core`);
console.log(`server sent ${((after.bytesOut - before.bytesOut) / secs / 1024).toFixed(1)} KB/s in all`);
console.log(`per bot: median ${(perBot[Math.floor(perBot.length / 2)]! / 1024).toFixed(1)} KB/s, max ${(perBot.at(-1)! / 1024).toFixed(1)} KB/s`);
console.log(`command latency: median ${lat[Math.floor(lat.length / 2)]?.toFixed(1)} ms, p95 ${lat[Math.floor(lat.length * 0.95)]?.toFixed(1)} ms (${lat.length} commands, ${bots.reduce((a, b) => a + b.failures, 0)} refused)`);
console.log('bytes by message type (whole run):');
for (const [t, n] of [...types].sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${t.padEnd(12)} ${(n / 1024).toFixed(0)} KB`);
for (const b of bots) b.ws.close();
server?.kill();
process.exit(0);
