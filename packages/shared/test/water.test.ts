import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  GameMap,
  GameState,
  HOUSE_TYPES,
  TICKS_PER_DAY,
  TileType,
  WATER_CANAL,
  encodeSnapshot,
  executeCommand,
  findShipPath,
  restoreSnapshot,
  type Command,
  type Train,
} from '../src/index.ts';

const TOWNHOUSE = HOUSE_TYPES.findIndex((h) => h.model === 'townhouse');

/**
 * A 128² map: sea along the west (x < 10, height 0), land at height 1 from x = 11 (x = 10 is the
 * shore slope), rising to height 2 at x = 41 (x = 40 is a slope for a lock). Houses around
 * (24, 30) and (60, 30).
 */
function world(startYear = 1950, accidents: 'off' | 'low' | 'realistic' = 'off') {
  const map = new GameMap(128, 128);
  const cw = map.width + 1;
  for (let y = 0; y <= map.height; y++) {
    for (let x = 0; x <= map.width; x++) map.heights[y * cw + x] = x <= 10 ? 0 : x <= 40 ? 1 : 2;
  }
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const i = map.tileIndex(x, y);
      if (x < 10) map.setWater(i);
      else map.setClear(i, 0, 0);
    }
  }
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear, breakdowns: false, accidents }, map);
  for (const cx of [24, 60]) {
    for (let x = cx - 3; x <= cx + 3; x++) {
      for (const y of [32, 33]) {
        const i = map.tileIndex(x, y);
        map.layers.type[i] = TileType.House;
        map.layers.data[i] = TOWNHOUSE;
      }
    }
  }
  const p = state.addPlayer('A', true);
  const c = state.foundCompany(p)!;
  c.money = 1e8;
  const exec = (cmd: Command) => executeCommand(state, { playerId: p.id, companyId: c.id }, cmd);
  const run = (cmd: Command) => {
    const r = exec(cmd);
    if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
  };
  const days = (n: number, each?: () => void) => {
    for (let i = 0; i < TICKS_PER_DAY * n; i++) {
      state.step();
      each?.();
    }
  };
  return { state, map, company: c, exec, run, days };
}

/** A canal along y = 30 from the sea, up through a lock on the shore (x = 10) and one at x = 40, to x = 70. */
function waterway(w: ReturnType<typeof world>) {
  const { run } = w;
  run({ type: 'buildLock', x: 10, y: 30 });
  run({ type: 'buildCanal', x0: 11, y0: 30, x1: 39, y1: 30 });
  run({ type: 'buildLock', x: 40, y: 30 });
  run({ type: 'buildCanal', x0: 41, y0: 30, x1: 70, y1: 30 });
}

