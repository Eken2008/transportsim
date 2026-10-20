import { createNoise2D, type NoiseFunction2D } from 'simplex-noise';
import { Random } from '../util/random.ts';
import { MAX_HEIGHT, SNOW_LINE } from './constants.ts';

export const CLIMATES = ['temperate', 'arctic', 'tropical'] as const;
export type Climate = (typeof CLIMATES)[number];

export const CLIMATE_NAMES: Record<Climate, string> = {
  temperate: 'Temperate',
  arctic: 'Sub-arctic',
  tropical: 'Sub-tropical',
};

/**
 * What a place is like: above the snow line (all climates, though only the sub-arctic one has
 * land up there to speak of), or the desert and rainforest of the sub-tropics.
 */
export type Zone = 'normal' | 'snow' | 'desert' | 'rainforest';

/** Moisture below this is desert, above RAINFOREST rainforest (sub-tropical climate). */
const DESERT = -0.12;
const RAINFOREST = 0.3;

/**
 * The climate of a world: its snow line, and in the sub-tropics where the desert and rainforest
 * lie. Zones come from the seed alone, so the server and every client agree on them, and they
 * don't change when land is built on, cleared or terraformed (except for the snow line, which
 * follows the land's height).
 */
export class WorldClimate {
  /** Height level from which land lies under snow. */
  readonly snowLine: number;
  private readonly wet?: NoiseFunction2D;
  private readonly wetDetail?: NoiseFunction2D;

  /** `arcticSnowLine`: the snow line if the climate is sub-arctic (it depends on the terrain). */
  constructor(
    readonly id: Climate,
    seed: number,
    arcticSnowLine: number,
  ) {
    this.snowLine = id === 'arctic' ? arcticSnowLine : id === 'tropical' ? MAX_HEIGHT + 1 : SNOW_LINE;
    if (id === 'tropical') {
      const rng = new Random(seed ^ 0x7e7a1c);
      this.wet = createNoise2D(() => rng.next());
      this.wetDetail = createNoise2D(() => rng.next());
    }
  }

  /** Sub-tropical moisture at a tile, about -1 (driest) to 1 (wettest); 0 elsewhere. */
  moisture(x: number, y: number): number {
    if (!this.wet) return 0;
    return 0.8 * this.wet(x / 210, y / 210) + 0.2 * this.wetDetail!(x / 40, y / 40);
  }

  /** The zone of a tile whose lowest corner is at `height`. */
  zone(x: number, y: number, height: number): Zone {
    if (height >= this.snowLine) return 'snow';
    if (!this.wet || height < 1) return 'normal';
    const m = this.moisture(x, y);
    return m < DESERT ? 'desert' : m > RAINFOREST ? 'rainforest' : 'normal';
  }

  /**
   * How far into the desert (negative, down to -1) or the rainforest (positive, up to 1) a tile
   * is, easing in over a few tiles at the edge; 0 between them and outside the sub-tropics.
   */
  wetness(x: number, y: number): number {
    if (!this.wet) return 0;
    const m = this.moisture(x, y);
    const EDGE = 0.06;
    if (m < DESERT + EDGE) return -Math.min(1, (DESERT + EDGE - m) / (2 * EDGE));
    if (m > RAINFOREST - EDGE) return Math.min(1, (m - RAINFOREST + EDGE) / (2 * EDGE));
    return 0;
  }
}

/** The temperate climate, for maps made without settings (tests, tools). */
export const TEMPERATE = new WorldClimate('temperate', 0, SNOW_LINE);
