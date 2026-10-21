import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  GameMap,
  GameState,
  Ground,
  HOUSE_TYPES,
  Piece,
  TICKS_PER_DAY,
  TileType,
  climateCargos,
  encodeSnapshot,
  executeCommand,
  isAvailable,
  parseUnits,
  railVehicle,
  restoreSnapshot,
  townNeeds,
  type Climate,
  type Command,
  type GameSettings,
  type Town,
} from '../src/index.ts';

const LIMITS = { maxPlayers: 15, maxMapSize: 2048 };
const TOWNHOUSE = HOUSE_TYPES.findIndex((h) => h.model === 'townhouse');

function settings(climate: Climate, over: Partial<GameSettings> = {}): GameSettings {
  return { ...DEFAULT_SETTINGS, mapWidth: 256, mapHeight: 256, seed: 7, climate, startYear: 1950, breakdowns: false, ...over };
}

/** Share of land tiles in each zone. */
function zones(state: GameState) {
  const map = state.map;
  const n = { normal: 0, snow: 0, desert: 0, rainforest: 0, land: 0 };
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      if (map.type(x, y) === TileType.Water) continue;
      n.land++;
      n[map.zone(x, y)]++;
    }
  }
  return { snow: n.snow / n.land, desert: n.desert / n.land, rainforest: n.rainforest / n.land };
}

