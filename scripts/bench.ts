/**
 * Simulation benchmark: builds a large flat map split into blocks, each with a signalled rail
 * loop and trains, a bus line, a canal with a ship and an airport with an aircraft, then times
 * the tick loop and each system in it.
 *
 *   bun scripts/bench.ts [--map 2048] [--blocks 500] [--ticks 3000] [--trains 4] [--buses 4]
 */
import {
  DEFAULT_SETTINGS,
  Edge,
  GameMap,
  GameState,
  HOUSE_TYPES,
  Piece,
  TICKS_PER_DAY,
  TileType,
  executeCommand,
  type Command,
} from '../packages/shared/src/index.ts';

const arg = (name: string, fallback: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? Number(process.argv[i + 1]) : fallback;
};
const SIZE = arg('map', 2048);
const BLOCKS = arg('blocks', 500);
const TICKS = arg('ticks', 3000);
const TRAINS = arg('trains', 4);
const BUSES = arg('buses', 4);
const BW = 48;
const BH = 40;

const t0 = performance.now();
const map = new GameMap(SIZE, SIZE);
map.heights.fill(4);
for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: SIZE, mapHeight: SIZE, startYear: 1965, breakdowns: true, accidents: 'off' }, map);
const players = Array.from({ length: 15 }, (_, k) => {
  const p = state.addPlayer(`P${k}`, k === 0);
  const c = state.foundCompany(p)!;
  c.money = 1e10;
  return { playerId: p.id, companyId: c.id };
});
const TOWNHOUSE = HOUSE_TYPES.findIndex((h) => h.model === 'townhouse');

let failures = 0;
const run = (ctx: (typeof players)[number], cmd: Command) => {
  const r = executeCommand(state, ctx, cmd);
  if (!r.ok) {
    if (failures++ < 5) console.log(`  ${cmd.type} failed: ${r.error}`);
    return false;
  }
  return true;
};
const houses = (x0: number, x1: number, y: number) => {
  for (let x = x0; x <= x1; x++) {
    const i = map.tileIndex(x, y);
    if (map.layers.type[i] !== TileType.Clear) continue;
    map.layers.type[i] = TileType.House;
    map.layers.data[i] = TOWNHOUSE;
  }
};
const newest = () => [...state.trains.values()].at(-1)!;
const perRow = Math.floor(SIZE / BW);
const airports: { ctx: (typeof players)[number]; st: number; hangar: number }[] = [];
/** Tick each vehicle is started at (trains on one loop a few days apart, so they space out). */
const startAt = new Map<number, number>();

