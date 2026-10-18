import { CROSSING_FLAG } from '../commands/track.ts';
import { ROAD_E, ROAD_N, ROAD_S, ROAD_W } from '../town/road.ts';
import { TileType } from '../world/constants.ts';
import type { GameMap } from '../world/map.ts';
import { HEAD_BRIDGE, HEAD_TUNNEL } from './structures.ts';
import {
  EDGE_DX,
  EDGE_DY,
  OPPOSITE_EDGE,
  PIECE_EDGES,
  TD_HEADING,
  hasPiece,
  pieceFitsSlope,
  pieceLength,
  tdEntry,
  tdExit,
  tdPiece,
  trackdir,
  turnSteps,
  type Edge,
  type PlacedPiece,
} from './track.ts';

export interface PlanOptions {
  owner: number;
  /** Extra tiles around the start/end box the route may wander into. */
  margin?: number;
  maxNodes?: number;
}

/** Cost of a heading change (45°). Keeps routes straight unless turning pays off. */
const TURN_COST = 0.45;
/** Reusing a piece that already exists is a little cheaper than building one. */
const EXISTING_FACTOR = 0.85;
/** Making a new switch on existing track along the way (not at the start or end). */
const JUNCTION_COST = 2.5;
/** Making a new level crossing of existing track along the way. */
const DIAMOND_COST = 0.4;
/** Starting or ending without joining nearby track. */
const LOOSE_END_COST = 2;

type Build = 'existing' | 'new' | null;

/** Can `piece` be on this tile for `owner` (already there, or buildable)? */
function pieceStatus(map: GameMap, x: number, y: number, piece: number, owner: number): Build {
  if (!map.inBounds(x, y)) return null;
  const i = map.tileIndex(x, y);
  const type = map.layers.type[i];
  const bits = map.layers.track[i]!;
  if (type === TileType.Rail || type === TileType.Station || type === TileType.Depot) {
    if (map.layers.owner[i] !== owner) return null;
    if (hasPiece(bits, piece)) return 'existing';
    if (type !== TileType.Rail) return null;
    const data = map.layers.data[i]!;
    if (data & (CROSSING_FLAG | HEAD_BRIDGE | HEAD_TUNNEL) || map.layers.signals[i]) return null;
    return pieceFitsSlope(map.tileCorners(x, y), piece) ? 'new' : null;
  }
  if (type === TileType.Clear) return pieceFitsSlope(map.tileCorners(x, y), piece) ? 'new' : null;
  if (type === TileType.Road) {
    const road = map.layers.data[i]! & 0xf;
    const ok = (piece === 0 && road === (ROAD_N | ROAD_S)) || (piece === 1 && road === (ROAD_E | ROAD_W));
    return ok && pieceFitsSlope(map.tileCorners(x, y), piece) ? 'new' : null;
  }
  return null;
}

/**
 * Does existing track on the neighbour across `edge` touch this tile and continue smoothly
 * from `heading` (null: any heading)?
 */
function joinsAcross(map: GameMap, x: number, y: number, edge: Edge, heading: number | null, owner: number, outward: boolean): boolean {
  const nx = x + EDGE_DX[edge];
  const ny = y + EDGE_DY[edge];
  if (!map.inBounds(nx, ny)) return false;
  const n = map.tileIndex(nx, ny);
  const type = map.layers.type[n];
  if (type !== TileType.Rail && type !== TileType.Station && type !== TileType.Depot) return false;
  if (map.layers.owner[n] !== owner) return false;
  const back = OPPOSITE_EDGE[edge];
  for (let p = 0; p < 6; p++) {
    if (!hasPiece(map.layers.track[n]!, p)) continue;
    const [e0, e1] = PIECE_EDGES[p]!;
    if (e0 !== back && e1 !== back) continue;
    if (heading === null) return true;
    // Direction of travel on the neighbour's piece, matching ours.
    const td = outward ? trackdir(p, e0 === back ? 0 : 1) : trackdir(p, e0 === back ? 1 : 0);
    if (turnSteps(heading, TD_HEADING[td]!) <= 1) return true;
  }
  return false;
}

/**
 * Find a buildable track route from tile (x0, y0) to tile (x1, y1): no 90° turns, few turns,
 * reusing existing track, and joining existing track at both ends where possible.
 * Returns the pieces to build (existing ones included), or null if there is no route.
 */
