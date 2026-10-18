import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  Edge,
  GameMap,
  GameState,
  Piece,
  TICKS_PER_DAY,
  executeCommand,
  linkAllByGeometry,
  nextSegments,
  planTrack,
  seg,
  trackdir,
  type Command,
  type PlacedPiece,
  TD_HEADING,
  tdExit as tdExitEdge,
  turnSteps,
} from '../src/index.ts';

function world() {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear: 1950 }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  const p = state.addPlayer('A', true);
  const c = state.foundCompany(p)!;
  c.money = 1e8;
  const ctx = { playerId: p.id, companyId: c.id };
  const run = (cmd: Command) => {
    const r = executeCommand(state, ctx, cmd);
    if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
    return r;
  };
  const build = (pieces: PlacedPiece[]) => run({ type: 'buildTrack', pieces: pieces.flatMap((q) => [q.x, q.y, q.piece]) });
  return { state, map, ctx, run, build, owner: c.id };
}

/** Walk the built network from a segment and return how many segments are reachable. */
function reachable(state: GameState, start: number, owner: number): Set<number> {
  const seen = new Set([start]);
  const todo = [start];
  while (todo.length) {
    for (const n of nextSegments(state.map, todo.pop()!, owner)) {
      if (seen.has(n)) continue;
      seen.add(n);
      todo.push(n);
    }
  }
  return seen;
}

/** Segments reachable by driving from `start` (following links). */
function drive(state: GameState, start: number, owner: number): Set<number> {
  return reachable(state, start, owner);
}
const tileOf = (s: number) => Math.floor(s / 16);

