import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  Edge,
  GameMap,
  GameState,
  HOUSE_TYPES,
  ROAD_E,
  ROAD_ONE_WAY,
  ROAD_W,
  TICKS_PER_DAY,
  TileType,
  executeCommand,
  industryType,
  newIndustry,
  placeIndustry,
  roadNext,
  roadSeg,
  rsTile,
  type Command,
} from '../src/index.ts';

const TOWNHOUSE = HOUSE_TYPES.findIndex((h) => h.model === 'townhouse');

/** Two clusters of houses, a road between them along y = 10 (x 3-56), a road depot at x = 2. */
function world(startYear = 1960) {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear, breakdowns: false }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  for (const cx of [7, 51]) {
    for (let x = cx - 2; x <= cx + 2; x++) {
      for (const y of [12, 13]) {
        const i = map.tileIndex(x, y);
        map.layers.type[i] = TileType.House;
        map.layers.data[i] = TOWNHOUSE;
      }
    }
  }
  const p = state.addPlayer('A', true);
  const c = state.foundCompany(p)!;
  c.money = 1e7;
  const exec = (cmd: Command) => executeCommand(state, { playerId: p.id, companyId: c.id }, cmd);
  const run = (cmd: Command) => {
    const r = exec(cmd);
    if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
  };
  run({ type: 'buildRoad', x0: 3, y0: 10, x1: 56, y1: 10 });
  run({ type: 'buildRoadDepot', x: 2, y: 10, exit: Edge.E });
  const days = (n: number, each?: () => void) => {
    for (let i = 0; i < TICKS_PER_DAY * n; i++) {
      state.step();
      each?.();
    }
  };
  const buy = (units: Command extends never ? never : (string | { type: string; cargo?: string })[]) => {
    run({ type: 'buyTrain', depot: map.tileIndex(2, 10), units: units as never });
    return [...state.trains.values()].at(-1)!;
  };
  return { state, map, company: c, exec, run, days, buy };
}

describe('road vehicles', () => {
  test('a bus serves two towns along a road, turning round at the ends', () => {
    const { state, run, days, buy } = world();
    run({ type: 'buildRoadStop', x: 7, y: 10, kind: 'bus' });
    run({ type: 'buildRoadStop', x: 50, y: 10, kind: 'bus' });
    const [a, b] = [0, 1];
    const bus = buy(['city_bus']);
    expect(bus.mode).toBe('road');
    expect(bus.name).toBe('Bus 1');
    run({ type: 'setOrders', id: bus.id, orders: [{ kind: 'station', station: a }, { kind: 'station', station: b }] });
    run({ type: 'trainAction', id: bus.id, action: 'start' });
    const visits: number[] = [];
    let was = false;
    days(80, () => {
      if (bus.status === 'loading' && !was) visits.push(bus.lastStation);
      was = bus.status === 'loading';
    });
    expect(visits.filter((v) => v === a).length).toBeGreaterThanOrEqual(2);
    expect(visits.filter((v) => v === b).length).toBeGreaterThanOrEqual(2);
    expect(bus.profitThisYear + bus.profitLastYear).toBeGreaterThan(0);
    expect(state.stations.get(a)!.waiting.passengers).toBeDefined();
  });

  test('buses on one road keep their distance', () => {
    const { run, days, buy } = world();
    run({ type: 'buildRoadStop', x: 7, y: 10, kind: 'bus' });
    run({ type: 'buildRoadStop', x: 50, y: 10, kind: 'bus' });
    const buses = [buy(['city_bus']), buy(['city_bus']), buy(['city_bus'])];
    for (const bus of buses) run({ type: 'setOrders', id: bus.id, orders: [{ kind: 'station', station: 0 }, { kind: 'station', station: 1 }] });
    for (const bus of buses) run({ type: 'trainAction', id: bus.id, action: 'start' });
    let moved = 0;
    days(60, () => {
      // No two buses on the same tile going the same way
      const seen = new Map<string, number>();
      for (const bus of buses) {
        for (const s of bus.path) {
          const k = `${rsTile(s)}:${s % 4}`;
          expect(seen.get(k) ?? bus.id).toBe(bus.id);
          seen.set(k, bus.id);
        }
        if (bus.speed > 1) moved++;
      }
    });
    expect(moved).toBeGreaterThan(1000);
    for (const bus of buses) expect(bus.profitThisYear + bus.profitLastYear).toBeGreaterThan(0);
  });

  test('a truck carries coal from a mine to a power station', () => {
    const { state, map, run, days, buy } = world();
    const mine = newIndustry(state.nextIndustryId++, industryType('coal_mine')!, 20, 11, 'Mine');
    const power = newIndustry(state.nextIndustryId++, industryType('power_station')!, 40, 11, 'Power');
    for (const ind of [mine, power]) {
      placeIndustry(map, ind);
      state.industries.set(ind.id, ind);
    }
    run({ type: 'buildRoadStop', x: 21, y: 10, kind: 'truck' });
    run({ type: 'buildRoadStop', x: 41, y: 10, kind: 'truck' });
    const truck = buy([{ type: 'tipper', cargo: 'coal' }]);
    expect(truck.name).toBe('Truck 1');
    run({ type: 'setOrders', id: truck.id, orders: [{ kind: 'station', station: 0 }, { kind: 'station', station: 1 }] });
    run({ type: 'trainAction', id: truck.id, action: 'start' });
    days(90);
    expect((power.delivered.coal ?? 0) + (power.lastDelivered.coal ?? 0)).toBeGreaterThan(0);
  });

  test('stops must suit the vehicle; road depots sell road vehicles only', () => {
    const { state, map, run, exec, buy } = world();
    run({ type: 'buildRoadStop', x: 7, y: 10, kind: 'bus' });
    const truck = buy([{ type: 'box_truck', cargo: 'goods' }]);
    expect(exec({ type: 'setOrders', id: truck.id, orders: [{ kind: 'station', station: 0 }] })).toMatchObject({ ok: false, error: expect.stringContaining('no truck stop') });
    expect(exec({ type: 'buyTrain', depot: map.tileIndex(2, 10), units: ['badger'] }).ok).toBe(false);
    expect(exec({ type: 'buyTrain', depot: map.tileIndex(2, 10), units: ['city_bus', 'city_bus'] }).ok).toBe(false);
    expect(state.trains.size).toBe(1);
    // Refit only
    run({ type: 'editConsist', id: truck.id, units: [{ type: 'box_truck', cargo: 'food' }] });
    expect(exec({ type: 'editConsist', id: truck.id, units: ['tipper'] }).ok).toBe(false);
  });

  test('one-way roads only let traffic out one way', () => {
    const { map } = world();
    const i = map.tileIndex(30, 10);
    map.layers.data[i] = ROAD_E | ROAD_W | ROAD_ONE_WAY; // eastbound only
    const west = map.tileIndex(29, 10);
    const east = map.tileIndex(31, 10);
    expect(roadNext(map, roadSeg(west, Edge.W, Edge.E)).length).toBe(1);
    expect(roadNext(map, roadSeg(east, Edge.E, Edge.W))).toEqual([]);
  });
});
