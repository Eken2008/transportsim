import { CROSSING_FLAG } from '../commands/track.ts';
import { EDGE_DX, EDGE_DY, EDGE_MID_X, EDGE_MID_Y, OPPOSITE_EDGE, type Edge } from '../rail/track.ts';
import { oneWayAllows, roadBitsAt, ROAD_EDGE_BITS } from '../town/road.ts';
import { TileType } from '../world/constants.ts';
import type { GameMap } from '../world/map.ts';
import { MinHeap } from '../util/heap.ts';

/**
 * Road vehicles move along *road segments*: a tile crossed from one edge to another, packed as
 * tile * 16 + entry * 4 + exit. Entry and exit equal means a U-turn on the tile. Traffic keeps
 * left. The same packing as rail segments (tile * 16 + code) lets trains and road vehicles
 * share the path/route fields and `segTile`.
 */
export const roadSeg = (tile: number, entry: number, exit: number) => tile * 16 + entry * 4 + exit;
export const rsTile = (s: number) => Math.floor(s / 16);
export const rsEntry = (s: number) => ((s % 16) >> 2) as Edge;
export const rsExit = (s: number) => (s % 4) as Edge;
export const rsReverse = (s: number) => roadSeg(rsTile(s), rsExit(s), rsEntry(s));
export const isUTurn = (s: number) => rsEntry(s) === rsExit(s);

/** Length (tiles) of a road segment: straight 1, a turn 0.8, a U-turn 1.2. */
export function rsLength(s: number): number {
  const a = rsEntry(s);
  const b = rsExit(s);
  return a === b ? 1.2 : OPPOSITE_EDGE[a] === b ? 1 : 0.8;
}

/** Road bits of a tile as road vehicles see it: roads, crossings, stops, and a depot's door. */
export function roadBits(map: GameMap, tile: number): number {
  const type = map.layers.type[tile]!;
  if (type === TileType.RoadDepot) return ROAD_EDGE_BITS[map.layers.data[tile]! & 3]!;
  return roadBitsAt(type, map.layers.data[tile]!, map.layers.track[tile]!);
}

const countBits = (b: number) => (b & 1) + ((b >> 1) & 1) + ((b >> 2) & 1) + ((b >> 3) & 1);

/** Is the tile a junction (three or four ways)? Junction tiles take one vehicle at a time. */
export const isJunction = (map: GameMap, tile: number) => countBits(roadBits(map, tile)) >= 3;

/**
 * Segments a road vehicle can continue onto after `s`. From the next tile (unless a cliff parts
 * the two): on to any road edge except back the way it came (a U-turn only at a dead end),
 * respecting one-way roads. Into a road depot only through its door.
 */
export function roadNext(map: GameMap, s: number, out: number[] = []): number[] {
  out.length = 0;
  const tile = rsTile(s);
  const exit = rsExit(s);
  const w = map.width;
  const x = (tile % w) + EDGE_DX[exit];
  const y = Math.floor(tile / w) + EDGE_DY[exit];
  if (x < 0 || y < 0 || x >= w || y >= map.height) return out;
  const n = y * w + x;
  const entry = OPPOSITE_EDGE[exit];
  const bits = roadBits(map, n);
  if (!(bits & ROAD_EDGE_BITS[entry]!) || !map.surfacesMeet(tile, exit, n)) return out; // no road, or a cliff
  const type = map.layers.type[n]!;
  if (type === TileType.RoadDepot) {
    out.push(roadSeg(n, entry, entry)); // drive in and turn round inside
    return out;
  }
  const data = map.layers.data[n]!;
  for (let e = 0; e < 4; e++) {
    if (e === entry || !(bits & ROAD_EDGE_BITS[e]!)) continue;
    // Straight across level crossings and stops.
    if ((type === TileType.RoadStop || (type === TileType.Rail && data & CROSSING_FLAG)) && e !== exit) continue;
    if (type === TileType.Road && !oneWayAllows(data, e)) continue;
    out.push(roadSeg(n, entry, e));
  }
  if (out.length === 0 && countBits(bits) === 1) out.push(roadSeg(n, entry, entry)); // dead end: turn round
  return out;
}

/** Does this road segment still exist (its tile still has road on both of its edges)? */
export function roadSegExists(map: GameMap, s: number): boolean {
  const tile = rsTile(s);
  if (map.layers.type[tile] === TileType.RoadDepot) {
    // Depot segments run between the door and the inside.
    const door = map.layers.data[tile]! & 3;
    return rsEntry(s) === door || rsExit(s) === door;
  }
  const bits = roadBits(map, tile);
  return (bits & ROAD_EDGE_BITS[rsEntry(s)]!) !== 0 && (bits & ROAD_EDGE_BITS[rsExit(s)]!) !== 0;
}

