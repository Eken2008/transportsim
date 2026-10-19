import { describe, expect, test } from 'bun:test';
import { TICKS_PER_DAY, baseReliability, maxReliability, type Train } from '../src/index.ts';
import { loop } from './loop.ts';

function days(state: ReturnType<typeof loop>['state'], n: number, each?: () => void) {
  for (let i = 0; i < TICKS_PER_DAY * n; i++) {
    state.step();
    each?.();
  }
}

describe('reliability and breakdowns', () => {
  test('reliability decays while running and a depot service restores it', () => {
    const { state, run, buy, top, bottom } = loop();
    const t = buy();
    run({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: top }, { kind: 'station', station: bottom }] });
    run({ type: 'trainAction', id: t.id, action: 'start' });
    days(state, 40);
    const base = baseReliability(t.units);
    expect(t.reliability).toBeLessThan(base - 0.04);
    run({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: top }, { kind: 'depot' }, { kind: 'station', station: bottom }] });
    const before = t.lastService;
    let restored = 0;
    days(state, 60, () => {
      if (t.lastService !== before && !restored) restored = t.reliability!;
    });
    expect(restored).toBeCloseTo(base, 2);
  });

  test('unreliable trains break down and stand still for a while; not with breakdowns off', () => {
    for (const breakdowns of [true, false]) {
      const { state, run, buy, top, bottom } = loop({ breakdowns });
      const t = buy();
      run({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: top }, { kind: 'station', station: bottom }] });
      run({ type: 'trainAction', id: t.id, action: 'start' });
      let stoppedBroken = false;
      days(state, 200, () => {
        if (state.dayTick === 0) t.reliability = 0;
        if (t.brokenDown && t.speed === 0) stoppedBroken = true;
      });
      expect((t.breakdowns ?? 0) > 0).toBe(breakdowns);
      expect(stoppedBroken).toBe(breakdowns);
    }
  });

  test('a train due for service detours to a depot and keeps its orders', () => {
    const { state, exec, run, buy, top, bottom } = loop();
    const t = buy();
    expect(exec({ type: 'trainSettings', id: t.id, serviceInterval: 10 }).ok).toBe(false);
    run({ type: 'trainSettings', id: t.id, serviceInterval: 30 });
    run({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: top }, { kind: 'station', station: bottom }] });
    run({ type: 'trainAction', id: t.id, action: 'start' });
    const services = new Set<number>();
    let detoured = false;
    days(state, 120, () => {
      detoured ||= t.serviceTrip === true;
      if (t.lastService !== undefined) services.add(t.lastService);
    });
    expect(detoured).toBe(true);
    expect(services.size).toBeGreaterThanOrEqual(2);
    expect(t.orders).toHaveLength(2);
    expect(t.status).not.toBe('depot');
  });
});

describe('ageing, autorenew and autoreplace', () => {
  const visitDepot = (s: ReturnType<typeof loop>, t: Train) => {
    s.run({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: s.top }, { kind: 'depot' }, { kind: 'station', station: s.bottom }] });
    s.run({ type: 'trainAction', id: t.id, action: 'start' });
    const before = t.lastService;
    for (let i = 0; i < TICKS_PER_DAY * 60 && t.lastService === before; i++) s.state.step();
  };

  test('old trains lose reliability and are renewed on a depot visit', () => {
    const s = loop();
    const t = s.buy();
    t.builtDays = s.state.date - 45 * 365; // Kestrel: 35 year design life
    expect(maxReliability(t, s.state.date)).toBeLessThan(baseReliability(t.units) * 0.5);
    const money = s.company.money;
    visitDepot(s, t);
    expect(t.builtDays).toBeGreaterThan(s.state.date - 60);
    expect(s.company.money).toBeLessThan(money - 10_000);
    expect(t.reliability).toBeCloseTo(baseReliability(t.units), 2);
  });

  test('no renewal with autorenew off; replacement rules swap vehicle types', () => {
    const s = loop({ startYear: 1925 });
    s.run({ type: 'vehicleSettings', autorenew: false });
    expect(s.exec({ type: 'vehicleSettings', replace: { from: 'coach_wood', to: 'atlas' } }).ok).toBe(false);
    s.run({ type: 'vehicleSettings', replace: { from: 'coach_wood', to: 'coach_steel' } });
    const t = s.buy();
    const built = s.state.date - 45 * 365;
    t.builtDays = built;
    visitDepot(s, t);
    expect(t.units.map((u) => u.type)).toEqual(['kestrel', 'coach_steel', 'coach_steel']);
    // The engine wasn't replaced, so the train keeps its age.
    expect(t.builtDays).toBe(built);
    expect(s.state.news.some((n) => n.kind === 'vehicle' && n.text.includes('getting old'))).toBe(true);
  });
});
