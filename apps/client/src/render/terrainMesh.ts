import {
  CHUNK_SIZE,
  Ground,
  HEIGHT_SCALE,
  SNOW_LINE,
  TileType,
  tileSplitsNWSE,
  type GameMap,
} from '@transportsim/shared';
import * as THREE from 'three';

/** Level-of-detail: cells are (1 << lod) tiles wide. */
export type Lod = 0 | 1 | 2 | 3;

/** Visual water surface height (world units), slightly above sea-level corners. */
export const WATER_Y = 0.45 * HEIGHT_SCALE;
const SKIRT_DEPTH = 2;

const GROUND_RGB: Record<number, [number, number, number]> = {
  [Ground.Grass]: rgb('#88a95a'),
  [Ground.Rough]: rgb('#9a9b62'),
  [Ground.Rocks]: rgb('#9c968c'),
  [Ground.Sand]: rgb('#dccb98'),
  [Ground.Snow]: rgb('#eef2f6'),
};
const HIGH_GRASS = rgb('#6e8f4a');
const SEABED = rgb('#b3a274');
const ROCK = rgb('#9c968c');

function rgb(hex: string): [number, number, number] {
  const c = new THREE.Color(hex).convertSRGBToLinear();
  return [c.r, c.g, c.b];
}

/** Deterministic per-tile hash in [0, 1). */
export function tileHash(x: number, y: number, salt = 0): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(salt, 2246822519);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function tileColor(map: GameMap, x: number, y: number, out: [number, number, number]): void {
  const i = map.tileIndex(x, y);
  const type = map.layers.type[i];
  const maxH = map.tileMaxHeight(x, y);
  let base: [number, number, number];
  if (type === TileType.Water) base = SEABED;
  else {
    const ground = (map.layers.data[i]! >> 3) & 0x7;
    base = GROUND_RGB[ground] ?? GROUND_RGB[Ground.Grass]!;
    if (ground === Ground.Grass) {
      const t = Math.min(1, maxH / (SNOW_LINE - 4));
      base = [lerp(base[0], HIGH_GRASS[0], t), lerp(base[1], HIGH_GRASS[1], t), lerp(base[2], HIGH_GRASS[2], t)];
      if (maxH > SNOW_LINE - 6) {
        const r = (maxH - (SNOW_LINE - 6)) / 6;
        base = [lerp(base[0], ROCK[0], r), lerp(base[1], ROCK[1], r), lerp(base[2], ROCK[2], r)];
      }
    }
  }
  const v = 0.94 + tileHash(x, y) * 0.12;
  out[0] = base[0] * v;
  out[1] = base[1] * v;
  out[2] = base[2] * v;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/**
 * Build a flat-shaded terrain mesh for one chunk. Non-indexed so every triangle has its
 * own normal (the faceted low-poly look). Edges get skirts to hide LOD seams.
 */
export function buildTerrainGeometry(map: GameMap, cx: number, cy: number, lod: Lod): THREE.BufferGeometry {
  const step = 1 << lod;
  const cells = CHUNK_SIZE / step;
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const triCount = cells * cells * 2 + cells * 4 * 2;
  const pos = new Float32Array(triCount * 9);
  const col = new Float32Array(triCount * 9);
  let p = 0;
  const color: [number, number, number] = [0, 0, 0];

  const pushTri = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    qx: number, qy: number, qz: number,
    shade = 1,
  ) => {
    pos[p] = ax; pos[p + 1] = ay; pos[p + 2] = az;
    pos[p + 3] = bx; pos[p + 4] = by; pos[p + 5] = bz;
    pos[p + 6] = qx; pos[p + 7] = qy; pos[p + 8] = qz;
    for (let k = 0; k < 3; k++) {
      col[p + k * 3] = color[0] * shade;
      col[p + k * 3 + 1] = color[1] * shade;
      col[p + k * 3 + 2] = color[2] * shade;
    }
    p += 9;
  };

  const H = (x: number, y: number) => map.cornerHeight(x, y) * HEIGHT_SCALE;

  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const tx = x0 + i * step;
      const ty = y0 + j * step;
      const ex = tx + step;
      const ey = ty + step;
      const nw = H(tx, ty), ne = H(ex, ty), se = H(ex, ey), sw = H(tx, ey);
      tileColor(map, tx + (step >> 1), ty + (step >> 1), color);
      // Counter-clockwise when seen from above (+Y), with Z pointing "south".
      if (tileSplitsNWSE(nw, ne, se, sw)) {
        pushTri(tx, nw, ty, ex, se, ey, ex, ne, ty);
        pushTri(tx, nw, ty, tx, sw, ey, ex, se, ey);
      } else {
        pushTri(tx, nw, ty, tx, sw, ey, ex, ne, ty);
        pushTri(ex, ne, ty, tx, sw, ey, ex, se, ey);
      }
    }
  }

  // Skirts along the four chunk edges.
  const bottom = -SKIRT_DEPTH;
  for (let k = 0; k < cells; k++) {
    const a = k * step;
    const b = a + step;
    // north edge (z = y0), facing -Z
    tileColor(map, x0 + a, y0, color);
    skirt(x0 + a, y0, x0 + b, y0);
    // south edge (z = y0 + CHUNK), facing +Z
    tileColor(map, x0 + a, y0 + CHUNK_SIZE - 1, color);
    skirt(x0 + b, y0 + CHUNK_SIZE, x0 + a, y0 + CHUNK_SIZE);
    // west edge (x = x0), facing -X
    tileColor(map, x0, y0 + a, color);
    skirt(x0, y0 + b, x0, y0 + a);
    // east edge (x = x0 + CHUNK), facing +X
    tileColor(map, x0 + CHUNK_SIZE - 1, y0 + a, color);
    skirt(x0 + CHUNK_SIZE, y0 + a, x0 + CHUNK_SIZE, y0 + b);
  }

  function skirt(ax: number, az: number, bx: number, bz: number) {
    const ha = H(ax, az);
    const hb = H(bx, bz);
    pushTri(ax, ha, az, bx, hb, bz, ax, bottom, az, 0.7);
    pushTri(bx, hb, bz, bx, bottom, bz, ax, bottom, az, 0.7);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** Water surface quads for cells that touch sea level. Returns null if the chunk is dry. */
export function buildWaterGeometry(map: GameMap, cx: number, cy: number, lod: Lod): THREE.BufferGeometry | null {
  const step = 1 << lod;
  const cells = CHUNK_SIZE / step;
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const quads: number[] = [];
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const tx = x0 + i * step;
      const ty = y0 + j * step;
      let wet = false;
      for (let dy = 0; dy < step && !wet; dy++) {
        for (let dx = 0; dx < step && !wet; dx++) {
          if (map.tileMinHeight(tx + dx, ty + dy) === 0) wet = true;
        }
      }
      if (wet) quads.push(tx, ty);
    }
  }
  if (quads.length === 0) return null;
  const n = quads.length / 2;
  const pos = new Float32Array(n * 18);
  for (let q = 0; q < n; q++) {
    const x = quads[q * 2]!;
    const z = quads[q * 2 + 1]!;
    const e = x + step;
    const s = z + step;
    pos.set([x, WATER_Y, z, x, WATER_Y, s, e, WATER_Y, z, e, WATER_Y, z, x, WATER_Y, s, e, WATER_Y, s], q * 18);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const normals = new Float32Array(n * 18);
  for (let k = 0; k < n * 6; k++) normals[k * 3 + 1] = 1;
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.computeBoundingSphere();
  return geo;
}
