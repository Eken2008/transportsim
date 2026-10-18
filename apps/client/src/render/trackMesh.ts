import {
  CHUNK_SIZE,
  CROSSING_FLAG,
  EDGE_MID_X,
  EDGE_MID_Y,
  HEIGHT_SCALE,
  PIECE_COUNT,
  PIECE_EDGES,
  TileType,
  depotExit,
  edgeHeight,
  hasPiece,
  type GameMap,
} from '@transportsim/shared';
import * as THREE from 'three';
import { GeoBuilder, lin } from './geoBuilder.ts';
import { SIGNAL_POST_HEIGHT, signalPlacement } from './signalGeometry.ts';
import type { Lod } from './terrainMesh.ts';

const BALLAST = lin('#8f877c');
const BALLAST_FAR = lin('#6d655c');
const SLEEPER = lin('#5a4535');
const RAIL = lin('#c3c7cc');
const ROAD = lin('#5d6166');
const PLATFORM = lin('#b9b4aa');
const PLATFORM_EDGE = lin('#e8d36a');
const CANOPY = lin('#5d6b78');
const POST = lin('#3c4148');
const DEPOT_WALL = lin('#a59c8e');
const DEPOT_DOOR = lin('#2a2d31');
const SIGNAL_POST = lin('#30343a');
const SIGNAL_HEAD = lin('#16181b');
const _foot = new THREE.Vector3();
const _dir = new THREE.Vector3();

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

/** Append a chunk's track, stations, depots and level-crossing road surfaces to a builder. */
export function addTrack(
  g: GeoBuilder,
  map: GameMap,
  cx: number,
  cy: number,
  lod: Lod,
  companyColor: (owner: number) => THREE.Color,
): void {
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
      const type = map.layers.type[i];
      if (type === TileType.Station) addPlatform(g, map, x, y, bits, lod);
      else if (type === TileType.Depot) {
        addDepot(g, map, x, y, depotExit(map.layers.data[i]!), companyColor(map.layers.owner[i]!));
        continue;
      }
      for (let p = 0; p < PIECE_COUNT; p++) {
        if (!hasPiece(bits, p)) continue;
        pieceEndpoints(map, x, y, p, _a, _b);
        addPiece(g, _a, _b, lod);
      }
      const sig = map.layers.signals[i]!;
      if (sig && lod <= 1) {
        for (let td = 0; td < 12; td++) {
          if (!((sig >> td) & 1)) continue;
          signalPlacement(map, x, y, td, _foot, _dir);
          const f = _foot;
          g.color(SIGNAL_POST).aabb(f.x - 0.018, f.y, f.z - 0.018, f.x + 0.018, f.y + SIGNAL_POST_HEIGHT, f.z + 0.018);
          g.color(SIGNAL_HEAD).aabb(f.x - 0.045, f.y + SIGNAL_POST_HEIGHT - 0.04, f.z - 0.045, f.x + 0.045, f.y + SIGNAL_POST_HEIGHT + 0.12, f.z + 0.045);
        }
      }
    }
  }
}

/**
 * Platform beside the track on a station tile. Rows alternate sides so neighbouring
 * tracks share an island platform between them.
 */
function addPlatform(g: GeoBuilder, map: GameMap, x: number, y: number, bits: number, lod: Lod): void {
  const alongX = hasPiece(bits, 0);
  const h = map.cornerHeight(x, y) * HEIGHT_SCALE;
  const row = alongX ? y : x;
  const side = row % 2 === 0 ? 1 : -1; // +1: platform on the +Z (or +X) side
  const inner = 0.25;
  const outer = 0.5;
  const top = h + 0.13;
  const lo = side > 0 ? inner : -outer;
  const hi = side > 0 ? outer : -inner;
  if (alongX) {
    g.color(PLATFORM).aabb(x, h, y + 0.5 + lo, x + 1, top, y + 0.5 + hi);
    g.color(PLATFORM_EDGE).aabb(x, top, y + 0.5 + (side > 0 ? inner : -inner - 0.03), x + 1, top + 0.004, y + 0.5 + (side > 0 ? inner + 0.03 : -inner));
  } else {
    g.color(PLATFORM).aabb(x + 0.5 + lo, h, y, x + 0.5 + hi, top, y + 1);
    g.color(PLATFORM_EDGE).aabb(x + 0.5 + (side > 0 ? inner : -inner - 0.03), top, y, x + 0.5 + (side > 0 ? inner + 0.03 : -inner), top + 0.004, y + 1);
  }
  if (lod >= 2) return;
  // Canopy on posts over the platform.
  const mid = 0.5 + side * 0.385;
  const roofY = top + 0.42;
  g.color(POST);
  for (const t of [0.25, 0.75]) {
    if (alongX) g.aabb(x + t - 0.015, top, y + mid - 0.015, x + t + 0.015, roofY, y + mid + 0.015);
    else g.aabb(x + mid - 0.015, top, y + t - 0.015, x + mid + 0.015, roofY, y + t + 0.015);
  }
  g.color(CANOPY);
  if (alongX) g.aabb(x, roofY, y + mid - 0.15, x + 1, roofY + 0.03, y + mid + 0.15);
  else g.aabb(x + mid - 0.15, roofY, y, x + mid + 0.15, roofY + 0.03, y + 1);
}

/** Engine shed open towards its exit edge, roof in the owner's colour. */
function addDepot(g: GeoBuilder, map: GameMap, x: number, y: number, exit: number, roof: THREE.Color): void {
  const h = map.cornerHeight(x, y) * HEIGHT_SCALE;
  const alongX = exit === 1 || exit === 3;
  const wallH = h + 0.55;
  const m = 0.08;
  g.color(DEPOT_WALL).aabb(x + m, h, y + m, x + 1 - m, wallH, y + 1 - m);
  // Dark doorway on the exit side.
  g.color(DEPOT_DOOR);
  const d = 0.004;
  if (exit === 0) g.aabb(x + 0.27, h, y + m - d, x + 0.73, h + 0.42, y + m);
  else if (exit === 2) g.aabb(x + 0.27, h, y + 1 - m, x + 0.73, h + 0.42, y + 1 - m + d);
  else if (exit === 1) g.aabb(x + 1 - m, h, y + 0.27, x + 1 - m + d, h + 0.42, y + 0.73);
  else g.aabb(x + m - d, h, y + 0.27, x + m, h + 0.42, y + 0.73);
  g.color(roof).gable(x + m, y + m, x + 1 - m, y + 1 - m, wallH, 0.24, 0.05, !alongX);
}
