/**
 * Track geometry (OpenTTD-style). Each tile can hold up to six track pieces, each a
 * straight segment between the midpoints of two tile edges:
 *
 *        N
 *     +-----+          X  : W–E        NE : N–E
 *   W |     | E        Y  : N–S        SE : S–E
 *     +-----+                          SW : S–W
 *        S                             NW : N–W
 *
 * Diagonal lines are staircases of alternating corner pieces. A *trackdir* is a piece
 * traversed in one direction: trackdir = piece * 2 + (0: edges[0]→edges[1], 1: reverse).
 */

export const Edge = { N: 0, E: 1, S: 2, W: 3 } as const;
export type Edge = (typeof Edge)[keyof typeof Edge];

export const Piece = { X: 0, Y: 1, NE: 2, SE: 3, SW: 4, NW: 5 } as const;
export type Piece = (typeof Piece)[keyof typeof Piece];
export const PIECE_COUNT = 6;
export const PIECE_NAMES = ['X', 'Y', 'NE', 'SE', 'SW', 'NW'] as const;

export const PIECE_EDGES: readonly (readonly [Edge, Edge])[] = [
  [Edge.W, Edge.E],
  [Edge.N, Edge.S],
  [Edge.N, Edge.E],
  [Edge.S, Edge.E],
  [Edge.S, Edge.W],
  [Edge.N, Edge.W],
];

export const EDGE_DX = [0, 1, 0, -1] as const;
export const EDGE_DY = [-1, 0, 1, 0] as const;
export const OPPOSITE_EDGE = [Edge.S, Edge.W, Edge.N, Edge.E] as const;

/** Edge midpoints in tile-local coordinates (x right/east, y down/south). */
export const EDGE_MID_X = [0.5, 1, 0.5, 0] as const;
export const EDGE_MID_Y = [0, 0.5, 1, 0.5] as const;

/** Tile corner indices (NW, NE, SE, SW) touching each edge. */
export const EDGE_CORNERS: readonly (readonly [number, number])[] = [
  [0, 1], // N: NW, NE
  [1, 2], // E: NE, SE
  [3, 2], // S: SW, SE
  [0, 3], // W: NW, SW
];

export const isDiagonal = (p: number) => p >= 2;
export const pieceLength = (p: number) => (p >= 2 ? Math.SQRT1_2 : 1);

export const trackdir = (piece: number, reverse: number) => piece * 2 + reverse;
export const tdPiece = (td: number) => td >> 1;
export const tdReverse = (td: number) => td ^ 1;
export const tdEntry = (td: number): Edge => PIECE_EDGES[td >> 1]![td & 1]!;
export const tdExit = (td: number): Edge => PIECE_EDGES[td >> 1]![(td & 1) ^ 1]!;
export const TRACKDIR_COUNT = 12;

/**
 * 8-way heading of a trackdir, 0 = east, increasing clockwise in map space
 * (1 = SE, 2 = S, ... 7 = NE).
 */
export const TD_HEADING: readonly number[] = (() => {
  const out: number[] = [];
  for (let td = 0; td < TRACKDIR_COUNT; td++) {
    const a = tdEntry(td);
    const b = tdExit(td);
    const dx = EDGE_MID_X[b] - EDGE_MID_X[a];
    const dy = EDGE_MID_Y[b] - EDGE_MID_Y[a];
    out.push((Math.round((Math.atan2(dy, dx) / Math.PI) * 4) + 8) % 8);
  }
  return out;
})();

/** Absolute heading change between two headings, in 45° steps (0..4). */
export function turnSteps(h1: number, h2: number): number {
  const d = Math.abs(h1 - h2) % 8;
  return d > 4 ? 8 - d : d;
}

/** Bitmask helpers for the per-tile `track` layer (bits 0-5). */
export const hasPiece = (bits: number, p: number) => ((bits >> p) & 1) === 1;

/** Height (in levels) of each edge for a tile's corner heights, or -1 if the edge is not level. */
export function edgeHeight(corners: readonly number[], e: Edge): number {
  const [a, b] = EDGE_CORNERS[e]!;
  return corners[a] === corners[b] ? corners[a]! : -1;
}

