import {
  CHUNK_SIZE,
  EDGE_MID_X,
  EDGE_MID_Y,
  HEIGHT_SCALE,
  ROAD_EDGE_BITS,
  TileType,
  edgeHeight,
  houseType,
  type GameMap,
  type HouseType,
} from '@transportsim/shared';
import * as THREE from 'three';
import { GeoBuilder, lin } from './geoBuilder.ts';
import { tileHash } from './terrainMesh.ts';

type Model = HouseType['model'];

interface ModelGeo {
  walls: THREE.BufferGeometry;
  roof: THREE.BufferGeometry;
}

const WHITE = lin('#ffffff');
const WINDOW = lin('#3a4552');

function windows(g: GeoBuilder, x0: number, x1: number, z: number, floors: number, floorH: number, base = 0.06): void {
  g.color(WINDOW);
  const cols = Math.max(1, Math.round((x1 - x0) / 0.16));
  const w = ((x1 - x0) / cols) * 0.45;
  for (let f = 0; f < floors; f++) {
    const y = base + f * floorH + floorH * 0.35;
    for (let c = 0; c < cols; c++) {
      const cx = x0 + ((c + 0.5) * (x1 - x0)) / cols;
      g.aabb(cx - w / 2, y, z - 0.008, cx + w / 2, y + floorH * 0.35, z + 0.008);
    }
  }
  g.color(WHITE);
}

/** Building models: walls (tinted per instance) and roofs (tinted separately). Front faces +Z. */
function makeModel(model: Model): ModelGeo {
  const w = new GeoBuilder().color(WHITE);
  const r = new GeoBuilder().color(WHITE);
  switch (model) {
    case 'cottage':
      w.aabb(-0.24, 0, -0.2, 0.24, 0.3, 0.2);
      windows(w, -0.2, 0.2, 0.2, 1, 0.24);
      r.gable(-0.24, -0.2, 0.24, 0.2, 0.3, 0.22);
      break;
    case 'terrace':
      w.aabb(-0.4, 0, -0.2, 0.4, 0.42, 0.2);
      windows(w, -0.36, 0.36, 0.2, 2, 0.18);
      r.gable(-0.4, -0.2, 0.4, 0.2, 0.42, 0.2);
      break;
    case 'shop':
      w.aabb(-0.32, 0, -0.28, 0.32, 0.36, 0.28);
      windows(w, -0.28, 0.28, 0.28, 1, 0.3, 0.02);
      r.aabb(-0.35, 0.36, -0.31, 0.35, 0.4, 0.31);
      r.aabb(-0.32, 0.2, 0.28, 0.32, 0.23, 0.38); // awning
      break;
    case 'townhouse':
      w.aabb(-0.3, 0, -0.26, 0.3, 0.72, 0.26);
      windows(w, -0.26, 0.26, 0.26, 3, 0.22);
      r.gable(-0.3, -0.26, 0.3, 0.26, 0.72, 0.24);
      break;
    case 'church':
      w.aabb(-0.2, 0, -0.36, 0.2, 0.42, 0.2);
      w.aabb(-0.12, 0, 0.2, 0.12, 0.95, 0.38); // tower
      r.gable(-0.36, -0.2, 0.2, 0.2, 0.42, 0.24);
      r.pyramid(0, 0.29, 0.13, 0.95, 0.42);
      break;
    case 'flats':
      w.aabb(-0.36, 0, -0.3, 0.36, 1.15, 0.3);
      windows(w, -0.32, 0.32, 0.3, 5, 0.21);
      r.aabb(-0.38, 1.15, -0.32, 0.38, 1.2, 0.32);
      break;
    case 'office':
      w.aabb(-0.34, 0, -0.34, 0.34, 1.9, 0.34);
      windows(w, -0.3, 0.3, 0.34, 8, 0.22);
      r.aabb(-0.36, 1.9, -0.36, 0.36, 1.96, 0.36);
      r.aabb(-0.1, 1.96, -0.1, 0.1, 2.12, 0.1);
      break;
  }
  return { walls: w.build()!, roof: r.build()! };
}

const MODELS: Record<Model, ModelGeo> = {
  cottage: makeModel('cottage'),
  terrace: makeModel('terrace'),
  shop: makeModel('shop'),
  townhouse: makeModel('townhouse'),
  church: makeModel('church'),
  flats: makeModel('flats'),
  office: makeModel('office'),
};

