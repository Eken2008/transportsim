import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  Edge,
  GameMap,
  GameState,
  Piece,
  TICKS_PER_DAY,
  executeCommand,
  segTile,
  type AccidentSeverity,
  type Command,
} from '../src/index.ts';

/** A railway along y = 20 and a road along x = 30 crossing it at (30, 20). */
function world(accidents: AccidentSeverity = 'low') {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear: 1950, accidents, breakdowns: false }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  const p = state.addPlayer('A', true);
  const c = state.foundCompany(p)!;
  c.money = 1e8;
  const run = (cmd: Command) => {
    const r = executeCommand(state, { playerId: p.id, companyId: c.id }, cmd);
    if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
  };
  run({ type: 'buildDepot', x: 2, y: 20, exit: Edge.E });
  const pieces: number[] = [];
  for (let x = 3; x <= 60; x++) pieces.push(x, 20, Piece.X);
  run({ type: 'buildTrack', pieces });
  run({ type: 'buildStation', x: 5, y: 20, axis: 0, platforms: 1, length: 4 });
  run({ type: 'buildStation', x: 52, y: 20, axis: 0, platforms: 1, length: 4 });
  run({ type: 'buildRoad', x0: 30, y0: 10, x1: 30, y1: 30 });
  run({ type: 'buildRoadDepot', x: 31, y: 10, exit: Edge.W });
  run({ type: 'buildRoadStop', x: 30, y: 13, kind: 'bus' });
  run({ type: 'buildRoadStop', x: 30, y: 27, kind: 'bus' });
  run({ type: 'buyTrain', depot: map.tileIndex(2, 20), units: ['badger', 'coach_steel', 'coach_steel'] });
  const train = [...state.trains.values()].at(-1)!;
  run({ type: 'setOrders', id: train.id, orders: [{ kind: 'station', station: 0 }, { kind: 'station', station: 1 }] });
  run({ type: 'buyTrain', depot: map.tileIndex(31, 10), units: ['city_bus'] });
  const bus = [...state.trains.values()].at(-1)!;
  run({ type: 'setOrders', id: bus.id, orders: [{ kind: 'station', station: 2 }, { kind: 'station', station: 3 }] });
  run({ type: 'trainAction', id: train.id, action: 'start' });
  run({ type: 'trainAction', id: bus.id, action: 'start' });
  return { state, map, run, train, bus, crossing: map.tileIndex(30, 20) };
}

describe('level crossings', () => {
  test('road vehicles wait for trains, so they never meet on the crossing', () => {
    const { state, train, bus, crossing } = world();
    let waited = false;
    const visits = new Set<number>();
    for (let i = 0; i < TICKS_PER_DAY * 150; i++) {
      state.step();
      const trainOn = train.path.some((s) => segTile(s) === crossing);
      const busOn = bus.path.some((s) => segTile(s) === crossing);
      expect(trainOn && busOn).toBe(false);
      if (state.rail.closedCrossings.has(crossing) && bus.speed === 0 && bus.status === 'running') waited = true;
      if (bus.status === 'loading') visits.add(bus.lastStation);
    }
    expect(state.trains.has(bus.id)).toBe(true);
    expect(visits.size).toBe(2);
    expect(waited).toBe(true);
  });

  test('a road vehicle stuck on the crossing is hit by the train', () => {
    const { state, bus, crossing } = world();
    let stopped = false;
    for (let i = 0; i < TICKS_PER_DAY * 120 && state.trains.has(bus.id); i++) {
      state.step();
      if (!stopped && bus.path.length && segTile(bus.path[0]!) === crossing && !state.rail.closedCrossings.has(crossing)) {
        // Broken down right on the crossing.
        bus.brokenDown = TICKS_PER_DAY * 30;
        bus.speed = 0;
        stopped = true;
      }
    }
    expect(stopped).toBe(true);
    expect(state.trains.has(bus.id)).toBe(false);
    expect(state.news.some((n) => n.kind === 'accident' && n.text.includes('level crossing'))).toBe(true);
    // The track isn't blocked: the train carries on.
    expect(state.rail.wreckTiles()).toEqual([]);
  });
});
