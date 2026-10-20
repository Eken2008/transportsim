import { COSTS } from '../economy/costs.ts';
import { formatDate } from '../sim/date.ts';
import type { GameState } from '../sim/state.ts';
import { Ground, OWNER_NONE, TileType } from '../world/constants.ts';
import { townRadius } from './growth.ts';
import { AUTHORITY_MARGIN, changeReputation, reputationOf } from './reputation.ts';
import { ROAD_WORKS } from './road.ts';
import type { Town } from './towns.ts';

/**
 * What a company can pay a town council for, as in OpenTTD's local authority window: advertising
 * campaigns, road reconstruction, a statue, new buildings, exclusive transport rights and a bribe.
 */
export const TOWN_ACTIONS = ['advertSmall', 'advertMedium', 'advertLarge', 'roadWorks', 'statue', 'fundBuildings', 'exclusiveRights', 'bribe'] as const;
export type TownAction = (typeof TOWN_ACTIONS)[number];

export const isTownAction = (v: unknown): v is TownAction => TOWN_ACTIONS.includes(v as TownAction);

/** Advertising: the company's stations within `radius` tiles (Manhattan) of the town centre gain `bonus` rating for a while. */
export const ADVERTS = {
  advertSmall: { radius: 10, bonus: 30 },
  advertMedium: { radius: 15, bonus: 50 },
  advertLarge: { radius: 20, bonus: 75 },
} as const satisfies Partial<Record<TownAction, { radius: number; bonus: number }>>;
export const ADVERT_DAYS = 60;
/** Road reconstruction runs this long. */
export const ROAD_WORKS_DAYS = 180;
/** Each day of a reconstruction, the chance that works start on each street tile, and how long they last. */
const WORKS_START = 0.012;
const WORKS_MIN_DAYS = 10;
const WORKS_MAX_DAYS = 18;
/** Funded new buildings: this much more growth per day, for this long. */
export const FUNDED_GROWTH = 1 / 3;
export const FUND_DAYS = 90;
export const EXCLUSIVE_DAYS = 365;
/** Reputation the council grants for a statue. */
export const STATUE_REPUTATION = 150;
/** A bribe raises reputation by this much, but not above BRIBE_MAX (and not at all from there). */
export const BRIBE_STEP = 200;
export const BRIBE_MAX = 800;
/** The chance a bribe is found out, and what happens then. */
export const BRIBE_CAUGHT_CHANCE = 1 / 14;
export const BRIBE_CAUGHT_REPUTATION = -50;
export const UNWANTED_DAYS = 180;
/** How far (tiles) from the town centre a statue may stand. */
const STATUE_REACH = 8;

export const TOWN_ACTION_INFO: Record<TownAction, { name: string; about: string }> = {
  advertSmall: {
    name: 'Small advertising campaign',
    about: `Your stations within ${ADVERTS.advertSmall.radius} tiles of the centre are rated ${ADVERTS.advertSmall.bonus} points higher for ${ADVERT_DAYS} days.`,
  },
  advertMedium: {
    name: 'Medium advertising campaign',
    about: `Your stations within ${ADVERTS.advertMedium.radius} tiles of the centre are rated ${ADVERTS.advertMedium.bonus} points higher for ${ADVERT_DAYS} days.`,
  },
  advertLarge: {
    name: 'Large advertising campaign',
    about: `Your stations within ${ADVERTS.advertLarge.radius} tiles of the centre are rated ${ADVERTS.advertLarge.bonus} points higher for ${ADVERT_DAYS} days.`,
  },
  roadWorks: {
    name: 'Fund road reconstruction',
    about: 'Six months of road works all over the town’s streets. Every company’s buses and trucks crawl through them — your own too.',
  },
  statue: {
    name: 'Build a statue of the company',
    about: 'A statue near the centre. The council thinks better of you, and your stations in the town are rated about 10% higher for good.',
  },
  fundBuildings: {
    name: 'Fund new buildings',
    about: 'Three months of rapid growth: the town builds new houses and bigger buildings every few days.',
  },
  exclusiveRights: {
    name: 'Buy exclusive transport rights',
    about: 'For a year, other companies’ stations in the town get no passengers, mail or cargo. Yours get them all.',
  },
  bribe: {
    name: 'Bribe the council',
    about: `Raises your reputation by ${BRIBE_STEP}, up to Excellent. If it is found out (about 1 in ${Math.round(1 / BRIBE_CAUGHT_CHANCE)}), your reputation drops to Poor and the council won’t deal with you for six months.`,
  },
};

/** What an action costs now. */
export const townActionCost = (state: GameState, action: TownAction): number => state.cost(COSTS[action]);

const active = (e: { until: number } | undefined, date: number) => e !== undefined && e.until > date;
const companyName = (state: GameState, id: number) => state.companies.get(id)?.name ?? 'Another company';

/** The company's stations an advertising campaign of this radius reaches. */
export function advertStations(state: GameState, town: Town, company: number, radius: number) {
  return [...state.stations.values()].filter((st) => st.owner === company && Math.abs(st.x - town.x) + Math.abs(st.y - town.y) <= radius);
}

