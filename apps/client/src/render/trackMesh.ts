import {
  CHUNK_SIZE,
  CROSSING_FLAG,
  EDGE_MID_X,
  EDGE_MID_Y,
  HEIGHT_SCALE,
  PIECE_COUNT,
  PIECE_EDGES,
  TileType,
  edgeHeight,
  hasPiece,
  type GameMap,
} from '@transportsim/shared';
import * as THREE from 'three';
import { GeoBuilder, lin } from './geoBuilder.ts';
import type { Lod } from './terrainMesh.ts';

const BALLAST = lin('#8f877c');
const BALLAST_FAR = lin('#6d655c');
const SLEEPER = lin('#5a4535');
const RAIL = lin('#c3c7cc');
const ROAD = lin('#5d6166');

const LIFT = 0.012;
const GAUGE = 0.15;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _side = new THREE.Vector3();

/** World-space endpoints of a piece on a tile (centre line at ballast level). */
export function pieceEndpoints(map: GameMap, x: number, y: number, piece: number, a: THREE.Vector3, b: THREE.Vector3): void {
  const corners = map.tileCorners(x, y);
  const [e1, e2] = PIECE_EDGES[piece]!;
  const h1 = Math.max(0, edgeHeight(corners, e1));
  const h2 = Math.max(0, edgeHeight(corners, e2));
  a.set(x + EDGE_MID_X[e1], h1 * HEIGHT_SCALE + LIFT, y + EDGE_MID_Y[e1]);
  b.set(x + EDGE_MID_X[e2], h2 * HEIGHT_SCALE + LIFT, y + EDGE_MID_Y[e2]);
}

/** Append one track piece (ballast, sleepers, rails) to a builder. */
export function addPiece(g: GeoBuilder, a: THREE.Vector3, b: THREE.Vector3, lod: Lod): void {
  g.color(lod >= 2 ? BALLAST_FAR : BALLAST).box(a, b, 0.42, 0.03, false);
  if (lod >= 2) return;
  const len = a.distanceTo(b);
  _side.set(-(b.z - a.z), 0, b.x - a.x).normalize();
  if (lod === 0) {
    const n = Math.max(3, Math.round(len / 0.14));
    g.color(SLEEPER);
    for (let i = 0; i < n; i++) {
      const t = (i + 0.5) / n;
      _p.lerpVectors(a, b, t).setY(_p.y + 0.03);
      const half = _q.copy(_side).multiplyScalar(0.16);
      g.box(_a2.copy(_p).sub(half), _b2.copy(_p).add(half), 0.05, 0.02, false);
    }
  }
  g.color(RAIL);
  for (const s of [-1, 1]) {
    const off = _q.copy(_side).multiplyScalar((s * GAUGE) / 2);
    g.box(_a2.copy(a).add(off).setY(a.y + 0.05), _b2.copy(b).add(off).setY(b.y + 0.05), 0.022, 0.025, false);
  }
}
const _a2 = new THREE.Vector3();
const _b2 = new THREE.Vector3();

/** Append a chunk's track (and level-crossing road surfaces) to a builder. */
export function addTrack(g: GeoBuilder, map: GameMap, cx: number, cy: number, lod: Lod): void {
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  for (let y = y0; y < y0 + CHUNK_SIZE; y++) {
    for (let x = x0; x < x0 + CHUNK_SIZE; x++) {
      const i = map.tileIndex(x, y);
      const bits = map.layers.track[i]!;
      if (bits === 0) continue;
      if (map.layers.type[i] === TileType.Rail && map.layers.data[i]! & CROSSING_FLAG) {
        // Road surface under the crossing, perpendicular to the track.
        const roadPiece = hasPiece(bits, 0) ? 1 : 0;
        pieceEndpoints(map, x, y, roadPiece, _a, _b);
        g.color(ROAD).box(_a.setY(_a.y - 0.005), _b.setY(_b.y - 0.005), 0.7, 0.035, false);
      }
      for (let p = 0; p < PIECE_COUNT; p++) {
        if (!hasPiece(bits, p)) continue;
        pieceEndpoints(map, x, y, p, _a, _b);
        addPiece(g, _a, _b, lod);
      }
    }
  }
}
