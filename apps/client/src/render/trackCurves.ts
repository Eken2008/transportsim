import {
  EDGE_DX,
  EDGE_DY,
  EDGE_MID_X,
  EDGE_MID_Y,
  HEIGHT_SCALE,
  OPPOSITE_EDGE,
  PIECE_EDGES,
  TD_HEADING,
  TileType,
  depotExit,
  hasPiece,
  headInfo,
  segHeights,
  trackdir,
  turnSteps,
  type GameMap,
} from '@transportsim/shared';
import * as THREE from 'three';

/** Height of the ballast base above the terrain. */
export const TRACK_LIFT = 0.012;

/**
 * A track piece drawn as a cubic Bézier from its first edge (PIECE_EDGES[p][0]) to its second.
 * Where pieces meet, both share one tangent, so joints are smooth in plan and in elevation.
 */
export interface PieceCurve {
  p0: THREE.Vector3;
  p1: THREE.Vector3;
  p2: THREE.Vector3;
  p3: THREE.Vector3;
}

interface EndRef {
  tile: number;
  piece: number;
  edge: number;
}

const isTrack = (t: number) => t === TileType.Rail || t === TileType.Station || t === TileType.Depot;

/** Smooth centre lines of track pieces, cached until the map changes. */
export class TrackCurves {
  private cache = new Map<number, PieceCurve>();

  constructor(private readonly map: GameMap) {}

  clear(): void {
    this.cache.clear();
  }

  /** Point on the piece's edge midpoint, at ballast-base height. */
  private endPoint(tile: number, piece: number, edge: number, out = new THREE.Vector3()): THREE.Vector3 {
    const w = this.map.width;
    const x = tile % w;
    const y = (tile - x) / w;
    const [e0] = PIECE_EDGES[piece]!;
    const [h0, h1] = segHeights(this.map, tile, trackdir(piece, 0));
    const h = edge === e0 ? h0 : h1;
    return out.set(x + EDGE_MID_X[edge as 0], h * HEIGHT_SCALE + TRACK_LIFT, y + EDGE_MID_Y[edge as 0]);
  }

  /** Unit direction leaving the piece through `edge` (3D, including slope). */
  private outward(tile: number, piece: number, edge: number): THREE.Vector3 {
    const [e0, e1] = PIECE_EDGES[piece]!;
    const other = edge === e0 ? e1 : e0;
    return this.endPoint(tile, piece, edge).sub(this.endPoint(tile, piece, other)).normalize();
  }

  /** Pieces that physically continue this end (same owner, ≤ 45° turn, respecting depots and bridges). */
  private neighbours(tile: number, piece: number, edge: number): EndRef[] {
    const map = this.map;
    const { type, owner, data, track } = map.layers;
    const here = headInfo(map, tile);
    if (here && here.dir === edge) return []; // span side of a bridge/tunnel end
    if (type[tile] === TileType.Depot && depotExit(data[tile]!) !== edge) return [];
    const w = map.width;
    const x = tile % w;
    const y = (tile - x) / w;
    const nx = x + EDGE_DX[edge as 0];
    const ny = y + EDGE_DY[edge as 0];
    if (!map.inBounds(nx, ny)) return [];
    const n = ny * w + nx;
    if (!isTrack(type[n]!) || owner[n] !== owner[tile]) return [];
    const back = OPPOSITE_EDGE[edge as 0];
    const there = headInfo(map, n);
    if (there && there.dir === back) return [];
    if (type[n] === TileType.Depot && depotExit(data[n]!) !== back) return [];
    const [, e1] = PIECE_EDGES[piece]!;
    const outTd = trackdir(piece, e1 === edge ? 0 : 1);
    const found: { ref: EndRef; turn: number }[] = [];
    for (let q = 0; q < 6; q++) {
      if (!hasPiece(track[n]!, q)) continue;
      const [q0, q1] = PIECE_EDGES[q]!;
      if (q0 !== back && q1 !== back) continue;
      const turn = turnSteps(TD_HEADING[outTd]!, TD_HEADING[trackdir(q, q0 === back ? 0 : 1)]!);
      if (turn <= 1) found.push({ ref: { tile: n, piece: q, edge: back }, turn });
    }
    return found.sort((a, b) => a.turn - b.turn).map((f) => f.ref);
  }

  /** Outward tangent shared by this end and the piece it joins. */
  private tangent(tile: number, piece: number, edge: number, depth = 0): THREE.Vector3 {
    const own = this.outward(tile, piece, edge);
    const best = this.neighbours(tile, piece, edge)[0];
    if (!best) return own;
    const cont = this.outward(best.tile, best.piece, best.edge).negate();
    const back = this.neighbours(best.tile, best.piece, best.edge)[0];
    const mutual = back && back.tile === tile && back.piece === piece;
    if (mutual || depth > 0) return own.add(cont).normalize();
    // We branch off a through route at a junction: follow its tangent so the points look right.
    return this.tangent(best.tile, best.piece, best.edge, depth + 1).negate();
  }

  get(tile: number, piece: number): PieceCurve {
    const key = tile * 8 + piece;
    let c = this.cache.get(key);
    if (c) return c;
    const [e0, e1] = PIECE_EDGES[piece]!;
    const p0 = this.endPoint(tile, piece, e0);
    const p3 = this.endPoint(tile, piece, e1);
    const len = p0.distanceTo(p3);
    const t0 = this.tangent(tile, piece, e0).negate(); // pointing into the piece
    const t3 = this.tangent(tile, piece, e1);
    c = {
      p0,
      p1: p0.clone().addScaledVector(t0, len / 3),
      p2: p3.clone().addScaledVector(t3, -len / 3),
      p3,
    };
    this.cache.set(key, c);
    return c;
  }
}

/** Point on a curve at parameter t (0 = first edge). */
export function curvePoint(c: PieceCurve, t: number, out: THREE.Vector3): THREE.Vector3 {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const d = 3 * u * t * t;
  const e = t * t * t;
  return out.set(
    a * c.p0.x + b * c.p1.x + d * c.p2.x + e * c.p3.x,
    a * c.p0.y + b * c.p1.y + d * c.p2.y + e * c.p3.y,
    a * c.p0.z + b * c.p1.z + d * c.p2.z + e * c.p3.z,
  );
}

/** Unit tangent at parameter t. */
export function curveTangent(c: PieceCurve, t: number, out: THREE.Vector3): THREE.Vector3 {
  const u = 1 - t;
  const a = 3 * u * u;
  const b = 6 * u * t;
  const d = 3 * t * t;
  return out
    .set(
      a * (c.p1.x - c.p0.x) + b * (c.p2.x - c.p1.x) + d * (c.p3.x - c.p2.x),
      a * (c.p1.y - c.p0.y) + b * (c.p2.y - c.p1.y) + d * (c.p3.y - c.p2.y),
      a * (c.p1.z - c.p0.z) + b * (c.p2.z - c.p1.z) + d * (c.p3.z - c.p2.z),
    )
    .normalize();
}

/** A straight "curve" between two points (bridge decks). */
export function straightCurve(a: THREE.Vector3, b: THREE.Vector3): PieceCurve {
  return { p0: a.clone(), p1: a.clone().lerp(b, 1 / 3), p2: a.clone().lerp(b, 2 / 3), p3: b.clone() };
}
