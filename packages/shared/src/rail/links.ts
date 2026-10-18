import { TileType } from '../world/constants.ts';
import type { GameMap } from '../world/map.ts';
import { depotExit } from './station.ts';
import { headInfo } from './structures.ts';
import {
  EDGE_DX,
  EDGE_DY,
  Edge,
  OPPOSITE_EDGE,
  PIECE_EDGES,
  TD_HEADING,
  hasPiece,
  trackdir,
  turnSteps,
} from './track.ts';

/**
 * Explicit track connections. Two pieces on neighbouring tiles that meet at the shared edge are
 * connected only if a link says so — touching alone isn't enough, so a diagonal can cross a
 * straight line without becoming a switch.
 *
 * Each edge has three pieces that can touch it. A tile stores the links across its own north
 * and west edges in the `links` layer: bit (i * 3 + j) for the N edge (bits 0-8) and 9 + (i * 3
 * + j) for the W edge, where i indexes this tile's pieces on that edge and j the neighbour's
 * pieces on the opposite edge (see EDGE_PIECES). Links across S/E edges live on the neighbour.
 */
export const EDGE_PIECES: readonly (readonly number[])[] = [
  [1, 2, 5], // N: Y, NE, NW
  [0, 2, 3], // E: X, NE, SE
  [1, 3, 4], // S: Y, SE, SW
  [0, 4, 5], // W: X, SW, NW
];

export interface PieceEnd {
  tile: number;
  piece: number;
  edge: Edge;
}

export function neighbourTile(map: GameMap, tile: number, edge: Edge): number {
  const w = map.width;
  const x = tile % w;
  const y = (tile - x) / w;
  const nx = x + EDGE_DX[edge];
  const ny = y + EDGE_DY[edge];
  return nx < 0 || ny < 0 || nx >= w || ny >= map.height ? -1 : ny * w + nx;
}

/** Bit position (in the storing tile) of the link between piece `p` on `tile` (edge `e`) and `q` across it. */
function linkBit(map: GameMap, tile: number, p: number, e: Edge, q: number): { holder: number; bit: number } | null {
  const n = neighbourTile(map, tile, e);
  if (n < 0) return null;
  const opp = OPPOSITE_EDGE[e];
  if (e === Edge.N || e === Edge.W) {
    const i = EDGE_PIECES[e]!.indexOf(p);
    const j = EDGE_PIECES[opp]!.indexOf(q);
    if (i < 0 || j < 0) return null;
    return { holder: tile, bit: (e === Edge.W ? 9 : 0) + i * 3 + j };
  }
  const i = EDGE_PIECES[opp]!.indexOf(q);
  const j = EDGE_PIECES[e]!.indexOf(p);
  if (i < 0 || j < 0) return null;
  return { holder: n, bit: (opp === Edge.W ? 9 : 0) + i * 3 + j };
}

export function isLinked(map: GameMap, tile: number, p: number, e: Edge, q: number): boolean {
  const b = linkBit(map, tile, p, e, q);
  return b !== null && ((map.layers.links[b.holder]! >>> b.bit) & 1) === 1;
}

/** Set or clear a link. Returns the tile whose data changed (for chunk dirtiness), or -1. */
export function setLink(map: GameMap, tile: number, p: number, e: Edge, q: number, on: boolean): number {
  const b = linkBit(map, tile, p, e, q);
  if (!b) return -1;
  const cur = map.layers.links[b.holder]!;
  map.layers.links[b.holder] = on ? cur | (1 << b.bit) : cur & ~(1 << b.bit);
  return b.holder;
}

/** Heading when leaving `tile` through edge `e` on piece `p`. */
export function headingOut(p: number, e: Edge): number {
  const [, e1] = PIECE_EDGES[p]!;
  return TD_HEADING[trackdir(p, e1 === e ? 0 : 1)]!;
}

/** Heading when entering a tile through edge `e` on piece `q`. */
export function headingIn(q: number, e: Edge): number {
  const [e0] = PIECE_EDGES[q]!;
  return TD_HEADING[trackdir(q, e0 === e ? 0 : 1)]!;
}

const isTrack = (t: number) => t === TileType.Rail || t === TileType.Station || t === TileType.Depot;

/**
 * Could track cross this edge at all? Bridge/tunnel span sides and depot walls are closed;
 * tiles must both carry track of the same owner.
 */
export function edgeLinkable(map: GameMap, tile: number, e: Edge): number {
  const { type, owner, data } = map.layers;
  if (!isTrack(type[tile]!)) return -1;
  const info = headInfo(map, tile);
  if (info && info.dir === e) return -1;
  if (type[tile] === TileType.Depot && depotExit(data[tile]!) !== e) return -1;
  const n = neighbourTile(map, tile, e);
  if (n < 0 || !isTrack(type[n]!) || owner[n] !== owner[tile]) return -1;
  const opp = OPPOSITE_EDGE[e];
  const ninfo = headInfo(map, n);
  if (ninfo && ninfo.dir === opp) return -1;
  if (type[n] === TileType.Depot && depotExit(data[n]!) !== opp) return -1;
  return n;
}

