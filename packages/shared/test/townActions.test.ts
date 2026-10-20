import { describe, expect, test } from 'bun:test';
import {
  ADVERTS,
  BRIBE_MAX,
  BRIBE_STEP,
  COSTS,
  DEFAULT_SETTINGS,
  Edge,
  EXCLUSIVE_DAYS,
  FUND_DAYS,
  GameMap,
  GameState,
  HOUSE_TYPES,
  OWNER_NONE,
  Piece,
  REPUTATION_START,
  ROAD_E,
  ROAD_W,
  ROAD_WORKS,
  ROAD_WORKS_DAYS,
  ROAD_WORKS_KMH,
  Random,
  STATUE_RATING,
  STATUE_REPUTATION,
  TICKS_PER_DAY,
  TileType,
  encodeSnapshot,
  executeCommand,
  exclusionBarred,
  ratingParts,
  reputationOf,
  restoreSnapshot,
  rsTile,
  townActionsDaily,
  type Command,
  type GameSettings,
  type Town,
  type TownAction,
} from '../src/index.ts';

const OFFICE = HOUSE_TYPES.findIndex((h) => h.model === 'office');

/** A flat map with one town at (40, 40): a street along y = 40 from x = 30 to 50, offices north of it. */
function world(settings: Partial<GameSettings> = {}) {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear: 1960, breakdowns: false, ...settings }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  const town: Town = { id: 0, name: 'Testby', x: 40, y: 40, population: 0, houses: 0 };
  state.towns.set(0, town);
  for (let x = 30; x <= 50; x++) {
    const i = map.tileIndex(x, 40);
    map.layers.type[i] = TileType.Road;
    map.layers.owner[i] = OWNER_NONE;
    map.layers.data[i] = (x > 30 ? ROAD_W : 0) | (x < 50 ? ROAD_E : 0);
    map.layers.town[i] = 1;
    const h = map.tileIndex(x, 39);
    map.layers.type[h] = TileType.House;
    map.layers.owner[h] = OWNER_NONE;
    map.layers.data[h] = OFFICE;
    map.layers.town[h] = 1;
    town.houses++;
    town.population += HOUSE_TYPES[OFFICE]!.population;
  }
  const players = ['A', 'B'].map((n) => {
    const p = state.addPlayer(n, false);
    const c = state.foundCompany(p, `${n} Co`)!;
    c.money = 1e7;
    return { p, c };
  });
  const exec = (who: number, cmd: Command, dry = false) => executeCommand(state, { playerId: players[who]!.p.id, companyId: players[who]!.c.id }, cmd, dry);
  const run = (who: number, cmd: Command) => {
    const r = exec(who, cmd);
    if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
    return r;
  };
  const act = (who: number, action: TownAction) => exec(who, { type: 'townAction', town: 0, action });
  const company = (who: number) => players[who]!.c;
  /** A two-tile rail station for a company, its west end at (x, y). */
  const station = (who: number, x: number, y: number) => {
    run(who, { type: 'buildTrack', pieces: [x, y, Piece.X, x + 1, y, Piece.X] });
    run(who, { type: 'buildStation', x, y, axis: 0, platforms: 1, length: 2 });
    return [...state.stations.values()].at(-1)!;
  };
  return { state, map, town, exec, run, act, company, station };
}

