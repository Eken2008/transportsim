import { EDGE_DX, EDGE_DY } from '../rail/track.ts';
import { TileType, WATER_BUOY, WATER_CANAL } from '../world/constants.ts';
import type { GameMap } from '../world/map.ts';

/**
 * Waterways: the sea (Water tiles at height 0), canals (Water tiles with WATER_CANAL, flat at any
 * height), locks (a straight slope linking two levels), ship depots and docks. Every Water tile
 * is flat, so neighbouring water tiles always share a level; only locks change level.
 */

export const isCanal = (map: GameMap, i: number) => map.layers.type[i] === TileType.Water && (map.layers.data[i]! & WATER_CANAL) !== 0;
export const hasBuoy = (map: GameMap, i: number) => map.layers.type[i] === TileType.Water && (map.layers.data[i]! & WATER_BUOY) !== 0;

/** Axis of a lock or ship depot: 0 = ships move east-west, 1 = north-south. */
export const waterAxis = (map: GameMap, i: number) => map.layers.data[i]! & 1;

/** Edges along an axis. */
const AXIS_EDGES = [
  [1, 3],
  [0, 2],
] as const;

/** Can a ship be on this tile? Depots only count as an end point (see `shipStep`). */
export function navigable(map: GameMap, i: number): boolean {
  const t = map.layers.type[i];
  return t === TileType.Water || t === TileType.Lock || t === TileType.ShipDepot;
}

/** Does this tile let ships in or out across `edge`? */
function openEdge(map: GameMap, i: number, edge: number): boolean {
  const t = map.layers.type[i];
  if (t === TileType.Water) return true;
  if (t === TileType.Lock || t === TileType.ShipDepot) return (AXIS_EDGES[waterAxis(map, i)] as readonly number[]).includes(edge);
  return false;
}

/** The tile across `edge`, if a ship can sail there from `i` (depots only if `depotOk`). */
export function shipStep(map: GameMap, i: number, edge: number, depotOk = false): number {
  const x = i % map.width;
  const y = (i - x) / map.width;
  const nx = x + EDGE_DX[edge as 0]!;
  const ny = y + EDGE_DY[edge as 0]!;
  if (!map.inBounds(nx, ny)) return -1;
  const n = ny * map.width + nx;
  if (!navigable(map, n) || !openEdge(map, i, edge) || !openEdge(map, n, (edge + 2) & 3)) return -1;
  if (map.layers.type[n] === TileType.ShipDepot && !depotOk) return -1;
  return n;
}

/** Height (in height levels) of the water surface on a tile, for drawing; -1 if not water. */
export function waterLevelAt(map: GameMap, x: number, y: number): number {
  const i = map.tileIndex(x, y);
  const t = map.layers.type[i];
  if (t === TileType.Water || t === TileType.ShipDepot) return map.tileMinHeight(x, y);
  if (t === TileType.Lock) return (map.tileMinHeight(x, y) + map.tileMaxHeight(x, y)) / 2;
  return -1;
}

/**
 * Water level at a point inside a tile (continuous across locks, where it ramps between the two
 * levels), for placing ships.
 */
export function waterLevelAtPoint(map: GameMap, px: number, py: number): number {
  const x = Math.max(0, Math.min(map.width - 1, Math.floor(px)));
  const y = Math.max(0, Math.min(map.height - 1, Math.floor(py)));
  const i = map.tileIndex(x, y);
  if (map.layers.type[i] !== TileType.Lock) return Math.max(0, waterLevelAt(map, x, y));
  const [nw, ne, , sw] = map.tileCorners(x, y);
  // The west (or north) edge is at the nw corner's height, the far edge at ne (or sw).
  const alongX = waterAxis(map, i) === 0;
  const f = alongX ? px - x : py - y;
  const far = alongX ? ne : sw;
  return nw + (far - nw) * Math.max(0, Math.min(1, f));
}

/** Is a lock possible on this tile: a straight slope rising one level along an axis? Returns the axis or -1. */
export function lockAxisFor(map: GameMap, x: number, y: number): number {
  const [nw, ne, se, sw] = map.tileCorners(x, y);
  if (nw === sw && ne === se && Math.abs(nw - ne) === 1) return 0;
  if (nw === ne && sw === se && Math.abs(nw - sw) === 1) return 1;
  return -1;
}

/** The water tile a dock faces (its loading berth). */
export function dockBerth(map: GameMap, dock: number): number {
  const edge = map.layers.track[dock]! & 3;
  const x = dock % map.width;
  const y = (dock - x) / map.width;
  return map.tileIndex(x + EDGE_DX[edge as 0]!, y + EDGE_DY[edge as 0]!);
}

/** Dock tiles of a station. */
export function stationDocks(map: GameMap, st: { id: number; x0: number; y0: number; x1: number; y1: number }): number[] {
  const out: number[] = [];
  for (let y = Math.max(0, st.y0); y <= Math.min(map.height - 1, st.y1); y++) {
    for (let x = Math.max(0, st.x0); x <= Math.min(map.width - 1, st.x1); x++) {
      const i = map.tileIndex(x, y);
      if (map.layers.type[i] === TileType.Dock && map.layers.data[i] === st.id) out.push(i);
    }
  }
  return out;
}