for (let b = 0; b < BLOCKS; b++) {
  const ox = (b % perRow) * BW;
  const oy = Math.floor(b / perRow) * BH;
  if (oy + BH > SIZE) break;
  const ctx = players[b % players.length]!;
  // Rail: a clockwise loop with two stations and block signals (see test/loop.ts).
  const P = (x: number, y: number, piece: number, out: number[]) => out.push(ox + x, oy + y, piece);
  const pieces: number[] = [];
  for (let x = 12; x <= 38; x++) {
    P(x, 10, Piece.X, pieces);
    P(x, 25, Piece.X, pieces);
  }
  for (let y = 12; y <= 23; y++) {
    P(10, y, Piece.Y, pieces);
    P(40, y, Piece.Y, pieces);
  }
  for (const [x, y, p] of [
    [39, 10, Piece.SW], [39, 11, Piece.NE], [40, 11, Piece.SW], [40, 24, Piece.NW], [39, 24, Piece.SE], [39, 25, Piece.NW],
    [11, 25, Piece.NE], [11, 24, Piece.SW], [10, 24, Piece.NE], [10, 11, Piece.SE], [11, 11, Piece.NW], [11, 10, Piece.SE],
    [24, 9, Piece.NE], [25, 9, Piece.SW], [25, 10, Piece.NE],
  ] as const) P(x, y, p, pieces);
  run(ctx, { type: 'buildTrack', pieces });
  run(ctx, { type: 'buildDepot', x: ox + 24, y: oy + 8, exit: Edge.S });
  run(ctx, { type: 'buildStation', x: ox + 14, y: oy + 10, axis: 0, platforms: 1, length: 5 });
  const top = state.nextStationId - 1;
  run(ctx, { type: 'buildStation', x: ox + 30, y: oy + 25, axis: 0, platforms: 1, length: 5 });
  const bottom = state.nextStationId - 1;
  for (const x of [20, 29, 34]) run(ctx, { type: 'setSignal', x: ox + x, y: oy + 10, piece: Piece.X, dirs: 1 });
  for (const x of [15, 22, 27]) run(ctx, { type: 'setSignal', x: ox + x, y: oy + 25, piece: Piece.X, dirs: 2 });
  houses(ox + 13, ox + 19, oy + 12);
  houses(ox + 29, ox + 35, oy + 23);
  for (let k = 0; k < TRAINS; k++) {
    if (!run(ctx, { type: 'buyTrain', depot: map.tileIndex(ox + 24, oy + 8), units: ['badger', 'coach_steel', 'coach_steel'] as never })) continue;
    const t = newest();
    run(ctx, { type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: top }, { kind: 'station', station: bottom }] });
    startAt.set(t.id, k * TICKS_PER_DAY * 3);
  }
  // Road: a bus line under the loop.
  run(ctx, { type: 'buildRoad', x0: ox + 10, y0: oy + 30, x1: ox + 40, y1: oy + 30 });
  run(ctx, { type: 'buildRoadDepot', x: ox + 9, y: oy + 30, exit: Edge.E });
  run(ctx, { type: 'buildRoadStop', x: ox + 12, y: oy + 30, kind: 'bus' });
  const busA = state.nextStationId - 1;
  run(ctx, { type: 'buildRoadStop', x: ox + 38, y: oy + 30, kind: 'bus' });
  const busB = state.nextStationId - 1;
  houses(ox + 10, ox + 16, oy + 31);
  houses(ox + 34, ox + 40, oy + 31);
  for (let k = 0; k < BUSES; k++) {
    if (!run(ctx, { type: 'buyTrain', depot: map.tileIndex(ox + 9, oy + 30), units: ['city_bus'] as never })) continue;
    const t = newest();
    run(ctx, { type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: busA }, { kind: 'station', station: busB }] });
  }
  // Water: a canal with two docks and a ship.
  run(ctx, { type: 'buildCanal', x0: ox + 2, y0: oy + 35, x1: ox + 44, y1: oy + 35 });
  run(ctx, { type: 'buildDock', x: ox + 4, y: oy + 36 });
  const dockA = state.nextStationId - 1;
  run(ctx, { type: 'buildDock', x: ox + 42, y: oy + 36 });
  const dockB = state.nextStationId - 1;
  run(ctx, { type: 'buildCanal', x0: ox + 24, y0: oy + 34, x1: ox + 24, y1: oy + 34 });
  run(ctx, { type: 'buildShipDepot', x: ox + 24, y: oy + 34 });
  houses(ox + 2, ox + 8, oy + 37);
  houses(ox + 38, ox + 44, oy + 37);
  if (run(ctx, { type: 'buyTrain', depot: map.tileIndex(ox + 24, oy + 34), units: ['motor_ferry'] as never })) {
    const t = newest();
    run(ctx, { type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: dockA }, { kind: 'station', station: dockB }] });
  }
  // Air: a small airport in the corner; aircraft fly to the previous block's airport.
  if (run(ctx, { type: 'buildAirport', x: ox + 42, y: oy + 1, kind: 'small' })) {
    const st = state.nextStationId - 1;
    houses(ox + 41, ox + 47, oy + 5);
    airports.push({ ctx, st, hangar: map.tileIndex(ox + 42, oy + 3) });
  }
}
// Each company's airports in a chain (blocks go round the companies, so its previous one is 15 back).
for (let k = players.length; k < airports.length; k++) {
  const a = airports[k]!;
  const b = airports[k - players.length]!;
  if (a.ctx.companyId !== b.ctx.companyId) continue;
  if (!run(a.ctx, { type: 'buyTrain', depot: a.hangar, units: ['skyliner'] as never })) continue;
  const t = newest();
  run(a.ctx, { type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: a.st }, { kind: 'station', station: b.st }] });
}
// Start everything (trains a few at a time per loop, so they space out).
const waiting = [...state.trains.values()];
const started = new Set<number>();
const startSome = () => {
  for (const t of waiting) {
    if (started.has(t.id) || (startAt.get(t.id) ?? 0) > state.tick) continue;
    const ctx = players.find((p) => p.companyId === t.owner)!;
    if (run(ctx, { type: 'trainAction', id: t.id, action: 'start' })) started.add(t.id);
  }
};
startSome();
const setup = performance.now() - t0;
const counts = { rail: 0, road: 0, air: 0, water: 0 };
for (const t of state.trains.values()) counts[t.mode ?? 'rail']++;
console.log(
  `map ${SIZE}², ${Math.min(BLOCKS, perRow * Math.floor(SIZE / BH))} blocks, ${state.trains.size} vehicles (${counts.rail} trains, ${counts.road} buses, ${counts.air} aircraft, ${counts.water} ships), ${state.stations.size} stations; setup ${(setup / 1000).toFixed(1)} s`,
);

