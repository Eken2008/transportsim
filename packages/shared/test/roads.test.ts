import { describe, expect, test } from 'bun:test';
import {
  CROSSING_FLAG,
  DEFAULT_SETTINGS,
  Edge,
  GameMap,
  GameState,
  OWNER_NONE,
  Piece,
  ROADSTOP_TRUCK,
  ROAD_E,
  ROAD_N,
  ROAD_ONE_WAY,
  ROAD_ONE_WAY_REVERSED,
  ROAD_S,
  ROAD_W,
  TileType,
  executeCommand,
  oneWayAllows,
  stationHas,
  type Command,
} from '../src/index.ts';

function world() {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear: 1950 }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  const players = ['A', 'B'].map((n) => {
    const p = state.addPlayer(n, false);
    const c = state.foundCompany(p, `${n} Co`)!;
    c.money = 1e7;
    return { p, c };
  });
  const exec = (who: number, cmd: Command) => executeCommand(state, { playerId: players[who]!.p.id, companyId: players[who]!.c.id }, cmd);
  const run = (who: number, cmd: Command) => {
    const r = exec(who, cmd);
    if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
    return r;
  };
  const tile = (x: number, y: number) => map.tileIndex(x, y);
  return { state, map, exec, run, tile };
}

describe('roads', () => {
  test('a dragged road connects its tiles and belongs to the company', () => {
    const { map, run, tile, exec } = world();
    run(0, { type: 'buildRoad', x0: 10, y0: 10, x1: 14, y1: 10 });
    expect(map.layers.type[tile(10, 10)]).toBe(TileType.Road);
    expect(map.layers.data[tile(10, 10)]! & 0xf).toBe(ROAD_E);
    expect(map.layers.data[tile(12, 10)]! & 0xf).toBe(ROAD_E | ROAD_W);
    expect(map.layers.data[tile(14, 10)]! & 0xf).toBe(ROAD_W);
    expect(map.layers.owner[tile(12, 10)]).toBe(0);
    expect(exec(0, { type: 'buildRoad', x0: 10, y0: 10, x1: 14, y1: 10 }).ok).toBe(false); // already built
    expect(exec(0, { type: 'buildRoad', x0: 10, y0: 10, x1: 14, y1: 12 }).ok).toBe(false); // not straight
    // A branch off the middle makes a junction
    run(0, { type: 'buildRoad', x0: 12, y0: 10, x1: 12, y1: 13 });
    expect(map.layers.data[tile(12, 10)]! & 0xf).toBe(ROAD_E | ROAD_W | ROAD_S);
  });

  test('roads cross your own railway as level crossings, not other companies', () => {
    const { map, run, exec, tile } = world();
    run(0, { type: 'buildTrack', pieces: [20, 5, Piece.X, 21, 5, Piece.X, 22, 5, Piece.X] });
    run(1, { type: 'buildTrack', pieces: [30, 5, Piece.X, 31, 5, Piece.X] });
    run(0, { type: 'buildRoad', x0: 21, y0: 3, x1: 21, y1: 7 });
    expect(map.layers.type[tile(21, 5)]).toBe(TileType.Rail);
    expect(map.layers.data[tile(21, 5)]! & CROSSING_FLAG).toBeTruthy();
    expect(map.layers.data[tile(21, 5)]! & 0xf).toBe(ROAD_N | ROAD_S);
    expect(exec(0, { type: 'buildRoad', x0: 30, y0: 3, x1: 30, y1: 7 })).toMatchObject({ ok: false, error: expect.stringContaining('own railway') });
    // Removing the road through the crossing leaves plain track
    run(0, { type: 'removeRoad', x0: 21, y0: 4, x1: 21, y1: 6 });
    expect(map.layers.data[tile(21, 5)]! & (CROSSING_FLAG | 0xf)).toBe(0);
    expect(map.layers.track[tile(21, 5)]).toBe(1 << Piece.X);
  });

  test('only own roads can be removed or made one-way', () => {
    const { state, map, run, exec, tile } = world();
    // A town street
    const t = tile(40, 40);
    map.layers.type[t] = TileType.Road;
    map.layers.data[t] = ROAD_E | ROAD_W;
    map.layers.town[t] = 1;
    expect(exec(0, { type: 'setOneWay', x: 40, y: 40 }).ok).toBe(false);
    run(0, { type: 'buildRoad', x0: 50, y0: 40, x1: 55, y1: 40 });
    expect(exec(1, { type: 'removeRoad', x0: 50, y0: 40, x1: 52, y1: 40 }).ok).toBe(false);
    run(0, { type: 'setOneWay', x: 52, y: 40 });
    expect(map.layers.data[tile(52, 40)]! & ROAD_ONE_WAY).toBeTruthy();
    expect(oneWayAllows(map.layers.data[tile(52, 40)]!, Edge.E)).toBe(true);
    expect(oneWayAllows(map.layers.data[tile(52, 40)]!, Edge.W)).toBe(false);
    run(0, { type: 'setOneWay', x: 52, y: 40 });
    expect(map.layers.data[tile(52, 40)]! & ROAD_ONE_WAY_REVERSED).toBeTruthy();
    expect(oneWayAllows(map.layers.data[tile(52, 40)]!, Edge.W)).toBe(true);
    run(0, { type: 'setOneWay', x: 52, y: 40 });
    expect(map.layers.data[tile(52, 40)]! & (ROAD_ONE_WAY | ROAD_ONE_WAY_REVERSED)).toBe(0);
    // Removing the middle splits the road; tiles with nothing left become land
    run(0, { type: 'removeRoad', x0: 50, y0: 40, x1: 51, y1: 40 });
    expect(map.layers.type[tile(50, 40)]).toBe(TileType.Clear);
    expect(map.layers.data[tile(51, 40)]! & 0xf).toBe(ROAD_E);
    expect(state.roadVersion).toBeGreaterThan(0);
  });

  test('road depots connect to the road; stops join stations and revert when bulldozed', () => {
    const { state, map, run, exec, tile } = world();
    run(0, { type: 'buildRoad', x0: 60, y0: 20, x1: 60, y1: 26 });
    run(0, { type: 'buildRoadDepot', x: 61, y: 22, exit: Edge.W });
    expect(map.layers.type[tile(61, 22)]).toBe(TileType.RoadDepot);
    expect(map.layers.data[tile(60, 22)]! & ROAD_E).toBeTruthy();
    expect(state.roadDepots.has(tile(61, 22))).toBe(true);
    // Stops need straight road; the depot made (60, 22) a junction
    expect(exec(0, { type: 'buildRoadStop', x: 60, y: 22, kind: 'bus' }).ok).toBe(false);
    // A town street next to a rail station of ours: the stop joins that station
    run(0, { type: 'buildTrack', pieces: [70, 30, Piece.X, 71, 30, Piece.X, 72, 30, Piece.X] });
    run(0, { type: 'buildStation', x: 70, y: 30, axis: 0, platforms: 1, length: 3 });
    const street = tile(71, 31);
    map.layers.type[street] = TileType.Road;
    map.layers.data[street] = ROAD_E | ROAD_W;
    map.layers.town[street] = 1;
    run(0, { type: 'buildRoadStop', x: 71, y: 31, kind: 'truck' });
    const st = state.stations.get(0)!;
    expect(map.layers.type[street]).toBe(TileType.RoadStop);
    expect(map.layers.data[street]).toBe(st.id);
    expect(map.layers.track[street]! & ROADSTOP_TRUCK).toBeTruthy();
    expect(st.tiles).toBe(4);
    expect(stationHas(map, st, 'rail')).toBe(true);
    expect(stationHas(map, st, 'truck')).toBe(true);
    expect(stationHas(map, st, 'bus')).toBe(false);
    // A stop on its own makes a new station; bulldozing gives the town its street back
    run(0, { type: 'buildRoadStop', x: 60, y: 25, kind: 'bus' });
    expect(state.stations.size).toBe(2);
    run(0, { type: 'clearArea', x0: 71, y0: 31, x1: 71, y1: 31 });
    expect(map.layers.type[street]).toBe(TileType.Road);
    expect(map.layers.owner[street]).toBe(OWNER_NONE);
    expect(map.layers.data[street]! & 0xf).toBe(ROAD_E | ROAD_W);
    expect(st.tiles).toBe(3);
    run(0, { type: 'clearArea', x0: 60, y0: 25, x1: 60, y1: 25 });
    expect(state.stations.size).toBe(1);
    run(0, { type: 'clearArea', x0: 61, y0: 22, x1: 61, y1: 22 });
    expect(state.roadDepots.size).toBe(0);
  });

  test('stops go on road that climbs a slope, with or without a ramp foundation', () => {
    const { map, run, exec, tile } = world();
    // A hill a level up east of x = 81: tile (80, y) climbs west→east as it is.
    for (let y = 40; y <= 60; y++) for (let x = 81; x <= 86; x++) map.heights[map.cornerIndex(x, y)] = 3;
    run(0, { type: 'buildRoad', x0: 78, y0: 50, x1: 83, y1: 50 });
    expect(map.isFlat(80, 50)).toBe(false);
    run(0, { type: 'buildRoadStop', x: 80, y: 50, kind: 'bus' });
    expect(map.layers.type[tile(80, 50)]).toBe(TileType.RoadStop);
    // One raised corner: the road climbs on a ramp foundation, and a stop can go there too.
    map.heights[map.cornerIndex(91, 70)] = 3;
    run(0, { type: 'buildRoad', x0: 88, y0: 70, x1: 93, y1: 70 });
    expect(map.layers.foundation[tile(90, 70)]).not.toBe(0);
    run(0, { type: 'buildRoadStop', x: 90, y: 70, kind: 'truck' });
    expect(map.layers.type[tile(90, 70)]).toBe(TileType.RoadStop);
    // Still not on a one-way road.
    run(0, { type: 'setOneWay', x: 82, y: 50 });
    expect(exec(0, { type: 'buildRoadStop', x: 82, y: 50, kind: 'bus' }).ok).toBe(false);
  });
});
