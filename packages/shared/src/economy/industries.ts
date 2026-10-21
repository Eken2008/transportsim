import type { Climate } from '../world/climate.ts';
import type { GameMap } from '../world/map.ts';
import { FIELD_CROP_SHIFT, FIELD_CROPS, FIELD_ROWS_Y, Ground, OWNER_NONE, TileType } from '../world/constants.ts';
import { Random } from '../util/random.ts';
import type { Town } from '../town/towns.ts';
import { CARGO_IDS, type CargoId } from './cargo.ts';

export type IndustryModel =
  | 'mine'
  | 'forest'
  | 'farm'
  | 'oilwells'
  | 'mill'
  | 'factory'
  | 'sawmill'
  | 'foodplant'
  | 'refinery'
  | 'power'
  | 'papermill'
  | 'printworks'
  | 'plantation'
  | 'orchard'
  | 'watersupply'
  | 'quarry'
  | 'cementworks'
  | 'chemworks'
  | 'cotton'
  | 'textilemill';

/** Where an industry type may be built: in a climate zone, or outside one. */
export type IndustryZone = 'snow' | 'nosnow' | 'desert' | 'nodesert' | 'rainforest';

export interface IndustryType {
  id: string;
  name: string;
  model: IndustryModel;
  /** Climates it appears in. */
  climates: readonly Climate[];
  /** Footprint in tiles. */
  w: number;
  h: number;
  produces: readonly CargoId[];
  accepts: readonly CargoId[];
  /** Primary industries: units per month of each cargo they produce (at production level 1). */
  production: number;
  /** Relative frequency at world generation. */
  weight: number;
  intro: number;
  /** Must stand in (or out of) this zone. */
  zone?: IndustryZone;
}

const ALL: readonly Climate[] = ['temperate', 'arctic', 'tropical'];
const TEMPERATE: readonly Climate[] = ['temperate'];
const ARCTIC: readonly Climate[] = ['arctic'];
const TROPICAL: readonly Climate[] = ['tropical'];
const NORTHERN: readonly Climate[] = ['temperate', 'arctic'];

