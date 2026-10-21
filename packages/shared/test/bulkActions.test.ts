import { describe, expect, test } from 'bun:test';
import { TICKS_PER_DAY, targetCode, type Order } from '../src/index.ts';
import { loop } from './loop.ts';

const both = (top: number, bottom: number): Order[] => [{ kind: 'station', station: top }, { kind: 'station', station: bottom }];

describe('bulk vehicle actions', () => {
  test('start, stop and send several vehicles to a depot at once, skipping those it does not apply to', () => {
    const { state, run, exec, buy, top, bottom } = loop();
    const a = buy();
    const b = buy();
    run({ type: 'setOrders', id: a.id, orders: both(top, bottom) });
    run({ type: 'assignLine', vehicle: b.id, line: a.line! });
    run({ type: 'vehiclesAction', ids: [a.id, b.id], action: 'start' });
    for (let i = 0; i < TICKS_PER_DAY * 2; i++) state.step();
    expect([a.status, b.status]).not.toContain('depot');
    // Only one is still running once the other is stopped; stopping both stops that one.
    run({ type: 'trainAction', id: a.id, action: 'stop' });
    run({ type: 'vehiclesAction', ids: [a.id, b.id], action: 'stop' });
    expect([a.status, b.status]).toEqual(['stopped', 'stopped']);
    expect(exec({ type: 'vehiclesAction', ids: [a.id, b.id], action: 'stop' }).ok).toBe(false);
    // Send to depot leaves one already on its way going there.
    run({ type: 'trainAction', id: a.id, action: 'toDepot' });
    run({ type: 'vehiclesAction', ids: [a.id, b.id], action: 'toDepot' });
    expect([a.toDepot, b.toDepot]).toEqual([true, true]);
  });

  test('a service sends a running vehicle to a depot without leaving its line', () => {
    const { state, run, exec, buy, top, bottom } = loop();
    const t = buy();
    expect(exec({ type: 'trainAction', id: t.id, action: 'service' }).ok).toBe(false);
    run({ type: 'setOrders', id: t.id, orders: both(top, bottom) });
    run({ type: 'trainAction', id: t.id, action: 'start' });
    for (let i = 0; i < TICKS_PER_DAY * 2; i++) state.step();
    run({ type: 'vehiclesAction', ids: [t.id], action: 'service' });
    expect(t.serviceTrip).toBe(true);
    expect(t.toDepot).toBe(false);
    expect(targetCode(t)).toBe(3);
    expect(exec({ type: 'trainAction', id: t.id, action: 'service' }).ok).toBe(false);
  });

  test('other companies’ vehicles are not touched', () => {
    const { state, exec, buy } = loop();
    const t = buy();
    const p = state.addPlayer('B', false);
    const c = state.foundCompany(p)!;
    const other = { ...t, id: 999, owner: c.id };
    state.trains.set(other.id, other);
    expect(exec({ type: 'vehiclesAction', ids: [other.id], action: 'start' }).ok).toBe(false);
    expect(exec({ type: 'vehiclesAction', ids: [], action: 'start' }).ok).toBe(false);
  });
});
