import { describe, expect, test } from 'bun:test';
import { DEFAULT_SETTINGS, trainInfo, type Station, type Train } from '@transportsim/shared';
import { ClientWorld } from '../src/game/clientWorld.ts';
import { PILING_UP, companyProblems, vehicleIssues } from '../src/game/problems.ts';

const DATE = 20000;

function vehicle(id: number, extra: Partial<Train> = {}): Train {
  return {
    id, owner: 0, name: `Train ${id}`, units: [{ type: 'kestrel' }], status: 'running', depot: -1, path: [], pos: 0, speed: 0, orders: [], orderIndex: 0,
    toDepot: false, route: [], routeFor: -1, replanAt: 0, loadTicks: 0, cargo: [], builtDays: DATE - 400, value: 0, profitThisYear: 0, profitLastYear: 100, lastStation: -1, line: 0,
    ...extra,
  };
}

function station(id: number, extra: Partial<Station> = {}): Station {
  return { id, name: `S${id}`, owner: 0, x: 0, y: 0, x0: 0, y0: 0, x1: 0, y1: 0, tiles: 1, townId: null, builtDays: 0, waiting: {}, waitingTotal: 0, rating: 200, ...extra };
}

describe('problem list', () => {
  test('vehicles: lost, losing money, stopped, off a line, too old', () => {
    expect(vehicleIssues(trainInfo(vehicle(1)), DATE)).toEqual([]);
    expect(vehicleIssues(trainInfo(vehicle(1, { lost: true, profitLastYear: -5, status: 'stopped' })), DATE)).toEqual(['lost', 'loss', 'stopped']);
    // A vehicle less than a year old hasn't had a full year to earn.
    expect(vehicleIssues(trainInfo(vehicle(1, { profitLastYear: -5, builtDays: DATE - 100 })), DATE)).toEqual([]);
    // In a depot without a line is fine (just bought); out of it is not.
    expect(vehicleIssues(trainInfo(vehicle(1, { line: undefined, status: 'depot' })), DATE)).toEqual([]);
    expect(vehicleIssues(trainInfo(vehicle(1, { line: undefined })), DATE)).toEqual(['noLine']);
    expect(vehicleIssues(trainInfo(vehicle(1, { builtDays: DATE - 365 * 80 })), DATE)).toEqual(['old']);
  });

  test("a company's problems: its vehicles, falling and crowded stations, empty lines; not other companies'", () => {
    const world = new ClientWorld({ ...DEFAULT_SETTINGS, mapWidth: 64, mapHeight: 64 });
    world.applyTrains([trainInfo(vehicle(1, { lost: true })), trainInfo(vehicle(2, { owner: 1, lost: true }))], [], true);
    world.applyStations([station(1), station(2, { waitingTotal: PILING_UP + 1 }), station(3, { owner: 1, waitingTotal: 5000 })], [], true);
    world.applyLines(
      [
        { id: 0, owner: 0, name: 'Busy', mode: 'rail', color: 0, orders: [] },
        { id: 1, owner: 0, name: 'Empty', mode: 'rail', color: 0, orders: [] },
      ],
      [],
      true,
    );
    // Station 1's rating is heading from 200 down to 120.
    world.applySummary([1, 200, 120, 0]);
    const found = companyProblems(world, 0, DATE).map((p) => `${p.issue}:${p.kind === 'vehicle' ? p.vehicle.id : p.kind === 'station' ? p.station.id : p.line.id}`);
    expect(found.sort()).toEqual(['empty:1', 'falling:1', 'lost:1', 'pilingUp:2']);
  });
});