export const INDUSTRY_TYPES: readonly IndustryType[] = [
  { id: 'coal_mine', name: 'Coal Mine', model: 'mine', climates: NORTHERN, w: 3, h: 3, produces: ['coal'], accepts: [], production: 1500, weight: 3, intro: 0 },
  { id: 'iron_mine', name: 'Iron Ore Mine', model: 'mine', climates: TEMPERATE, w: 3, h: 3, produces: ['iron_ore'], accepts: [], production: 1300, weight: 2, intro: 0 },
  { id: 'forest', name: 'Forest', model: 'forest', climates: NORTHERN, w: 4, h: 4, produces: ['wood'], accepts: [], production: 1200, weight: 3, intro: 0 },
  { id: 'farm', name: 'Farm', model: 'farm', climates: NORTHERN, w: 4, h: 3, produces: ['grain', 'livestock'], accepts: [], production: 700, weight: 4, intro: 0, zone: 'nosnow' },
  { id: 'oil_wells', name: 'Oil Wells', model: 'oilwells', climates: ALL, w: 3, h: 3, produces: ['oil'], accepts: [], production: 1100, weight: 2, intro: 1880 },
  { id: 'steel_mill', name: 'Steel Mill', model: 'mill', climates: TEMPERATE, w: 4, h: 3, produces: ['steel'], accepts: ['iron_ore', 'coal'], production: 0, weight: 1.5, intro: 0 },
  { id: 'factory', name: 'Factory', model: 'factory', climates: TEMPERATE, w: 3, h: 3, produces: ['goods'], accepts: ['steel', 'chemicals'], production: 0, weight: 1.5, intro: 0 },
  { id: 'sawmill', name: 'Sawmill', model: 'sawmill', climates: TEMPERATE, w: 3, h: 2, produces: ['goods'], accepts: ['wood'], production: 0, weight: 1.5, intro: 0 },
  { id: 'food_plant', name: 'Food Processing Plant', model: 'foodplant', climates: NORTHERN, w: 3, h: 3, produces: ['food'], accepts: ['grain', 'livestock'], production: 0, weight: 1.5, intro: 0 },
  { id: 'refinery', name: 'Oil Refinery', model: 'refinery', climates: ALL, w: 4, h: 4, produces: ['goods'], accepts: ['oil'], production: 0, weight: 1, intro: 1880 },
  { id: 'power_station', name: 'Power Station', model: 'power', climates: NORTHERN, w: 3, h: 3, produces: [], accepts: ['coal'], production: 0, weight: 2, intro: 0 },
  // All climates
  { id: 'quarry', name: 'Quarry', model: 'quarry', climates: ALL, w: 3, h: 3, produces: ['stone'], accepts: [], production: 1400, weight: 2, intro: 0 },
  { id: 'cement_works', name: 'Cement Works', model: 'cementworks', climates: ALL, w: 4, h: 3, produces: ['building_materials'], accepts: ['stone'], production: 0, weight: 1.5, intro: 0 },
  { id: 'chemical_works', name: 'Chemical Works', model: 'chemworks', climates: ALL, w: 3, h: 3, produces: ['chemicals'], accepts: ['oil'], production: 0, weight: 1, intro: 1880 },
  // Sub-arctic
  { id: 'gold_mine', name: 'Gold Mine', model: 'mine', climates: ARCTIC, w: 3, h: 3, produces: ['gold'], accepts: [], production: 320, weight: 1.5, intro: 0, zone: 'snow' },
  { id: 'paper_mill', name: 'Paper Mill', model: 'papermill', climates: ARCTIC, w: 4, h: 3, produces: ['paper'], accepts: ['wood', 'chemicals'], production: 0, weight: 1.5, intro: 0 },
  { id: 'printing_works', name: 'Printing Works', model: 'printworks', climates: ARCTIC, w: 3, h: 3, produces: ['goods'], accepts: ['paper'], production: 0, weight: 1.5, intro: 0 },
  // Sub-tropical
  { id: 'copper_mine', name: 'Copper Ore Mine', model: 'mine', climates: TROPICAL, w: 3, h: 3, produces: ['copper_ore'], accepts: [], production: 1300, weight: 2.5, intro: 0 },
  { id: 'diamond_mine', name: 'Diamond Mine', model: 'mine', climates: TROPICAL, w: 3, h: 3, produces: ['diamonds'], accepts: [], production: 280, weight: 1.5, intro: 0 },
  { id: 'lumber_camp', name: 'Lumber Camp', model: 'forest', climates: TROPICAL, w: 4, h: 4, produces: ['wood'], accepts: [], production: 1200, weight: 2.5, intro: 0, zone: 'rainforest' },
  { id: 'rubber_plantation', name: 'Rubber Plantation', model: 'plantation', climates: TROPICAL, w: 4, h: 3, produces: ['rubber'], accepts: [], production: 1000, weight: 2, intro: 0, zone: 'rainforest' },
  { id: 'fruit_plantation', name: 'Fruit Plantation', model: 'orchard', climates: TROPICAL, w: 4, h: 3, produces: ['fruit'], accepts: [], production: 750, weight: 2.5, intro: 0, zone: 'nodesert' },
  { id: 'maize_farm', name: 'Maize Farm', model: 'farm', climates: TROPICAL, w: 4, h: 3, produces: ['grain'], accepts: [], production: 1100, weight: 2.5, intro: 0, zone: 'nodesert' },
  { id: 'water_supply', name: 'Water Supply', model: 'watersupply', climates: TROPICAL, w: 2, h: 2, produces: ['water'], accepts: [], production: 1200, weight: 2.5, intro: 0, zone: 'desert' },
  { id: 'tropic_food_plant', name: 'Food Processing Plant', model: 'foodplant', climates: TROPICAL, w: 3, h: 3, produces: ['food'], accepts: ['fruit', 'grain'], production: 0, weight: 2, intro: 0 },
  { id: 'cotton_plantation', name: 'Cotton Plantation', model: 'cotton', climates: TROPICAL, w: 4, h: 3, produces: ['cotton'], accepts: [], production: 900, weight: 2, intro: 0, zone: 'nodesert' },
  { id: 'textile_mill', name: 'Textile Mill', model: 'textilemill', climates: TROPICAL, w: 3, h: 3, produces: ['goods'], accepts: ['cotton', 'chemicals'], production: 0, weight: 1.5, intro: 0 },
  { id: 'tropic_factory', name: 'Factory', model: 'factory', climates: TROPICAL, w: 3, h: 3, produces: ['goods'], accepts: ['rubber', 'copper_ore', 'wood'], production: 0, weight: 1.5, intro: 0 },
];

const BY_ID = new Map(INDUSTRY_TYPES.map((t) => [t.id, t]));
export const industryType = (id: string): IndustryType | undefined => BY_ID.get(id);

const CLIMATE_CARGOS = new Map<Climate, readonly CargoId[]>(
  (['temperate', 'arctic', 'tropical'] as const).map((climate) => {
    const types = INDUSTRY_TYPES.filter((t) => t.climates.includes(climate));
    return [climate, CARGO_IDS.filter((c) => c === 'passengers' || c === 'mail' || types.some((t) => t.produces.includes(c) || t.accepts.includes(c)))];
  }),
);

