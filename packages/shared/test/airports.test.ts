import { describe, expect, test } from 'bun:test';
import {
  AIRPORT_TYPES,
  DEFAULT_SETTINGS,
  GameMap,
  GameState,
  HOUSE_TYPES,
  TICKS_PER_DAY,
  TileType,
  encodeSnapshot,
  executeCommand,
  restoreSnapshot,
  type AirportKind,
  type Command,
  type Train,
} from '../src/index.ts';

const TOWNHOUSE = HOUSE_TYPES.findIndex((h) => h.model === 'townhouse');

/** Flat land with two clusters of houses, around x = 8 and x = 70 (rows 9-10). */
function world(startYear = 1960, accidents: 'off' | 'low' | 'realistic' = 'off', seed = DEFAULT_SETTINGS.seed) {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear, breakdowns: false, accidents, seed }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  for (const cx of [8, 70]) {
    for (let x = cx - 3; x <= cx + 3; x++) {
      for (const y of [9, 10]) {
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
  const airport = (x: number, y: number, kind: AirportKind = 'small') => {
    run({ type: 'buildAirport', x, y, kind });
    return [...state.stations.values()].at(-1)!;
  };
  const hangar = (x: number, y: number, kind: AirportKind = 'small') => map.tileIndex(x, y + AIRPORT_TYPES[kind].h - 1);
  const buy = (depot: number, type: string) => {
    run({ type: 'buyTrain', depot, units: [type] as never });
    return [...state.trains.values()].at(-1)!;
  };
  return { state, map, company: c, exec, run, days, airport, hangar, buy };
}

describe('airports', () => {
  test('building and bulldozing an airport', () => {
    const { state, map, run, exec, airport } = world();
    const a = airport(5, 4);
    expect(a.name).toMatch(/Airport$/);
    expect(a.airport).toEqual({ kind: 'small', x: 5, y: 4 });
    expect(map.layers.type[map.tileIndex(9, 6)]).toBe(TileType.Airport);
    // Only one airport per station; a second next to it is refused.
    expect(exec({ type: 'buildAirport', x: 10, y: 4, kind: 'small' }).ok).toBe(false);
    // Not on houses.
    expect(exec({ type: 'buildAirport', x: 5, y: 8, kind: 'small' }).ok).toBe(false);
    run({ type: 'clearArea', x0: 7, y0: 5, x1: 7, y1: 5 });
    expect(map.layers.type[map.tileIndex(5, 4)]).toBe(TileType.Clear);
    expect(state.stations.get(a.id)?.airport).toBeUndefined();
  });

  test('large airports only arrive in 1955', () => {
    const { exec } = world(1940);
    expect(exec({ type: 'buildAirport', x: 5, y: 3, kind: 'large' }).ok).toBe(false);
    expect(exec({ type: 'buildAirport', x: 5, y: 3, kind: 'small' }).ok).toBe(true);
  });

  test('hangars sell aircraft only, and heavy jets need a large airport', () => {
    const { exec, airport, hangar, buy } = world(1975);
    airport(5, 4);
    const depot = hangar(5, 4);
    expect(exec({ type: 'buyTrain', depot, units: ['city_bus'] as never }).ok).toBe(false);
    expect(exec({ type: 'buyTrain', depot, units: ['skyliner', 'skyliner'] as never }).ok).toBe(false);
    expect(exec({ type: 'buyTrain', depot, units: ['jetliner'] as never }).ok).toBe(false);
    const plane = buy(depot, 'skyliner');
    expect(plane.mode).toBe('air');
    expect(plane.name).toBe('Aircraft 1');
    airport(60, 30, 'large');
    expect(buy(hangar(60, 30, 'large'), 'jetliner').mode).toBe('air');
  });

  test('aircraft climb and descend smoothly, well above the ground', () => {
    const { map, run, days, airport, hangar, buy } = world();
    const a = airport(5, 4);
    const b = airport(67, 4);
    const plane = buy(hangar(5, 4), 'skyliner');
    run({ type: 'setOrders', id: plane.id, orders: [{ kind: 'station', station: a.id }, { kind: 'station', station: b.id }] });
    run({ type: 'trainAction', id: plane.id, action: 'start' });
    const ground = map.cornerHeight(5, 4) * 0.3;
    let top = 0;
    let lastZ: number | null = null;
    let lastRate: number | null = null;
    let worstJerk = 0;
    days(40, () => {
      const air = plane.air;
      if (!air || (air.phase !== 'flying' && air.phase !== 'holding')) {
        lastZ = lastRate = null;
        return;
      }
      top = Math.max(top, air.z - ground);
      if (lastZ !== null) {
        const rate = air.z - lastZ;
        if (lastRate !== null) worstJerk = Math.max(worstJerk, Math.abs(rate - lastRate));
        lastRate = rate;
      }
      lastZ = air.z;
    });
    expect(top).toBeGreaterThan(4);
    // No steps: the climb rate changes only a little from one tick to the next.
    expect(worstJerk).toBeLessThan(0.01);
  });

  test('an aircraft carries passengers between two airports', () => {
    const { state, company, run, days, airport, hangar, buy } = world();
    const a = airport(5, 4);
    const b = airport(67, 4);
    const plane = buy(hangar(5, 4), 'skyliner');
    run({ type: 'setOrders', id: plane.id, orders: [{ kind: 'station', station: a.id }, { kind: 'station', station: b.id }] });
    run({ type: 'trainAction', id: plane.id, action: 'start' });
    const visits: number[] = [];
    let was = false;
    let maxZ = 0;
    days(120, () => {
      if (plane.status === 'loading' && !was) visits.push(plane.lastStation);
      was = plane.status === 'loading';
      maxZ = Math.max(maxZ, plane.air?.z ?? 0);
    });
    expect(maxZ).toBeGreaterThan(2);
    expect(visits.filter((v) => v === a.id).length).toBeGreaterThanOrEqual(2);
    expect(visits.filter((v) => v === b.id).length).toBeGreaterThanOrEqual(2);
    expect(plane.profitThisYear + plane.profitLastYear).toBeGreaterThan(0);
    // Its fares are booked as air income.
    const fares = company.finances.reduce((sum, q) => sum + (q.modes.air?.income ?? 0), 0);
    expect(fares).toBeGreaterThan(0);
    expect(fares).toBe(company.finances.reduce((sum, q) => sum + q.ledger.income, 0));
    // Its position is streamed as an air tuple.
    expect(state.air.motion(plane).air).toHaveLength(6);
  });

  test('one aircraft on a runway at a time; others hold or wait', () => {
    const { state, run, days, airport, hangar, buy } = world();
    const a = airport(5, 4);
    const b = airport(67, 4);
    const planes: Train[] = [];
    for (let i = 0; i < 4; i++) {
      const p = buy(hangar(5, 4), 'skyliner');
      run({ type: 'setOrders', id: p.id, orders: [{ kind: 'station', station: a.id }, { kind: 'station', station: b.id }] });
      run({ type: 'trainAction', id: p.id, action: 'start' });
      planes.push(p);
    }
    let held = false;
    let maxAtGates = 0;
    const arrivals = new Map<number, number>();
    const loading = new Set<number>();
    days(90, () => {
      for (const p of planes) {
        if (p.status === 'loading' && !loading.has(p.id)) arrivals.set(p.id, (arrivals.get(p.id) ?? 0) + 1);
        if (p.status === 'loading') loading.add(p.id);
        else loading.delete(p.id);
      }
      for (const st of [a.id, b.id]) {
        const onRunway = planes.filter((p) => p.air?.airport === st && (p.air.phase === 'takeoff' || p.air.phase === 'landing'));
        expect(onRunway.length).toBeLessThanOrEqual(1);
        const gates = planes.filter((p) => p.air?.airport === st && p.air.gate !== undefined).map((p) => p.air!.gate);
        expect(new Set(gates).size).toBe(gates.length);
        maxAtGates = Math.max(maxAtGates, gates.length);
      }
      if (planes.some((p) => p.air?.phase === 'holding' || p.air?.phase === 'hold')) held = true;
    });
    expect(held).toBe(true);
    expect(maxAtGates).toBeLessThanOrEqual(2);
    expect(planes.every((p) => (arrivals.get(p.id) ?? 0) >= 2)).toBe(true);
    expect(state.trains.size).toBe(4);
  });

  test("aircraft can't stop in the air, and airports with aircraft can't be removed", () => {
    const { run, exec, days, airport, hangar, buy } = world();
    const a = airport(5, 4);
    const b = airport(67, 4);
    const plane = buy(hangar(5, 4), 'skyliner');
    run({ type: 'setOrders', id: plane.id, orders: [{ kind: 'station', station: a.id }, { kind: 'station', station: b.id }] });
    expect(exec({ type: 'clearArea', x0: 5, y0: 4, x1: 5, y1: 4 }).ok).toBe(false);
    run({ type: 'trainAction', id: plane.id, action: 'start' });
    let tries = 0;
    days(30, () => {
      if (plane.air?.phase === 'flying' && tries++ === 0) expect(exec({ type: 'trainAction', id: plane.id, action: 'stop' }).ok).toBe(false);
    });
    expect(tries).toBeGreaterThan(0);
  });

  test('a removed destination makes the aircraft divert home to its hangar', () => {
    const { state, run, days, airport, hangar, buy } = world();
    const a = airport(5, 4);
    const b = airport(67, 4);
    const plane = buy(hangar(5, 4), 'skyliner');
    run({ type: 'setOrders', id: plane.id, orders: [{ kind: 'station', station: b.id }] });
    run({ type: 'trainAction', id: plane.id, action: 'start' });
    let removed = false;
    days(60, () => {
      if (!removed && plane.air?.phase === 'flying' && plane.air.airport === b.id) {
        run({ type: 'clearArea', x0: 67, y0: 4, x1: 67, y1: 4 });
        removed = true;
      }
    });
    expect(removed).toBe(true);
    expect(state.stations.get(b.id)?.airport).toBeUndefined();
    expect(plane.status).toBe('depot');
    expect(plane.depot).toBe(hangar(5, 4));
    expect(a.airport).toBeDefined();
  });

  test('aircraft in flight survive a save and load', () => {
    const { state, run, days, airport, hangar, buy } = world();
    const a = airport(5, 4);
    const b = airport(67, 4);
    const plane = buy(hangar(5, 4), 'skyliner');
    run({ type: 'setOrders', id: plane.id, orders: [{ kind: 'station', station: a.id }, { kind: 'station', station: b.id }] });
    run({ type: 'trainAction', id: plane.id, action: 'start' });
    days(3);
    const restored = restoreSnapshot(encodeSnapshot(state), { maxPlayers: 15, maxMapSize: 256 });
    const p = restored.trains.get(plane.id)!;
    expect(p.mode).toBe('air');
    expect(p.air).toEqual(plane.air);
    expect(restored.stations.get(b.id)!.airport).toEqual(b.airport);
    for (let i = 0; i < TICKS_PER_DAY * 60; i++) restored.step();
    expect(p.profitThisYear + p.profitLastYear).toBeGreaterThan(0);
  });

  test('heavy jets at small airports risk crashing on landing', () => {
    let crashes = 0;
    for (let seed = 0; seed < 4 && crashes === 0; seed++) {
      const { state, run, days, airport, hangar, buy } = world(1975, 'realistic', seed + 1);
      const big = airport(5, 2, 'large');
      const small = airport(67, 4);
      const jet = buy(hangar(5, 2, 'large'), 'jetliner');
      run({ type: 'setOrders', id: jet.id, orders: [{ kind: 'station', station: big.id }, { kind: 'station', station: small.id }] });
      run({ type: 'trainAction', id: jet.id, action: 'start' });
      days(400, () => {
        if (!state.trains.has(jet.id) && crashes === 0) {
          crashes++;
          expect(state.news.some((n) => n.text.startsWith('Air crash!'))).toBe(true);
          expect(state.air.runwayClosed.get(small.id)).toBeGreaterThan(state.tick);
        }
      });
    }
    expect(crashes).toBe(1);
  });
});