/**
 * Whether a piece can lie on a tile with these corner heights. Both edges must be level.
 * Straight pieces may climb one level; corner pieces must be level end to end (the free
 * corner acts like a half-tile foundation).
 */
export function pieceFitsSlope(corners: readonly number[], p: number): boolean {
  const [e1, e2] = PIECE_EDGES[p]!;
  const h1 = edgeHeight(corners, e1);
  const h2 = edgeHeight(corners, e2);
  if (h1 < 0 || h2 < 0) return false;
  return isDiagonal(p) ? h1 === h2 : Math.abs(h1 - h2) <= 1;
}

/** Point along a trackdir at fraction t ∈ [0,1], tile-local coordinates. */
export function tdPoint(td: number, t: number): { x: number; y: number } {
  const a = tdEntry(td);
  const b = tdExit(td);
  return {
    x: EDGE_MID_X[a] + (EDGE_MID_X[b] - EDGE_MID_X[a]) * t,
    y: EDGE_MID_Y[a] + (EDGE_MID_Y[b] - EDGE_MID_Y[a]) * t,
  };
}

/** Nearest piece to a tile-local point (used by the build cursor). */
export function nearestPiece(fx: number, fy: number, allowed = 0x3f): Piece {
  let best: Piece = Piece.X;
  let bestD = Infinity;
  for (let p = 0; p < PIECE_COUNT; p++) {
    if (!hasPiece(allowed, p)) continue;
    const [a, b] = PIECE_EDGES[p]!;
    const d = distToSegment(fx, fy, EDGE_MID_X[a], EDGE_MID_Y[a], EDGE_MID_X[b], EDGE_MID_Y[b]);
    if (d < bestD) {
      bestD = d;
      best = p as Piece;
    }
  }
  return best;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax;
  const vy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy)));
  return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
}

export interface PlacedPiece {
  x: number;
  y: number;
  piece: Piece;
}

/** The two corner pieces forming a diagonal line along heading (sx, sy). */
function diagonalPair(sx: number, sy: number): [Piece, Piece] {
  return sx === sy ? [Piece.NE, Piece.SW] : [Piece.SE, Piece.NW];
}

/**
 * OpenTTD-style "autorail": the pieces for a drag from a start tile (with the piece under
 * the cursor at drag start) to an end tile. Produces a straight X/Y line or a 45° staircase.
 */
export function autorailPath(
  x0: number,
  y0: number,
  startPiece: Piece,
  x1: number,
  y1: number,
  maxPieces = 512,
): PlacedPiece[] {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const out: PlacedPiece[] = [];
  if (dx === 0 && dy === 0) return [{ x: x0, y: y0, piece: startPiece }];

  const ax = Math.abs(dx);
  const ay = Math.abs(dy);
  // Straight unless the drag is reasonably diagonal.
  if (ay * 2 < ax || (ay === 0)) {
    const s = Math.sign(dx);
    for (let i = 0; i <= ax && out.length < maxPieces; i++) out.push({ x: x0 + i * s, y: y0, piece: Piece.X });
    return out;
  }
  if (ax * 2 < ay || ax === 0) {
    const s = Math.sign(dy);
    for (let i = 0; i <= ay && out.length < maxPieces; i++) out.push({ x: x0, y: y0 + i * s, piece: Piece.Y });
    return out;
  }

  const sx = Math.sign(dx);
  const sy = Math.sign(dy);
  const pair = diagonalPair(sx, sy);
  const heading = (Math.round((Math.atan2(sy, sx) / Math.PI) * 4) + 8) % 8;
  let piece: Piece = pair.includes(startPiece) ? startPiece : pair[0];
  let x = x0;
  let y = y0;
  const steps = Math.min(ax, ay) * 2 + 1;
  for (let i = 0; i < steps && out.length < maxPieces; i++) {
    out.push({ x, y, piece });
    const td = TD_HEADING[trackdir(piece, 0)] === heading ? trackdir(piece, 0) : trackdir(piece, 1);
    const exit = tdExit(td);
    x += EDGE_DX[exit];
    y += EDGE_DY[exit];
    piece = piece === pair[0] ? pair[1] : pair[0];
  }
  return out;
}