/** The cargo of a climate: passengers, mail and whatever its industries make or take. */
export const climateCargos = (climate: Climate): readonly CargoId[] => CLIMATE_CARGOS.get(climate)!;

export type CargoAmounts = Partial<Record<CargoId, number>>;

export interface Industry {
  id: number;
  type: string;
  name: string;
  /** North-west corner and size. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Production level (primary industries scale their production by it). */
  level: number;
  /** Delivered input waiting to be processed (secondary industries). */
  input: CargoAmounts;
  /** This month so far, and last month: produced, moved to stations, and delivered here. */
  produced: CargoAmounts;
  transported: CargoAmounts;
  delivered: CargoAmounts;
  lastProduced: CargoAmounts;
  lastTransported: CargoAmounts;
  lastDelivered: CargoAmounts;
  /** Months in a row nobody took cargo from it or brought cargo to it. */
  idleMonths?: number;
}

/** Fraction of last month's production that reached stations, 0..1. */
export function transportedShare(ind: Industry, cargo: CargoId): number {
  const p = ind.lastProduced[cargo] ?? 0;
  return p > 0 ? Math.min(1, (ind.lastTransported[cargo] ?? 0) / p) : 0;
}

/** Land tiles per industry at world generation. */
const TILES_PER_INDUSTRY = 1000;
const MIN_TOWN_DISTANCE = 7;
const MIN_INDUSTRY_SPACING = 5;

/** Can an industry of this size stand here: clear, flat, level land away from towns and other industries? */
export function industryFits(map: GameMap, x: number, y: number, w: number, h: number, towns: readonly Town[], others: readonly Industry[]): boolean {
  if (x < 2 || y < 2 || x + w > map.width - 2 || y + h > map.height - 2) return false;
  const level = map.cornerHeight(x, y);
  if (level < 1) return false;
  for (let ty = y; ty < y + h; ty++) {
    for (let tx = x; tx < x + w; tx++) {
      if (map.type(tx, ty) !== TileType.Clear || !map.isFlat(tx, ty) || map.cornerHeight(tx, ty) !== level) return false;
    }
  }
  for (const t of towns) {
    if (Math.max(Math.abs(t.x - (x + w / 2)), Math.abs(t.y - (y + h / 2))) < MIN_TOWN_DISTANCE + Math.max(w, h)) return false;
  }
  for (const o of others) {
    if (x < o.x + o.w + MIN_INDUSTRY_SPACING && o.x < x + w + MIN_INDUSTRY_SPACING && y < o.y + o.h + MIN_INDUSTRY_SPACING && o.y < y + h + MIN_INDUSTRY_SPACING) return false;
  }
  return true;
}

/** Name from the nearest town, unique among the given industries. */
export function industryName(type: IndustryType, x: number, y: number, towns: readonly Town[], others: readonly Industry[]): string {
  let best: Town | undefined;
  let bestD = Infinity;
  for (const t of towns) {
    const d = Math.abs(t.x - x) + Math.abs(t.y - y);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  const base = `${best?.name ?? 'Valley'} ${type.name}`;
  const used = new Set(others.map((o) => o.name));
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
}

export function newIndustry(id: number, type: IndustryType, x: number, y: number, name: string): Industry {
  return {
    id,
    type: type.id,
    name,
    x,
    y,
    w: type.w,
    h: type.h,
    level: 1,
    input: {},
    produced: {},
    transported: {},
    delivered: {},
    lastProduced: {},
    lastTransported: {},
    lastDelivered: {},
  };
}

/** Mark an industry's tiles on the map. */
export function placeIndustry(map: GameMap, ind: Industry): void {
  for (let ty = ind.y; ty < ind.y + ind.h; ty++) {
    for (let tx = ind.x; tx < ind.x + ind.w; tx++) {
      const i = map.tileIndex(tx, ty);
      map.layers.type[i] = TileType.Industry;
      map.layers.owner[i] = OWNER_NONE;
      map.layers.data[i] = ind.id;
      map.layers.track[i] = 0;
      map.layers.town[i] = 0;
      map.touchTile(tx, ty);
    }
  }
}

/**
 * Lay out a farm's fields: a few large rectangles of one crop each on open land around the
 * farmstead. Fields stay ordinary clear land, so building over them is free.
 */
export function plantFarmFields(map: GameMap, ind: Industry, rng: Random): void {
  const count = rng.int(4, 6);
  for (let f = 0; f < count; f++) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const fw = rng.int(5, 10);
      const fh = rng.int(4, 8);
      const fx = ind.x + rng.int(-fw - 5, ind.w + 5);
      const fy = ind.y + rng.int(-fh - 5, ind.h + 5);
      const tiles: number[] = [];
      for (let ty = fy; ty < fy + fh; ty++) {
        for (let tx = fx; tx < fx + fw; tx++) {
          if (tx < 1 || ty < 1 || tx >= map.width - 1 || ty >= map.height - 1) continue;
          const i = map.tileIndex(tx, ty);
          if (map.layers.type[i] !== TileType.Clear) continue;
          const ground = (map.layers.data[i]! >> 3) & 7;
          if (ground !== Ground.Grass && ground !== Ground.Rough) continue;
          if (map.zone(tx, ty) === 'desert') continue;
          if (map.tileMaxHeight(tx, ty) - map.tileMinHeight(tx, ty) > 1) continue;
          tiles.push(i);
        }
      }
      // Mostly open land, or try somewhere else.
      if (tiles.length < fw * fh * 0.6) continue;
      const crop = rng.int(0, FIELD_CROPS - 1);
      const rows = rng.chance(0.5) ? FIELD_ROWS_Y : 0;
      for (const i of tiles) {
        map.setClear(i, Ground.Field, 0);
        map.layers.data[i] = map.layers.data[i]! | (crop << FIELD_CROP_SHIFT) | rows;
        const x = i % map.width;
        map.touchTile(x, (i - x) / map.width);
      }
      break;
    }
  }
}

