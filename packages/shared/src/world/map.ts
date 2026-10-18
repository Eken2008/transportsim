import { CHUNK_SIZE, Ground, MAX_TREES, OWNER_NONE, TileType } from './constants.ts';

type TypedArrayCtor =
  | Uint8ArrayConstructor
  | Uint16ArrayConstructor
  | Uint32ArrayConstructor
  | Int16ArrayConstructor;
export type LayerArray = Uint8Array | Uint16Array | Uint32Array | Int16Array;

/**
 * Per-tile data layers. Every layer has exactly width*height entries.
 * Adding a layer here automatically includes it in chunk sync and save games.
 */
export const TILE_LAYERS = {
  /** TileType */
  type: Uint8Array,
  /** Owning company id, OWNER_NONE if unowned. */
  owner: Uint8Array,
  /** Type-specific payload (trees/ground for Clear, water kind for Water, ...). */
  data: Uint16Array,
} satisfies Record<string, TypedArrayCtor>;

export type LayerName = keyof typeof TILE_LAYERS;
export type TileLayers = { [K in LayerName]: InstanceType<(typeof TILE_LAYERS)[K]> };
export const LAYER_NAMES = Object.keys(TILE_LAYERS) as LayerName[];

/**
 * The tile map. Stored as struct-of-arrays for compactness and cache-friendly iteration.
 *
 * Coordinates: tile (x, y) covers world X in [x, x+1] and world Z in [y, y+1].
 * Corner heights live on a (width+1) × (height+1) grid; corner (x, y) is the
 * north-west corner of tile (x, y).
 */
export class GameMap {
  readonly width: number;
  readonly height: number;
  readonly chunksX: number;
  readonly chunksY: number;
  /** Corner heights, (width+1)*(height+1). */
  readonly heights: Uint8Array;
  readonly layers: TileLayers;
  /** Version counter per chunk, bumped whenever anything in that chunk changes. */
  readonly chunkVersions: Uint32Array;

  constructor(width: number, height: number) {
    if (width % CHUNK_SIZE !== 0 || height % CHUNK_SIZE !== 0) {
      throw new Error(`Map size must be a multiple of ${CHUNK_SIZE}`);
    }
    this.width = width;
    this.height = height;
    this.chunksX = width / CHUNK_SIZE;
    this.chunksY = height / CHUNK_SIZE;
    this.heights = new Uint8Array((width + 1) * (height + 1));
    const n = width * height;
    const layers = {} as Record<LayerName, LayerArray>;
    for (const name of LAYER_NAMES) layers[name] = new TILE_LAYERS[name](n);
    this.layers = layers as TileLayers;
    this.layers.owner.fill(OWNER_NONE);
    this.chunkVersions = new Uint32Array(this.chunksX * this.chunksY);
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  cornerInBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x <= this.width && y <= this.height;
  }

  tileIndex(x: number, y: number): number {
    return y * this.width + x;
  }

  cornerIndex(x: number, y: number): number {
    return y * (this.width + 1) + x;
  }

  cornerHeight(x: number, y: number): number {
    return this.heights[y * (this.width + 1) + x]!;
  }

  /** Corner heights of a tile in order NW, NE, SE, SW. */
  tileCorners(x: number, y: number): [number, number, number, number] {
    const w = this.width + 1;
    const i = y * w + x;
    const h = this.heights;
    return [h[i]!, h[i + 1]!, h[i + w + 1]!, h[i + w]!];
  }

  tileMinHeight(x: number, y: number): number {
    return Math.min(...this.tileCorners(x, y));
  }

  tileMaxHeight(x: number, y: number): number {
    return Math.max(...this.tileCorners(x, y));
  }

  isFlat(x: number, y: number): boolean {
    const [a, b, c, d] = this.tileCorners(x, y);
    return a === b && b === c && c === d;
  }

  /** Terrain height (in height levels, fractional) at a world position, matching the rendered mesh. */
  heightAt(wx: number, wz: number): number {
    const x = Math.min(Math.max(Math.floor(wx), 0), this.width - 1);
    const y = Math.min(Math.max(Math.floor(wz), 0), this.height - 1);
    const fx = Math.min(Math.max(wx - x, 0), 1);
    const fy = Math.min(Math.max(wz - y, 0), 1);
    const [nw, ne, se, sw] = this.tileCorners(x, y);
    // Matches the triangle split used by the terrain mesh (see tileSplitsNWSE).
    if (tileSplitsNWSE(nw, ne, se, sw)) {
      // Diagonal NW-SE: triangles (nw, ne, se) and (nw, se, sw)
      if (fx >= fy) return nw + (ne - nw) * fx + (se - ne) * fy;
      return nw + (se - sw) * fx + (sw - nw) * fy;
    }
    // Diagonal NE-SW: triangles (nw, ne, sw) and (ne, se, sw)
    if (fx + fy <= 1) return nw + (ne - nw) * fx + (sw - nw) * fy;
    return se + (sw - se) * (1 - fx) + (ne - se) * (1 - fy);
  }

  type(x: number, y: number): TileType {
    return this.layers.type[y * this.width + x] as TileType;
  }

  treeCount(x: number, y: number): number {
    const i = y * this.width + x;
    if (this.layers.type[i] !== TileType.Clear) return 0;
    return this.layers.data[i]! & 0x7;
  }

  setClear(i: number, ground: Ground, trees: number): void {
    this.layers.type[i] = TileType.Clear;
    this.layers.owner[i] = OWNER_NONE;
    this.layers.data[i] = (Math.min(trees, MAX_TREES) & 0x7) | ((ground & 0x7) << 3);
  }

  setWater(i: number): void {
    this.layers.type[i] = TileType.Water;
    this.layers.owner[i] = OWNER_NONE;
    this.layers.data[i] = 0;
  }

  chunkIndex(cx: number, cy: number): number {
    return cy * this.chunksX + cx;
  }

  chunkOfTile(x: number, y: number): number {
    return Math.floor(y / CHUNK_SIZE) * this.chunksX + Math.floor(x / CHUNK_SIZE);
  }

  /** Mark the chunk(s) containing a tile dirty. */
  touchTile(x: number, y: number, dirty?: Set<number>): void {
    const c = this.chunkOfTile(x, y);
    this.chunkVersions[c]!++;
    dirty?.add(c);
  }

  /** Mark every chunk whose mesh uses this corner dirty. */
  touchCorner(x: number, y: number, dirty?: Set<number>): void {
    for (let ty = y - 1; ty <= y; ty++) {
      for (let tx = x - 1; tx <= x; tx++) {
        if (!this.inBounds(tx, ty)) continue;
        const c = this.chunkOfTile(tx, ty);
        if (dirty) {
          if (!dirty.has(c)) {
            dirty.add(c);
            this.chunkVersions[c]!++;
          }
        } else {
          this.chunkVersions[c]!++;
        }
      }
    }
  }
}

/**
 * Which diagonal a tile's two triangles share. Chosen so that "valley" and "ridge"
 * corners fold naturally, like OpenTTD's slope sprites.
 */
export function tileSplitsNWSE(nw: number, ne: number, se: number, sw: number): boolean {
  // Fold along the diagonal whose endpoints are closest in height: a single raised
  // corner then forms one sloped triangle, a single lowered corner one dipped triangle.
  return Math.abs(nw - se) <= Math.abs(ne - sw);
}