describe('waterways', () => {
  test('canals go on flat land and keep their height', () => {
    const { map, exec, run } = world();
    run({ type: 'buildCanal', x0: 20, y0: 10, x1: 25, y1: 10 });
    const i = map.tileIndex(22, 10);
    expect(map.layers.type[i]).toBe(TileType.Water);
    expect(map.layers.data[i]! & WATER_CANAL).toBe(WATER_CANAL);
    expect(map.tileMinHeight(22, 10)).toBe(1);
    // Not on a slope, nor over houses.
    expect(exec({ type: 'buildCanal', x0: 40, y0: 12, x1: 40, y1: 12 }).ok).toBe(false);
    expect(exec({ type: 'buildCanal', x0: 24, y0: 32, x1: 24, y1: 32 }).ok).toBe(false);
    // Terraforming leaves canals alone.
    expect(exec({ type: 'terraform', x0: 22, y0: 10, x1: 22, y1: 10, mode: 'raise' }).ok).toBe(false);
    // Bulldozing a canal gives back land.
    run({ type: 'clearArea', x0: 20, y0: 10, x1: 25, y1: 10 });
    expect(map.layers.type[i]).toBe(TileType.Clear);
  });

  test('locks need a straight one-level slope and link two levels', () => {
    const w = world();
    const { map, exec } = w;
    expect(exec({ type: 'buildLock', x: 30, y: 30 }).ok).toBe(false); // flat
    waterway(w);
    expect(map.layers.type[map.tileIndex(40, 30)]).toBe(TileType.Lock);
    // A route from the sea up the canal goes through the lock.
    const path = findShipPath(map, map.tileIndex(5, 30), new Set([map.tileIndex(70, 30)]));
    expect(path).not.toBeNull();
    expect(path).toContain(map.tileIndex(40, 30));
    // Without the lock there is no way up.
    w.run({ type: 'clearArea', x0: 40, y0: 30, x1: 40, y1: 30 });
    expect(findShipPath(map, map.tileIndex(5, 30), new Set([map.tileIndex(70, 30)]))).toBeNull();
  });

  test('docks face water and join or make a station; depots and buoys go on water', () => {
    const w = world();
    const { state, map, exec, run } = w;
    waterway(w);
    expect(exec({ type: 'buildDock', x: 24, y: 20 }).ok).toBe(false); // no water
    run({ type: 'buildDock', x: 24, y: 31 });
    const st = [...state.stations.values()].at(-1)!;
    expect(st.name).toMatch(/Docks$/);
    expect(map.layers.track[map.tileIndex(24, 31)]).toBe(0); // faces north, onto the canal
    expect(exec({ type: 'buildShipDepot', x: 24, y: 20 }).ok).toBe(false);
    run({ type: 'buildShipDepot', x: 15, y: 30 });
    expect(map.layers.type[map.tileIndex(15, 30)]).toBe(TileType.ShipDepot);
    expect(state.shipDepots.has(map.tileIndex(15, 30))).toBe(true);
    run({ type: 'buildBuoy', x: 5, y: 40 });
    const buoy = [...state.waypoints.values()].at(-1)!;
    expect(buoy.buoy).toBe(true);
    expect(buoy.name).toMatch(/Buoy/);
    // Bulldozing the buoy removes it but leaves the sea.
    run({ type: 'clearArea', x0: 5, y0: 40, x1: 5, y1: 40 });
    expect(state.waypoints.has(buoy.id)).toBe(false);
    expect(map.layers.type[map.tileIndex(5, 40)]).toBe(TileType.Water);
    // The depot turns back into canal.
    run({ type: 'clearArea', x0: 15, y0: 30, x1: 15, y1: 30 });
    expect(map.layers.data[map.tileIndex(15, 30)]! & WATER_CANAL).toBe(WATER_CANAL);
  });
});

