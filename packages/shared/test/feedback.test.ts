import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  Edge,
  GameMap,
  GameState,
  Piece,
  TICKS_PER_DAY,
  executeCommand,
  nextSegments,
  planTrack,
  seg,
  trackdir,
  type Command,
  type PlacedPiece,
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

describe('route planner', () => {
  test('a dragged route continues existing track without 90° turns', () => {
    const { state, map, build, owner } = world();
    // Existing line heading east, ending at x = 20.
    build(Array.from({ length: 11 }, (_, k) => ({ x: 10 + k, y: 30, piece: Piece.X })));
    // Drag from just past its end to a point south-east of it.
    const plan = planTrack(map, 21, 30, 30, 38, { owner })!;
    expect(plan).not.toBeNull();
    build(plan);
    const tiles = reachable(state, seg(map.tileIndex(10, 30), trackdir(Piece.X, 0)), owner);
    const reachedEnd = [...tiles].some((s) => Math.floor(s / 16) === map.tileIndex(30, 38));
    expect(reachedEnd).toBe(true);
  });

  test('a route joins track at its end and goes around obstacles', () => {
    const { state, map, build, owner } = world();
    build(Array.from({ length: 6 }, (_, k) => ({ x: 40, y: 10 + k, piece: Piece.Y }))); // N-S line at x = 40
    for (let y = 18; y <= 24; y++) map.setWater(map.tileIndex(30, y)); // a pond in the way
    const plan = planTrack(map, 20, 21, 40, 16, { owner })!;
    expect(plan).not.toBeNull();
    expect(plan.some((q) => q.x === 30 && q.y >= 18 && q.y <= 24)).toBe(false);
    build(plan);
    const from = seg(map.tileIndex(plan[0]!.x, plan[0]!.y), trackdir(plan[0]!.piece, 0));
    const back = seg(map.tileIndex(plan[0]!.x, plan[0]!.y), trackdir(plan[0]!.piece, 1));
    const reach = new Set([...reachable(state, from, owner), ...reachable(state, back, owner)]);
    expect([...reach].some((s) => Math.floor(s / 16) === map.tileIndex(40, 10))).toBe(true);
  });
});

describe('route planner across existing lines', () => {
  test('crossing a line to reach a parallel one goes straight over, not along it', () => {
    const { map, build, owner } = world();
    // Two parallel east-west lines on rows 10 and 12.
    build(Array.from({ length: 21 }, (_, k) => ({ x: 10 + k, y: 10, piece: Piece.X })));
    build(Array.from({ length: 21 }, (_, k) => ({ x: 10 + k, y: 12, piece: Piece.X })));
    // Drag from below the lower line up to the upper line.
    const plan = planTrack(map, 20, 18, 22, 10, { owner })!;
    expect(plan).not.toBeNull();
    const onLower = plan.filter((q) => q.y === 12);
    expect(onLower).toHaveLength(1); // crosses the lower line once...
    expect(onLower[0]!.piece).toBe(Piece.Y); // ...as a diamond crossing, not via switches
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
