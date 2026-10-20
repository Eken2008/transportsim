import { describe, expect, test } from 'bun:test';
import {
  ACCIDENT_RULES,
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
import { loop } from './loop.ts';

/**
 * A single line x = 3..39 on y = 10 with a depot at each end and a station near each end.
 * One signal at x = 20 faces east only: westbound trains pass it from behind unchecked.
 */
function line(accidents: AccidentSeverity) {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear: 1925, accidents, breakdowns: false }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  const p = state.addPlayer('A', true);
  const c = state.foundCompany(p, 'A Rail')!;
  c.money = 1e8;
  const ctx = { playerId: p.id, companyId: c.id };
  const run = (cmd: Command) => {
    const r = executeCommand(state, ctx, cmd);
    if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
  };
  run({ type: 'buildDepot', x: 2, y: 10, exit: Edge.E });
  run({ type: 'buildDepot', x: 40, y: 10, exit: Edge.W });
  const pieces: number[] = [];
  for (let x = 3; x <= 39; x++) pieces.push(x, 10, Piece.X);
  run({ type: 'buildTrack', pieces });
  run({ type: 'buildStation', x: 5, y: 10, axis: 0, platforms: 1, length: 4 });
  run({ type: 'buildStation', x: 32, y: 10, axis: 0, platforms: 1, length: 4 });
  run({ type: 'setSignal', x: 20, y: 10, piece: Piece.X, dirs: 1 });
  const [west, east] = [0, 1];
  const train = (depotX: number, to: number) => {
    run({ type: 'buyTrain', depot: map.tileIndex(depotX, 10), units: ['atlas', 'coach_steel'] });
    const t = [...state.trains.values()].at(-1)!;
    run({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: to }] });
    return t;
  };
  const days = (n: number) => {
    for (let i = 0; i < TICKS_PER_DAY * n; i++) state.step();
  };
  return { state, map, company: c, run, train, days, west, east };
}

describe('rail accidents', () => {
  test('one-direction signals on two-way track: fast trains crash on realistic, never with accidents off', () => {
    for (const severity of ['realistic', 'off'] as const) {
      const { state, company, run, train, days, west, east } = line(severity);
      const a = train(2, east);
      const b = train(40, west);
      run({ type: 'trainAction', id: a.id, action: 'start' });
      days(1);
      run({ type: 'trainAction', id: b.id, action: 'start' });
      const money = company.money;
      const crashed = () => state.news.some((n) => n.kind === 'accident');
      for (let d = 0; d < 20 && !crashed(); d++) days(1);
      expect(crashed()).toBe(severity === 'realistic');
      if (severity === 'realistic') {
        expect(state.trains.size).toBe(0);
        expect(state.rail.wreckTiles().length).toBeGreaterThan(0);
        // Both trains' units (an engine and a coach each) lie on the line where they met.
        const wreckage = state.incidents.wreckage;
        expect(wreckage.map((w) => w.type).sort()).toEqual(['atlas', 'atlas', 'coach_steel', 'coach_steel']);
        for (const w of wreckage) expect(Math.abs(w.y - 10.5)).toBeLessThan(0.01);
        // The report says why: the signal faces one way only.
        expect(state.news.find((n) => n.kind === 'accident')?.detail).toMatch(/met head-on: no signal kept them apart\. .* Signal both directions/);
        expect(company.money).toBeLessThan(money - ACCIDENT_RULES.realistic.base);
        expect(company.finances.at(-1)!.ledger.incidents).toBeLessThan(0);
        // Wreckage is cleared after the cleanup period
        days(ACCIDENT_RULES.realistic.cleanupDays + 1);
        expect(state.rail.wreckTiles()).toEqual([]);
        expect(state.incidents.wreckage).toEqual([]);
      } else {
        expect(state.trains.size).toBe(2);
      }
    }
  });

  test('a brake failure runs a train past a red signal', () => {
    const { state, map, run, train, days, east } = line('low');
    // A train standing east of the signal makes it red for eastbound trains.
    const blocker = train(40, east);
    run({ type: 'trainAction', id: blocker.id, action: 'start' });
    days(2);
    run({ type: 'trainAction', id: blocker.id, action: 'stop' });
    days(1);
    expect(state.rail.signalRed(map.tileIndex(20, 10), Piece.X * 2)).toBe(true);
    const t = train(2, east);
    run({ type: 'trainAction', id: t.id, action: 'start' });
    let failed = false;
    for (let i = 0; i < TICKS_PER_DAY * 20 && state.trains.has(t.id); i++) {
      state.step();
      const x = t.path.length ? segTile(t.path[0]!) % map.width : 0;
      if (!failed && x >= 12 && t.speed > 60) {
        t.brakeFail = TICKS_PER_DAY * 3;
        failed = true;
      }
    }
    expect(failed).toBe(true);
    expect(state.trains.has(t.id)).toBe(false);
    expect(state.news.at(-1)?.text).toContain('collide');
    expect(state.news.at(-1)?.detail).toBe(`${t.name}'s brakes had failed, so it could not stop and ran past a red signal.`);
  });

  test('realistic: a train coasting into a tight corner far too fast derails', () => {
    for (const accidents of ['realistic', 'low'] as const) {
      const s = loop({ accidents, startYear: 1925, breakdowns: false });
      const t = s.buy(['atlas', 'coach_steel']);
      s.run({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: s.bottom }] });
      s.run({ type: 'trainAction', id: t.id, action: 'start' });
      let pushed = false;
      for (let i = 0; i < TICKS_PER_DAY * 20 && s.state.trains.has(t.id); i++) {
        s.state.step();
        const tile = t.path.length ? segTile(t.path[0]!) : 0;
        if (!pushed && tile === s.map.tileIndex(34, 10)) {
          t.speed = 128;
          t.brakeFail = TICKS_PER_DAY * 2;
          pushed = true;
        }
      }
      expect(pushed).toBe(true);
      const derailed = s.state.news.some((n) => n.kind === 'accident' && n.text.includes('derails'));
      expect(derailed).toBe(accidents === 'realistic');
      if (derailed) expect(s.state.news.at(-1)?.detail).toMatch(/^It took a curve for \d+ km\/h at \d+ km\/h: its brakes had failed\.$/);
    }
  });
});
