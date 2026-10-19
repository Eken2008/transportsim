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
  isLinked,
  segHeights,
  trackdir,
  turnSteps,
  type GameMap,
} from '@transportsim/shared';
import * as THREE from 'three';

/** Height of the ballast base above the terrain. */
export const TRACK_LIFT = 0.012;
/**
 * Bézier handle length as a fraction of the piece length. Short handles keep each piece
 * straight and only round off a small zone where pieces meet at an angle.
 */
const JOINT_ROUNDING = 0.16;

/**
 * A track piece drawn as a cubic Bézier from its first edge (PIECE_EDGES[p][0]) to its second.
 * Where pieces meet, both share one tangent, so joints are smooth in plan and in elevation.
 */
export interface PieceCurve {
  p0: THREE.Vector3;
  p1: THREE.Vector3;
  p2: THREE.Vector3;
  p3: THREE.Vector3;
  /** Cumulative arc length at t = i / LUT_STEPS, for even spacing along the curve. */
  lut?: Float32Array;
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

  /** Can track cross this edge of the tile at all (bridge span sides and depot walls can't)? */
  private edgeOpen(tile: number, edge: number): boolean {
    const map = this.map;
    const info = headInfo(map, tile);
    if (info && info.dir === edge) return false;
    return !(map.layers.type[tile] === TileType.Depot && depotExit(map.layers.data[tile]!) !== edge);
  }

  /** The tile across `edge` if track there could join ours (same owner, open edges), else -1. */
  private across(tile: number, edge: number): number {
    const map = this.map;
    const { type, owner } = map.layers;
    if (!this.edgeOpen(tile, edge)) return -1;
    const w = map.width;
    const x = tile % w;
    const y = (tile - x) / w;
    const nx = x + EDGE_DX[edge as 0];
    const ny = y + EDGE_DY[edge as 0];
    if (!map.inBounds(nx, ny)) return -1;
    const n = ny * w + nx;
    if (!isTrack(type[n]!) || owner[n] !== owner[tile]) return -1;
    return this.edgeOpen(n, OPPOSITE_EDGE[edge as 0]) ? n : -1;
  }

  private piecesTouching(tile: number, edge: number): number[] {
    const out: number[] = [];
    const type = this.map.layers.type[tile];
    if (type === TileType.RoadStop || type === TileType.Airport) return out; // road bits or airport roles, not track
    const bits = this.map.layers.track[tile]!;
    for (let p = 0; p < 6; p++) {
      const [e0, e1] = PIECE_EDGES[p]!;
      if (hasPiece(bits, p) && (e0 === edge || e1 === edge)) out.push(p);
    }
    return out;
  }

  /**
   * Direction of the track through the joint at `edge` of `tile`, pointing out of `tile`, or
   * null if `piece` joins nothing there. Every piece meeting at a joint uses the same direction,
   * so joints are seamless:
   *  - a straight-through pair sets it (branches peel off it like a switch);
   *  - otherwise a lone piece on one side (the trunk of a wye) sets it;
   *  - otherwise it's the average of the two directions of the straightest pair.
   */
  private jointDirection(tile: number, piece: number, edge: number): THREE.Vector3 | null {
    const n = this.across(tile, edge);
    if (n < 0) return null;
    const back = OPPOSITE_EDGE[edge as 0];
    const heading = (t: number, p: number, e: number, out: boolean) => {
      const [e0, e1] = PIECE_EDGES[p]!;
      // Leaving t through e (out) or entering t through e.
      return TD_HEADING[trackdir(p, out ? (e1 === e ? 0 : 1) : e0 === e ? 0 : 1)]!;
    };
    const mine = this.piecesTouching(tile, edge);
    const theirs = this.piecesTouching(n, back);
    // Connected pairs across this joint (pieces that merely touch don't count).
    const all: { a: number; b: number; turn: number }[] = [];
    for (const a of mine) {
      for (const b of theirs) {
        if (!isLinked(this.map, tile, a, edge as 0, b)) continue;
        const turn = turnSteps(heading(tile, a, edge, true), heading(n, b, back, false));
        if (turn <= 1) all.push({ a, b, turn });
      }
    }
    if (!all.some((p) => p.a === piece)) return null;
    // Only the group of pieces connected to ours shapes our joint; a track crossing at the same
    // point (touching but not connected) keeps its own direction.
    const groupA = new Set([piece]);
    const groupB = new Set<number>();
    for (let changed = true; changed; ) {
      changed = false;
      for (const p of all) {
        if (groupA.has(p.a) && !groupB.has(p.b)) {
          groupB.add(p.b);
          changed = true;
        }
        if (groupB.has(p.b) && !groupA.has(p.a)) {
          groupA.add(p.a);
          changed = true;
        }
      }
    }
    const pairs = all.filter((p) => groupA.has(p.a));
    const dirA = (a: number) => this.outward(tile, a, edge);
    const dirB = (b: number) => this.outward(n, b, back).negate();
    const straight = pairs.find((p) => p.turn === 0);
    if (straight) return dirA(straight.a).add(dirB(straight.b)).normalize();
    const joinedA = [...new Set(pairs.map((p) => p.a))];
    const joinedB = [...new Set(pairs.map((p) => p.b))];
    if (joinedA.length === 1 && joinedB.length === 1) return dirA(joinedA[0]!).add(dirB(joinedB[0]!)).normalize();
    if (joinedA.length === 1) return dirA(joinedA[0]!);
    if (joinedB.length === 1) return dirB(joinedB[0]!);
    // Canonical choice (same from both sides): order pieces by the lower-indexed tile first.
    const key = (p: { a: number; b: number }) => (tile < n ? p.a * 8 + p.b : p.b * 8 + p.a);
    const best = pairs.sort((x, y) => key(x) - key(y))[0]!;
    return dirA(best.a).add(dirB(best.b)).normalize();
  }

  /** Outward tangent of a piece end: the joint direction, or the piece's own if it's a dead end. */
  private tangent(tile: number, piece: number, edge: number): THREE.Vector3 {
    return this.jointDirection(tile, piece, edge) ?? this.outward(tile, piece, edge);
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
      p1: p0.clone().addScaledVector(t0, len * JOINT_ROUNDING),
      p2: p3.clone().addScaledVector(t3, -len * JOINT_ROUNDING),
      p3,
    };
    this.cache.set(key, c);
    return c;
  }
}

const LUT_STEPS = 24;
const _lp = new THREE.Vector3();
const _lq = new THREE.Vector3();

/** Curve parameter at a fraction (0..1) of the curve's arc length. */
export function curveParamAt(c: PieceCurve, frac: number): number {
  if (!c.lut) {
    const lut = new Float32Array(LUT_STEPS + 1);
    curvePoint(c, 0, _lp);
    for (let i = 1; i <= LUT_STEPS; i++) {
      curvePoint(c, i / LUT_STEPS, _lq);
      lut[i] = lut[i - 1]! + _lq.distanceTo(_lp);
      _lp.copy(_lq);
    }
    c.lut = lut;
  }
  const lut = c.lut;
  const target = Math.min(1, Math.max(0, frac)) * lut[LUT_STEPS]!;
  let i = 1;
  while (i < LUT_STEPS && lut[i]! < target) i++;
  const a = lut[i - 1]!;
  const b = lut[i]!;
  return (i - 1 + (b > a ? (target - a) / (b - a) : 0)) / LUT_STEPS;
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
