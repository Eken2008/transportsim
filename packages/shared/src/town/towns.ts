import { EDGE_DX, EDGE_DY, Edge, OPPOSITE_EDGE, edgeHeight } from '../rail/track.ts';
import { Random } from '../util/random.ts';
import { OWNER_NONE, TileType } from '../world/constants.ts';
import type { GameMap } from '../world/map.ts';
import { HOUSE_TYPES, houseType } from './houses.ts';
import { townName } from './names.ts';
import { ROAD_EDGE_BITS } from './road.ts';

/** What a town's stations handled in a month. */
export interface TownStats {
  /** Passengers and mail picked up at stations in the town. */
  passengers: number;
  mail: number;
  /** Goods and food delivered to stations in the town. */
  goods: number;
  food: number;
}

export const emptyTownStats = (): TownStats => ({ passengers: 0, mail: 0, goods: 0, food: 0 });

export interface Town {
  id: number;
  name: string;
  /** Centre tile */
  x: number;
  y: number;
  population: number;
  houses: number;
  /** Growth points; the town grows by one step each time they reach 1. */
  growth?: number;
  /** Growth points per day, from service (for display). */
  growthRate?: number;
  /** Stations serving the town well (recent pickups, good rating). */
  served?: number;
  stats?: TownStats;
  lastStats?: TownStats;
  /** Each company's reputation with the town council (company id → -1000..1000); missing means the starting value. */
  ratings?: Record<number, number>;
  /** Companies with a statue in the town. */
  statues?: number[];
  /** A company holds exclusive transport rights in the town until this day. */
  exclusive?: { company: number; until: number };
  /** Rapid growth paid for by a company, until this day. */
  funded?: { company: number; until: number };
  /** Road reconstruction paid for by a company, until this day. */
  roadWorks?: { company: number; until: number };
  /** Companies caught bribing the council (company id → the day it deals with them again). */
  unwanted?: Record<number, number>;
}

export type TownSize = 'small' | 'medium' | 'large';

const SIZES: Record<TownSize, { arm: number; side: number; houses: number }> = {
  small: { arm: 4, side: 2, houses: 10 },
  medium: { arm: 6, side: 4, houses: 26 },
  large: { arm: 9, side: 5, houses: 60 },
};

const MIN_TOWN_DISTANCE = 22;
const EDGE_MARGIN = 10;

/** Land tiles per town at "normal" density. */
const TILES_PER_TOWN = 3500;

/**
 * Place towns with a small road network (a cross of main streets with side streets) and
 * houses along the roads. Deterministic for a given seed.
 */
export function generateTowns(map: GameMap, seed: number, year: number, maxTowns = 4000): Town[] {
  const rng = new Random(seed ^ 0x51ed270b);
  let land = 0;
  for (const t of map.layers.type) if (t !== TileType.Water) land++;
  const target = Math.max(2, Math.min(maxTowns, Math.round(land / TILES_PER_TOWN)));
  const towns: Town[] = [];
  const names = new Set<string>();

  for (let attempt = 0; attempt < target * 40 && towns.length < target; attempt++) {
    const x = rng.int(EDGE_MARGIN, map.width - 1 - EDGE_MARGIN);
    const y = rng.int(EDGE_MARGIN, map.height - 1 - EDGE_MARGIN);
    if (!isGoodCentre(map, x, y)) continue;
    if (towns.some((t) => Math.max(Math.abs(t.x - x), Math.abs(t.y - y)) < MIN_TOWN_DISTANCE)) continue;
    const roll = rng.next();
    const size: TownSize = roll < 0.12 ? 'large' : roll < 0.45 ? 'medium' : 'small';
    const town: Town = { id: towns.length, name: townName(rng, names), x, y, population: 0, houses: 0 };
    buildTown(map, town, SIZES[size], rng, year);
    towns.push(town);
  }
  return towns;
}

function isGoodCentre(map: GameMap, x: number, y: number): boolean {
  if (map.type(x, y) !== TileType.Clear || !map.isFlat(x, y) || map.tileMinHeight(x, y) < 1) return false;
  let ok = 0;
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -3; dx <= 3; dx++) {
      const tx = x + dx;
      const ty = y + dy;
      if (map.inBounds(tx, ty) && map.type(tx, ty) === TileType.Clear && map.isFlat(tx, ty)) ok++;
    }
  }
  return ok >= 30;
}

/** Road may run straight along `axis` (0 = X, 1 = Y) over this tile. */
function roadFits(map: GameMap, x: number, y: number, axis: 0 | 1, junction: boolean): boolean {
  if (!map.inBounds(x, y)) return false;
  if (map.type(x, y) !== TileType.Clear) return false;
  if (map.tileMinHeight(x, y) < 1) return false;
  if (map.isFlat(x, y)) return true;
  if (junction) return false;
  const c = map.tileCorners(x, y);
  const [e1, e2] = axis === 0 ? [Edge.W, Edge.E] : [Edge.N, Edge.S];
  const h1 = edgeHeight(c, e1);
  const h2 = edgeHeight(c, e2);
  return h1 >= 0 && h2 >= 0 && Math.abs(h1 - h2) <= 1;
}

