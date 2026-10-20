import { describe, expect, test } from 'bun:test';
import { TICKS_PER_DAY, encode, encodeSnapshot, restoreSnapshot, takeSnapshot, type Order } from '../src/index.ts';
import { loop } from './loop.ts';

const LIMITS = { maxPlayers: 15, maxMapSize: 256 };
const both = (top: number, bottom: number): Order[] => [{ kind: 'station', station: top }, { kind: 'station', station: bottom }];

describe('lines', () => {
  test('vehicles on a line follow its stops, and editing the line changes them all', () => {
    const { state, run, buy, top, bottom } = loop();
    const a = buy();
    const b = buy();
    run({ type: 'createLine', mode: 'rail', vehicle: a.id, orders: both(top, bottom) });
    const line = [...state.lines.values()][0]!;
    expect(line.name).toBe('Rail line 1');
    expect(a.line).toBe(line.id);
    expect(a.orders).toEqual(both(top, bottom));
    run({ type: 'assignLine', vehicle: b.id, line: line.id });
    expect(b.orders).toEqual(both(top, bottom));
    run({ type: 'editLine', id: line.id, orders: [{ kind: 'station', station: top }] });
    expect(a.orders).toEqual([{ kind: 'station', station: top }]);
    expect(b.orders).toEqual([{ kind: 'station', station: top }]);
    // setOrders on a vehicle edits its line.
    run({ type: 'setOrders', id: b.id, orders: both(bottom, top) });
    expect(line.orders).toEqual(both(bottom, top));
    expect(a.orders).toEqual(both(bottom, top));
    // Off the line, a vehicle has no orders; deleting the line leaves the others without.
    run({ type: 'assignLine', vehicle: b.id, line: null });
    expect(b.line).toBeUndefined();
    expect(b.orders).toEqual([]);
    run({ type: 'deleteLine', id: line.id });
    expect(state.lines.size).toBe(0);
    expect(a.orders).toEqual([]);
  });

  test('setOrders starts a line for a vehicle without one', () => {
    const { state, run, buy, top, bottom } = loop();
    const t = buy();
    run({ type: 'setOrders', id: t.id, orders: both(top, bottom) });
    expect(state.lines.size).toBe(1);
    expect(state.lines.get(t.line!)!.orders).toEqual(both(top, bottom));
  });

  test('lines are checked against their kind of vehicle', () => {
    const { exec, run, buy, top } = loop();
    const t = buy();
    expect(exec({ type: 'createLine', mode: 'air', orders: [{ kind: 'station', station: top }] }).ok).toBe(false);
    expect(exec({ type: 'createLine', mode: 'road', vehicle: t.id }).ok).toBe(false);
    run({ type: 'createLine', mode: 'air' });
    expect(exec({ type: 'assignLine', vehicle: t.id, line: 0 }).ok).toBe(false);
    expect(exec({ type: 'editLine', id: 0, name: '  ' }).ok).toBe(false);
    run({ type: 'editLine', id: 0, name: 'Shuttle', color: 3 });
  });

  test('a duplicate is bought in the depot, on the same line, and runs it', () => {
    const { state, company, run, buy, depot, top, bottom } = loop();
    const t = buy(['kestrel', 'coach_wood', 'mail_van']);
    run({ type: 'setOrders', id: t.id, orders: both(top, bottom) });
    run({ type: 'trainSettings', id: t.id, serviceInterval: 90 });
    run({ type: 'trainAction', id: t.id, action: 'start' });
    for (let i = 0; i < TICKS_PER_DAY * 3; i++) state.step();
    const money = company.money;
    const r = run({ type: 'cloneVehicle', id: t.id });
    const copy = [...state.trains.values()].at(-1)!;
    expect(copy.id).not.toBe(t.id);
    expect(copy.units).toEqual(t.units);
    expect(copy.status).toBe('depot');
    expect(copy.line).toBe(t.line);
    expect(copy.orders).toEqual(t.orders);
    expect(copy.serviceInterval).toBe(90);
    expect(copy.depot).toBe(depot);
    expect(company.money).toBe(money - r.cost);
    // The loop is one signal block, so the original goes home and only the copy runs.
    state.removeVehicle(t);
    run({ type: 'trainAction', id: copy.id, action: 'start' });
    const visited = new Set<number>();
    for (let i = 0; i < TICKS_PER_DAY * 60; i++) {
      state.step();
      if (copy.status === 'loading') visited.add(copy.lastStation);
    }
    expect(visited).toEqual(new Set([top, bottom]));
  });

  test('lines survive a save, and older saves get lines for vehicles with the same orders', () => {
    const { state, run, buy, top, bottom } = loop();
    const a = buy();
    const b = buy();
    const c = buy();
    run({ type: 'setOrders', id: a.id, orders: both(top, bottom) });
    run({ type: 'assignLine', vehicle: b.id, line: a.line! });
    const restored = restoreSnapshot(encodeSnapshot(state), LIMITS);
    const line = restored.lines.get(a.line!)!;
    expect(line.orders).toEqual(both(top, bottom));
    expect(restored.trains.get(b.id)!.orders).toBe(line.orders);
    // A save from before lines: orders on the vehicles only.
    const old = takeSnapshot(state);
    old.lines = undefined;
    old.trains = old.trains!.map((t) => ({ ...t, line: undefined }));
    old.trains.find((t) => t.id === c.id)!.orders = [{ kind: 'station', station: top }];
    const migrated = restoreSnapshot(encode(old), LIMITS);
    expect(migrated.lines.size).toBe(2);
    const ma = migrated.trains.get(a.id)!;
    expect(migrated.trains.get(b.id)!.line).toBe(ma.line!);
    expect(migrated.trains.get(c.id)!.line).not.toBe(ma.line!);
  });

  test('removing a waypoint drops it from lines, and jumps follow', () => {
    const { state, run, buy, top, bottom } = loop();
    run({ type: 'buildWaypoint', x: 40, y: 16 });
    const t = buy();
    run({
      type: 'setOrders',
      id: t.id,
      orders: [{ kind: 'waypoint', waypoint: 0 }, { kind: 'station', station: top }, { kind: 'station', station: bottom }, { kind: 'jump', to: 1, cond: 'always' }],
    });
    run({ type: 'removeWaypoint', x: 40, y: 16 });
    expect(state.lines.get(t.line!)!.orders).toEqual([...both(top, bottom), { kind: 'jump', to: 0, cond: 'always', op: 'lt', value: 0 }]);
  });
});
