import { CROSSING_FLAG } from '../commands/track.ts';
import { ROAD_E, ROAD_N, ROAD_S, ROAD_W } from '../town/road.ts';
import { TileType } from '../world/constants.ts';
import type { GameMap } from '../world/map.ts';
import { HEAD_BRIDGE, HEAD_TUNNEL } from './structures.ts';
import { linkCandidates } from './links.ts';
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
/** Starting a new piece beside existing track on the start tile without joining it. */
const LOOSE_START_COST = 1.5;
/** Starting or ending a route pointing away from the drag direction (per 45°). */
const ALIGN_COST = 0.6;
/** Building over a tile that already has track (it is crossed, not joined): only a tie-breaker. */
const DIAMOND_COST = 0.02;

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
  // Search state: tile, trackdir, and whether every piece so far is existing track (riding
  // along existing track from the start of the drag).
  // ...and, on a corner piece, the heading before it (8 = none), so the route never bends 90°
  // through a single corner piece (track doesn't connect that way).
  const key = (x: number, y: number, td: number, riding: boolean, prev: number) =>
    (((y * w + x) * 16 + td) * 2 + (riding ? 1 : 0)) * 9 + prev;
  const decode = (k: number) => {
    const prev = k % 9;
    const r = Math.floor(k / 9);
    return { prev, riding: r % 2 === 1, td: Math.floor(r / 2) % 16, tile: Math.floor(r / 32) };
  };
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
  // The route should start and end heading the way the player dragged.
  const dragHeading = (Math.round(Math.atan2(y1 - y0, x1 - x0) / (Math.PI / 4)) + 8) % 8;
  const misalign = (td: number) => (x0 === x1 && y0 === y1 ? 0 : turnSteps(TD_HEADING[td]!, dragHeading) * ALIGN_COST);
  const pieceCost = (status: Build, piece: number) => pieceLength(piece) * (status === 'existing' ? EXISTING_FACTOR : 1);

  // Start: any piece on the start tile. The planner doesn't steer towards connections; pieces
  // built together connect, and loose ends connect to track they touch (see rail/links.ts).
  for (let td = 0; td < 12; td++) {
    const status = pieceStatus(map, x0, y0, tdPiece(td), opts.owner);
    if (!status) continue;
    let cost = pieceCost(status, tdPiece(td)) + misalign(td);
    // Starting on a tile with track: a new first piece should begin where that track comes in
    // (branching off it), not sit beside it unconnected — otherwise continue the existing piece.
    if (status === 'new' && map.layers.track[map.tileIndex(x0, y0)]) {
      if (linkCandidates(map, map.tileIndex(x0, y0), tdPiece(td), tdEntry(td)).length === 0) cost += LOOSE_START_COST;
    }
    const k = key(x0, y0, td, status === 'existing', 8);
    g.set(k, cost);
    push(cost + h(x0, y0), k);
  }

  let expanded = 0;
  while (heap.length) {
    const cur = pop();
    const { prev, riding, td, tile } = decode(cur);
    const x = tile % w;
    const y = (tile - x) / w;
    if (x === x1 && y === y1) {
      const out: PlacedPiece[] = [];
      for (let k: number | undefined = cur; k !== undefined; k = parent.get(k)) {
        const { td: t, tile: ti } = decode(k);
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
      if (prev !== 8 && turnSteps(prev, TD_HEADING[ntd]!) > 1) continue; // 90° through a corner
      const status = pieceStatus(map, nx, ny, p, opts.owner);
      if (!status) continue;
      const atEnd = nx === x1 && ny === y1;
      // A route connects to other track only where the drag starts and ends. In between it may
      // keep following track it started on, or cross track at right angles — never join it.
      if (!atEnd && status === 'existing' && !riding) continue;
      let cost = gc + pieceCost(status, p) + turn * TURN_COST;
      if (status === 'new' && !atEnd && map.layers.track[map.tileIndex(nx, ny)]) cost += DIAMOND_COST;
      if (atEnd) cost += misalign(ntd);
      const k = key(nx, ny, ntd, riding && status === 'existing', p >= 2 ? TD_HEADING[td]! : 8);
      const old = g.get(k);
      if (old !== undefined && old <= cost) continue;
      g.set(k, cost);
      parent.set(k, cur);
      push(cost + h(nx, ny), k);
    }
  }
  return null;
}