/** The town's own street tiles (not level crossings, stops or company roads). */
export function townStreets(state: GameState, town: Town): number[] {
  const map = state.map;
  const r = Math.ceil(townRadius(town)) + 2;
  const out: number[] = [];
  for (let y = Math.max(0, town.y - r); y <= Math.min(map.height - 1, town.y + r); y++) {
    for (let x = Math.max(0, town.x - r); x <= Math.min(map.width - 1, town.x + r); x++) {
      const i = map.tileIndex(x, y);
      if (map.layers.type[i] === TileType.Road && map.layers.town[i] === town.id + 1 && map.layers.owner[i] === OWNER_NONE) out.push(i);
    }
  }
  return out;
}

/** Where a statue would go: open, flat, dry land near the centre, beside a street if possible; -1 if there is none. */
export function statueSite(state: GameState, town: Town): number {
  const map = state.map;
  let best = -1;
  let bestScore = Infinity;
  for (let dy = -STATUE_REACH; dy <= STATUE_REACH; dy++) {
    for (let dx = -STATUE_REACH; dx <= STATUE_REACH; dx++) {
      const x = town.x + dx;
      const y = town.y + dy;
      if (!map.inBounds(x, y)) continue;
      const i = map.tileIndex(x, y);
      if (map.layers.type[i] !== TileType.Clear || !map.isFlat(x, y) || map.tileMinHeight(x, y) < 1) continue;
      if (((map.layers.data[i]! >> 3) & 0x7) === Ground.Field) continue;
      const street = [i - 1, i + 1, i - map.width, i + map.width].some((n) => n >= 0 && n < map.layers.type.length && map.layers.type[n] === TileType.Road);
      const score = Math.hypot(dx, dy) + (street ? 0 : 4);
      if (score < bestScore) {
        bestScore = score;
        best = i;
      }
    }
  }
  return best;
}

/** Why the council won't let a company take an action now, or null if it will. */
export function townActionRefusal(state: GameState, town: Town, company: number, action: TownAction): string | null {
  const date = state.date;
  const until = town.unwanted?.[company];
  if (until !== undefined && until > date) return `The ${town.name} council won’t deal with you until ${formatDate(until)}`;
  switch (action) {
    case 'advertSmall':
    case 'advertMedium':
    case 'advertLarge': {
      const { radius } = ADVERTS[action];
      return advertStations(state, town, company, radius).length ? null : `You have no stations within ${radius} tiles of ${town.name}`;
    }
    case 'roadWorks':
      if (active(town.roadWorks, date)) return `The streets of ${town.name} are already being rebuilt (until ${formatDate(town.roadWorks!.until)})`;
      return townStreets(state, town).length ? null : `${town.name} has no streets to rebuild`;
    case 'statue':
      if (town.statues?.includes(company)) return `Your statue already stands in ${town.name}`;
      return statueSite(state, town) >= 0 ? null : `There is no room for a statue near the centre of ${town.name}`;
    case 'fundBuildings':
      return active(town.funded, date) ? `New buildings in ${town.name} are already being funded (until ${formatDate(town.funded!.until)})` : null;
    case 'exclusiveRights': {
      const ex = town.exclusive;
      if (!active(ex, date)) return null;
      return ex!.company === company
        ? `You already hold the rights until ${formatDate(ex!.until)}`
        : `${companyName(state, ex!.company)} holds exclusive transport rights until ${formatDate(ex!.until)}`;
    }
    case 'bribe':
      if (!state.settings.bribery) return 'Bribery is turned off in this game';
      return reputationOf(town, company) >= BRIBE_MAX ? 'The council is already as pleased with you as a bribe can make it' : null;
  }
}

