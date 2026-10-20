import { COSTS, clearCost } from '../economy/costs.ts';
import { structuresAt } from '../rail/structures.ts';
import type { GameState } from '../sim/state.ts';
import { Ground, TileType } from '../world/constants.ts';
import { Foundation, isGentleSlope } from '../world/foundation.ts';
import type { Company } from './company.ts';

/**
 * A company's headquarters: a 2×2 office building, one per company. Building it again
 * elsewhere moves it. It grows taller as the company's value grows, and it can't be
 * bulldozed; it comes down with the company.
 *
 * Tile data: bits 0-1 = part (dx | dy << 1 from the north-west corner), bits 2-4 = size.
 */
export const HQ_SIZE = 2;
const SIZE_SHIFT = 2;

/** Company value from which the headquarters reach each size (0 to 4). */
export const HQ_SIZE_VALUES = [0, 1_000_000, 4_000_000, 15_000_000, 50_000_000] as const;

export const HQ_SIZE_NAMES = ['Small office', 'Office block', 'Office tower', 'Tower block', 'Skyscraper'] as const;

/** How big a company's headquarters are at a company value. */
export function hqSizeFor(value: number): number {
  let size = 0;
  while (size + 1 < HQ_SIZE_VALUES.length && value >= HQ_SIZE_VALUES[size + 1]!) size++;
  return size;
}

export const hqPart = (data: number) => data & 3;
export const hqSize = (data: number) => (data >> SIZE_SHIFT) & 7;

/** Where headquarters could go, with the north-west corner at (x, y): its cost, or why not. */
export interface HqSite {
  tiles: number[];
  /** Tiles a foundation levels. */
  levelled: Set<number>;
  cost: number;
}

/**
 * Check a site for a company's headquarters: dry, open land that is flat or gently sloped up to one
 * level. Its own headquarters may be in the way (they move). Returns the site (cost before economy
 * scaling) or an error.
 */
export function hqSite(state: GameState, company: number, x: number, y: number): HqSite | string {
  const map = state.map;
  if (!map.inBounds(x, y) || !map.inBounds(x + HQ_SIZE - 1, y + HQ_SIZE - 1)) return 'Out of bounds';
  const own = (i: number) => map.layers.type[i] === TileType.Headquarters && map.layers.owner[i] === company;
  // Level at the highest ground; gentle slopes below it are levelled up.
  let level = 0;
  for (let ty = y; ty < y + HQ_SIZE; ty++) for (let tx = x; tx < x + HQ_SIZE; tx++) level = Math.max(level, ...map.rawCorners(tx, ty));
  const tiles: number[] = [];
  const levelled = new Set<number>();
  let cost = COSTS.headquarters;
  for (let ty = y; ty < y + HQ_SIZE; ty++) {
    for (let tx = x; tx < x + HQ_SIZE; tx++) {
      const i = map.tileIndex(tx, ty);
      if (map.layers.type[i] !== TileType.Clear && !own(i)) return `Object in the way (${tx},${ty})`;
      const raw = map.rawCorners(tx, ty);
      const flat = raw.every((h) => h === raw[0]);
      if (level < 1) return `Headquarters need dry land (${tx},${ty})`;
      if (!flat && isGentleSlope(raw) && Math.max(...raw) === level) {
        levelled.add(i);
        cost += COSTS.foundation;
      } else if (!flat || raw[0] !== level) {
        return `Headquarters need level land (${tx},${ty})`;
      }
      if (structuresAt(map, i).some((s) => s.kind === 'bridge')) return `A bridge is in the way (${tx},${ty})`;
      cost += clearCost(map, tx, ty);
      tiles.push(i);
    }
  }
  if (tiles.every(own) && state.companies.get(company)?.hq === tiles[0]) return 'Your headquarters are already here';
  return { tiles, levelled, cost };
}

/** Pull down a company's headquarters, if it has any. */
export function removeHeadquarters(state: GameState, c: Company, dirtyChunks?: Set<number>): void {
  if (c.hq === undefined) return;
  const map = state.map;
  const x0 = c.hq % map.width;
  const y0 = (c.hq - x0) / map.width;
  for (let ty = y0; ty < y0 + HQ_SIZE; ty++) {
    for (let tx = x0; tx < x0 + HQ_SIZE; tx++) {
      if (!map.inBounds(tx, ty)) continue;
      const i = map.tileIndex(tx, ty);
      if (map.layers.type[i] !== TileType.Headquarters || map.layers.owner[i] !== c.id) continue;
      map.setClear(i, Ground.Rough, 0);
      map.touchTile(tx, ty, dirtyChunks);
    }
  }
  delete c.hq;
}

/** Put up a company's headquarters on a site checked with `hqSite`, moving them if it has some. */
export function placeHeadquarters(state: GameState, c: Company, site: HqSite, dirtyChunks: Set<number>): void {
  removeHeadquarters(state, c, dirtyChunks);
  const map = state.map;
  const size = hqSizeFor(c.value);
  site.tiles.forEach((i, part) => {
    const tx = i % map.width;
    const ty = (i - tx) / map.width;
    map.setClear(i, Ground.Grass, 0);
    if (site.levelled.has(i)) map.layers.foundation[i] = Foundation.Level;
    map.layers.type[i] = TileType.Headquarters;
    map.layers.owner[i] = c.id;
    map.layers.data[i] = part | (size << SIZE_SHIFT);
    map.touchTile(tx, ty, dirtyChunks);
  });
  c.hq = site.tiles[0];
}

/** Monthly: headquarters grow (or shrink) with the company's value. */
export function resizeHeadquarters(state: GameState, c: Company): void {
  if (c.hq === undefined) return;
  const map = state.map;
  const size = hqSizeFor(c.value);
  if (hqSize(map.layers.data[c.hq]!) === size) return;
  const x0 = c.hq % map.width;
  const y0 = (c.hq - x0) / map.width;
  for (let ty = y0; ty < y0 + HQ_SIZE; ty++) {
    for (let tx = x0; tx < x0 + HQ_SIZE; tx++) {
      const i = map.tileIndex(tx, ty);
      map.layers.data[i] = hqPart(map.layers.data[i]!) | (size << SIZE_SHIFT);
      map.touchTile(tx, ty);
    }
  }
}

/** After loading: find each company's headquarters, and clear those of companies that are gone. */
export function findHeadquarters(state: GameState): void {
  const map = state.map;
  const { type, owner, data } = map.layers;
  for (const c of state.companies.values()) delete c.hq;
  for (let i = 0; i < type.length; i++) {
    if (type[i] !== TileType.Headquarters) continue;
    const c = state.companies.get(owner[i]!);
    if (!c) map.setClear(i, Ground.Rough, 0);
    else if (hqPart(data[i]!) === 0) c.hq = i;
  }
}