describe('town actions', () => {
  test('advertising raises the rating of the company’s stations nearby for a while', () => {
    const { state, town, act, company, station } = world();
    expect(act(0, 'advertSmall').ok).toBe(false); // no stations yet
    const near = station(0, 38, 43);
    const far = station(0, 70, 43);
    const theirs = station(1, 44, 43);
    const money = company(0).money;
    const r = act(0, 'advertSmall');
    expect(r.ok).toBe(true);
    expect(company(0).money).toBe(money - state.cost(COSTS.advertSmall));
    expect(company(0).finances.at(-1)!.ledger.councils).toBe(-state.cost(COSTS.advertSmall));
    expect(near.advert?.bonus).toBe(ADVERTS.advertSmall.bonus);
    expect(far.advert).toBeUndefined();
    expect(theirs.advert).toBeUndefined();
    const before = ratingParts(near, state.date, town);
    expect(before.advert).toBe(ADVERTS.advertSmall.bonus);
    // A bigger campaign is worth more (still not reaching (70, 43), 33 tiles away); a smaller one
    // doesn't cut a running bigger one short.
    act(0, 'advertLarge');
    expect(near.advert?.bonus).toBe(ADVERTS.advertLarge.bonus);
    expect(far.advert).toBeUndefined();
    act(0, 'advertSmall');
    expect(near.advert?.bonus).toBe(ADVERTS.advertLarge.bonus);
    state.date += 61;
    expect(ratingParts(near, state.date, town).advert).toBe(0);
  });

  test('a statue goes up near the centre, pleases the council and lifts station ratings', () => {
    const { state, map, town, act, company, station } = world();
    const st = station(0, 38, 43);
    expect(act(0, 'statue').ok).toBe(true);
    const tiles = [...map.layers.type.keys()].filter((i) => map.layers.type[i] === TileType.Statue);
    expect(tiles.length).toBe(1);
    const tile = tiles[0]!;
    expect(map.layers.owner[tile]).toBe(company(0).id);
    expect(Math.hypot((tile % map.width) - town.x, Math.floor(tile / map.width) - town.y)).toBeLessThanOrEqual(3);
    expect(town.statues).toEqual([company(0).id]);
    expect(reputationOf(town, company(0).id)).toBe(REPUTATION_START + STATUE_REPUTATION);
    expect(ratingParts(st, state.date, town).statue).toBe(STATUE_RATING);
    const second = act(0, 'statue');
    expect(!second.ok && second.error).toContain('already');
    // The bulldozer leaves it alone; it comes down with the company.
    expect(act(1, 'statue').ok).toBe(true);
    expect(executeCommand(state, { playerId: 1, companyId: company(0).id }, { type: 'clearArea', x0: tile % map.width, y0: Math.floor(tile / map.width), x1: tile % map.width, y1: Math.floor(tile / map.width) }).ok).toBe(false);
    state.dissolveCompany(company(0).id);
    expect(map.layers.type[tile]).toBe(TileType.Clear);
    expect(town.statues).toEqual([company(1).id]);
  });

  test('funding new buildings makes the town grow fast for three months', () => {
    const { state, town, act } = world();
    const growth = () => {
      for (let i = 0; i < TICKS_PER_DAY; i++) state.step();
      return town.growthRate ?? 0;
    };
    const normal = growth();
    expect(act(0, 'fundBuildings').ok).toBe(true);
    expect(town.funded?.until).toBe(state.date + FUND_DAYS);
    expect(growth()).toBeGreaterThan(normal * 10);
    expect(act(1, 'fundBuildings').ok).toBe(false);
    const houses = town.houses;
    for (let d = 0; d < FUND_DAYS; d++) growth();
    expect(town.houses).toBeGreaterThan(houses + 10);
    expect(town.funded).toBeUndefined();
    expect(growth()).toBeLessThan(normal * 2);
  });

  test('exclusive transport rights bar other companies’ stations in the town for a year', () => {
    const { state, town, act, company, station } = world();
    const mine = station(0, 38, 43);
    const theirs = station(1, 44, 43);
    const elsewhere = station(1, 100, 100);
    expect(act(0, 'exclusiveRights').ok).toBe(true);
    expect(town.exclusive).toEqual({ company: company(0).id, until: state.date + EXCLUSIVE_DAYS });
    const barred = exclusionBarred(state);
    expect(barred.has(theirs.id)).toBe(true);
    expect(barred.has(mine.id)).toBe(false);
    expect(barred.has(elsewhere.id)).toBe(false);
    state.cargo.refresh();
    expect(theirs.share).toBe(0);
    expect(state.cargo.share(theirs.id)).toBe(0);
    // Nobody can buy them while they run, and they run out after a year.
    const again = act(1, 'exclusiveRights');
    expect(!again.ok && again.error).toContain('A Co holds exclusive transport rights');
    state.date += EXCLUSIVE_DAYS;
    townActionsDaily(state);
    expect(town.exclusive).toBeUndefined();
    expect(state.news.at(-1)!.text).toContain('run out');
    expect(exclusionBarred(state).size).toBe(0);
  });

  test('road reconstruction digs up the town’s streets for six months, and road vehicles crawl through', () => {
    const { state, map, town, act } = world();
    state.councilRng = new Random(7);
    expect(act(0, 'roadWorks').ok).toBe(true);
    expect(act(1, 'roadWorks').ok).toBe(false);
    const works = () => [...state.roadWorks.keys()].filter((i) => map.layers.data[i]! & ROAD_WORKS).length;
    let most = 0;
    for (let d = 0; d < 60; d++) {
      state.date++;
      townActionsDaily(state);
      most = Math.max(most, works());
    }
    expect(most).toBeGreaterThan(0);
    expect(most).toBeLessThan(15); // a fair part of the 21 streets, not all of them
    for (const i of state.roadWorks.keys()) expect(map.layers.town[i]).toBe(1);
    // Road works survive a save.
    const loaded = restoreSnapshot(encodeSnapshot(state), { maxPlayers: 15, maxMapSize: 256 });
    expect([...loaded.roadWorks]).toEqual([...state.roadWorks]);
    expect(loaded.towns.get(0)!.roadWorks).toEqual(town.roadWorks);
    // When the money runs out the works close one by one.
    state.date += ROAD_WORKS_DAYS;
    townActionsDaily(state);
    expect(town.roadWorks).toBeUndefined();
    for (let d = 0; d < 20; d++) {
      state.date++;
      townActionsDaily(state);
    }
    expect(state.roadWorks.size).toBe(0);
    expect([...map.layers.data].some((v, i) => map.layers.type[i] === TileType.Road && v & ROAD_WORKS)).toBe(false);
  });

  test('a bus slows to a crawl through road works', () => {
    const { state, map, run } = world();
    run(0, { type: 'buildRoad', x0: 50, y0: 40, x1: 90, y1: 40 });
    run(0, { type: 'buildRoadDepot', x: 91, y: 40, exit: Edge.W });
    run(0, { type: 'buildRoadStop', x: 85, y: 40, kind: 'bus' });
    run(0, { type: 'buildRoadStop', x: 32, y: 40, kind: 'bus' });
    for (let x = 55; x <= 75; x++) map.layers.data[map.tileIndex(x, 40)] |= ROAD_WORKS;
    run(0, { type: 'buyTrain', depot: map.tileIndex(91, 40), units: ['city_bus'] as never });
    const bus = [...state.trains.values()].at(-1)!;
    const [a, b] = [...state.stations.keys()];
    run(0, { type: 'setOrders', id: bus.id, orders: [{ kind: 'station', station: a! }, { kind: 'station', station: b! }] });
    run(0, { type: 'trainAction', id: bus.id, action: 'start' });
    let inWorks = 0;
    let outside = 0;
    for (let i = 0; i < TICKS_PER_DAY * 40; i++) {
      state.step();
      if (!bus.path.length) continue;
      const x = rsTile(bus.path[0]!) % map.width;
      if (x >= 56 && x <= 74) inWorks = Math.max(inWorks, bus.speed);
      else if (x > 76 && x < 84) outside = Math.max(outside, bus.speed);
    }
    expect(inWorks).toBeGreaterThan(0);
    expect(inWorks).toBeLessThanOrEqual(ROAD_WORKS_KMH + 0.01);
    expect(outside).toBeGreaterThan(ROAD_WORKS_KMH * 2);
  });

  test('a bribe usually buys reputation, but a caught briber is shunned for six months', () => {
    const { state, town, act, company, station } = world();
    station(0, 38, 43);
    state.councilRng = { next: () => 0.99 } as Random;
    expect(act(0, 'bribe').ok).toBe(true);
    expect(reputationOf(town, company(0).id)).toBe(REPUTATION_START + BRIBE_STEP);
    expect(act(0, 'bribe').ok).toBe(true);
    expect(reputationOf(town, company(0).id)).toBe(BRIBE_MAX);
    expect(act(0, 'bribe').ok).toBe(false);
    // Caught: reputation down to Poor, exclusive rights lost, and no deals for six months.
    town.ratings![company(0).id] = 300;
    act(0, 'exclusiveRights');
    state.councilRng = { next: () => 0 } as Random;
    expect(act(0, 'bribe').ok).toBe(true);
    expect(reputationOf(town, company(0).id)).toBe(-50);
    expect(town.exclusive).toBeUndefined();
    expect(state.news.at(-1)!.text).toContain('Bribery scandal');
    const refused = act(0, 'advertSmall');
    expect(!refused.ok && refused.error).toContain('won’t deal with you');
    expect(act(1, 'fundBuildings').ok).toBe(true); // others are welcome
    state.date += 181;
    townActionsDaily(state);
    expect(town.unwanted).toBeUndefined();
    expect(act(0, 'advertSmall').ok).toBe(true);
  });

  test('bribery can be turned off; viewers and players without a company can’t act', () => {
    const { state, act } = world({ bribery: false });
    const r = act(0, 'bribe');
    expect(!r.ok && r.error).toContain('turned off');
    const loner = state.addPlayer('C', false);
    expect(executeCommand(state, { playerId: loner.id, companyId: null }, { type: 'townAction', town: 0, action: 'fundBuildings' }).ok).toBe(false);
    expect(act(0, 'nonsense' as TownAction).ok).toBe(false);
    expect(executeCommand(state, { playerId: 1, companyId: 0 }, { type: 'townAction', town: 99, action: 'fundBuildings' }).ok).toBe(false);
  });

  test('town actions survive a save', () => {
    const { state, town, act, company, station } = world();
    const st = station(0, 38, 43);
    act(0, 'statue');
    act(0, 'exclusiveRights');
    act(1, 'fundBuildings');
    act(0, 'advertMedium');
    town.unwanted = { [company(1).id]: state.date + 100 };
    const loaded = restoreSnapshot(encodeSnapshot(state), { maxPlayers: 15, maxMapSize: 256 });
    const t = loaded.towns.get(0)!;
    expect(t.statues).toEqual(town.statues);
    expect(t.exclusive).toEqual(town.exclusive);
    expect(t.funded).toEqual(town.funded);
    expect(t.unwanted).toEqual(town.unwanted);
    expect(loaded.stations.get(st.id)!.advert).toEqual(st.advert);
    expect(loaded.settings.bribery).toBe(true);
  });
});