describe('track connections', () => {
  test('a corner piece never joins two perpendicular straights (no 90° connections)', () => {
    for (const order of ['line first', 'stub first'] as const) {
      const { state, map, build, owner } = world();
      const line = () => build(Array.from({ length: 21 }, (_, k) => ({ x: 10 + k, y: 20, piece: Piece.X })));
      // A north-south stub from below, ending in a corner piece on the line's tile (S–W).
      const stub = () =>
        build([
          ...Array.from({ length: 4 }, (_, k) => ({ x: 20, y: 24 - k, piece: Piece.Y })),
          { x: 20, y: 20, piece: Piece.SW },
        ]);
      if (order === 'line first') {
        line();
        stub();
      } else {
        stub();
        line();
      }
      const row = (s: number) => Math.floor(tileOf(s) / map.width);
      // Northbound on the stub a train reaches the corner piece but can't turn onto the line.
      const up = drive(state, seg(map.tileIndex(20, 24), trackdir(Piece.Y, 1)), owner);
      expect([...up].some((s) => row(s) === 20 && (s % 16) >> 1 === Piece.X)).toBe(false);
      // Trains on the line run straight past.
      for (const td of [0, 1]) {
        const along = drive(state, seg(map.tileIndex(td ? 30 : 10, 20), trackdir(Piece.X, td)), owner);
        expect([...along].every((s) => row(s) === 20 && (s % 16) >> 1 === Piece.X)).toBe(true);
      }
    }
  });

  test('45° branches and continuations still connect', () => {
    const { state, map, build, owner } = world();
    build(Array.from({ length: 5 }, (_, k) => ({ x: 10 + k, y: 30, piece: Piece.X })));
    build([{ x: 15, y: 30, piece: Piece.X }]);
    expect(drive(state, seg(map.tileIndex(10, 30), trackdir(Piece.X, 0)), owner).has(seg(map.tileIndex(15, 30), trackdir(Piece.X, 0)))).toBe(true);
    // A diagonal branch (corner piece, then more diagonal) leaving the line is a 45° switch.
    build([{ x: 12, y: 30, piece: Piece.SW }, { x: 12, y: 31, piece: Piece.NE }, { x: 13, y: 31, piece: Piece.SW }]);
    const from = drive(state, seg(map.tileIndex(10, 30), trackdir(Piece.X, 0)), owner);
    expect(from.has(seg(map.tileIndex(12, 30), trackdir(Piece.SW, 1)))).toBe(true);
    expect(from.has(seg(map.tileIndex(13, 31), trackdir(Piece.SW, 1)))).toBe(true);
  });

  test('saves from before stored connections follow the same rule', () => {
    const { state, map, build, owner } = world();
    build(Array.from({ length: 21 }, (_, k) => ({ x: 10 + k, y: 20, piece: Piece.X })));
    build([...Array.from({ length: 4 }, (_, k) => ({ x: 20, y: 24 - k, piece: Piece.Y })), { x: 20, y: 20, piece: Piece.SW }]);
    map.layers.links.fill(0);
    linkAllByGeometry(map);
    const up = drive(state, seg(map.tileIndex(20, 24), trackdir(Piece.Y, 1)), owner);
    expect([...up].some((s) => Math.floor(tileOf(s) / map.width) === 20 && (s % 16) >> 1 === Piece.X)).toBe(false);
    const along = drive(state, seg(map.tileIndex(10, 20), trackdir(Piece.X, 0)), owner);
    expect(along.has(seg(map.tileIndex(30, 20), trackdir(Piece.X, 0)))).toBe(true);
  });

  test('a dragged route starting on a line continues it', () => {
    const { state, map, build, owner } = world();
    build(Array.from({ length: 11 }, (_, k) => ({ x: 10 + k, y: 30, piece: Piece.X })));
    build(planTrack(map, 20, 30, 30, 38, { owner })!);
    const reach = drive(state, seg(map.tileIndex(10, 30), trackdir(Piece.X, 0)), owner);
    expect([...reach].some((s) => tileOf(s) === map.tileIndex(30, 38))).toBe(true);
  });

  test('a dragged route over a double line crosses both tracks without joining them', () => {
    const { state, map, build, owner } = world();
    for (const y of [20, 21]) build(Array.from({ length: 31 }, (_, k) => ({ x: 20 + k, y, piece: Piece.X })));
    const plan = planTrack(map, 34, 28, 35, 20, { owner })!;
    expect(plan).not.toBeNull();
    build(plan);
    // From the route a train can't drive onto either track; the drag doesn't decide to connect.
    const startSeg = seg(map.tileIndex(plan[0]!.x, plan[0]!.y), trackdir(plan[0]!.piece, 0));
    const startBack = seg(map.tileIndex(plan[0]!.x, plan[0]!.y), trackdir(plan[0]!.piece, 1));
    const reach = new Set([...drive(state, startSeg, owner), ...drive(state, startBack, owner)]);
    const row = (s: number) => Math.floor(tileOf(s) / map.width);
    expect([...reach].some((s) => (s % 16) >> 1 === Piece.X)).toBe(false);
    // Trains on both tracks run straight through.
    for (const y of [20, 21]) {
      const line = drive(state, seg(map.tileIndex(20, y), trackdir(Piece.X, 0)), owner);
      expect([...line].every((s) => row(s) === y)).toBe(true);
    }
  });

  test('extending a line by dragging from its middle past its end still works', () => {
    const { map, build, owner } = world();
    build(Array.from({ length: 10 }, (_, k) => ({ x: 20 + k, y: 30, piece: Piece.X })));
    const plan = planTrack(map, 24, 30, 36, 30, { owner })!;
    expect(plan).not.toBeNull();
    expect(plan.every((q) => q.y === 30 && q.piece === Piece.X)).toBe(true);
  });
});

