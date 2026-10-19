import { EDGE_DX, EDGE_DY, Edge, OPPOSITE_EDGE, edgeHeight } from '../rail/track.ts';
import type { Random } from '../util/random.ts';
import { OWNER_NONE, TileType } from '../world/constants.ts';
import type { GameMap } from '../world/map.ts';
import { HOUSE_TYPES, houseType } from './houses.ts';
import { ROAD_EDGE_BITS } from './road.ts';
import type { Town } from './towns.ts';

/** How far (tiles) from its centre a town builds, by size. */
export const townRadius = (t: Town) => Math.min(30, 4 + Math.sqrt(t.houses) * 1.3);

/** Could a house stand on this tile (clear, flat, dry)? */
function houseFits(map: GameMap, x: number, y: number): boolean {
  return map.inBounds(x, y) && map.type(x, y) === TileType.Clear && map.isFlat(x, y) && map.tileMinHeight(x, y) >= 1;
}

/** Could a straight street run along `axis` over this tile? */
function streetFits(map: GameMap, x: number, y: number, axis: 0 | 1): boolean {
  if (!map.inBounds(x, y) || map.type(x, y) !== TileType.Clear || map.tileMinHeight(x, y) < 1) return false;
  if (map.isFlat(x, y)) return true;
  const c = map.tileCorners(x, y);
  const [e1, e2] = axis === 0 ? [Edge.W, Edge.E] : [Edge.N, Edge.S];
  const h1 = edgeHeight(c, e1);
  const h2 = edgeHeight(c, e2);
  return h1 >= 0 && h2 >= 0 && Math.abs(h1 - h2) <= 1;
}

/** Pick a house type for a distance band (0 = core) in a year, as at world generation. */
function pickHouse(rng: Random, band: number, year: number): number {
  const options = HOUSE_TYPES.map((h, idx) => ({ h, idx })).filter(({ h }) => h.model !== 'church' && h.from <= year && Math.abs(h.band - band) <= 1);
  if (options.length === 0) return 0;
  // Bigger buildings more likely in the core as the town grows.
  const sorted = options.sort((a, b) => a.h.population - b.h.population);
  const k = band === 0 ? Math.floor(Math.pow(rng.next(), 0.5) * sorted.length) : Math.floor(rng.next() * sorted.length);
  return sorted[Math.min(sorted.length - 1, k)]!.idx;
}

/**
 * One growth step: build a house beside a street, rebuild a small house as a bigger one, or
 * extend a street into open land. Returns the changed tiles (empty if nothing fitted).
 */
export function growTown(map: GameMap, town: Town, rng: Random, year: number): number[] {
  const r = Math.ceil(townRadius(town));
  const roads: number[] = [];
  const houses: number[] = [];
  for (let y = town.y - r; y <= town.y + r; y++) {
    for (let x = town.x - r; x <= town.x + r; x++) {
      if (!map.inBounds(x, y)) continue;
      const i = map.tileIndex(x, y);
      if (map.layers.town[i] !== town.id + 1) continue;
      if (map.layers.type[i] === TileType.Road) roads.push(i);
      else if (map.layers.type[i] === TileType.House) houses.push(i);
    }
  }
  const band = (x: number, y: number) => {
    const d = Math.hypot(x - town.x, y - town.y) / Math.max(1, r);
    return d < 0.35 ? 0 : d < 0.75 ? 1 : 2;
  };
  const roll = rng.next();

  // New house next to a street (most growth).
  if (roll < 0.7) {
    const sites: { i: number; x: number; y: number; face: Edge }[] = [];
    for (const ri of roads) {
      const rx = ri % map.width;
      const ry = (ri - rx) / map.width;
      for (const e of [Edge.N, Edge.E, Edge.S, Edge.W]) {
        const hx = rx + EDGE_DX[e];
        const hy = ry + EDGE_DY[e];
        if (Math.hypot(hx - town.x, hy - town.y) > r || !houseFits(map, hx, hy)) continue;
        sites.push({ i: map.tileIndex(hx, hy), x: hx, y: hy, face: OPPOSITE_EDGE[e] });
      }
    }
    if (sites.length) {
      const s = sites[Math.floor(rng.next() * sites.length)]!;
      setHouse(map, town, s.i, pickHouse(rng, band(s.x, s.y), year), s.face);
      return [s.i];
    }
  }

  // Rebuild a small house in the centre as a bigger one.
  if (roll < 0.85 && houses.length) {
    const i = houses[Math.floor(rng.next() * houses.length)]!;
    const x = i % map.width;
    const y = (i - x) / map.width;
    const old = houseType(map.layers.data[i]!);
    const next = pickHouse(rng, band(x, y), year);
    if (old.model !== 'church' && HOUSE_TYPES[next]!.population > old.population) {
      town.population -= old.population;
      town.houses--;
      setHouse(map, town, i, next, ((map.layers.data[i]! >> 8) & 3) as Edge);
      return [i];
    }
  }

  // Extend a street: from a street tile, straight on into clear land for 1-3 tiles.
  for (let attempt = 0; attempt < 12 && roads.length; attempt++) {
    const ri = roads[Math.floor(rng.next() * roads.length)]!;
    const e = [Edge.N, Edge.E, Edge.S, Edge.W][rng.int(0, 3)]!;
    const axis = e === Edge.E || e === Edge.W ? 0 : 1;
    let px = ri % map.width;
    let py = (ri - px) / map.width;
    const len = rng.int(1, 3);
    const changed: number[] = [];
    for (let k = 0; k < len; k++) {
      const nx = px + EDGE_DX[e];
      const ny = py + EDGE_DY[e];
      if (Math.hypot(nx - town.x, ny - town.y) > r + 2 || !streetFits(map, nx, ny, axis)) break;
      const a = map.tileIndex(px, py);
      const b = map.tileIndex(nx, ny);
      map.layers.type[b] = TileType.Road;
      map.layers.owner[b] = OWNER_NONE;
      map.layers.track[b] = 0;
      map.layers.data[b] = ROAD_EDGE_BITS[OPPOSITE_EDGE[e]]!;
      map.layers.town[b] = town.id + 1;
      map.layers.data[a] = map.layers.data[a]! | ROAD_EDGE_BITS[e]!;
      changed.push(a, b);
      px = nx;
      py = ny;
    }
    if (changed.length) return changed;
  }
  return [];
}

function setHouse(map: GameMap, town: Town, i: number, type: number, face: Edge): void {
  map.layers.type[i] = TileType.House;
  map.layers.owner[i] = OWNER_NONE;
  map.layers.data[i] = type | (face << 8);
  map.layers.track[i] = 0;
  map.layers.town[i] = town.id + 1;
  town.houses++;
  town.population += HOUSE_TYPES[type]!.population;
}
