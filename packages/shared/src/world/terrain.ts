import { createNoise2D } from 'simplex-noise';
import { Random } from '../util/random.ts';
import { WorldClimate, type Climate } from './climate.ts';
import { Ground, MAX_HEIGHT, MAX_TREES, TileType, WATER_CANAL, WATER_RAPIDS, WATER_RIVER } from './constants.ts';
import { GameMap } from './map.ts';
import { carveRivers } from './rivers.ts';

export type TerrainRoughness = 'flat' | 'hilly' | 'mountainous';

export interface TerrainOptions {
  seed: number;
  roughness: TerrainRoughness;
  /** Approximate fraction of the map covered by sea (0..0.8). */
  waterLevel: number;
  /** Tree density multiplier (0..2). */
  treeDensity: number;
  /** River count multiplier (0..2); 1 if left out. */
  rivers?: number;
}

/** `arcticSnowLine`: in the sub-arctic, about a third of the land and a quarter of the towns lie above it. */
const ROUGHNESS = {
  flat: { maxHeight: 10, octaves: 4, scale: 1 / 380, mountain: 0.15, arcticSnowLine: 4 },
  hilly: { maxHeight: 22, octaves: 5, scale: 1 / 300, mountain: 0.45, arcticSnowLine: 6 },
  mountainous: { maxHeight: MAX_HEIGHT, octaves: 6, scale: 1 / 260, mountain: 0.9, arcticSnowLine: 8 },
} as const;

/** The climate of a world made with these settings. */
export function worldClimate(s: { climate?: Climate; seed: number; roughness: TerrainRoughness }): WorldClimate {
  return new WorldClimate(s.climate ?? 'temperate', s.seed, (ROUGHNESS[s.roughness] ?? ROUGHNESS.hilly).arcticSnowLine);
}

/**
 * Enforce the slope rule: orthogonally adjacent corners may differ by at most one
 * height level. Uses a two-pass chamfer sweep that lowers corners to the
 * largest field ≤ the input satisfying the constraint (an exact L1 distance transform).
 */
export function enforceSlopeLimit(heights: Uint8Array, w: number, h: number): void {
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let v = heights[i]!;
      if (x > 0) v = Math.min(v, heights[i - 1]! + 1);
      if (y > 0) v = Math.min(v, heights[i - w]! + 1);
      heights[i] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      let v = heights[i]!;
      if (x < w - 1) v = Math.min(v, heights[i + 1]! + 1);
      if (y < h - 1) v = Math.min(v, heights[i + w]! + 1);
      heights[i] = v;
    }
  }
}

