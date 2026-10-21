import {
  CROSSING_FLAG,
  EDGE_DX,
  EDGE_DY,
  HEIGHT_SCALE,
  OPPOSITE_EDGE,
  PIECE_COUNT,
  PIECE_EDGES,
  TileType,
  hasPiece,
  type GameMap,
} from '@transportsim/shared';
import * as THREE from 'three';
import { GeoBuilder, lin } from './geoBuilder.ts';
import type { Lod } from './terrainMesh.ts';
import { curveParamAt, curvePoint, curveTangent, type PieceCurve, type TrackCurves } from './trackCurves.ts';

/** Fence line offset from the track centre line: outside signals and masts. */
const FENCE_OFFSET = 0.42;
/**
 * No fence where another track's centre line is this close to it: tracks that run close
 * together (side by side, or splitting at points) share the land between them.
 */
const NEIGHBOUR_RANGE = 1.05;
/** Pieces either way along a fence's own track that never count as a neighbour, so fences follow bends. */
const LINE_DEPTH = 3;
const FENCE_HEIGHT = 0.13;
const FENCE_POST = lin('#4b4239');
/** Points per piece centre line used for distance tests. */
const POLY_STEPS = 6;

const isTrack = (t: number) => t === TileType.Rail || t === TileType.Station || t === TileType.Depot;

const _p = new THREE.Vector3();
const _t = new THREE.Vector3();
const _u = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** Track centre lines as xz polylines, for one chunk build. */
export type FencePolylines = Map<number, Float32Array>;

function polyline(curves: TrackCurves, polys: FencePolylines, tile: number, piece: number): Float32Array {
  const key = tile * 8 + piece;
  let line = polys.get(key);
  if (line) return line;
  const c = curves.get(tile, piece);
  line = new Float32Array((POLY_STEPS + 1) * 2);
  for (let k = 0; k <= POLY_STEPS; k++) {
    curvePoint(c, k / POLY_STEPS, _p);
    line[k * 2] = _p.x;
    line[k * 2 + 1] = _p.z;
  }
  polys.set(key, line);
  return line;
}

function polylineDistance(line: Float32Array, px: number, pz: number): number {
  let best = Infinity;
  for (let k = 0; k < POLY_STEPS; k++) {
    const ax = line[k * 2]!;
    const az = line[k * 2 + 1]!;
    const dx = line[k * 2 + 2]! - ax;
    const dz = line[k * 2 + 3]! - az;
    const l2 = dx * dx + dz * dz;
    const s = l2 > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (pz - az) * dz) / l2)) : 0;
    best = Math.min(best, Math.hypot(ax + dx * s - px, az + dz * s - pz));
  }
  return best;
}

/** Direction leaving a piece's curve through one of its edges. */
function outwardAt(c: PieceCurve, piece: number, edge: number, out: THREE.Vector3): THREE.Vector3 {
  return PIECE_EDGES[piece]![0] === edge ? curveTangent(c, 0, out).negate() : curveTangent(c, 1, out);
}

/** Add the pieces that carry this piece's track on through `edge`, up to `depth` pieces on. */
function follow(map: GameMap, curves: TrackCurves, tile: number, piece: number, edge: number, depth: number, out: Set<number>): void {
  if (depth === 0) return;
  const w = map.width;
  const x = tile % w;
  const y = (tile - x) / w;
  const nx = x + EDGE_DX[edge as 0];
  const ny = y + EDGE_DY[edge as 0];
  if (!map.inBounds(nx, ny)) return;
  const n = ny * w + nx;
  if (!isTrack(map.layers.type[n]!)) return;
  const bits = map.layers.track[n]!;
  const back = OPPOSITE_EDGE[edge as 0];
  const dir = outwardAt(curves.get(tile, piece), piece, edge, new THREE.Vector3());
  for (let q = 0; q < PIECE_COUNT; q++) {
    const [q0, q1] = PIECE_EDGES[q]!;
    if (!hasPiece(bits, q) || (q0 !== back && q1 !== back) || out.has(n * 8 + q)) continue;
    // Joined pieces share one tangent at the joint; ones that merely touch there don't.
    if (outwardAt(curves.get(n, q), q, back, _u).dot(dir) > -0.999) continue;
    out.add(n * 8 + q);
    follow(map, curves, n, q, q0 === back ? q1 : q0, depth - 1, out);
  }
}

