import { describe, expect, test } from 'bun:test';
import { Piece, TICKS_PER_DAY, encodeSnapshot, restoreSnapshot, targetGap, type Order } from '../src/index.ts';
import { loop } from './loop.ts';

const both = (top: number, bottom: number): Order[] => [{ kind: 'station', station: top }, { kind: 'station', station: bottom }];

/**
 * Two trains on a signalled loop, the second started a day behind the first, so they run
 * bunched up. Returns the gaps (days) between their departures from the top station.
 */
function bunched(spacing: boolean, days = 240) {
  const { state, run, buy, top, bottom } = loop({ breakdowns: false });
  // Clockwise signals: eastbound top, southbound right, westbound bottom, northbound left.
  run({ type: 'setSignal', x: 22, y: 10, piece: Piece.X, dirs: 1 });
  run({ type: 'setSignal', x: 40, y: 18, piece: Piece.Y, dirs: 1 });
  run({ type: 'setSignal', x: 27, y: 25, piece: Piece.X, dirs: 2 });
  run({ type: 'setSignal', x: 10, y: 18, piece: Piece.Y, dirs: 2 });
  const trains = [buy(), buy()];
  run({ type: 'createLine', mode: 'rail', vehicle: trains[0]!.id, orders: both(top, bottom) });
  const line = state.lines.get(trains[0]!.line!)!;
  run({ type: 'assignLine', vehicle: trains[1]!.id, line: line.id });
  if (spacing) run({ type: 'editLine', id: line.id, spacing: top });
  run({ type: 'trainAction', id: trains[0]!.id, action: 'start' });
  for (let i = 0; i < TICKS_PER_DAY; i++) state.step();
  run({ type: 'trainAction', id: trains[1]!.id, action: 'start' });
  const departures: number[] = [];
  const wasAt = new Map<number, boolean>();
  for (let i = 0; i < TICKS_PER_DAY * days; i++) {
    state.step();
    for (const t of trains) {
      const at = t.status === 'loading' && t.lastStation === top;
      if (wasAt.get(t.id) && !at) departures.push(state.tick);
      wasAt.set(t.id, at);
    }
  }
  const gaps = departures.slice(1).map((d, i) => (d - departures[i]!) / TICKS_PER_DAY);
  return { state, run, line, gaps, top, bottom };
}

/** Largest gap over the smallest among the last few departures (1 = perfectly even). */
const unevenness = (gaps: number[]) => Math.max(...gaps.slice(-6)) / Math.min(...gaps.slice(-6));

describe('even spacing', () => {
  test('bunched trains stay bunched without it, and spread out evenly with it', () => {
    const off = bunched(false);
    const on = bunched(true);
    expect(unevenness(off.gaps)).toBeGreaterThan(1.4);
    expect(unevenness(on.gaps)).toBeLessThan(1.03);
    // The round trip leaves out the time held for spacing: it matches the trains' natural one.
    const natural = off.gaps.slice(-2).reduce((a, b) => a + b, 0);
    expect(on.line.lap! / TICKS_PER_DAY).toBeCloseTo(natural, 0);
    expect(targetGap(on.state, on.line) / TICKS_PER_DAY).toBeCloseTo(natural / 2, 0);
    expect(on.line.gaps).toHaveLength(8);
    expect(off.line.lap).toBeUndefined();
  });

  test('the timing point must be one of the line’s stations; a new route starts measuring again', () => {
    const { state, run, line, top, bottom } = bunched(true, 60);
    expect(() => run({ type: 'editLine', id: line.id, spacing: 99 })).toThrow();
    // Timetable times don't change the route, so what was measured stays.
    const lap = line.lap;
    run({ type: 'editLine', id: line.id, orders: [{ kind: 'station', station: top, wait: 1 }, { kind: 'station', station: bottom }] });
    expect(line.lap).toBe(lap!);
    // Dropping the timing point's station turns spacing off.
    run({ type: 'editLine', id: line.id, orders: [{ kind: 'station', station: bottom }] });
    expect(line.spacing).toBeUndefined();
    expect(line.lap).toBeUndefined();
    expect([...state.trains.values()].every((t) => t.lapStart === undefined)).toBe(true);
    run({ type: 'editLine', id: line.id, orders: both(top, bottom), spacing: bottom });
    expect(line.spacing).toBe(bottom);
    run({ type: 'editLine', id: line.id, spacing: null });
    expect(line.spacing).toBeUndefined();
  });

  test('spacing and what it measured are saved', () => {
    const { state, line } = bunched(true, 60);
    const restored = restoreSnapshot(encodeSnapshot(state), { maxPlayers: 15, maxMapSize: 256 });
    const again = restored.lines.get(line.id)!;
    expect([again.spacing, again.lap, again.lastDeparture, again.gaps]).toEqual([line.spacing, line.lap, line.lastDeparture, line.gaps]);
    const t = [...state.trains.values()][0]!;
    expect(restored.trains.get(t.id)!.lapStart).toBe(t.lapStart!);
  });
});
