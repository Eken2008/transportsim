import { TileType } from '../world/constants.ts';
import type { GameMap } from '../world/map.ts';
import { depotExit } from './station.ts';
import {
  EDGE_DX,
  EDGE_DY,
  OPPOSITE_EDGE,
  PIECE_EDGES,
  TD_HEADING,
  hasPiece,
  pieceLength,
  tdEntry,
  tdExit,
  tdPiece,
  trackdir,
  turnSteps,
} from './track.ts';

/**
 * A *segment* is one track piece on one tile traversed in one direction, packed into a
 * number: tileIndex * 16 + trackdir. It is the unit of train movement and pathfinding.
 */
export const seg = (tile: number, td: number) => tile * 16 + td;
export const segTile = (s: number) => Math.floor(s / 16);
export const segTd = (s: number) => s % 16;
export const segPiece = (s: number) => (s % 16) >> 1;
export const segReverse = (s: number) => s ^ 1;
export const segLength = (s: number) => pieceLength((s % 16) >> 1);
/** Direction-independent key of the physical piece (for occupancy). */
export const pieceKey = (s: number) => Math.floor(s / 16) * 8 + ((s % 16) >> 1);

export function isTrackTile(type: number): boolean {
  return type === TileType.Rail || type === TileType.Station || type === TileType.Depot;
}

/**
 * Segments a train can continue onto after leaving `s` through its exit edge. 90° turns are
 * not allowed. Depots can only be entered and left through their door edge.
 */
export function nextSegments(map: GameMap, s: number, owner: number, out: number[] = []): number[] {
  out.length = 0;
  const tile = segTile(s);
  const td = segTd(s);
  const w = map.width;
  const x = tile % w;
  const y = (tile - x) / w;
  const exit = tdExit(td);
  if (map.layers.type[tile] === TileType.Depot && exit !== depotExit(map.layers.data[tile]!)) return out; // back wall
  const nx = x + EDGE_DX[exit];
  const ny = y + EDGE_DY[exit];
  if (nx < 0 || ny < 0 || nx >= w || ny >= map.height) return out;
  const n = ny * w + nx;
  const type = map.layers.type[n]!;
  if (!isTrackTile(type) || map.layers.owner[n] !== owner) return out;
  const entry = OPPOSITE_EDGE[exit];
  if (type === TileType.Depot && entry !== depotExit(map.layers.data[n]!)) return out;
  // Heights must match at the shared edge (they do by construction, since corners are shared).
  const bits = map.layers.track[n]!;
  const heading = TD_HEADING[td]!;
  for (let p = 0; p < 6; p++) {
    if (!hasPiece(bits, p)) continue;
    const [e0, e1] = PIECE_EDGES[p]!;
    let ntd: number;
    if (e0 === entry) ntd = trackdir(p, 0);
    else if (e1 === entry) ntd = trackdir(p, 1);
    else continue;
    if (turnSteps(heading, TD_HEADING[ntd]!) > 1) continue;
    out.push(n * 16 + ntd);
  }
  return out;
}

/** Whether segment `b` directly follows segment `a`. */
export function segmentsConnect(map: GameMap, a: number, b: number, owner: number): boolean {
  return nextSegments(map, a, owner).includes(b);
}

/** Whether a segment's piece still exists on its tile (track may have been removed). */
export function segmentExists(map: GameMap, s: number): boolean {
  const tile = segTile(s);
  if (tile < 0 || tile >= map.layers.type.length) return false;
  return isTrackTile(map.layers.type[tile]!) && hasPiece(map.layers.track[tile]!, segPiece(s));
}

/** Segment leaving a depot through its door. */
export function depotExitSegment(map: GameMap, tile: number): number {
  const exit = depotExit(map.layers.data[tile]!);
  const piece = exit === 1 || exit === 3 ? 0 : 1; // X or Y
  const [, e1] = PIECE_EDGES[piece]!;
  return seg(tile, trackdir(piece, e1 === exit ? 0 : 1));
}

/** Tile-space position of a point at distance `d` (0..len) along a segment. */
export function segPoint(map: GameMap, s: number, d: number): { x: number; y: number } {
  const tile = segTile(s);
  const td = segTd(s);
  const x = tile % map.width;
  const y = (tile - x) / map.width;
  const a = tdEntry(td);
  const b = tdExit(td);
  const t = d / pieceLength(tdPiece(td));
  const ax = [0.5, 1, 0.5, 0][a]!;
  const ay = [0, 0.5, 1, 0.5][a]!;
  const bx = [0.5, 1, 0.5, 0][b]!;
  const by = [0, 0.5, 1, 0.5][b]!;
  return { x: x + ax + (bx - ax) * t, y: y + ay + (by - ay) * t };
}
