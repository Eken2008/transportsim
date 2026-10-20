import { TileType } from '../world/constants.ts';
import type { GameMap } from '../world/map.ts';
import { EDGE_DX, EDGE_DY, Edge, OPPOSITE_EDGE, edgeHeight, isSpanTd, tdEntry, tdExit } from './track.ts';

/**
 * Bridge heads and tunnel portals are Rail tiles carrying one straight piece, marked in the
 * tile's `data`:
 *   bit 9      bridge head
 *   bit 10     tunnel portal
 *   bits 12-13 edge the span leaves through (N/E/S/W)
 *   bits 14-15 bridge type
 */
export const HEAD_BRIDGE = 0x200;
export const HEAD_TUNNEL = 0x400;
const DIR_SHIFT = 12;
const TYPE_SHIFT = 14;

export const MAX_BRIDGE_SPAN = 32;
export const MAX_TUNNEL_LENGTH = 64;

export interface BridgeType {
  name: string;
  /** km/h */
  maxSpeed: number;
  /** Longest span in tiles (middle tiles). */
  maxSpan: number;
  /** Cost per tile of span. */
  costPerTile: number;
  intro: number;
  look: 'wood' | 'girder' | 'suspension' | 'concrete';
}

export const BRIDGE_TYPES: readonly BridgeType[] = [
  { name: 'Timber trestle', maxSpeed: 80, maxSpan: 6, costPerTile: 900, intro: 1850, look: 'wood' },
  { name: 'Steel girder', maxSpeed: 130, maxSpan: 14, costPerTile: 2_000, intro: 1870, look: 'girder' },
  { name: 'Suspension', maxSpeed: 200, maxSpan: 32, costPerTile: 4_200, intro: 1925, look: 'suspension' },
  { name: 'Concrete viaduct', maxSpeed: 320, maxSpan: 24, costPerTile: 3_500, intro: 1960, look: 'concrete' },
];

export interface HeadInfo {
  kind: 'bridge' | 'tunnel';
  /** Edge of the head tile that the span leaves through. */
  dir: Edge;
  bridgeType: number;
}

export function headInfo(map: GameMap, tile: number): HeadInfo | null {
  if (map.layers.type[tile] !== TileType.Rail) return null;
  const d = map.layers.data[tile]!;
  if (!(d & (HEAD_BRIDGE | HEAD_TUNNEL))) return null;
  return {
    kind: d & HEAD_BRIDGE ? 'bridge' : 'tunnel',
    dir: ((d >> DIR_SHIFT) & 3) as Edge,
    bridgeType: (d >> TYPE_SHIFT) & 3,
  };
}

export function headData(kind: 'bridge' | 'tunnel', dir: Edge, bridgeType = 0): number {
  return (kind === 'bridge' ? HEAD_BRIDGE : HEAD_TUNNEL) | (dir << DIR_SHIFT) | ((bridgeType & 3) << TYPE_SHIFT);
}

/** Level of the bridge deck (higher edge of the head) or tunnel floor (outer edge of the portal). */
export function headLevel(map: GameMap, tile: number, info: HeadInfo): number {
  const x = tile % map.width;
  const corners = map.tileCorners(x, (tile - x) / map.width);
  const outer = Math.max(0, edgeHeight(corners, OPPOSITE_EDGE[info.dir]));
  return info.kind === 'bridge' ? Math.max(outer, edgeHeight(corners, info.dir)) : outer;
}

/** The far head of the bridge/tunnel starting at `tile`, or -1. */
export function otherHead(map: GameMap, tile: number, info: HeadInfo): number {
  const w = map.width;
  let x = tile % w;
  let y = (tile - x) / w;
  const max = (info.kind === 'bridge' ? MAX_BRIDGE_SPAN : MAX_TUNNEL_LENGTH) + 1;
  for (let k = 0; k < max; k++) {
    x += EDGE_DX[info.dir];
    y += EDGE_DY[info.dir];
    if (!map.inBounds(x, y)) return -1;
    const t = y * w + x;
    const h = headInfo(map, t);
    if (h && h.kind === info.kind && h.dir === OPPOSITE_EDGE[info.dir]) return t;
  }
  return -1;
}

export interface Span {
  kind: 'bridge' | 'tunnel';
  /** Head tile on the west/north side and on the east/south side. */
  a: number;
  b: number;
  /** Deck / floor level. */
  level: number;
  bridgeType: number;
}

/**
 * The bridge over, or tunnel under, a tile along an axis (0 = X, 1 = Y), if any.
 * Scans back towards the west/north for the nearest head; spans along one axis never nest.
 */
export function spanOver(map: GameMap, tile: number, axis: 0 | 1, kind?: 'bridge' | 'tunnel'): Span | null {
  const w = map.width;
  const x0 = tile % w;
  const y0 = (tile - x0) / w;
  const back = axis === 0 ? Edge.W : Edge.N;
  const fwd = OPPOSITE_EDGE[back];
  for (let k = 1; k <= MAX_TUNNEL_LENGTH + 1; k++) {
    const x = x0 + EDGE_DX[back] * k;
    const y = y0 + EDGE_DY[back] * k;
    if (!map.inBounds(x, y)) return null;
    const t = y * w + x;
    const info = headInfo(map, t);
    if (!info || (kind && info.kind !== kind)) continue;
    if (info.dir !== fwd) {
      if (info.dir === back) return null; // the nearest head faces away: nothing spans us
      continue; // perpendicular head, not on our axis
    }
    const b = otherHead(map, t, info);
    if (b < 0) return null;
    const bx = b % w;
    const by = (b - bx) / w;
    const beyond = axis === 0 ? bx > x0 : by > y0;
    if (!beyond) return null;
    return { kind: info.kind, a: t, b, level: headLevel(map, t, info), bridgeType: info.bridgeType };
  }
  return null;
}

/** Bridges over and tunnels under a tile (both axes). */
export function structuresAt(map: GameMap, tile: number): Span[] {
  const out: Span[] = [];
  for (const axis of [0, 1] as const) {
    for (const kind of ['bridge', 'tunnel'] as const) {
      const s = spanOver(map, tile, axis, kind);
      if (s) out.push(s);
    }
  }
  return out;
}

/**
 * Heights (levels) at the entry and exit of a segment: track on slopes climbs, bridge and
 * tunnel spans stay level, tunnel portals are level at the tunnel floor.
 */
export function segHeights(map: GameMap, tile: number, td: number): [number, number] {
  const w = map.width;
  if (isSpanTd(td)) {
    const axis = td < 14 ? 0 : 1;
    const span = spanOver(map, tile, axis);
    const h = span ? span.level : 0;
    return [h, h];
  }
  const x = tile % w;
  const y = (tile - x) / w;
  const entry = tdEntry(td);
  const exit = tdExit(td);
  const info = headInfo(map, tile);
  if (info) {
    // Tunnel portals are level; bridge ends meet the deck at the span edge.
    const level = headLevel(map, tile, info);
    if (info.kind === 'tunnel') return [level, level];
    const h = (e: number) => (e === info.dir ? level : Math.max(0, map.edgeLevel(x, y, e)));
    return [h(entry), h(exit)];
  }
  // Edges of the surface: foundations included.
  return [Math.max(0, map.edgeLevel(x, y, entry)), Math.max(0, map.edgeLevel(x, y, exit))];
}
