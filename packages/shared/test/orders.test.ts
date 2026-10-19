import { describe, expect, test } from 'bun:test';
import { TICKS_PER_DAY, segTile, type Order, type Train } from '../src/index.ts';
import { loop } from './loop.ts';

/** Station arrivals in order, over `days`. */
function arrivals(state: ReturnType<typeof loop>['state'], t: Train, days: number, onTick?: () => void): number[] {
  const seen: number[] = [];
  let was = false;
  for (let i = 0; i < TICKS_PER_DAY * days; i++) {
    state.step();
    onTick?.();
    const loading = t.status === 'loading';
    if (loading && !was) seen.push(t.lastStation);
    was = loading;
  }
  return seen;
}

describe('orders', () => {
  test('waypoints go on plain straight track, once', () => {
    const { state, map, exec, run } = loop();
    run({ type: 'buildWaypoint', x: 40, y: 16 });
    const wp = [...state.waypoints.values()][0]!;
    expect(wp.tile).toBe(map.tileIndex(40, 16));
    expect(exec({ type: 'buildWaypoint', x: 40, y: 16 }).ok).toBe(false);
    expect(exec({ type: 'buildWaypoint', x: 39, y: 11 }).ok).toBe(false); // corner piece
    expect(exec({ type: 'buildWaypoint', x: 25, y: 10 }).ok).toBe(false); // junction
    // Bulldozing the track removes the waypoint
    run({ type: 'clearArea', x0: 40, y0: 16, x1: 40, y1: 16 });
    expect(state.waypoints.size).toBe(0);
  });

  test('a train runs through a waypoint at speed and then heads for the next order', () => {
    const { state, map, exec, run, buy, top } = loop();
    run({ type: 'buildWaypoint', x: 40, y: 16 });
    const wp = [...state.waypoints.values()][0]!;
    const t = buy();
    run({ type: 'setOrders', id: t.id, orders: [{ kind: 'waypoint', waypoint: wp.id }, { kind: 'station', station: top }] });
    run({ type: 'trainAction', id: t.id, action: 'start' });
    let passSpeed = Infinity;
    const seen = arrivals(state, t, 40, () => {
      if (t.path.length && segTile(t.path[0]!) === map.tileIndex(40, 16)) passSpeed = Math.min(passSpeed, t.speed);
    });
    expect(passSpeed).toBeGreaterThan(30);
    expect(passSpeed).toBeLessThan(Infinity);
    expect(seen.every((s) => s === top)).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    // Signals and junctions can't go on a waypoint; removing it drops the order.
    expect(exec({ type: 'setSignal', x: 40, y: 16, piece: 1, dirs: 1 }).ok).toBe(false);
    run({ type: 'removeWaypoint', x: 40, y: 16 });
    expect(state.waypoints.size).toBe(0);
    expect(t.orders).toEqual([{ kind: 'station', station: top }]);
  });

  test('depot orders: the train is serviced and carries on', () => {
    const { state, run, buy, top, bottom } = loop();
    const t = buy();
    run({
      type: 'setOrders',
      id: t.id,
      orders: [{ kind: 'station', station: top }, { kind: 'depot' }, { kind: 'station', station: bottom }],
    });
    run({ type: 'trainAction', id: t.id, action: 'start' });
    const built = t.lastService;
    let serviced = false;
    const seen = arrivals(state, t, 70, () => {
      serviced ||= t.lastService !== built && t.status !== 'depot';
    });
    expect(serviced).toBe(true);
    expect(seen).toContain(top);
    expect(seen).toContain(bottom);
  });

  test('conditional orders jump when their condition holds', () => {
    const { state, exec, run, buy, top, bottom } = loop();
    const t = buy();
    const orders = (cond: Order): Order[] => [{ kind: 'station', station: top }, cond, { kind: 'station', station: bottom }];
    expect(exec({ type: 'setOrders', id: t.id, orders: orders({ kind: 'jump', to: 7, cond: 'always' }) }).ok).toBe(false);
    expect(exec({ type: 'setOrders', id: t.id, orders: [{ kind: 'jump', to: 0, cond: 'always' }] }).ok).toBe(false);
    // Always jump back to the top station: the bottom one is never visited.
    run({ type: 'setOrders', id: t.id, orders: orders({ kind: 'jump', to: 0, cond: 'always' }) });
    run({ type: 'trainAction', id: t.id, action: 'start' });
    let seen = arrivals(state, t, 50);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen).not.toContain(bottom);
    // Jump only when more than 100% full: never, so it goes on to the bottom station.
    run({ type: 'setOrders', id: t.id, orders: orders({ kind: 'jump', to: 0, cond: 'load', op: 'ge', value: 101 }) });
    seen = arrivals(state, t, 50);
    expect(seen).toContain(bottom);
  });

  test('timetables: autofill records travel times, then lateness and waits apply', () => {
    const { state, run, buy, top, bottom } = loop();
    const t = buy();
    run({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: top }, { kind: 'station', station: bottom }] });
    run({ type: 'trainAction', id: t.id, action: 'autofill' });
    run({ type: 'trainAction', id: t.id, action: 'start' });
    arrivals(state, t, 60);
    const filled = t.orders.map((o) => (o.kind === 'station' ? o.travel : undefined));
    expect(filled.every((v) => typeof v === 'number' && v > 0)).toBe(true);
    run({ type: 'trainAction', id: t.id, action: 'autofill' });
    expect(t.autofill).toBe(false);
    // A 6-day wait at the bottom station, and a tight schedule to the top one: it runs late.
    run({
      type: 'setOrders',
      id: t.id,
      orders: [
        { kind: 'station', station: top, travel: 0.5 },
        { kind: 'station', station: bottom, wait: 6, travel: filled[1] },
      ],
    });
    let longest = 0;
    let stay = 0;
    arrivals(state, t, 60, () => {
      stay = t.status === 'loading' && t.lastStation === bottom ? stay + 1 : 0;
      longest = Math.max(longest, stay);
    });
    expect(longest).toBeGreaterThanOrEqual(6 * TICKS_PER_DAY);
    expect(t.lateness).toBeDefined();
  });
});
