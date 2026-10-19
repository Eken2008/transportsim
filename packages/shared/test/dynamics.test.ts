import { describe, expect, test } from 'bun:test';
import {
  CLOSE_AFTER_MONTHS,
  DEFAULT_SETTINGS,
  GameMap,
  GameState,
  LOAN_STEP,
  Random,
  TICKS_PER_DAY,
  TileType,
  encodeSnapshot,
  industryMonthly,
  industryType,
  newIndustry,
  placeIndustry,
  restoreSnapshot,
} from '../src/index.ts';

function flat(size = 256, extra = {}) {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: size, mapHeight: size, startYear: 1950, ...extra }, new GameMap(size, size));
  state.map.heights.fill(2);
  for (let i = 0; i < state.map.width * state.map.height; i++) state.map.setClear(i, 0, 0);
  const add = (type: string, x: number, y: number) => {
    const ind = newIndustry(state.nextIndustryId++, industryType(type)!, x, y, type);
    placeIndustry(state.map, ind);
    state.industries.set(ind.id, ind);
    return ind;
  };
  return { state, add };
}

describe('industry dynamics', () => {
  test('well-served primary industries grow; neglected ones shrink', () => {
    const { state, add } = flat();
    const served = add('coal_mine', 20, 20);
    const neglected = add('iron_mine', 60, 20);
    const rng = new Random(1);
    for (let m = 0; m < 60; m++) {
      served.lastProduced = { coal: 100 };
      served.lastTransported = { coal: 80 };
      neglected.lastProduced = { iron_ore: 100 };
      neglected.lastTransported = { iron_ore: 0 };
      industryMonthly(state, rng, 1950);
    }
    expect(served.level).toBeGreaterThan(1.5);
    expect(neglected.level).toBeLessThan(1);
  });

  test('industries unserved for years close, with news', () => {
    const { state, add } = flat();
    const mill = add('steel_mill', 20, 20);
    const rng = new Random(2);
    for (let m = 0; m < CLOSE_AFTER_MONTHS + 60 && state.industries.has(mill.id); m++) industryMonthly(state, rng, 1950);
    expect(state.industries.has(mill.id)).toBe(false);
    expect(state.removedIndustries.has(mill.id)).toBe(true);
    expect(state.map.layers.type[state.map.tileIndex(21, 21)]).toBe(TileType.Clear);
    expect(state.news.some((n) => n.text.includes('closure'))).toBe(true);
  });

  test('new industries open over the years', () => {
    const { state } = flat();
    const rng = new Random(3);
    for (let m = 0; m < 12 * 15; m++) industryMonthly(state, rng, 1950);
    expect(state.industries.size).toBeGreaterThan(0);
    expect(state.news.some((n) => n.text.startsWith('New '))).toBe(true);
  });
});

describe('inflation', () => {
  test('with inflation on, costs and the loan limit rise each year; off, they stay', () => {
    for (const inflation of [true, false]) {
      const { state } = flat(128, { inflation });
      const cost = state.cost(10_000);
      const loan = state.maxLoan();
      for (let i = 0; i < TICKS_PER_DAY * 400; i++) state.step();
      if (inflation) {
        expect(state.cost(10_000)).toBe(Math.round(10_000 * 1.03));
        expect(state.inflation.payments).toBeCloseTo(1.025, 6);
        expect(state.maxLoan()).toBeGreaterThan(loan);
        expect(state.maxLoan() % LOAN_STEP).toBe(0);
        const restored = restoreSnapshot(encodeSnapshot(state), { maxPlayers: 15, maxMapSize: 256 });
        expect(restored.inflation).toEqual(state.inflation);
      } else {
        expect(state.cost(10_000)).toBe(cost);
      }
    }
  });
});