// Time each system.
const timing = new Map<string, number>();
const wrap = (name: string, obj: Record<string, unknown>, method: string) => {
  const fn = obj[method] as (...a: unknown[]) => unknown;
  obj[method] = function (this: unknown, ...a: unknown[]) {
    const s = performance.now();
    const r = fn.apply(this, a);
    timing.set(name, (timing.get(name) ?? 0) + performance.now() - s);
    return r;
  };
};
const s = state as unknown as Record<string, Record<string, unknown>>;
wrap('rail', s.rail!, 'step');
wrap('road', s.road!, 'step');
wrap('air', s.air!, 'step');
wrap('ships', s.ships!, 'step');
wrap('cargo (daily)', s.cargo!, 'daily');
wrap('maintenance (daily)', s.maintenance!, 'daily');
wrap('day', state as unknown as Record<string, unknown>, 'onNewDay');
wrap('month', state as unknown as Record<string, unknown>, 'onNewMonth');

const times: number[] = [];
for (let i = 0; i < TICKS; i++) {
  if (i % 50 === 0 && started.size < waiting.length) startSome();
  const a = performance.now();
  state.step();
  times.push(performance.now() - a);
}
times.sort((a, b) => a - b);
const avg = times.reduce((a, b) => a + b, 0) / times.length;
const pct = (p: number) => times[Math.min(times.length - 1, Math.floor(times.length * p))]!;
const running = [...state.trains.values()].filter((t) => t.status !== 'depot').length;
console.log(`${TICKS} ticks (${(TICKS / TICKS_PER_DAY).toFixed(0)} days): avg ${avg.toFixed(2)} ms, p50 ${pct(0.5).toFixed(2)}, p99 ${pct(0.99).toFixed(2)}, max ${pct(1).toFixed(1)} ms; ${running} vehicles out`);
console.log(`budget at 30 ticks/s: ${((avg * 30) / 10).toFixed(1)}% of a core`);
for (const [name, ms] of [...timing].sort((a, b) => b[1] - a[1])) console.log(`  ${name.padEnd(22)} ${(ms / TICKS).toFixed(3)} ms/tick  (${ms.toFixed(0)} ms total)`);
const mem = process.memoryUsage();
console.log(`heap ${(mem.heapUsed / 1e6).toFixed(0)} MB, rss ${(mem.rss / 1e6).toFixed(0)} MB`);