const WALLS = ['#eadfcb', '#d9c3a5', '#c98a64', '#b0603e', '#efe9df', '#c9cfd6', '#e3cf9a'].map(lin);
const ROOFS = ['#8c3b2e', '#6b4a3a', '#4a5a66', '#7b3f2a', '#3e4a52', '#5c6b3a'].map(lin);
const CHURCH_WALL = lin('#cfc6b4');
const CHURCH_ROOF = lin('#4a5560');
const MODERN_WALLS = ['#c9cfd6', '#b8c2cc', '#d6d0c4', '#9fb0bf'].map(lin);

export const buildingMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

const tmp = new THREE.Object3D();
// Model front faces +Z; rotate it to face the road edge (N, E, S, W).
const FACE_ROT = [Math.PI, Math.PI / 2, 0, -Math.PI / 2];

/** Instanced houses for a chunk (one walls + one roof mesh per model in use). */
export function buildHouses(map: GameMap, cx: number, cy: number): THREE.InstancedMesh[] {
  const byModel = new Map<Model, number[]>();
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  for (let y = y0; y < y0 + CHUNK_SIZE; y++) {
    for (let x = x0; x < x0 + CHUNK_SIZE; x++) {
      const i = map.tileIndex(x, y);
      if (map.layers.type[i] !== TileType.House) continue;
      const m = houseType(map.layers.data[i]!).model;
      let list = byModel.get(m);
      if (!list) byModel.set(m, (list = []));
      list.push(i);
    }
  }
  const out: THREE.InstancedMesh[] = [];
  for (const [model, tiles] of byModel) {
    const geo = MODELS[model];
    const walls = new THREE.InstancedMesh(geo.walls, buildingMaterial, tiles.length);
    const roof = new THREE.InstancedMesh(geo.roof, buildingMaterial, tiles.length);
    tiles.forEach((i, k) => {
      const x = i % map.width;
      const y = (i - x) / map.width;
      const face = (map.layers.data[i]! >> 8) & 3;
      const h = tileHash(x, y, 7);
      tmp.position.set(x + 0.5, map.cornerHeight(x, y) * HEIGHT_SCALE, y + 0.5);
      tmp.rotation.set(0, FACE_ROT[face]!, 0);
      const s = 0.92 + h * 0.16;
      tmp.scale.set(s, 0.9 + tileHash(x, y, 9) * 0.25, s);
      tmp.updateMatrix();
      walls.setMatrixAt(k, tmp.matrix);
      roof.setMatrixAt(k, tmp.matrix);
      const modern = model === 'flats' || model === 'office';
      const wallPalette = modern ? MODERN_WALLS : WALLS;
      walls.setColorAt(k, model === 'church' ? CHURCH_WALL : wallPalette[Math.floor(h * wallPalette.length)]!);
      roof.setColorAt(k, model === 'church' ? CHURCH_ROOF : ROOFS[Math.floor(tileHash(x, y, 3) * ROOFS.length)]!);
    });
    for (const m of [walls, roof]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere();
      out.push(m);
    }
  }
  return out;
}

const ASPHALT = lin('#53575c');
const PAVEMENT = lin('#9a958c');
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

/** Road surfaces for a chunk (town roads; level crossings are drawn with the track). */
export function addRoads(g: GeoBuilder, map: GameMap, cx: number, cy: number): void {
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  for (let y = y0; y < y0 + CHUNK_SIZE; y++) {
    for (let x = x0; x < x0 + CHUNK_SIZE; x++) {
      const i = map.tileIndex(x, y);
      if (map.layers.type[i] !== TileType.Road) continue;
      const bits = map.layers.data[i]! & 0xf;
      const corners = map.tileCorners(x, y);
      const centre = ((corners[0] + corners[1] + corners[2] + corners[3]) / 4) * HEIGHT_SCALE + 0.01;
      _a.set(x + 0.5, centre, y + 0.5);
      const flat = map.isFlat(x, y);
      if (flat) g.color(PAVEMENT).box(_b.set(x + 0.5, centre - 0.002, y + 0.08), _a.clone().setZ(y + 0.92), 0.84, 0.018, false);
      for (let e = 0; e < 4; e++) {
        if (!(bits & ROAD_EDGE_BITS[e]!)) continue;
        const eh = Math.max(0, edgeHeight(corners, e as 0 | 1 | 2 | 3)) * HEIGHT_SCALE + 0.01;
        _b.set(x + EDGE_MID_X[e]!, eh, y + EDGE_MID_Y[e]!);
        g.color(ASPHALT).box(_a, _b, 0.56, 0.03, false);
      }
      if (flat) g.color(ASPHALT).box(_b.set(x + 0.5, centre, y + 0.22), _a.clone().setZ(y + 0.78), 0.56, 0.03, false);
    }
  }
}
