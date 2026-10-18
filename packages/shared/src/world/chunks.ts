import { CHUNK_SIZE } from './constants.ts';
import { GameMap, LAYER_NAMES, TILE_LAYERS, type LayerArray, type LayerName } from './map.ts';

/** Wire format for one chunk: its tiles plus the (CHUNK_SIZE+1)² corner heights it uses. */
export interface ChunkData {
  cx: number;
  cy: number;
  version: number;
  heights: Uint8Array;
  layers: Record<LayerName, LayerArray>;
}

const CORNERS = CHUNK_SIZE + 1;

export function extractChunk(map: GameMap, cx: number, cy: number): ChunkData {
  const heights = new Uint8Array(CORNERS * CORNERS);
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const mw = map.width + 1;
  for (let y = 0; y < CORNERS; y++) {
    const src = (y0 + y) * mw + x0;
    heights.set(map.heights.subarray(src, src + CORNERS), y * CORNERS);
  }
  const layers = {} as Record<LayerName, LayerArray>;
  for (const name of LAYER_NAMES) {
    const srcArr = map.layers[name] as LayerArray;
    const dst = new TILE_LAYERS[name](CHUNK_SIZE * CHUNK_SIZE);
    for (let y = 0; y < CHUNK_SIZE; y++) {
      const src = (y0 + y) * map.width + x0;
      dst.set(srcArr.subarray(src, src + CHUNK_SIZE), y * CHUNK_SIZE);
    }
    layers[name] = dst;
  }
  return { cx, cy, version: map.chunkVersions[map.chunkIndex(cx, cy)]!, heights, layers };
}

export function applyChunk(map: GameMap, chunk: ChunkData): void {
  const x0 = chunk.cx * CHUNK_SIZE;
  const y0 = chunk.cy * CHUNK_SIZE;
  const mw = map.width + 1;
  for (let y = 0; y < CORNERS; y++) {
    const dst = (y0 + y) * mw + x0;
    map.heights.set(chunk.heights.subarray(y * CORNERS, (y + 1) * CORNERS), dst);
  }
  for (const name of LAYER_NAMES) {
    const src = chunk.layers[name];
    if (!src) continue;
    const dstArr = map.layers[name] as LayerArray;
    for (let y = 0; y < CHUNK_SIZE; y++) {
      dstArr.set(src.subarray(y * CHUNK_SIZE, (y + 1) * CHUNK_SIZE), (y0 + y) * map.width + x0);
    }
  }
  map.chunkVersions[map.chunkIndex(chunk.cx, chunk.cy)] = chunk.version;
}

/** Chunk ids (cy * chunksX + cx) whose bounds intersect a tile-space rectangle. */
export function chunksInRect(
  map: GameMap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number[] {
  const cx0 = Math.max(0, Math.floor(Math.min(x0, x1) / CHUNK_SIZE));
  const cy0 = Math.max(0, Math.floor(Math.min(y0, y1) / CHUNK_SIZE));
  const cx1 = Math.min(map.chunksX - 1, Math.floor(Math.max(x0, x1) / CHUNK_SIZE));
  const cy1 = Math.min(map.chunksY - 1, Math.floor(Math.max(y0, y1) / CHUNK_SIZE));
  const out: number[] = [];
  for (let cy = cy0; cy <= cy1; cy++) for (let cx = cx0; cx <= cx1; cx++) out.push(cy * map.chunksX + cx);
  return out;
}