export function planTrack(map: GameMap, x0: number, y0: number, x1: number, y1: number, opts: PlanOptions): PlacedPiece[] | null {
  if (!map.inBounds(x0, y0) || !map.inBounds(x1, y1)) return null;
  const margin = opts.margin ?? 6;
  const bx0 = Math.min(x0, x1) - margin;
  const by0 = Math.min(y0, y1) - margin;
  const bx1 = Math.max(x0, x1) + margin;
  const by1 = Math.max(y0, y1) + margin;
  const maxNodes = opts.maxNodes ?? 40_000;
  const w = map.width;
  const key = (x: number, y: number, td: number) => (y * w + x) * 16 + td;
  const g = new Map<number, number>();
  const parent = new Map<number, number>();
  // Small binary heap of [f, key]
  const heap: [number, number][] = [];
  const push = (f: number, k: number) => {
    heap.push([f, k]);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (heap[p]![0] <= f) break;
      [heap[p], heap[i]] = [heap[i]!, heap[p]!];
      i = p;
    }
  };
  const pop = (): number => {
    const top = heap[0]![1];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
        if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i]!, heap[m]!];
        i = m;
      }
    }
    return top;
  };
  const h = (x: number, y: number) => Math.hypot(x - x1, y - y1) * 0.7;
  const pieceCost = (status: Build, piece: number) => pieceLength(piece) * (status === 'existing' ? EXISTING_FACTOR : 1);
  /** Ending on the target tile: prefer leaving towards track that's already there. */
  const endCost = (x: number, y: number, td: number) => {
    if (joinsAcross(map, x, y, tdExit(td), TD_HEADING[td]!, opts.owner, true)) return 0;
    for (const e of [0, 1, 2, 3] as Edge[]) {
      if (joinsAcross(map, x, y, e, null, opts.owner, true)) return LOOSE_END_COST; // track nearby, but we don't join it
    }
    return 0;
  };

  // Start: any piece on the start tile, cheaper if it continues track that leads into it.
  for (let td = 0; td < 12; td++) {
    const status = pieceStatus(map, x0, y0, tdPiece(td), opts.owner);
    if (!status) continue;
    const joins = joinsAcross(map, x0, y0, tdEntry(td), TD_HEADING[td]!, opts.owner, false);
    let cost = pieceCost(status, tdPiece(td)) + (joins ? 0 : LOOSE_END_COST * 0.5);
    if (x0 === x1 && y0 === y1) cost += endCost(x0, y0, td);
    const k = key(x0, y0, td);
    g.set(k, cost);
    push(cost + h(x0, y0), k);
  }

  let expanded = 0;
  while (heap.length) {
    const cur = pop();
    const td = cur % 16;
    const tile = (cur - td) / 16;
    const x = tile % w;
    const y = (tile - x) / w;
    if (x === x1 && y === y1) {
      const out: PlacedPiece[] = [];
      for (let k: number | undefined = cur; k !== undefined; k = parent.get(k)) {
        const t = k % 16;
        const ti = (k - t) / 16;
        out.push({ x: ti % w, y: Math.floor(ti / w), piece: tdPiece(t) as PlacedPiece['piece'] });
      }
      return out.reverse();
    }
    if (++expanded > maxNodes) return null;
    const gc = g.get(cur)!;
    const exit = tdExit(td);
    const nx = x + EDGE_DX[exit];
    const ny = y + EDGE_DY[exit];
    if (nx < bx0 || ny < by0 || nx > bx1 || ny > by1) continue;
    const entry = OPPOSITE_EDGE[exit];
    for (let p = 0; p < 6; p++) {
      const [e0, e1] = PIECE_EDGES[p]!;
      if (e0 !== entry && e1 !== entry) continue;
      const ntd = trackdir(p, e0 === entry ? 0 : 1);
      const turn = turnSteps(TD_HEADING[td]!, TD_HEADING[ntd]!);
      if (turn > 1) continue;
      const status = pieceStatus(map, nx, ny, p, opts.owner);
      if (!status) continue;
      let cost = gc + pieceCost(status, p) + turn * TURN_COST;
      if (status === 'new' && !(nx === x1 && ny === y1)) {
        // Joining or crossing track mid-route only where it pays off; the drag ends are free.
        const bits = map.layers.track[map.tileIndex(nx, ny)]!;
        if (bits) cost += touchesEdge(bits, p) ? JUNCTION_COST : DIAMOND_COST;
      }
      if (nx === x1 && ny === y1) cost += endCost(nx, ny, ntd);
      const k = key(nx, ny, ntd);
      const old = g.get(k);
      if (old !== undefined && old <= cost) continue;
      g.set(k, cost);
      parent.set(k, cur);
      push(cost + h(nx, ny), k);
    }
  }
  return null;
}

/** Does piece p share an edge with any piece in `bits` (i.e. would adding it make a switch)? */
function touchesEdge(bits: number, p: number): boolean {
  const [a0, a1] = PIECE_EDGES[p]!;
  for (let q = 0; q < 6; q++) {
    if (q === p || !hasPiece(bits, q)) continue;
    const [b0, b1] = PIECE_EDGES[q]!;
    if (a0 === b0 || a0 === b1 || a1 === b0 || a1 === b1) return true;
  }
  return false;
}