/** Generate heights, water, ground variants and trees, for the map's climate. */
export function generateTerrain(map: GameMap, opts: TerrainOptions): void {
  const rng = new Random(opts.seed);
  const base = createNoise2D(() => rng.next());
  const ridge = createNoise2D(() => rng.next());
  const detail = createNoise2D(() => rng.next());
  const forest = createNoise2D(() => rng.next());
  const params = ROUGHNESS[opts.roughness];

  const cw = map.width + 1;
  const ch = map.height + 1;
  const raw = new Float32Array(cw * ch);

  // 1. Fractal noise field in [0, 1]
  for (let y = 0; y < ch; y++) {
    for (let x = 0; x < cw; x++) {
      let amp = 1;
      let freq = params.scale;
      let sum = 0;
      let norm = 0;
      for (let o = 0; o < params.octaves; o++) {
        sum += amp * base(x * freq, y * freq);
        norm += amp;
        amp *= 0.5;
        freq *= 2;
      }
      let v = (sum / norm) * 0.5 + 0.5;
      // Ridged mountains grow out of high ground
      const r = 1 - Math.abs(ridge(x * params.scale * 1.7, y * params.scale * 1.7));
      v += params.mountain * r * r * Math.max(0, v - 0.45);
      v += 0.03 * detail(x / 18, y / 18);
      raw[y * cw + x] = v;
    }
  }

  // 2. Pick sea level from the requested water fraction (histogram percentile)
  const sorted = Float32Array.from(raw).sort();
  const sea = sorted[Math.floor(Math.min(Math.max(opts.waterLevel, 0), 0.8) * (sorted.length - 1))]!;
  const top = sorted[sorted.length - 1]!;
  const span = Math.max(top - sea, 1e-6);

  const heights = map.heights;
  for (let i = 0; i < raw.length; i++) {
    const t = (raw[i]! - sea) / span;
    // Slight curve flattens lowlands, which gives more buildable land near the coast.
    heights[i] = t <= 0 ? 0 : Math.min(params.maxHeight, Math.round(Math.pow(t, 1.35) * params.maxHeight + 0.5));
  }
  enforceSlopeLimit(heights, cw, ch);

  // 3. Rivers from the hills down to the sea
  const rivers = carveRivers(heights, map.width, map.height, opts.seed, opts.rivers ?? 1, Math.max(3, Math.round(params.maxHeight * 0.3)));

  // 4. Tile classification: water, ground and trees
  const climate = map.climate;
  // Rocky ground below the snow line (the sub-arctic one is low, so only just below it).
  const rockBand = climate.id === 'arctic' ? 2 : 5;
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const i = y * map.width + x;
      const river = rivers.get(i);
      if (river !== undefined) {
        map.setWater(i);
        map.layers.data[i] = WATER_RIVER | (river ? WATER_RAPIDS : 0);
        continue;
      }
      const [a, b, c, d] = map.tileCorners(x, y);
      const max = Math.max(a, b, c, d);
      if (max === 0) {
        map.setWater(i);
        continue;
      }
      const min = Math.min(a, b, c, d);
      const zone = climate.zone(x, y, min);
      // Low-frequency noise drives coherent patches rather than per-tile speckle.
      const patch = detail(x / 23 + 100, y / 23 - 100);
      let ground: Ground = Ground.Grass;
      if (zone === 'snow') ground = Ground.Snow;
      else if (min === 0 && max <= 1 && patch > -0.35) ground = Ground.Sand; // beaches
      else if (max - min >= 2 || (min > climate.snowLine - rockBand && patch > 0.1)) ground = Ground.Rocks;
      else if (patch > (zone === 'desert' ? 0.3 : 0.62)) ground = Ground.Rough; // scrub in the desert

      let trees = 0;
      // Sub-arctic forests run on up into the snow; deserts have only the odd cactus.
      const wooded = ground === Ground.Grass || ground === Ground.Rough || (ground === Ground.Snow && climate.id === 'arctic' && min < climate.snowLine + 6);
      if (zone === 'desert') {
        if (rng.chance(0.015 * opts.treeDensity)) trees = 1;
      } else if (wooded) {
        // Forests: dense cores with soft edges, plus a few scattered trees in the open. The
        // rainforest is mostly forest.
        const f = forest(x / 48, y / 48) * 0.5 + 0.5 + 0.12 * forest(x / 10, y / 10) + (zone === 'rainforest' ? 0.22 : 0);
        const density = (f - 0.52) * opts.treeDensity;
        if (density > 0 && rng.chance(Math.min(1, density * 4))) {
          trees = Math.max(1, Math.min(MAX_TREES, Math.round(1 + density * 9 + rng.next())));
        } else if (rng.chance(0.012 * opts.treeDensity)) {
          trees = 1;
        }
      }
      map.setClear(i, ground, trees);
    }
  }
}

/** Spiral outward from (x, y) to the nearest dry, gently sloped tile. */
export function findLandNear(map: GameMap, x: number, y: number): { x: number; y: number } {
  const maxR = Math.max(map.width, map.height);
  for (let r = 0; r < maxR; r += 2) {
    for (let k = 0; k < Math.max(1, r * 8); k += 2) {
      const a = (k / Math.max(1, r * 8)) * Math.PI * 2;
      const tx = Math.round(x + Math.cos(a) * r);
      const ty = Math.round(y + Math.sin(a) * r);
      if (!map.inBounds(tx, ty)) continue;
      if (map.type(tx, ty) === TileType.Water) continue;
      if (map.tileMinHeight(tx, ty) >= 1 && map.tileMaxHeight(tx, ty) - map.tileMinHeight(tx, ty) <= 1) {
        return { x: tx, y: ty };
      }
    }
  }
  return { x, y };
}

/** Recompute Water/Clear for a tile after terraforming. */
export function reclassifyTile(map: GameMap, x: number, y: number): void {
  const i = map.tileIndex(x, y);
  const type = map.layers.type[i];
  const maxH = map.tileMaxHeight(x, y);
  if (type === TileType.Water && maxH > 0 && !(map.layers.data[i]! & (WATER_CANAL | WATER_RIVER))) {
    map.setClear(i, Ground.Grass, 0);
  } else if (type === TileType.Clear && maxH === 0 && touchesWater(map, x, y)) {
    map.setWater(i);
  }
}

function touchesWater(map: GameMap, x: number, y: number): boolean {
  if (x === 0 || y === 0 || x === map.width - 1 || y === map.height - 1) return true; // map edge is sea
  return (
    map.type(x - 1, y) === TileType.Water ||
    map.type(x + 1, y) === TileType.Water ||
    map.type(x, y - 1) === TileType.Water ||
    map.type(x, y + 1) === TileType.Water
  );
}