/** The piece and the pieces continuing its line either way (never other pieces of its own tile). */
function ownLine(map: GameMap, curves: TrackCurves, tile: number, piece: number): Set<number> {
  const out = new Set([tile * 8 + piece]);
  for (const e of PIECE_EDGES[piece]!) follow(map, curves, tile, piece, e, LINE_DEPTH, out);
  return out;
}

/** Can a fence stand at (fx, fz): on open ground or plain track, with no other track close by? */
function fenceFits(map: GameMap, curves: TrackCurves, polys: FencePolylines, line: Set<number>, fx: number, fz: number): boolean {
  const tx = Math.floor(fx);
  const tz = Math.floor(fz);
  if (!map.inBounds(tx, tz)) return false;
  const i = map.tileIndex(tx, tz);
  const type = map.layers.type[i];
  if (type !== TileType.Clear && type !== TileType.Rail) return false;
  if (type === TileType.Rail && map.layers.data[i]! & CROSSING_FLAG) return false;
  const r = NEIGHBOUR_RANGE;
  for (let y = Math.floor(fz - r); y <= Math.floor(fz + r); y++) {
    for (let x = Math.floor(fx - r); x <= Math.floor(fx + r); x++) {
      if (!map.inBounds(x, y)) continue;
      const j = map.tileIndex(x, y);
      if (!isTrack(map.layers.type[j]!)) continue;
      // Nearest point of the tile to the fence point.
      if (Math.hypot(fx - Math.min(Math.max(fx, x), x + 1), fz - Math.min(Math.max(fz, y), y + 1)) >= r) continue;
      const bits = map.layers.track[j]!;
      for (let p = 0; p < PIECE_COUNT; p++) {
        if (!hasPiece(bits, p) || line.has(j * 8 + p)) continue;
        if (polylineDistance(polyline(curves, polys, j, p), fx, fz) < r) return false;
      }
    }
  }
  return true;
}

/**
 * Lineside fences along both sides of a piece, rails in the owner's colour. Left out where
 * the ground beside the track is taken (roads, buildings, stations, water) or another track
 * runs close by, so neighbouring tracks have no fence between them.
 */
export function addFences(
  g: GeoBuilder,
  map: GameMap,
  curves: TrackCurves,
  polys: FencePolylines,
  tile: number,
  piece: number,
  lod: Lod,
  color: THREE.Color,
): void {
  const c = curves.get(tile, piece);
  const n = Math.max(2, Math.round(c.p0.distanceTo(c.p3) / 0.25));
  const line = ownLine(map, curves, tile, piece);
  const fits = (fx: number, fz: number) => fenceFits(map, curves, polys, line, fx, fz);
  const pts: THREE.Vector3[] = [];
  const ok: boolean[] = [];
  for (const side of [1, -1]) {
    for (let k = 0; k <= n; k++) {
      const t = curveParamAt(c, k / n);
      curvePoint(c, t, _p);
      curveTangent(c, t, _t);
      _u.set(-_t.z, 0, _t.x).normalize().multiplyScalar(side * FENCE_OFFSET);
      const fx = _p.x + _u.x;
      const fz = _p.z + _u.z;
      pts[k] = (pts[k] ?? new THREE.Vector3()).set(fx, map.heightAt(fx, fz) * HEIGHT_SCALE, fz);
      ok[k] = fits(fx, fz);
    }
    let lastPost = -1;
    for (let k = 0; k < n; k++) {
      const a = pts[k]!;
      const b = pts[k + 1]!;
      if (!ok[k] || !ok[k + 1] || !fits((a.x + b.x) / 2, (a.z + b.z) / 2)) continue;
      g.color(FENCE_POST);
      for (const [idx, q] of [[k, a], [k + 1, b]] as const) {
        if (idx === lastPost) continue;
        g.aabb(q.x - 0.011, q.y - 0.02, q.z - 0.011, q.x + 0.011, q.y + FENCE_HEIGHT, q.z + 0.011);
        lastPost = idx;
      }
      g.color(color);
      for (const h of lod === 0 ? [0.055, FENCE_HEIGHT - 0.02] : [FENCE_HEIGHT - 0.02]) {
        g.box(_a.copy(a).setY(a.y + h), _b.copy(b).setY(b.y + h), 0.012, 0.018, false);
      }
    }
  }
}