/** A flat world of one height with a town of townhouses at (20, 20) and a company with money. */
function townWorld(climate: Climate, height: number, seed = 7) {
  const state = new GameState(settings(climate, { mapWidth: 128, mapHeight: 128, roughness: 'flat', seed }), new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(height);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  const town: Town = { id: 0, name: 'T', x: 20, y: 20, population: 0, houses: 0 };
  state.towns.set(0, town);
  for (let x = 16; x <= 24; x++) {
    for (const y of [20, 21]) {
      const i = map.tileIndex(x, y);
      map.layers.type[i] = TileType.House;
      map.layers.data[i] = TOWNHOUSE;
      map.layers.town[i] = 1;
      town.houses++;
      town.population += HOUSE_TYPES[TOWNHOUSE]!.population;
    }
  }
  const p = state.addPlayer('A', true);
  const c = state.foundCompany(p)!;
  c.money = 1e7;
  const run = (cmd: Command) => {
    const r = executeCommand(state, { playerId: p.id, companyId: c.id }, cmd);
    if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
  };
  const day = () => {
    for (let i = 0; i < TICKS_PER_DAY; i++) state.step();
  };
  return { state, map, town, run, day };
}

describe('climates', () => {
  test('sub-arctic land lies largely under snow, and the sub-tropics have desert and rainforest', () => {
    const temperate = zones(GameState.create(settings('temperate')));
    const arctic = zones(GameState.create(settings('arctic')));
    const tropical = zones(GameState.create(settings('tropical')));
    expect(temperate.snow).toBeLessThan(0.05);
    expect(temperate.desert + temperate.rainforest).toBe(0);
    expect(arctic.snow).toBeGreaterThan(0.15);
    expect(arctic.desert + arctic.rainforest).toBe(0);
    expect(tropical.snow).toBe(0);
    expect(tropical.desert).toBeGreaterThan(0.1);
    expect(tropical.rainforest).toBeGreaterThan(0.05);
  });

  test('snowy sub-arctic land is snow ground, and its forests climb into it', () => {
    const state = GameState.create(settings('arctic'));
    const map = state.map;
    let snow = 0;
    let snowyTrees = 0;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        if (map.type(x, y) !== TileType.Clear || map.zone(x, y) !== 'snow') continue;
        const ground = (map.layers.data[map.tileIndex(x, y)]! >> 3) & 7;
        if (ground === Ground.Snow) snow++;
        if (map.treeCount(x, y) > 0) snowyTrees++;
      }
    }
    expect(snow).toBeGreaterThan(1000);
    expect(snowyTrees).toBeGreaterThan(100);
  });

  test('each climate has its own cargo', () => {
    expect(climateCargos('temperate')).toEqual(['passengers', 'mail', 'coal', 'iron_ore', 'steel', 'wood', 'goods', 'grain', 'livestock', 'food', 'oil', 'stone', 'building_materials', 'chemicals']);
    expect(climateCargos('arctic')).toEqual(['passengers', 'mail', 'coal', 'wood', 'goods', 'grain', 'livestock', 'food', 'oil', 'stone', 'building_materials', 'chemicals', 'paper', 'gold']);
    expect(climateCargos('tropical')).toEqual(['passengers', 'mail', 'wood', 'goods', 'grain', 'food', 'oil', 'stone', 'building_materials', 'chemicals', 'copper_ore', 'rubber', 'fruit', 'water', 'diamonds', 'cotton']);
  });

  test('wagons carry only cargo of the climate, and default to the first they can carry there', () => {
    expect(parseUnits(['badger', 'open_wagon'], 'temperate')).toEqual([{ type: 'badger' }, { type: 'open_wagon' }]);
    expect(parseUnits(['badger', 'open_wagon'], 'tropical')).toEqual([{ type: 'badger' }, { type: 'open_wagon', cargo: 'grain' }]);
    expect(parseUnits(['badger', { type: 'open_wagon', cargo: 'coal' }], 'tropical')).toBe("Open wagon can't carry that");
    expect(parseUnits(['badger', 'stock_car'], 'tropical')).toBe('Cattle wagon has nothing to carry in this climate');
    expect(isAvailable(railVehicle('stock_car')!, 1950, 'era', 'tropical')).toBe(false);
    expect(isAvailable(railVehicle('armoured_van')!, 1900, 'era', 'temperate')).toBe(false);
    expect(isAvailable(railVehicle('armoured_van')!, 1900, 'era', 'arctic')).toBe(true);
    expect(isAvailable(railVehicle('badger')!, 1950, 'era', 'tropical')).toBe(true);
  });

  test('sub-arctic towns above the snow line only grow with food', () => {
    const { state, town, day } = townWorld('arctic', 9);
    expect(state.map.climate.snowLine).toBeLessThanOrEqual(9);
    expect(townNeeds(state.map, town)).toEqual(['food']);
    day();
    expect(town.growthRate).toBe(0);
    town.lastStats = { passengers: 0, mail: 0, goods: 0, food: 40, water: 0 };
    day();
    expect(town.growthRate).toBeGreaterThan(0);

    const low = townWorld('arctic', 2);
    expect(townNeeds(low.state.map, low.town)).toEqual([]);
    low.day();
    expect(low.town.growthRate).toBeGreaterThan(0);
  });

  test('desert towns need food and water, and their stations take water', () => {
    const { state, map, town, run, day } = townWorld('tropical', 2, 1);
    // Put the town's centre in the desert.
    let at: { x: number; y: number } | undefined;
    for (let y = 0; y < map.height && !at; y++) for (let x = 0; x < map.width && !at; x++) if (map.zone(x, y) === 'desert') at = { x, y };
    expect(at).toBeDefined();
    town.x = at!.x;
    town.y = at!.y;
    expect(townNeeds(map, town)).toEqual(['food', 'water']);
    day();
    expect(town.growthRate).toBe(0);
    town.lastStats = { passengers: 0, mail: 0, goods: 0, food: 40, water: 0 };
    day();
    expect(town.growthRate).toBe(0);
    town.lastStats = { passengers: 0, mail: 0, goods: 0, food: 40, water: 40 };
    day();
    expect(town.growthRate).toBeGreaterThan(0);

    // A station beside the houses (540 residents) takes water, but not another climate's gold.
    run({ type: 'buildTrack', pieces: [16, 18, Piece.X, 17, 18, Piece.X, 18, 18, Piece.X, 19, 18, Piece.X] });
    run({ type: 'buildStation', x: 16, y: 18, axis: 0, platforms: 1, length: 4 });
    day();
    const st = [...state.stations.values()][0]!;
    expect(st.accepts).toContain('water');
    expect(st.accepts).toContain('food');
    expect(st.accepts).not.toContain('gold');
  });

  test('the climate is kept in saves', () => {
    const state = GameState.create(settings('tropical', { mapWidth: 128, mapHeight: 128 }));
    const restored = restoreSnapshot(encodeSnapshot(state), LIMITS);
    expect(restored.settings.climate).toBe('tropical');
    expect(restored.map.climate.id).toBe('tropical');
    expect(restored.map.zone(40, 40)).toBe(state.map.zone(40, 40));
  });
});