/** Carry out an action (checked with `townActionRefusal`; paid for by the caller). */
export function applyTownAction(state: GameState, town: Town, company: number, action: TownAction, dirtyChunks: Set<number>): void {
  const date = state.date;
  const name = companyName(state, company);
  const news = (text: string) => state.addNews('town', text, { company, tile: state.map.tileIndex(town.x, town.y) });
  switch (action) {
    case 'advertSmall':
    case 'advertMedium':
    case 'advertLarge': {
      const { radius, bonus } = ADVERTS[action];
      for (const st of advertStations(state, town, company, radius)) {
        const running = st.advert && st.advert.until > date ? st.advert.bonus : 0;
        st.advert = { bonus: Math.max(bonus, running), until: date + ADVERT_DAYS };
        state.markStationDirty(st.id);
      }
      break;
    }
    case 'roadWorks':
      town.roadWorks = { company, until: date + ROAD_WORKS_DAYS };
      news(`${name} funds road reconstruction in ${town.name}: six months of misery for motorists!`);
      break;
    case 'statue': {
      const i = statueSite(state, town);
      const map = state.map;
      map.setClear(i, Ground.Grass, 0);
      map.layers.type[i] = TileType.Statue;
      map.layers.owner[i] = company;
      map.layers.town[i] = town.id + 1;
      const x = i % map.width;
      map.touchTile(x, (i - x) / map.width, dirtyChunks);
      (town.statues ??= []).push(company);
      changeReputation(town, company, STATUE_REPUTATION);
      news(`A statue of ${name} is unveiled in ${town.name}`);
      break;
    }
    case 'fundBuildings':
      town.funded = { company, until: date + FUND_DAYS };
      news(`${name} funds new buildings in ${town.name}: the town is set to grow fast`);
      break;
    case 'exclusiveRights':
      town.exclusive = { company, until: date + EXCLUSIVE_DAYS };
      news(`${name} buys exclusive transport rights in ${town.name} for a year! Other companies’ stations there get nothing`);
      break;
    case 'bribe': {
      const now = reputationOf(town, company);
      if (state.councilRng.next() < BRIBE_CAUGHT_CHANCE) {
        changeReputation(town, company, Math.min(0, BRIBE_CAUGHT_REPUTATION - now));
        (town.unwanted ??= {})[company] = date + UNWANTED_DAYS;
        if (town.exclusive?.company === company) delete town.exclusive;
        news(`Bribery scandal! ${name} was caught trying to bribe the ${town.name} council, which won’t deal with it for six months`);
      } else {
        changeReputation(town, company, Math.max(0, Math.min(BRIBE_MAX, now + BRIBE_STEP) - now));
      }
      break;
    }
  }
  state.dirtyTowns.add(town.id);
}

/**
 * Daily: town actions run out; towns whose roads are being rebuilt dig up some of their streets,
 * and road works that are done close.
 */
export function townActionsDaily(state: GameState): void {
  const map = state.map;
  const date = state.date;
  for (const [i, end] of state.roadWorks) {
    if (end > date) continue;
    state.roadWorks.delete(i);
    if (map.layers.type[i] === TileType.Road) map.layers.data[i] = map.layers.data[i]! & ~ROAD_WORKS;
    const x = i % map.width;
    map.touchTile(x, (i - x) / map.width);
  }
  for (const town of state.towns.values()) {
    let changed = false;
    if (town.exclusive && town.exclusive.until <= date) {
      if (state.companies.has(town.exclusive.company)) {
        state.addNews('town', `${companyName(state, town.exclusive.company)}’s exclusive transport rights in ${town.name} have run out`, {
          company: town.exclusive.company,
          tile: map.tileIndex(town.x, town.y),
        });
      }
      delete town.exclusive;
      changed = true;
    }
    if (town.funded && town.funded.until <= date) {
      delete town.funded;
      changed = true;
    }
    if (town.roadWorks && town.roadWorks.until <= date) {
      delete town.roadWorks;
      changed = true;
    }
    if (town.unwanted) {
      for (const [k, until] of Object.entries(town.unwanted)) {
        if (until > date) continue;
        delete town.unwanted[Number(k)];
        changed = true;
      }
      if (Object.keys(town.unwanted).length === 0) delete town.unwanted;
    }
    if (changed) state.dirtyTowns.add(town.id);
    if (!town.roadWorks) continue;
    for (const i of townStreets(state, town)) {
      if (state.roadWorks.has(i) || !state.councilRng.chance(WORKS_START)) continue;
      map.layers.data[i] = map.layers.data[i]! | ROAD_WORKS;
      state.roadWorks.set(i, date + state.councilRng.int(WORKS_MIN_DAYS, WORKS_MAX_DAYS));
      const x = i % map.width;
      map.touchTile(x, (i - x) / map.width);
    }
  }
}

/** Stations that get no new cargo because another company holds exclusive transport rights in their town. */
export function exclusionBarred(state: GameState): Set<number> {
  const out = new Set<number>();
  for (const town of state.towns.values()) {
    const ex = town.exclusive;
    if (!ex || ex.until <= state.date) continue;
    const reach = townRadius(town) + AUTHORITY_MARGIN;
    for (const st of state.stations.values()) {
      if (st.owner !== ex.company && st.townId === town.id && Math.hypot(st.x - town.x, st.y - town.y) <= reach) out.add(st.id);
    }
  }
  return out;
}

/** A company is gone: its statues come down, and its rights and bans lapse. */
export function forgetCompanyInTowns(state: GameState, company: number): void {
  const map = state.map;
  for (const town of state.towns.values()) {
    let changed = false;
    if (town.statues?.includes(company)) {
      town.statues = town.statues.filter((c) => c !== company);
      if (town.statues.length === 0) delete town.statues;
      changed = true;
    }
    if (town.exclusive?.company === company) {
      delete town.exclusive;
      changed = true;
    }
    if (town.unwanted?.[company] !== undefined) {
      delete town.unwanted[company];
      changed = true;
    }
    if (changed) state.dirtyTowns.add(town.id);
  }
  const { type, owner } = map.layers;
  for (let i = 0; i < type.length; i++) {
    if (type[i] !== TileType.Statue || owner[i] !== company) continue;
    map.setClear(i, Ground.Grass, 0);
    const x = i % map.width;
    map.touchTile(x, (i - x) / map.width);
  }
}