/** Pieces across edge `e` that piece `p` on `tile` could link to (≤ 45° turn), straightest first. */
export function linkCandidates(map: GameMap, tile: number, p: number, e: Edge): number[] {
  const n = edgeLinkable(map, tile, e);
  if (n < 0) return [];
  const opp = OPPOSITE_EDGE[e];
  const out: { q: number; turn: number }[] = [];
  for (const q of EDGE_PIECES[opp]!) {
    if (!hasPiece(map.layers.track[n]!, q)) continue;
    const turn = turnSteps(headingOut(p, e), headingIn(q, opp));
    if (turn <= 1) out.push({ q, turn });
  }
  return out.sort((a, b) => a.turn - b.turn || a.q - b.q).map((c) => c.q);
}

/** Pieces linked to piece `p` of `tile` across edge `e`. */
export function linkedAcross(map: GameMap, tile: number, p: number, e: Edge): number[] {
  const n = neighbourTile(map, tile, e);
  if (n < 0) return [];
  const opp = OPPOSITE_EDGE[e];
  return EDGE_PIECES[opp]!.filter((q) => hasPiece(map.layers.track[n]!, q) && isLinked(map, tile, p, e, q));
}

/** Remove every link of the given pieces of a tile. Returns tiles whose data changed. */
export function unlinkPieces(map: GameMap, tile: number, pieceBits: number): number[] {
  const changed = new Set<number>();
  for (let p = 0; p < 6; p++) {
    if (!((pieceBits >> p) & 1)) continue;
    for (const e of PIECE_EDGES[p]!) {
      for (const q of EDGE_PIECES[OPPOSITE_EDGE[e]]!) {
        const t = setLink(map, tile, p, e, q, false);
        if (t >= 0) changed.add(t);
      }
    }
  }
  return [...changed];
}

/**
 * Link a set of newly placed (or reused) pieces: pieces in the set connect to each other where
 * they meet, and each end with no partner in the set connects to the straightest existing piece
 * it touches. Pieces in the set never connect to other existing track mid-way.
 * Returns tiles whose link data changed.
 */
export function linkPlaced(map: GameMap, placed: readonly PieceEnd['tile'][], pieces: readonly number[]): number[] {
  const changed = new Set<number>();
  const inSet = new Set(placed.map((t, k) => t * 8 + pieces[k]!));
  placed.forEach((tile, k) => {
    const p = pieces[k]!;
    for (const e of PIECE_EDGES[p]!) {
      const cands = linkCandidates(map, tile, p, e);
      if (cands.length === 0) continue;
      const n = neighbourTile(map, tile, e);
      const ours = cands.filter((q) => inSet.has(n * 8 + q));
      const targets = ours.length > 0 ? ours : [cands[0]!];
      for (const q of targets) {
        const t = setLink(map, tile, p, e, q, true);
        if (t >= 0) changed.add(t);
      }
    }
  });
  return [...changed];
}

/**
 * How many links linkPlaced() would add (before the pieces in `adding` exist, they are treated
 * as present). Used to tell "Already built" apart from "connect these".
 */
export function pendingLinks(map: GameMap, placed: readonly number[], pieces: readonly number[], adding: ReadonlyMap<number, number>): number {
  if (adding.size > 0) return 1;
  let n = 0;
  const inSet = new Set(placed.map((t, k) => t * 8 + pieces[k]!));
  placed.forEach((tile, k) => {
    const p = pieces[k]!;
    for (const e of PIECE_EDGES[p]!) {
      const cands = linkCandidates(map, tile, p, e);
      if (cands.length === 0) continue;
      const nt = neighbourTile(map, tile, e);
      const ours = cands.filter((q) => inSet.has(nt * 8 + q));
      for (const q of ours.length > 0 ? ours : [cands[0]!]) if (!isLinked(map, tile, p, e, q)) n++;
    }
  });
  return n;
}

/**
 * Infer links for a whole map from geometry (every pair of touching pieces with ≤ 45° turn).
 * Used for saves made before links existed.
 */
export function linkAllByGeometry(map: GameMap): void {
  const { type, track } = map.layers;
  for (let tile = 0; tile < type.length; tile++) {
    if (!isTrack(type[tile]!)) continue;
    for (let p = 0; p < 6; p++) {
      if (!hasPiece(track[tile]!, p)) continue;
      for (const e of PIECE_EDGES[p]!) for (const q of linkCandidates(map, tile, p, e)) setLink(map, tile, p, e, q, true);
    }
  }
}
