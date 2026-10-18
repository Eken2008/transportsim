import {
  CHUNK_SIZE,
  CROSSING_FLAG,
  EDGE_MID_X,
  EDGE_MID_Y,
  HEIGHT_SCALE,
  PIECE_COUNT,
  PIECE_EDGES,
  TileType,
  SIGNAL_ONE_WAY,
  depotExit,
  hasPiece,
  headInfo,
  segHeights,
  trackdir,
  type GameMap,
} from '@transportsim/shared';
import * as THREE from 'three';
import { GeoBuilder, lin } from './geoBuilder.ts';
import { SIGNAL_POST_HEIGHT, signalPlacement } from './signalGeometry.ts';
import { addBridge, addHeadFoundation, addTunnelPortal } from './structureMesh.ts';
import { addCrossingFurniture } from './crossings.ts';
import type { Lod } from './terrainMesh.ts';
import { TRACK_LIFT, curveParamAt, curvePoint, curveTangent, straightCurve, type PieceCurve, type TrackCurves } from './trackCurves.ts';

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
const ONE_WAY_PLATE = lin('#f2f2f2');
const _foot = new THREE.Vector3();
const _dir = new THREE.Vector3();

const LIFT = TRACK_LIFT;
const GAUGE = 0.15;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _p = new THREE.Vector3();
const _q = new THREE.Vector3();

/** World-space endpoints of a piece on a tile (centre line at ballast level). */
export function pieceEndpoints(map: GameMap, x: number, y: number, piece: number, a: THREE.Vector3, b: THREE.Vector3): void {
  const [e1, e2] = PIECE_EDGES[piece]!;
  // Heights account for bridge-end foundations and level tunnel portals.
  const [h1, h2] = segHeights(map, map.tileIndex(x, y), trackdir(piece, 0));
  a.set(x + EDGE_MID_X[e1], h1 * HEIGHT_SCALE + LIFT, y + EDGE_MID_Y[e1]);
  b.set(x + EDGE_MID_X[e2], h2 * HEIGHT_SCALE + LIFT, y + EDGE_MID_Y[e2]);
}

const _t = new THREE.Vector3();
const _pt = new THREE.Vector3();
const _lat = new THREE.Vector3();

interface Section {
  p: THREE.Vector3;
  lat: THREE.Vector3;
}

/** Cross-sections along a curve; shared ends have identical sections, so joints are seamless. */
function sections(c: PieceCurve): Section[] {
  // Straight pieces need a single span; curved ones a few.
  const chord = _t.subVectors(c.p3, c.p0);
  const len = chord.length();
  const dev = (q: THREE.Vector3) => _pt.subVectors(q, c.p0).cross(chord).length() / Math.max(len, 1e-6);
  // Bends happen near the ends (short handles), so sample densely there.
  const ts = dev(c.p1) < 0.003 && dev(c.p2) < 0.003 ? [0, 1] : [0, 0.03, 0.07, 0.12, 0.2, 0.5, 0.8, 0.88, 0.93, 0.97, 1];
  const out: Section[] = [];
  for (const t of ts) {
    const p = curvePoint(c, t, new THREE.Vector3());
    const tan = curveTangent(c, t, _lat);
    out.push({ p, lat: new THREE.Vector3(-tan.z, 0, tan.x).normalize() });
  }
  return out;
}

/** Sweep a box-shaped profile (offset sideways, width, base, height) along sections. */
function sweep(g: GeoBuilder, secs: Section[], offset: number, half: number, base: number, height: number): void {
  const L = (s: Section, y: number) => s.p.clone().addScaledVector(s.lat, offset - half).setY(s.p.y + y);
  const R = (s: Section, y: number) => s.p.clone().addScaledVector(s.lat, offset + half).setY(s.p.y + y);
  for (let i = 0; i < secs.length - 1; i++) {
    const a = secs[i]!;
    const b = secs[i + 1]!;
    const top = base + height;
    g.quad(L(a, top), R(a, top), R(b, top), L(b, top));
    g.quad(R(a, base), R(b, base), R(b, top), R(a, top));
    g.quad(L(b, base), L(a, base), L(a, top), L(b, top));
  }
}

/** Append one track piece (ballast, sleepers, rails) following its curve. */
export function addPieceCurve(g: GeoBuilder, c: PieceCurve, lod: Lod): void {
  const secs = sections(c);
  g.color(lod >= 2 ? BALLAST_FAR : BALLAST);
  sweep(g, secs, 0, 0.21, 0, 0.03);
  if (lod >= 2) return;
  if (lod === 0) {
    const len = c.p0.distanceTo(c.p3);
    const n = Math.max(3, Math.round(len / 0.14));
    g.color(SLEEPER);
    for (let i = 0; i < n; i++) {
      const t = curveParamAt(c, (i + 0.5) / n);
      curvePoint(c, t, _p).setY(_p.y + 0.03);
      const tan = curveTangent(c, t, _t);
      const half = _q.set(-tan.z, 0, tan.x).normalize().multiplyScalar(0.16);
      g.box(_a2.copy(_p).sub(half), _b2.copy(_p).add(half), 0.05, 0.02, false);
    }
  }
  g.color(RAIL);
  for (const side of [-1, 1]) sweep(g, secs, (side * GAUGE) / 2, 0.011, 0.05, 0.025);
}

/** A straight piece between two points (bridge decks). */
export function addPiece(g: GeoBuilder, a: THREE.Vector3, b: THREE.Vector3, lod: Lod): void {
  addPieceCurve(g, straightCurve(a, b), lod);
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
  curves: TrackCurves,
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
        if (lod <= 1) addCrossingFurniture(g, map, x, y, roadPiece === 1);
      }
      const type = map.layers.type[i];
      const head = type === TileType.Rail ? headInfo(map, i) : null;
      if (head) {
        if (head.kind === 'bridge') {
          addHeadFoundation(g, map, i, head);
          addBridge(g, map, i, head, lod);
        } else {
          addTunnelPortal(g, map, i, head);
        }
      }
      if (type === TileType.Station) addPlatform(g, map, x, y, bits, lod);
      else if (type === TileType.Depot) {
        addDepot(g, map, x, y, depotExit(map.layers.data[i]!), companyColor(map.layers.owner[i]!));
        continue;
      }
      for (let p = 0; p < PIECE_COUNT; p++) {
        if (!hasPiece(bits, p)) continue;
        addPieceCurve(g, curves.get(i, p), lod);
      }
      const sig = map.layers.signals[i]!;
      if (sig && lod <= 1) {
        for (let td = 0; td < 12; td++) {
          if (!((sig >> td) & 1)) continue;
          signalPlacement(map, x, y, td, _foot, _dir);
          const f = _foot;
          g.color(SIGNAL_POST).aabb(f.x - 0.018, f.y, f.z - 0.018, f.x + 0.018, f.y + SIGNAL_POST_HEIGHT, f.z + 0.018);
          g.color(SIGNAL_HEAD).aabb(f.x - 0.045, f.y + SIGNAL_POST_HEIGHT - 0.04, f.z - 0.045, f.x + 0.045, f.y + SIGNAL_POST_HEIGHT + 0.12, f.z + 0.045);
          if (sig & SIGNAL_ONE_WAY) {
            // One-way: white plate below the head.
            g.color(ONE_WAY_PLATE).aabb(f.x - 0.055, f.y + SIGNAL_POST_HEIGHT - 0.17, f.z - 0.055, f.x + 0.055, f.y + SIGNAL_POST_HEIGHT - 0.08, f.z + 0.055);
          }
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
