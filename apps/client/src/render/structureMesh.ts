import {
  BRIDGE_TYPES,
  EDGE_DX,
  EDGE_DY,
  EDGE_MID_X,
  EDGE_MID_Y,
  HEIGHT_SCALE,
  OPPOSITE_EDGE,
  headLevel,
  isElectrified,
  otherHead,
  type GameMap,
  type HeadInfo,
} from '@transportsim/shared';
import * as THREE from 'three';
import { GeoBuilder, lin } from './geoBuilder.ts';
import { groundColor, type Lod } from './terrainMesh.ts';
import { addDeckCatenary, addPiece } from './trackMesh.ts';

const LIFT = 0.012;
const DECK = lin('#6f6a63');
const WOOD = lin('#6b4a2f');
const STEEL = lin('#5a6b78');
const STONE = lin('#9b9286');
const CONCRETE = lin('#b5b2ab');
const CABLE = lin('#3a3f45');
const PORTAL = lin('#8a8073');
const DARK = lin('#121417');
const FOUNDATION = lin('#a39a8c');

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/**
 * Draw a whole bridge from its west/north head. (The east/south head draws nothing, so each
 * bridge is built exactly once, in the chunk of its first head.)
 */
export function addBridge(g: GeoBuilder, map: GameMap, tile: number, info: HeadInfo, lod: Lod, railType = 0): void {
  if (info.dir !== 1 && info.dir !== 2) return; // only heads facing E or S draw
  const far = otherHead(map, tile, info);
  if (far < 0) return;
  const w = map.width;
  const level = headLevel(map, tile, info);
  const y = level * HEIGHT_SCALE + LIFT;
  const look = BRIDGE_TYPES[info.bridgeType]?.look ?? 'girder';
  const dx = EDGE_DX[info.dir];
  const dz = EDGE_DY[info.dir];
  const x0 = tile % w;
  const z0 = (tile - x0) / w;
  const fx = far % w;
  const fz = (far - fx) / w;
  const span = Math.abs(fx - x0) + Math.abs(fz - z0) - 1;
  // Deck from the near head's span edge to the far head's span edge.
  const ax = x0 + EDGE_MID_X[info.dir];
  const az = z0 + EDGE_MID_Y[info.dir];
  const bx = fx + EDGE_MID_X[OPPOSITE_EDGE[info.dir]];
  const bz = fz + EDGE_MID_Y[OPPOSITE_EDGE[info.dir]];
  const deckDepth = look === 'concrete' ? 0.16 : 0.09;
  g.color(look === 'concrete' ? CONCRETE : DECK).box(_a.set(ax, y - deckDepth, az), _b.set(bx, y - deckDepth, bz), 0.62, deckDepth, true);
  const wires = isElectrified(railType) && lod <= 1;
  for (let k = 1; k <= span; k++) {
    const mx = x0 + dx * k;
    const mz = z0 + dz * k;
    _a.set(mx + 0.5 - dx * 0.5, y, mz + 0.5 - dz * 0.5);
    _b.set(mx + 0.5 + dx * 0.5, y, mz + 0.5 + dz * 0.5);
    addPiece(g, _a, _b, lod, railType);
    // A mast on every other tile, and at the last one.
    if (wires) addDeckCatenary(g, _a, _b, k % 2 === 1 || k === span);
  }

  const sideX = -dz; // perpendicular
  const sideZ = dx;
  const ground = (k: number) => {
    const mx = x0 + dx * k;
    const mz = z0 + dz * k;
    return map.inBounds(mx, mz) ? map.tileMinHeight(mx, mz) * HEIGHT_SCALE : 0;
  };
  const centre = (k: number) => ({ x: x0 + dx * k + 0.5, z: z0 + dz * k + 0.5 });

  if (look === 'wood') {
    g.color(WOOD);
    for (let k = 1; k <= span; k++) {
      const c = centre(k);
      for (const s of [-1, 1]) {
        const px = c.x + sideX * 0.24 * s;
        const pz = c.z + sideZ * 0.24 * s;
        g.aabb(px - 0.03, ground(k) - 0.05, pz - 0.03, px + 0.03, y - deckDepth, pz + 0.03);
      }
      // Cross brace
      g.box(_a.set(c.x - sideX * 0.24, (ground(k) + y) / 2, c.z - sideZ * 0.24), _b.set(c.x + sideX * 0.24, (ground(k) + y) / 2, c.z + sideZ * 0.24), 0.04, 0.04);
    }
  } else if (look === 'girder' || look === 'concrete') {
    if (look === 'girder') {
      g.color(STEEL);
      for (const s of [-1, 1]) {
        const ox = sideX * 0.3 * s;
        const oz = sideZ * 0.3 * s;
        g.box(_a.set(ax + ox, y - 0.02, az + oz), _b.set(bx + ox, y - 0.02, bz + oz), 0.04, 0.2);
      }
    }
    g.color(look === 'girder' ? STONE : CONCRETE);
    const every = look === 'girder' ? 3 : 2;
    for (let k = 1; k <= span; k++) {
      if (k % every !== 0 && k !== span) continue;
      const c = centre(k);
      const r = look === 'girder' ? 0.14 : 0.1;
      g.aabb(c.x - (dx ? r : 0.24), ground(k) - 0.05, c.z - (dz ? r : 0.24), c.x + (dx ? r : 0.24), y - deckDepth, c.z + (dz ? r : 0.24));
    }
  } else {
    // Suspension: two towers and draped cables.
    const t1 = Math.max(1, Math.round(span * 0.2));
    const t2 = Math.max(1, Math.round(span * 0.8));
    const top = y + 0.9;
    g.color(STEEL);
    for (const k of [t1, t2]) {
      const c = centre(k);
      for (const s of [-1, 1]) {
        const px = c.x + sideX * 0.34 * s;
        const pz = c.z + sideZ * 0.34 * s;
        g.aabb(px - 0.04, ground(k) - 0.05, pz - 0.04, px + 0.04, top, pz + 0.04);
      }
    }
    g.color(CABLE);
    for (const s of [-1, 1]) {
      const pts: THREE.Vector3[] = [];
      const steps = Math.max(4, span * 2);
      for (let i = 0; i <= steps; i++) {
        const t = i / steps;
        const k = t * (span + 1);
        // Catenary-ish: high at the towers, low mid-span, anchored at the heads.
        const u = k < t1 ? k / t1 : k > t2 ? (span + 1 - k) / (span + 1 - t2) : 1 - Math.sin(((k - t1) / (t2 - t1)) * Math.PI) * 0.75;
        const px = ax + (bx - ax) * t + sideX * 0.34 * s;
        const pz = az + (bz - az) * t + sideZ * 0.34 * s;
        pts.push(new THREE.Vector3(px, y + 0.05 + (top - y - 0.05) * Math.max(0, Math.min(1, u)), pz));
      }
      for (let i = 1; i < pts.length; i++) g.box(pts[i - 1]!, pts[i]!, 0.025, 0.025);
    }
  }
}