function buildTown(map: GameMap, town: Town, size: { arm: number; side: number; houses: number }, rng: Random, year: number): void {
  const roads = new Map<number, number>(); // tile index → road bits
  const connect = (a: number, b: number, edgeFromA: Edge) => {
    roads.set(a, (roads.get(a) ?? 0) | ROAD_EDGE_BITS[edgeFromA]!);
    roads.set(b, (roads.get(b) ?? 0) | ROAD_EDGE_BITS[OPPOSITE_EDGE[edgeFromA]]!);
  };

  /** Extend a street from (x, y) — which is already road — in direction `edge`. */
  const street = (x: number, y: number, edge: Edge, length: number, branches: boolean) => {
    const axis = edge === Edge.E || edge === Edge.W ? 0 : 1;
    let px = x;
    let py = y;
    for (let k = 1; k <= length; k++) {
      const nx = px + EDGE_DX[edge];
      const ny = py + EDGE_DY[edge];
      const ni = map.tileIndex(nx, ny);
      const isJunction = branches && k % 3 === 0;
      if (roads.has(ni)) break;
      if (!roadFits(map, nx, ny, axis, isJunction)) break;
      connect(map.tileIndex(px, py), ni, edge);
      px = nx;
      py = ny;
      if (isJunction) {
        for (const side of axis === 0 ? [Edge.N, Edge.S] : [Edge.E, Edge.W]) {
          if (rng.chance(0.75)) street(px, py, side as Edge, Math.max(1, size.side + rng.int(-1, 1)), false);
        }
      }
    }
  };

  const centre = map.tileIndex(town.x, town.y);
  roads.set(centre, 0);
  for (const e of [Edge.N, Edge.E, Edge.S, Edge.W]) street(town.x, town.y, e, size.arm + rng.int(-1, 1), true);

  for (const [i, bits] of roads) {
    // Lone centre tile without connections isn't worth keeping as road.
    if (bits === 0) continue;
    map.layers.type[i] = TileType.Road;
    map.layers.owner[i] = OWNER_NONE;
    map.layers.data[i] = bits;
    map.layers.track[i] = 0;
    map.layers.town[i] = town.id + 1;
  }

  // Houses on flat tiles next to roads, denser and taller near the centre.
  const candidates: { i: number; x: number; y: number; d: number; face: Edge }[] = [];
  for (const i of roads.keys()) {
    const rx = i % map.width;
    const ry = (i - rx) / map.width;
    for (const e of [Edge.N, Edge.E, Edge.S, Edge.W]) {
      const hx = rx + EDGE_DX[e];
      const hy = ry + EDGE_DY[e];
      if (!map.inBounds(hx, hy)) continue;
      const hi = map.tileIndex(hx, hy);
      if (roads.has(hi) || map.type(hx, hy) !== TileType.Clear || !map.isFlat(hx, hy)) continue;
      if (map.tileMinHeight(hx, hy) < 1) continue;
      candidates.push({ i: hi, x: hx, y: hy, d: Math.hypot(hx - town.x, hy - town.y), face: OPPOSITE_EDGE[e] });
    }
  }
  candidates.sort((a, b) => a.d - b.d + (rng.next() - 0.5) * 4);
  const core = size.arm * 0.45;
  const mid = size.arm * 0.85;
  let church = false;
  for (const c of candidates) {
    if (town.houses >= size.houses) break;
    if (map.type(c.x, c.y) !== TileType.Clear) continue;
    if (rng.chance(0.15)) continue; // leave some gaps
    const band = c.d < core ? 0 : c.d < mid ? 1 : 2;
    const options = HOUSE_TYPES.map((h, idx) => ({ h, idx })).filter(({ h }) =>
      h.model === 'church' ? !church && h.band === band : h.from <= year && Math.abs(h.band - band) <= 1,
    );
    if (options.length === 0) continue;
    const pick = options[Math.floor(rng.next() * options.length)]!;
    if (pick.h.model === 'church') church = true;
    map.layers.type[c.i] = TileType.House;
    map.layers.owner[c.i] = OWNER_NONE;
    map.layers.data[c.i] = pick.idx | (c.face << 8);
    map.layers.track[c.i] = 0;
    map.layers.town[c.i] = town.id + 1;
    town.houses++;
    town.population += pick.h.population;
  }
}

/** Recount population and houses for every town from the map. */
export function recountTowns(map: GameMap, towns: Iterable<Town>): void {
  const byId = new Map<number, Town>();
  for (const t of towns) {
    t.population = 0;
    t.houses = 0;
    byId.set(t.id, t);
  }
  const { type, town, data } = map.layers;
  for (let i = 0; i < type.length; i++) {
    if (type[i] !== TileType.House) continue;
    const t = byId.get(town[i]! - 1);
    if (!t) continue;
    t.houses++;
    t.population += houseType(data[i]!).population;
  }
}