/** Segment leaving a road depot through its door. */
export function roadDepotExit(map: GameMap, depot: number): number {
  const exit = map.layers.data[depot]! & 3;
  return roadSeg(depot, OPPOSITE_EDGE[exit as Edge], exit);
}

/**
 * A* over road segments from `start` to any segment whose tile is in `goals`. Returns the
 * segments after `start`, or null.
 */
export function findRoadPath(map: GameMap, start: number, goals: ReadonlySet<number>, penalty?: (s: number) => number, maxNodes = 40_000): number[] | null {
  const w = map.width;
  const gx: number[] = [];
  const gy: number[] = [];
  for (const g of goals) {
    gx.push(g % w);
    gy.push(Math.floor(g / w));
  }
  if (gx.length === 0) return null;
  const h = (s: number) => {
    const t = rsTile(s);
    const x = t % w;
    const y = (t - x) / w;
    let best = Infinity;
    for (let i = 0; i < gx.length; i++) best = Math.min(best, Math.abs(gx[i]! - x) + Math.abs(gy[i]! - y));
    return best;
  };
  const g = new Map<number, number>([[start, 0]]);
  const prev = new Map<number, number>();
  const open = new MinHeap();
  open.push(h(start), start);
  const closed = new Set<number>();
  const next: number[] = [];
  let expanded = 0;
  while (open.size) {
    const cur = open.pop();
    if (closed.has(cur)) continue;
    closed.add(cur);
    if (cur !== start && goals.has(rsTile(cur))) {
      const path: number[] = [];
      for (let s = cur; s !== start; s = prev.get(s)!) path.push(s);
      return path.reverse();
    }
    if (++expanded > maxNodes) return null;
    for (const n of roadNext(map, cur, next)) {
      const cost = g.get(cur)! + rsLength(n) + (isUTurn(n) ? 3 : 0) + (penalty?.(n) ?? 0);
      if (cost < (g.get(n) ?? Infinity)) {
        g.set(n, cost);
        prev.set(n, cur);
        open.push(cost + h(n), n);
      }
    }
  }
  return null;
}

/** Lane offset from the road centre line (traffic keeps left). */
export const LANE_OFFSET = 0.16;

/**
 * Tile-space position at distance `d` along a road segment, in the left lane, and the heading.
 * Straight: edge to edge; turns: a quarter circle about the shared corner; U-turn: out to the
 * centre and back.
 */
export function roadSegPoint(map: GameMap, s: number, d: number): { x: number; y: number; dx: number; dy: number } {
  const tile = rsTile(s);
  const tx = tile % map.width;
  const ty = (tile - tx) / map.width;
  const a = rsEntry(s);
  const b = rsExit(s);
  const len = rsLength(s);
  const t = Math.max(0, Math.min(1, d / len));
  // Unit direction into the tile from the entry edge, and out through the exit edge.
  const inX = -(EDGE_MID_X[a] - 0.5) * 2;
  const inY = -(EDGE_MID_Y[a] - 0.5) * 2;
  const outX = (EDGE_MID_X[b] - 0.5) * 2;
  const outY = (EDGE_MID_Y[b] - 0.5) * 2;
  let x: number;
  let y: number;
  let dx: number;
  let dy: number;
  if (a === b) {
    // U-turn: in to the centre, then back out on the other side.
    const half = t < 0.5;
    const k = half ? t * 2 : (1 - t) * 2; // 0 at the edge, 1 at the centre
    dx = half ? inX : -inX;
    dy = half ? inY : -inY;
    x = EDGE_MID_X[a] + inX * 0.5 * k;
    y = EDGE_MID_Y[a] + inY * 0.5 * k;
  } else if (OPPOSITE_EDGE[a] === b) {
    x = EDGE_MID_X[a] + (EDGE_MID_X[b] - EDGE_MID_X[a]) * t;
    y = EDGE_MID_Y[a] + (EDGE_MID_Y[b] - EDGE_MID_Y[a]) * t;
    dx = outX;
    dy = outY;
  } else {
    // Quarter circle (quadratic through the tile centre).
    const p0x = EDGE_MID_X[a];
    const p0y = EDGE_MID_Y[a];
    const p2x = EDGE_MID_X[b];
    const p2y = EDGE_MID_Y[b];
    const u = 1 - t;
    x = u * u * p0x + 2 * u * t * 0.5 + t * t * p2x;
    y = u * u * p0y + 2 * u * t * 0.5 + t * t * p2y;
    dx = 2 * u * (0.5 - p0x) + 2 * t * (p2x - 0.5);
    dy = 2 * u * (0.5 - p0y) + 2 * t * (p2y - 0.5);
    const l = Math.hypot(dx, dy) || 1;
    dx /= l;
    dy /= l;
  }
  // Keep left: the left of heading (dx, dy) in map space (y south) is (dy, -dx).
  return { x: tx + x + dy * LANE_OFFSET, y: ty + y - dx * LANE_OFFSET, dx, dy };
}