/** Level foundation under a bridge head that sits on a slope falling towards the bridge. */
export function addHeadFoundation(g: GeoBuilder, map: GameMap, tile: number, info: HeadInfo): void {
  const w = map.width;
  const x = tile % w;
  const z = (tile - x) / w;
  const level = headLevel(map, tile, info);
  const low = map.tileMinHeight(x, z);
  if (info.kind !== 'bridge' || low >= level) return;
  g.color(FOUNDATION).aabb(x + 0.04, low * HEIGHT_SCALE - 0.02, z + 0.04, x + 0.96, level * HEIGHT_SCALE + 0.005, z + 0.96);
}

/** Stone portal with a dark opening on the hill side of a tunnel entrance. */
export function addTunnelPortal(g: GeoBuilder, map: GameMap, tile: number, info: HeadInfo): void {
  const w = map.width;
  const x = tile % w;
  const z = (tile - x) / w;
  const y = headLevel(map, tile, info) * HEIGHT_SCALE;
  // `u` runs from the tile centre into the hill, `v` across the track, `h` up from the floor.
  const fdx = EDGE_DX[info.dir];
  const fdz = EDGE_DY[info.dir];
  const P = (u: number, v: number, h: number) => new THREE.Vector3(x + 0.5 + fdx * u - fdz * v, y + h, z + 0.5 + fdz * u + fdx * v);
  const outward = P(-1, 0, 0).sub(P(0, 0, 0));
  // The hill is gentler than the portal is tall, so the hill swells up over it: a mound in the
  // colour of the ground that slopes back and to the sides into the real terrain.
  const front = 0.34;
  const top = 0.74;
  const half = 0.45;
  const back = 0.55; // height lost per tile going back
  const side = 2.4; // ... and per tile going sideways past the portal
  const wide = half + top / side;
  const long = top / back;
  const crest = (v: number) => top - Math.max(0, Math.abs(v) - half) * side;
  const ground = (u: number, v: number) => {
    const p = P(u, v, 0);
    const gx = Math.max(0, Math.min(map.width - 0.001, p.x));
    const gz = Math.max(0, Math.min(map.height - 0.001, p.z));
    return map.heightAt(gx, gz) * HEIGHT_SCALE - y;
  };
  const NU = 6;
  const NV = 8;
  const grid: THREE.Vector3[][] = [];
  for (let i = 0; i <= NU; i++) {
    const u = front + (long * i) / NU;
    grid.push(
      Array.from({ length: NV + 1 }, (_, j) => {
        const v = -wide + (2 * wide * j) / NV;
        return P(u, v, Math.max(ground(u, v) - 0.03, crest(v) - (u - front) * back));
      }),
    );
  }
  const behind = map.tileIndex(Math.max(0, Math.min(map.width - 1, x + fdx)), Math.max(0, Math.min(map.height - 1, z + fdz)));
  groundColor(map, behind % w, Math.floor(behind / w), _col);
  g.color(_col);
  for (let i = 0; i < NU; i++) {
    for (let j = 0; j < NV; j++) face(g, [grid[i]![j]!, grid[i + 1]![j]!, grid[i + 1]![j + 1]!, grid[i]![j + 1]!], _up);
  }
  // Stone facade with wing walls whose tops follow the mound down to the ground.
  g.color(PORTAL);
  const foot = -0.05;
  face(g, [P(front, -half, foot), P(front, half, foot), P(front, half, top), P(front, -half, top)], outward);
  for (const s of [-1, 1]) face(g, [P(front, s * half, foot), P(front, s * wide, foot), P(front, s * half, top)], outward);
  // The mouth clears a pantograph at the contact wire.
  g.color(DARK);
  const m = front - 0.004;
  face(g, [P(m, -0.26, 0), P(m, 0.26, 0), P(m, 0.26, 0.6), P(m, -0.26, 0.6)], outward);
}

const _up = new THREE.Vector3(0, 1, 0);
const _col = new THREE.Color();
const _n = new THREE.Vector3();
const _e = new THREE.Vector3();

/** A flat polygon (3 or 4 points) wound to face `out`. */
function face(g: GeoBuilder, pts: THREE.Vector3[], out: THREE.Vector3): void {
  _n.subVectors(pts[1]!, pts[0]!).cross(_e.subVectors(pts[2]!, pts[0]!));
  if (_n.dot(out) < 0) pts.reverse();
  if (pts.length === 3) g.tri(pts[0]!, pts[1]!, pts[2]!);
  else g.quad(pts[0]!, pts[1]!, pts[2]!, pts[3]!);
}