describe('ships', () => {
  /** Docks at both towns on the canal, a depot by the sea end. */
  function harbour(startYear = 1950, accidents: 'off' | 'low' | 'realistic' = 'off') {
    const w = world(startYear, accidents);
    waterway(w);
    const { state, run, map } = w;
    run({ type: 'buildDock', x: 24, y: 31 });
    const a = [...state.stations.values()].at(-1)!;
    run({ type: 'buildDock', x: 60, y: 31 });
    const b = [...state.stations.values()].at(-1)!;
    // The depot sits in a side basin, off the canal (ships only enter depots to stop there).
    run({ type: 'buildCanal', x0: 15, y0: 29, x1: 15, y1: 29 });
    run({ type: 'buildShipDepot', x: 15, y: 29 });
    const depot = map.tileIndex(15, 29);
    const buy = (type = 'motor_ferry') => {
      run({ type: 'buyTrain', depot, units: [type] as never });
      return [...state.trains.values()].at(-1)!;
    };
    return { ...w, a, b, depot, buy };
  }

  test('ship depots sell ships only', () => {
    const { exec, depot, buy } = harbour();
    expect(exec({ type: 'buyTrain', depot, units: ['city_bus'] as never }).ok).toBe(false);
    expect(exec({ type: 'buyTrain', depot, units: ['motor_ferry', 'motor_ferry'] as never }).ok).toBe(false);
    const s = buy();
    expect(s.mode).toBe('water');
    expect(s.name).toBe('Ship 1');
  });

  test('a ferry carries passengers between two docks, through the lock', () => {
    const { state, map, run, days, a, b, buy } = harbour();
    const ferry = buy();
    run({ type: 'setOrders', id: ferry.id, orders: [{ kind: 'station', station: a.id }, { kind: 'station', station: b.id }] });
    run({ type: 'trainAction', id: ferry.id, action: 'start' });
    const visits: number[] = [];
    let was = false;
    let inLock = false;
    days(200, () => {
      if (ferry.status === 'loading' && !was) visits.push(ferry.lastStation);
      was = ferry.status === 'loading';
      if (ferry.ship && Math.floor(ferry.ship.x) === 40 && ferry.ship.lockWait) inLock = true;
    });
    expect(inLock).toBe(true);
    expect(visits.filter((v) => v === a.id).length).toBeGreaterThanOrEqual(2);
    expect(visits.filter((v) => v === b.id).length).toBeGreaterThanOrEqual(2);
    expect(ferry.profitThisYear + ferry.profitLastYear).toBeGreaterThan(0);
    expect(state.ships.motion(ferry).ship).toHaveLength(5);
    expect(map.layers.type[map.tileIndex(40, 30)]).toBe(TileType.Lock);
  });

  test('one ship in a lock at a time', () => {
    const { state, run, days, a, b, buy } = harbour();
    const ships: Train[] = [];
    for (let k = 0; k < 3; k++) {
      const s = buy();
      run({ type: 'setOrders', id: s.id, orders: [{ kind: 'station', station: a.id }, { kind: 'station', station: b.id }] });
      run({ type: 'trainAction', id: s.id, action: 'start' });
      ships.push(s);
      days(3);
    }
    days(120, () => {
      const waiting = ships.filter((s) => s.ship && Math.floor(s.ship.x) === 40 && s.ship.lockWait);
      expect(waiting.length).toBeLessThanOrEqual(1);
    });
    expect(state.trains.size).toBe(3);
    expect(ships.every((s) => s.profitThisYear + s.profitLastYear > 0)).toBe(true);
  });

  test('ships follow buoys and go for service at a depot', () => {
    const { state, map, run, days, a, buy } = harbour();
    run({ type: 'buildBuoy', x: 4, y: 50 });
    const buoy = [...state.waypoints.values()].at(-1)!;
    const s = buy();
    run({ type: 'setOrders', id: s.id, orders: [{ kind: 'station', station: a.id }, { kind: 'waypoint', waypoint: buoy.id }, { kind: 'depot' }] });
    run({ type: 'trainAction', id: s.id, action: 'start' });
    let passedBuoy = false;
    let serviced = 0;
    const firstService = s.lastService;
    days(150, () => {
      if (s.ship && Math.floor(s.ship.x) === 4 && Math.floor(s.ship.y) === 50) passedBuoy = true;
      if (s.lastService !== firstService) serviced++;
    });
    expect(passedBuoy).toBe(true);
    expect(serviced).toBeGreaterThan(0);
    expect(s.status).not.toBe('depot'); // it carries on after its service
    // Trains can't use buoys; ships can't use rail-less stations without docks.
    expect(map.layers.type[buoy.tile]).toBe(TileType.Water);
  });

  test("canals with ships on them can't be removed; a depot with ships neither", () => {
    const { exec, run, days, a, b, buy } = harbour();
    const s = buy();
    expect(exec({ type: 'clearArea', x0: 15, y0: 29, x1: 15, y1: 29 }).ok).toBe(false);
    run({ type: 'setOrders', id: s.id, orders: [{ kind: 'station', station: a.id }, { kind: 'station', station: b.id }] });
    run({ type: 'trainAction', id: s.id, action: 'start' });
    days(4);
    const x = Math.floor(s.ship!.x);
    const y = Math.floor(s.ship!.y);
    expect(exec({ type: 'clearArea', x0: x, y0: y, x1: x, y1: y }).ok).toBe(false);
  });

  test('ships at sea survive a save and load', () => {
    const { state, run, days, a, b, buy } = harbour();
    const s = buy();
    run({ type: 'setOrders', id: s.id, orders: [{ kind: 'station', station: a.id }, { kind: 'station', station: b.id }] });
    run({ type: 'trainAction', id: s.id, action: 'start' });
    days(6);
    const restored = restoreSnapshot(encodeSnapshot(state), { maxPlayers: 15, maxMapSize: 256 });
    const r = restored.trains.get(s.id)!;
    expect(r.mode).toBe('water');
    expect(r.ship!.x).toBeCloseTo(s.ship!.x);
    expect(restored.shipDepots.size).toBe(1);
    for (let i = 0; i < TICKS_PER_DAY * 120; i++) restored.step();
    expect(r.profitThisYear + r.profitLastYear).toBeGreaterThan(0);
  });
});
