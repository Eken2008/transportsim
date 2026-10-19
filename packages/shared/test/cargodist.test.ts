import { describe, expect, test } from 'bun:test';
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
  solveLinkGraph,
  type Command,
} from '../src/index.ts';

describe('link graph', () => {
  test('demand goes to reachable accepting stations; routes give next hops', () => {
    // A - B - C in a line (both ways), D only reachable from C.
    const r = solveLinkGraph({
      cargo: 'passengers',
      symmetric: true,
      stations: [
        { id: 1, x: 0, y: 0, supply: 100, accepts: true },
        { id: 2, x: 20, y: 0, supply: 50, accepts: true },
        { id: 3, x: 40, y: 0, supply: 300, accepts: true },
        { id: 4, x: 60, y: 0, supply: 10, accepts: false },
      ],
      links: [
        { from: 1, to: 2, capacity: 100 },
        { from: 2, to: 1, capacity: 100 },
        { from: 2, to: 3, capacity: 100 },
        { from: 3, to: 2, capacity: 100 },
        { from: 3, to: 4, capacity: 100 },
      ],
    });
    const demand = new Map(r.demand.map(([s, d]) => [s, new Map(d)]));
    const hops = new Map(r.nextHop.map(([s, h]) => [s, new Map(h)]));
    // From A: B and C, not D (it accepts nothing); C draws more (bigger supply)
    expect([...demand.get(1)!.keys()].sort()).toEqual([2, 3]);
    expect(demand.get(1)!.get(3)!).toBeGreaterThan(demand.get(1)!.get(2)!);
    expect(hops.get(1)!.get(3)).toBe(2);
    expect(hops.get(2)!.get(3)).toBe(3);
    expect(hops.get(3)!.get(1)).toBe(2);
    expect(hops.get(1)!.get(4)).toBe(2);
  });

  test('freight demand is asymmetric: only to stations accepting it', () => {
    const r = solveLinkGraph({
      cargo: 'coal',
      symmetric: false,
      stations: [
        { id: 1, x: 0, y: 0, supply: 120, accepts: false },
        { id: 2, x: 30, y: 0, supply: 0, accepts: true },
      ],
      links: [
        { from: 1, to: 2, capacity: 60 },
        { from: 2, to: 1, capacity: 60 },
      ],
    });
    expect(r.demand).toEqual([[1, [[2, expect.any(Number)]]]]);
  });
});

const TOWNHOUSE = HOUSE_TYPES.findIndex((h) => h.model === 'townhouse');

/**
 * Three towns: A (x 5) and B (x 35) on track y = 10, B and C (x 65) on track y = 11. B is a
 * two-platform station joining both lines; one train runs A-B, another B-C, each from its own depot.
 */
function corridor() {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear: 1950, breakdowns: false }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  for (const cx of [7, 37, 67]) {
    for (let x = cx - 2; x <= cx + 2; x++) {
      for (const y of [13, 14]) {
        const i = map.tileIndex(x, y);
        map.layers.type[i] = TileType.House;
        map.layers.data[i] = TOWNHOUSE;
      }
    }
  }
  const p = state.addPlayer('A', true);
  const c = state.foundCompany(p)!;
  c.money = 1e7;
  const run = (cmd: Command) => {
    const r = executeCommand(state, { playerId: p.id, companyId: c.id }, cmd);
    if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
  };
  run({ type: 'buildDepot', x: 2, y: 10, exit: Edge.E });
  run({ type: 'buildDepot', x: 73, y: 11, exit: Edge.W });
  const pieces: number[] = [];
  for (let x = 3; x <= 38; x++) pieces.push(x, 10, Piece.X);
  for (let x = 35; x <= 72; x++) pieces.push(x, 11, Piece.X);
  run({ type: 'buildTrack', pieces });
  run({ type: 'buildStation', x: 5, y: 10, axis: 0, platforms: 1, length: 4 });
  run({ type: 'buildStation', x: 35, y: 10, axis: 0, platforms: 2, length: 4 });
  run({ type: 'buildStation', x: 65, y: 11, axis: 0, platforms: 1, length: 4 });
  const [a, b, cc] = [0, 1, 2];
  const train = (depotX: number, depotY: number, from: number, to: number) => {
    run({ type: 'buyTrain', depot: map.tileIndex(depotX, depotY), units: ['badger', 'coach_steel', 'coach_steel'] });
    const t = [...state.trains.values()].at(-1)!;
    run({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: from }, { kind: 'station', station: to }] });
    return t;
  };
  return { state, run, train, a, b, c: cc };
}

describe('cargodist in play', () => {
  test('passengers travel A to C by changing trains at B, and both trains earn', () => {
    const { state, run, train, a, b, c } = corridor();
    const t1 = train(2, 10, a, b);
    run({ type: 'trainAction', id: t1.id, action: 'start' });
    for (let i = 0; i < TICKS_PER_DAY * 4; i++) state.step();
    const t2 = train(73, 11, b, c);
    run({ type: 'trainAction', id: t2.id, action: 'start' });
    let transferredAtB = false;
    let carriedFromA = false;
    for (let i = 0; i < TICKS_PER_DAY * 120; i++) {
      state.step();
      transferredAtB ||= (state.cargo.packets.get(b) ?? []).some((p) => p.src === a && p.dest === c);
      carriedFromA ||= t2.cargo.some((p) => p.src === a && p.dest === c);
    }
    expect(state.cargo.destinations('passengers', a)).toContain(c);
    expect(state.cargo.hopFor('passengers', a, c)).toBe(b);
    expect(transferredAtB).toBe(true);
    expect(carriedFromA).toBe(true);
    expect(t1.profitThisYear + t1.profitLastYear).toBeGreaterThan(0);
    expect(t2.profitThisYear + t2.profitLastYear).toBeGreaterThan(0);
  });

  test('an asynchronous runner is fine: results arrive later', () => {
    const { state, run, train, a, b } = corridor();
    let queued: (() => void) | null = null;
    state.cargo.runner = (inputs, done) => {
      queued = () => done(inputs.map(solveLinkGraph));
    };
    const t = train(2, 10, a, b);
    for (let i = 0; i < TICKS_PER_DAY * 2; i++) state.step();
    // Before the graph arrives, direct links still give destinations
    expect(state.cargo.destinations('passengers', a)).toEqual([b]);
    expect(queued).not.toBeNull();
    queued!();
    expect(state.cargo.hopFor('passengers', a, b)).toBe(b);
    run({ type: 'trainAction', id: t.id, action: 'start' });
  });
});
