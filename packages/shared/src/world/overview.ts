import { CHUNK_SIZE, Ground, OWNER_NONE, TileType, WATER_CANAL, WATER_RIVER } from './constants.ts';
import type { GameMap } from './map.ts';

/**
 * A low-resolution picture of the whole map for the minimap. Clients only receive the chunks
 * they look at, so the server keeps this overview and sends it to everyone: whole on joining,
 * then the parts that change.
 *
 * Each cell covers `scale`×`scale` tiles and holds one byte of what is there (OverviewKind in
 * the low four bits, a height band in the high four) and one byte of who owns it.
 */
export const OverviewKind = {
  Sea: 0,
  /** Rivers and canals. */
  Waterway: 1,
  Land: 2,
  Trees: 3,
  Snow: 4,
  Desert: 5,
  Field: 6,
  /** Houses and town streets. */
  Town: 7,
  Industry: 8,
  /** Company roads, bus and truck stops, road depots. */
  Road: 9,
  /** Track, train depots. */
  Rail: 10,
  /** Station platforms, stops, airports and docks. */
  Station: 11,
  /** Headquarters and statues. */
  Building: 12,
  /** Locks and ship depots. */
  WaterWorks: 13,
} as const;
export type OverviewKind = (typeof OverviewKind)[keyof typeof OverviewKind];

/** Cells per side at most: larger maps put more tiles in a cell. */
export const OVERVIEW_MAX_SIDE = 512;

export const overviewScale = (map: { width: number; height: number }): number => Math.max(1, Math.ceil(Math.max(map.width, map.height) / OVERVIEW_MAX_SIDE));

/** Height band (0–15) of a corner height. */
export const heightBand = (h: number): number => Math.min(15, Math.floor(h / 3));

export const overviewKind = (cell: number): OverviewKind => (cell & 15) as OverviewKind;
export const overviewBand = (cell: number): number => cell >> 4;

/** Built things win over the land under them when a cell covers several tiles; higher first. */
const PRIORITY: Record<number, number> = {
  [OverviewKind.Station]: 9,
  [OverviewKind.Rail]: 8,
  [OverviewKind.Road]: 7,
  [OverviewKind.Building]: 6,
  [OverviewKind.WaterWorks]: 5,
  [OverviewKind.Industry]: 4,
  [OverviewKind.Town]: 3,
  [OverviewKind.Waterway]: 2,
};

/** What one tile looks like on the overview. */
export function tileKind(map: GameMap, i: number): OverviewKind {
  const L = map.layers;
  switch (L.type[i]) {
    case TileType.Water:
      return L.data[i]! & (WATER_RIVER | WATER_CANAL) ? OverviewKind.Waterway : OverviewKind.Sea;
    case TileType.Rail:
    case TileType.Depot:
      return OverviewKind.Rail;
    case TileType.Road:
      return L.owner[i] === OWNER_NONE ? OverviewKind.Town : OverviewKind.Road;
    case TileType.RoadDepot:
      return OverviewKind.Road;
    case TileType.Station:
    case TileType.RoadStop:
    case TileType.Airport:
    case TileType.Dock:
      return OverviewKind.Station;
    case TileType.House:
      return OverviewKind.Town;
    case TileType.Industry:
      return OverviewKind.Industry;
    case TileType.Lock:
    case TileType.ShipDepot:
      return OverviewKind.WaterWorks;
    case TileType.Statue:
    case TileType.Headquarters:
      return OverviewKind.Building;
    default: {
      const data = L.data[i]!;
      const ground = (data >> 3) & 7;
      if (ground === Ground.Field) return OverviewKind.Field;
      if ((data & 7) >= 2) return OverviewKind.Trees;
      if (ground === Ground.Snow) return OverviewKind.Snow;
      if (ground === Ground.Sand) return OverviewKind.Desert;
      return OverviewKind.Land;
    }
  }
}

export interface Overview {
  scale: number;
  /** Cells across and down. */
  w: number;
  h: number;
  cells: Uint8Array;
  owners: Uint8Array;
}

export function emptyOverview(map: { width: number; height: number }): Overview {
  const scale = overviewScale(map);
  const w = Math.ceil(map.width / scale);
  const h = Math.ceil(map.height / scale);
  return { scale, w, h, cells: new Uint8Array(w * h), owners: new Uint8Array(w * h).fill(OWNER_NONE) };
}

