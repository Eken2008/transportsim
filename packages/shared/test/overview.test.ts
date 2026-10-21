import { describe, expect, test } from 'bun:test';
import {
  CARGO_IDS,
  GameMap,
  OWNER_NONE,
  OverviewKind,
  TICKS_PER_DAY,
  applyOverviewPatch,
  buildOverview,
  chunkCells,
  emptyOverview,
  overviewBand,
  overviewKind,
  overviewPatch,
  rle,
  unrle,
  updateOverview,
  type Order,
} from '../src/index.ts';
import { loop } from './loop.ts';

describe('map overview', () => {
  test('shows track, stations and depots in their owner’s name, and land by height', () => {
    const { state, map, company } = loop();
    const ov = buildOverview(map);
    expect(ov.scale).toBe(1);
    const at = (x: number, y: number) => ({ kind: overviewKind(ov.cells[y * ov.w + x]!), band: overviewBand(ov.cells[y * ov.w + x]!), owner: ov.owners[y * ov.w + x] });
    expect(at(20, 10)).toEqual({ kind: OverviewKind.Rail, band: 0, owner: company.id });
    expect(at(15, 10).kind).toBe(OverviewKind.Station);
    expect(at(24, 8).kind).toBe(OverviewKind.Rail);
    expect(at(60, 60)).toEqual({ kind: OverviewKind.Land, band: 0, owner: OWNER_NONE });
    // Raising land and removing track show up once the area is brought up to date.
    for (let y = 60; y <= 61; y++) for (let x = 60; x <= 61; x++) map.heights[y * (map.width + 1) + x] = 9;
    expect(updateOverview(map, ov, 60, 60, 61, 61)).toBe(true);
    expect(at(60, 60).band).toBe(3);
    expect(updateOverview(map, ov, 60, 60, 61, 61)).toBe(false);
    void state;
  });

  test('large maps put several tiles in a cell, built things showing over the land', () => {
    const map = new GameMap(2048, 1024);
    const ov = emptyOverview(map);
    expect([ov.scale, ov.w, ov.h]).toEqual([4, 512, 256]);
    map.layers.type[map.tileIndex(401, 402)] = 2; // a rail tile in cell (100, 100)
    map.layers.owner[map.tileIndex(401, 402)] = 3;
    updateOverview(map, ov, 0, 0, 2048, 1024);
    expect(overviewKind(ov.cells[100 * ov.w + 100]!)).toBe(OverviewKind.Rail);
    expect(ov.owners[100 * ov.w + 100]).toBe(3);
    expect(overviewKind(ov.cells[100 * ov.w + 101]!)).toBe(OverviewKind.Land);
    expect(chunkCells(ov, 6, 1)).toEqual([96, 16, 16, 16]);
  });

  test('patches and run-length encoding round-trip', () => {
    const { map } = loop();
    const ov = buildOverview(map);
    const copy = emptyOverview(map);
    const [x, y, w, h] = [8, 4, 40, 30];
    const p = overviewPatch(ov, x, y, w, h);
    const packed = rle(p.cells);
    expect(packed.length).toBeLessThan(p.cells.length);
    applyOverviewPatch(copy, x, y, w, h, unrle(packed, w * h), unrle(rle(p.owners), w * h));
    expect(overviewPatch(copy, x, y, w, h)).toEqual(p);
    const long = new Uint8Array(1000).fill(7);
    expect(unrle(rle(long), 1000)).toEqual(long);
  });

  test('cargo moved along each link is counted for the month', () => {
    const { state, run, buy, top, bottom } = loop();
    const t = buy();
    const orders: Order[] = [{ kind: 'station', station: top }, { kind: 'station', station: bottom }];
    run({ type: 'setOrders', id: t.id, orders });
    run({ type: 'trainAction', id: t.id, action: 'start' });
    state.cargo.packetsAt(top).push({ cargo: 'passengers', dest: bottom, src: top, n: 40, day: state.date });
    for (let i = 0; i < TICKS_PER_DAY * 70 && state.cargo.lastFlows.length === 0; i++) state.step();
    const flows = state.cargo.lastFlows;
    const k = flows.findIndex((_, i) => i % 4 === 0 && flows[i] === top && flows[i + 1] === bottom && CARGO_IDS[flows[i + 2]!] === 'passengers');
    expect(k).toBeGreaterThanOrEqual(0);
    expect(flows[k + 3]).toBeGreaterThan(0);
  });
});