/** Remove an industry's tiles (closure), leaving rough land. */
export function clearIndustry(map: GameMap, ind: Industry): void {
  for (let ty = ind.y; ty < ind.y + ind.h; ty++) {
    for (let tx = ind.x; tx < ind.x + ind.w; tx++) {
      const i = map.tileIndex(tx, ty);
      if (map.layers.type[i] === TileType.Industry && map.layers.data[i] === ind.id) map.setClear(i, Ground.Rough, 0);
      map.touchTile(tx, ty);
    }
  }
}

/** Industry types of a climate that can appear in a given year. */
export const typesFor = (year: number, climate: Climate) => INDUSTRY_TYPES.filter((t) => t.intro <= year && t.climates.includes(climate));

/** Pick a type by weight, optionally only among those passing `allow`. */
export function pickIndustryType(rng: Random, year: number, climate: Climate, allow: (t: IndustryType) => boolean = () => true): IndustryType {
  const types = typesFor(year, climate).filter(allow);
  const total = types.reduce((s, t) => s + t.weight, 0);
  let r = rng.next() * total;
  for (const t of types) {
    r -= t.weight;
    if (r <= 0) return t;
  }
  return types[types.length - 1]!;
}

/** Is the land at (x, y) in the zone this type needs? */
export function zoneFits(map: GameMap, type: IndustryType, x: number, y: number): boolean {
  if (!type.zone) return true;
  const zone = map.zone(x + (type.w >> 1), y + (type.h >> 1));
  switch (type.zone) {
    case 'snow':
    case 'desert':
    case 'rainforest':
      return zone === type.zone;
    case 'nosnow':
      return zone !== 'snow';
    case 'nodesert':
      return zone !== 'desert';
  }
}

/**
 * Place industries for a new world, roughly one per TILES_PER_INDUSTRY land tiles. Every
 * type of the map's climate appears at least once where possible, so all chains exist.
 */
export function generateIndustries(map: GameMap, towns: readonly Town[], seed: number, year: number): Industry[] {
  const rng = new Random(seed ^ 0x1d057e);
  const climate = map.climate.id;
  let land = 0;
  for (const t of map.layers.type) if (t !== TileType.Water) land++;
  const target = Math.max(typesFor(year, climate).length, Math.round(land / TILES_PER_INDUSTRY));
  const out: Industry[] = [];
  const queue = [...typesFor(year, climate)];
  let tries = 0;
  for (let attempt = 0; attempt < target * 60 && out.length < target; attempt++) {
    // Give up on placing a type first after a while (its zone may be missing from the map).
    if (queue.length && ++tries > 400) {
      queue.shift();
      tries = 0;
    }
    const type = queue.length ? queue[0]! : pickIndustryType(rng, year, climate);
    const x = rng.int(2, map.width - type.w - 2);
    const y = rng.int(2, map.height - type.h - 2);
    if (!industryFits(map, x, y, type.w, type.h, towns, out) || !zoneFits(map, type, x, y)) continue;
    if (queue.length) {
      queue.shift();
      tries = 0;
    }
    const ind = newIndustry(out.length, type, x, y, industryName(type, x, y, towns, out));
    placeIndustry(map, ind);
    if (type.model === 'farm') plantFarmFields(map, ind, rng);
    out.push(ind);
  }
  return out;
}
