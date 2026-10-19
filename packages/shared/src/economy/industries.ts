import type { GameMap } from '../world/map.ts';
import { Ground, OWNER_NONE, TileType } from '../world/constants.ts';
import { Random } from '../util/random.ts';
import type { Town } from '../town/towns.ts';
import type { CargoId } from './cargo.ts';

export type IndustryModel = 'mine' | 'forest' | 'farm' | 'oilwells' | 'mill' | 'factory' | 'sawmill' | 'foodplant' | 'refinery' | 'power';

export interface IndustryType {
  id: string;
  name: string;
  model: IndustryModel;
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
}

export const INDUSTRY_TYPES: readonly IndustryType[] = [
  { id: 'coal_mine', name: 'Coal Mine', model: 'mine', w: 3, h: 3, produces: ['coal'], accepts: [], production: 150, weight: 3, intro: 0 },
  { id: 'iron_mine', name: 'Iron Ore Mine', model: 'mine', w: 3, h: 3, produces: ['iron_ore'], accepts: [], production: 130, weight: 2, intro: 0 },
  { id: 'forest', name: 'Forest', model: 'forest', w: 4, h: 4, produces: ['wood'], accepts: [], production: 120, weight: 3, intro: 0 },
  { id: 'farm', name: 'Farm', model: 'farm', w: 4, h: 3, produces: ['grain', 'livestock'], accepts: [], production: 70, weight: 4, intro: 0 },
  { id: 'oil_wells', name: 'Oil Wells', model: 'oilwells', w: 3, h: 3, produces: ['oil'], accepts: [], production: 110, weight: 2, intro: 1880 },
  { id: 'steel_mill', name: 'Steel Mill', model: 'mill', w: 4, h: 3, produces: ['steel'], accepts: ['iron_ore', 'coal'], production: 0, weight: 1.5, intro: 0 },
  { id: 'factory', name: 'Factory', model: 'factory', w: 3, h: 3, produces: ['goods'], accepts: ['steel'], production: 0, weight: 1.5, intro: 0 },
  { id: 'sawmill', name: 'Sawmill', model: 'sawmill', w: 3, h: 2, produces: ['goods'], accepts: ['wood'], production: 0, weight: 1.5, intro: 0 },
  { id: 'food_plant', name: 'Food Processing Plant', model: 'foodplant', w: 3, h: 3, produces: ['food'], accepts: ['grain', 'livestock'], production: 0, weight: 1.5, intro: 0 },
  { id: 'refinery', name: 'Oil Refinery', model: 'refinery', w: 4, h: 4, produces: ['goods'], accepts: ['oil'], production: 0, weight: 1, intro: 1880 },
  { id: 'power_station', name: 'Power Station', model: 'power', w: 3, h: 3, produces: [], accepts: ['coal'], production: 0, weight: 2, intro: 0 },
];

const BY_ID = new Map(INDUSTRY_TYPES.map((t) => [t.id, t]));
export const industryType = (id: string): IndustryType | undefined => BY_ID.get(id);

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
}

/** Fraction of last month's production that reached stations, 0..1. */
export function transportedShare(ind: Industry, cargo: CargoId): number {
  const p = ind.lastProduced[cargo] ?? 0;
  return p > 0 ? Math.min(1, (ind.lastTransported[cargo] ?? 0) / p) : 0;
}

/** Land tiles per industry at world generation. */
const TILES_PER_INDUSTRY = 2600;
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

/** Industry types that can appear in a given year. */
export const typesFor = (year: number) => INDUSTRY_TYPES.filter((t) => t.intro <= year);

/** Pick a type by weight. */
export function pickIndustryType(rng: Random, year: number): IndustryType {
  const types = typesFor(year);
  const total = types.reduce((s, t) => s + t.weight, 0);
  let r = rng.next() * total;
  for (const t of types) {
    r -= t.weight;
    if (r <= 0) return t;
  }
  return types[types.length - 1]!;
}

/**
 * Place industries for a new world, roughly one per TILES_PER_INDUSTRY land tiles. Every
 * type appears at least once where possible, so all chains exist.
 */
export function generateIndustries(map: GameMap, towns: readonly Town[], seed: number, year: number): Industry[] {
  const rng = new Random(seed ^ 0x1d057e);
  let land = 0;
  for (const t of map.layers.type) if (t !== TileType.Water) land++;
  const target = Math.max(typesFor(year).length, Math.round(land / TILES_PER_INDUSTRY));
  const out: Industry[] = [];
  const queue = [...typesFor(year)];
  for (let attempt = 0; attempt < target * 60 && out.length < target; attempt++) {
    const type = queue.length ? queue[0]! : pickIndustryType(rng, year);
    const x = rng.int(2, map.width - type.w - 2);
    const y = rng.int(2, map.height - type.h - 2);
    if (!industryFits(map, x, y, type.w, type.h, towns, out)) continue;
    if (queue.length) queue.shift();
    const ind = newIndustry(out.length, type, x, y, industryName(type, x, y, towns, out));
    placeIndustry(map, ind);
    out.push(ind);
  }
  return out;
}