/** Recompute the cells covering tiles x0..x1, y0..y1 (exclusive ends). Returns whether any changed. */
export function updateOverview(map: GameMap, ov: Overview, x0: number, y0: number, x1: number, y1: number): boolean {
  const s = ov.scale;
  let changed = false;
  for (let cy = Math.floor(y0 / s); cy < Math.ceil(y1 / s); cy++) {
    for (let cx = Math.floor(x0 / s); cx < Math.ceil(x1 / s); cx++) {
      const tx0 = cx * s;
      const ty0 = cy * s;
      // The land is what lies in the middle of the cell; anything built anywhere in it shows over that.
      const mid = map.tileIndex(Math.min(map.width - 1, tx0 + (s >> 1)), Math.min(map.height - 1, ty0 + (s >> 1)));
      let kind: number = tileKind(map, mid);
      let owner = map.layers.owner[mid]!;
      let best = PRIORITY[kind] ?? 0;
      for (let ty = ty0; ty < Math.min(map.height, ty0 + s); ty++) {
        for (let tx = tx0; tx < Math.min(map.width, tx0 + s); tx++) {
          const i = map.tileIndex(tx, ty);
          const k = tileKind(map, i);
          const p = PRIORITY[k] ?? 0;
          if (p > best) {
            best = p;
            kind = k;
            owner = map.layers.owner[i]!;
          }
        }
      }
      const mx = Math.min(map.width, tx0 + (s >> 1));
      const my = Math.min(map.height, ty0 + (s >> 1));
      const cell = kind | (heightBand(map.heights[my * (map.width + 1) + mx]!) << 4);
      const o = PRIORITY[kind] ? owner : OWNER_NONE;
      const at = cy * ov.w + cx;
      if (ov.cells[at] !== cell || ov.owners[at] !== o) {
        ov.cells[at] = cell;
        ov.owners[at] = o;
        changed = true;
      }
    }
  }
  return changed;
}

/** The overview of a whole map. */
export function buildOverview(map: GameMap): Overview {
  const ov = emptyOverview(map);
  updateOverview(map, ov, 0, 0, map.width, map.height);
  return ov;
}

/** Cells of the rectangle (in cells) cx..cx+w, cy..cy+h, row by row. */
export function overviewPatch(ov: Overview, cx: number, cy: number, w: number, h: number): { cells: Uint8Array; owners: Uint8Array } {
  const cells = new Uint8Array(w * h);
  const owners = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    cells.set(ov.cells.subarray((cy + y) * ov.w + cx, (cy + y) * ov.w + cx + w), y * w);
    owners.set(ov.owners.subarray((cy + y) * ov.w + cx, (cy + y) * ov.w + cx + w), y * w);
  }
  return { cells, owners };
}

/** Write a patch (from overviewPatch) back into an overview. */
export function applyOverviewPatch(ov: Overview, cx: number, cy: number, w: number, h: number, cells: Uint8Array, owners: Uint8Array): void {
  for (let y = 0; y < h; y++) {
    ov.cells.set(cells.subarray(y * w, y * w + w), (cy + y) * ov.w + cx);
    ov.owners.set(owners.subarray(y * w, y * w + w), (cy + y) * ov.w + cx);
  }
}

/** The cells (x, y, w, h) covering a chunk. */
export function chunkCells(ov: Overview, chunkX: number, chunkY: number): [number, number, number, number] {
  const per = CHUNK_SIZE / ov.scale;
  const x = Math.floor(chunkX * per);
  const y = Math.floor(chunkY * per);
  return [x, y, Math.min(ov.w - x, Math.ceil(per)), Math.min(ov.h - y, Math.ceil(per))];
}

/** Run-length encoding: pairs of (run length 1–255, value). Sea and plain land shrink a lot. */
export function rle(bytes: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; ) {
    const v = bytes[i]!;
    let n = 1;
    while (n < 255 && i + n < bytes.length && bytes[i + n] === v) n++;
    out.push(n, v);
    i += n;
  }
  return Uint8Array.from(out);
}

export function unrle(bytes: Uint8Array, length: number): Uint8Array {
  const out = new Uint8Array(length);
  let at = 0;
  for (let i = 0; i + 1 < bytes.length && at < length; i += 2) {
    out.fill(bytes[i + 1]!, at, Math.min(length, at + bytes[i]!));
    at += bytes[i]!;
  }
  return out;
}
