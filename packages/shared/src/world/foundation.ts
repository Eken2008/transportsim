import { EDGE_CORNERS, PIECE_EDGES, isDiagonal, pieceFitsSlope } from '../rail/track.ts';

/**
 * Foundations (OpenTTD-style): a built tile on a gentle slope can stand on a foundation that
 * raises part or all of it. The terrain's corners stay where they are, so the raised surface
 * meets the lower land around it with a cliff.
 *
 *  - Level: the whole tile flat at its highest corner (stations, depots, junctions).
 *  - InclineX / InclineY: a straight ramp along X (W→E) or Y (N→S), each end raised to the
 *    higher corner of that edge, so straight track and roads keep climbing over one raised corner.
 *  - HalfNW … HalfSW: only the triangle at a raised corner is levelled up to it, with the cliff
 *    running diagonally across the tile; a corner piece of track runs on top (the low half stays
 *    as it was and can carry the opposite corner piece).
 */
export const Foundation = {
  None: 0,
  Level: 1,
  InclineX: 2,
  InclineY: 3,
  HalfNW: 4,
  HalfNE: 5,
  HalfSE: 6,
  HalfSW: 7,
} as const;
export type Foundation = (typeof Foundation)[keyof typeof Foundation];

type Corners = readonly number[];
type Quad = [number, number, number, number];

/** The raised corner (0 NW, 1 NE, 2 SE, 3 SW) of a half-tile foundation, or -1. */
export const halfCorner = (kind: number): number => (kind >= Foundation.HalfNW ? kind - Foundation.HalfNW : -1);

/** The tile corner a corner piece of track bends around (NE piece: the NE corner). */
const PIECE_CORNER = [-1, -1, 1, 2, 3, 0] as const;

/** Is this a gentle slope (corners one level apart at most, not flat)? Only those take foundations. */
export function isGentleSlope(raw: Corners): boolean {
  return Math.max(...raw) - Math.min(...raw) === 1;
}

/**
 * Surface corners (NW, NE, SE, SW) of a tile on a whole-tile foundation. A half-tile foundation
 * has no single surface: its raw corners are returned, and edges and heights must be asked of
 * foundationEdge() and the map instead.
 */
export function foundationCorners(raw: Corners, kind: number): Quad {
  const [nw, ne, se, sw] = raw as Quad;
  switch (kind) {
    case Foundation.Level: {
      const top = Math.max(nw, ne, se, sw);
      return [top, top, top, top];
    }
    case Foundation.InclineX: {
      const w = Math.max(nw, sw);
      const e = Math.max(ne, se);
      return [w, e, e, w];
    }
    case Foundation.InclineY: {
      const n = Math.max(nw, ne);
      const s = Math.max(sw, se);
      return [n, n, s, s];
    }
    default:
      return [nw, ne, se, sw];
  }
}

/** Surface heights at the two corners of edge `e` (in EDGE_CORNERS order) on a foundation. */
export function foundationEdge(raw: Corners, kind: number, e: number): [number, number] {
  const [a, b] = EDGE_CORNERS[e]!;
  const k = halfCorner(kind);
  if (k >= 0) {
    if (a !== k && b !== k) return [raw[a]!, raw[b]!];
    const top = Math.max(...raw);
    return [top, top];
  }
  const c = foundationCorners(raw, kind);
  return [c[a], c[b]];
}

/** Does track piece `p` lie on this surface: on level edges, climbing at most one level, never across a cliff? */
export function pieceFitsSurface(raw: Corners, kind: number, p: number): boolean {
  const k = halfCorner(kind);
  if (k < 0) return pieceFitsSlope(foundationCorners(raw, kind), p);
  // A half-tile foundation carries the corner piece on top, and the opposite one below.
  return isDiagonal(p) && (PIECE_CORNER[p] === k || PIECE_CORNER[p] === ((k + 2) & 3));
}

/** Can the triangle at corner k be raised: k is the one high corner, the other three level? */
function canHalf(raw: Corners, k: number): boolean {
  const low = raw[(k + 1) & 3]!;
  return raw[k] === low + 1 && raw[(k + 2) & 3] === low && raw[(k + 3) & 3] === low;
}

const isFlatQuad = (c: Corners) => c[0] === c[1] && c[1] === c[2] && c[2] === c[3];

/**
 * The foundation a tile needs to carry track: `add` are new pieces, `keep` the pieces already
 * there, which must stay at their heights. Returns the current foundation if everything fits it,
 * otherwise the best new one (a half tile for a corner piece, a ramp for a straight, else level),
 * or -1 if nothing will do. A tile that already has a foundation keeps it.
 */
export function trackFoundation(raw: Corners, current: number, add: readonly number[], keep: readonly number[]): number {
  const all = [...keep, ...add];
  if (all.every((p) => pieceFitsSurface(raw, current, p))) return current;
  if (current !== Foundation.None || !isGentleSlope(raw)) return -1;
  const candidates: number[] = [];
  for (const p of add) if (isDiagonal(p) && canHalf(raw, PIECE_CORNER[p]!)) candidates.push(Foundation.HalfNW + PIECE_CORNER[p]!);
  candidates.push(Foundation.InclineX, Foundation.InclineY, Foundation.Level);
  for (const kind of candidates) {
    if ((kind === Foundation.InclineX || kind === Foundation.InclineY) && isFlatQuad(foundationCorners(raw, kind))) continue;
    if (!all.every((p) => pieceFitsSurface(raw, kind, p))) continue;
    // Track already on the tile stays where it is.
    const moves = keep.some((p) =>
      PIECE_EDGES[p]!.some((e) => {
        const [a, b] = foundationEdge(raw, kind, e);
        const [c, d] = foundationEdge(raw, Foundation.None, e);
        return a !== c || b !== d;
      }),
    );
    if (!moves) return kind;
  }
  return -1;
}

/** Does a straight road along `axis` (0: X, 1: Y) fit these surface corners, clear of the sea? */
export function roadFitsCorners(c: Corners, axis: 0 | 1): boolean {
  if (Math.min(...c) < 1) return false;
  if (isFlatQuad(c)) return true;
  return pieceFitsSlope(c, axis);
}

/** The foundation a bare tile needs for a straight road along `axis`: a ramp if one will do, else level. -1 if none. */
export function roadFoundation(raw: Corners, axis: 0 | 1): number {
  if (roadFitsCorners(raw, axis)) return Foundation.None;
  if (!isGentleSlope(raw)) return -1;
  const ramp = axis === 0 ? Foundation.InclineX : Foundation.InclineY;
  const c = foundationCorners(raw, ramp);
  if (!isFlatQuad(c) && roadFitsCorners(c, axis)) return ramp;
  return roadFitsCorners(foundationCorners(raw, Foundation.Level), axis) ? Foundation.Level : -1;
}