describe('signals', () => {
  test('a piece takes one signal; one-way signals block trains from behind', () => {
    const { state, map, run, build, owner } = world();
    build(Array.from({ length: 10 }, (_, k) => ({ x: 10 + k, y: 5, piece: Piece.X })));
    expect(executeCommand(state, { playerId: 1, companyId: owner }, { type: 'setSignal', x: 14, y: 5, piece: Piece.X, dirs: 3 }).ok).toBe(false);
    // Normal signal facing east: westbound trains may pass.
    run({ type: 'setSignal', x: 14, y: 5, piece: Piece.X, dirs: 1 });
    const westbound = seg(map.tileIndex(15, 5), trackdir(Piece.X, 1));
    expect(nextSegments(map, westbound, owner)).toHaveLength(1);
    // One-way: westbound trains can't enter the tile.
    run({ type: 'setSignal', x: 14, y: 5, piece: Piece.X, dirs: 1, oneWay: true });
    expect(nextSegments(map, westbound, owner)).toHaveLength(0);
    const eastbound = seg(map.tileIndex(13, 5), trackdir(Piece.X, 0));
    expect(nextSegments(map, eastbound, owner)).toHaveLength(1);
  });
});

describe('consist editing', () => {
  test('rearrange, add and remove vehicles in the depot', () => {
    const { state, map, run } = world();
    run({ type: 'buildDepot', x: 2, y: 2, exit: Edge.E });
    run({ type: 'buyTrain', depot: map.tileIndex(2, 2), units: ['badger', 'coach_steel', 'mail_van'] });
    const t = [...state.trains.values()][0]!;
    const money = state.companies.get(t.owner)!.money;
    // Reorder: free
    expect(run({ type: 'editConsist', id: t.id, units: ['badger', 'mail_van', 'coach_steel'] }).ok && state.companies.get(t.owner)!.money).toBe(money);
    expect(t.units.map((u) => u.type)).toEqual(['badger', 'mail_van', 'coach_steel']);
    // Add a coach: costs money; capacity grows
    const cap = state.rail.statsOf(t).capacity;
    run({ type: 'editConsist', id: t.id, units: ['badger', 'mail_van', 'coach_steel', 'coach_steel'] });
    expect(state.companies.get(t.owner)!.money).toBeLessThan(money);
    expect(state.rail.statsOf(t).capacity).toBeGreaterThan(cap);
    // Removing the engine is refused; removing a coach refunds
    const before = state.companies.get(t.owner)!.money;
    expect(executeCommand(state, { playerId: 1, companyId: t.owner }, { type: 'editConsist', id: t.id, units: ['coach_steel'] }).ok).toBe(false);
    run({ type: 'editConsist', id: t.id, units: ['badger', 'coach_steel'] });
    expect(state.companies.get(t.owner)!.money).toBeGreaterThan(before);
    // Not allowed outside the depot
    run({ type: 'buildStation', x: 3, y: 2, axis: 0, platforms: 1, length: 3 });
    run({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: 0 }] });
    run({ type: 'trainAction', id: t.id, action: 'start' });
    for (let i = 0; i < TICKS_PER_DAY; i++) state.step();
    expect(executeCommand(state, { playerId: 1, companyId: t.owner }, { type: 'editConsist', id: t.id, units: ['badger'] }).ok).toBe(false);
  });
});

describe('route planner and right angles', () => {
  test('planned routes never bend 90° through a single corner piece', () => {
    const { map, owner } = world();
    const heading = (q: PlacedPiece, next: PlacedPiece) => {
      // Heading of q when travelling towards next: pick q's trackdir whose exit faces next.
      for (const td of [trackdir(q.piece, 0), trackdir(q.piece, 1)]) {
        const nx = q.x + [0, 1, 0, -1][tdExitEdge(td)]!;
        const ny = q.y + [-1, 0, 1, 0][tdExitEdge(td)]!;
        if (nx === next.x && ny === next.y) return TD_HEADING[td]!;
      }
      return -1;
    };
    for (const [ex, ey] of [[30, 12], [12, 30], [28, 25], [22, 30]] as const) {
      const plan = planTrack(map, 10, 10, ex, ey, { owner })!;
      expect(plan).not.toBeNull();
      for (let i = 1; i + 2 < plan.length; i++) {
        if (plan[i]!.piece < 2) continue;
        const before = heading(plan[i - 1]!, plan[i]!);
        const after = heading(plan[i + 1]!, plan[i + 2]!);
        expect(turnSteps(before, after)).toBeLessThanOrEqual(1);
      }
    }
  });
});
