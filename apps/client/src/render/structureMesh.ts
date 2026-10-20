import {
  BRIDGE_TYPES,
  EDGE_DX,
  EDGE_DY,
  EDGE_MID_X,
  EDGE_MID_Y,
  HEIGHT_SCALE,
  OPPOSITE_EDGE,
  headLevel,
  otherHead,
  type GameMap,
  type HeadInfo,
} from '@transportsim/shared';
import * as THREE from 'three';
import { GeoBuilder, lin } from './geoBuilder.ts';
import type { Lod } from './terrainMesh.ts';
import { addPiece } from './trackMesh.ts';

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
export function addBridge(g: GeoBuilder, map: GameMap, tile: number, info: HeadInfo, lod: Lod): void {
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
  for (let k = 1; k <= span; k++) {
    const mx = x0 + dx * k;
    const mz = z0 + dz * k;
    addPiece(g, _a.set(mx + 0.5 - dx * 0.5, y, mz + 0.5 - dz * 0.5), _b.set(mx + 0.5 + dx * 0.5, y, mz + 0.5 + dz * 0.5), lod);
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
  const level = headLevel(map, tile, info);
  const y = level * HEIGHT_SCALE;
  // Facade against the hill at the back of the portal's cutting, facing out.
  const t = 0.08;
  const fx = x + 0.5 + EDGE_DX[info.dir] * (0.5 - t);
  const fz = z + 0.5 + EDGE_DY[info.dir] * (0.5 - t);
  const along = info.dir === 1 || info.dir === 3;
  g.color(PORTAL);
  if (along) g.aabb(fx - t, y, fz - 0.45, fx + t, y + 0.74, fz + 0.45);
  else g.aabb(fx - 0.45, y, fz - t, fx + 0.45, y + 0.74, fz + t);
  g.color(DARK);
  const o = -EDGE_DX[info.dir] * (t + 0.004);
  const p = -EDGE_DY[info.dir] * (t + 0.004);
  // The mouth clears a pantograph at the contact wire.
  if (along) g.aabb(fx + o - 0.002, y, fz - 0.26, fx + o + 0.002, y + 0.6, fz + 0.26);
  else g.aabb(fx - 0.26, y, fz + p - 0.002, fx + 0.26, y + 0.6, fz + p + 0.002);
}
