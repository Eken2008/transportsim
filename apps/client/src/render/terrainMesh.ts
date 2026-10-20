import {
  CHUNK_SIZE,
  EDGE_CORNERS,
  EDGE_DX,
  EDGE_DY,
  halfCorner,
  FIELD_CROP_SHIFT,
  headInfo,
  headLevel,
  isRapids,
  isRiver,
  waterAxis,
  Ground,
  HEIGHT_SCALE,
  SNOW_LINE,
  TileType,
  type WorldClimate,
  tileSplitsNWSE,
  type GameMap,
} from '@transportsim/shared';
import * as THREE from 'three';

/** Level-of-detail: cells are (1 << lod) tiles wide. */
export type Lod = 0 | 1 | 2 | 3;

/** Visual water surface height (world units), slightly above sea-level corners. */
export const WATER_Y = 0.45 * HEIGHT_SCALE;
const SKIRT_DEPTH = 2;
/** Skirts start just below the surface so they never show along seams between equal-LOD chunks. */
const SKIRT_INSET = 0.03;

const GROUND_RGB: Record<number, [number, number, number]> = {
  [Ground.Grass]: rgb('#8db35e'),
  [Ground.Rough]: rgb('#9a9b62'),
  [Ground.Rocks]: rgb('#9c968c'),
  [Ground.Sand]: rgb('#dccb98'),
  [Ground.Snow]: rgb('#eef2f6'),
};
/** Field crops: ripe wheat, ploughed soil, young green crop, flowering rapeseed. */
export const CROP_RGB: [number, number, number][] = [rgb('#d2b35a'), rgb('#7e5f3d'), rgb('#7aa646'), rgb('#dfc93c')];
const HIGH_GRASS = rgb('#73984f');
const SEABED = rgb('#b3a274');
const ROCK = rgb('#9c968c');
/** Sub-arctic: grass turns to tundra towards the snow line, and snow covers what lies above it. */
const TUNDRA = rgb('#8f9470');
const SNOW = rgb('#eef2f6');
const SNOWY_ROCK = rgb('#c4c8cc');
/** Sub-tropical grassland, desert and rainforest, by ground (grass, rough, rocks). */
const SAVANNA = rgb('#9db55a');
const DESERT_RGB = [rgb('#e3c78f'), rgb('#cdae72'), rgb('#b88a62')];
const JUNGLE_RGB = [rgb('#4a8a36'), rgb('#557f38'), rgb('#7d8a6c')];
/** Stone walls of foundations, where a levelled tile stands above the land beside it. */
const FOUNDATION = rgb('#a69c8b');

function rgb(hex: string): [number, number, number] {
  const c = new THREE.Color(hex); // ColorManagement converts sRGB hex to linear
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
    if (ground === Ground.Field) {
      // A field is one even colour, so its outline reads from afar.
      const c = CROP_RGB[(map.layers.data[i]! >> FIELD_CROP_SHIFT) & 3]!;
      const v = 0.98 + tileHash(x, y) * 0.04;
      out[0] = c[0] * v;
      out[1] = c[1] * v;
      out[2] = c[2] * v;
      return;
    }
    base = GROUND_RGB[ground] ?? GROUND_RGB[Ground.Grass]!;
    const climate = map.climate;
    if (climate.id === 'arctic') base = arcticColor(map, climate, x, y, ground, maxH, base);
    else if (climate.id === 'tropical') base = tropicalColor(climate, x, y, ground, base);
    else if (ground === Ground.Grass) {
      const t = Math.min(1, maxH / (SNOW_LINE - 4));
      base = mix(base, HIGH_GRASS, t);
      if (maxH > SNOW_LINE - 6) base = mix(base, ROCK, (maxH - (SNOW_LINE - 6)) / 6);
    }
  }
  const v = 0.94 + tileHash(x, y) * 0.12;
  out[0] = base[0] * v;
  out[1] = base[1] * v;
  out[2] = base[2] * v;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const mix = (a: readonly number[], b: readonly number[], t: number): [number, number, number] => [lerp(a[0]!, b[0]!, t), lerp(a[1]!, b[1]!, t), lerp(a[2]!, b[2]!, t)];

/** Sub-arctic ground: tundra towards the snow line, snow above it (and half way on tiles reaching it). */
function arcticColor(map: GameMap, climate: WorldClimate, x: number, y: number, ground: number, maxH: number, base: [number, number, number]): [number, number, number] {
  if (ground === Ground.Sand) return base;
  if (ground === Ground.Grass || ground === Ground.Rough) base = mix(base, TUNDRA, Math.min(1, maxH / climate.snowLine) * 0.8);
  const snow = ground === Ground.Rocks ? SNOWY_ROCK : SNOW;
  if (map.zone(x, y) === 'snow') return snow;
  return maxH >= climate.snowLine ? mix(base, snow, 0.55) : base;
}

/** Sub-tropical ground: grassland, easing into desert sand or rainforest green. */
function tropicalColor(climate: WorldClimate, x: number, y: number, ground: number, base: [number, number, number]): [number, number, number] {
  const k = ground === Ground.Grass ? 0 : ground === Ground.Rough ? 1 : ground === Ground.Rocks ? 2 : -1;
  if (k < 0) return base;
  if (k === 0) base = SAVANNA;
  const w = climate.wetness(x, y);
  if (w < 0) return mix(base, DESERT_RGB[k]!, -w);
  if (w > 0) return mix(base, JUNGLE_RGB[k]!, w);
  return base;
}

const _rgb: [number, number, number] = [0, 0, 0];

/** The terrain's colour on a tile (linear), for things that should blend into the ground. */
export function groundColor(map: GameMap, x: number, y: number, out: THREE.Color): THREE.Color {
  tileColor(map, x, y, _rgb);
  return out.setRGB(_rgb[0], _rgb[1], _rgb[2], THREE.LinearSRGBColorSpace);
}

/** Tile-local x, z of the NW, NE, SE and SW corners. */
const CORNER_XZ = [[0, 0], [1, 0], [1, 1], [0, 1]] as const;

/**
 * Cliff walls of the tiles on foundations in a chunk: x1, z1, x2, z2, then the top and bottom
 * level at each end, wound to face the lower side. Walls run along tile edges, down from the
 * foundation to the surface of the tile beside it (or the terrain at the map's edge), and across
 * half-tile foundations, down from the raised half to the low one.
 */
function foundationWalls(map: GameMap, x0: number, y0: number): number[] {
  const out: number[] = [];
  const wall = (ax: number, az: number, bx: number, bz: number, ta: number, la: number, tb: number, lb: number, ox: number, oz: number) => {
    if (la >= ta && lb >= tb) return;
    // Facing (ox, oz): the normal of (top a, top b, low b) is (bz - az, 0, ax - bx) times the drop.
    if ((bz - az) * ox + (ax - bx) * oz >= 0) out.push(ax, az, bx, bz, ta, Math.min(ta, la), tb, Math.min(tb, lb));
    else out.push(bx, bz, ax, az, tb, Math.min(tb, lb), ta, Math.min(ta, la));
  };
  const found = map.layers.foundation;
  for (let ty = y0; ty < y0 + CHUNK_SIZE; ty++) {
    for (let tx = x0; tx < x0 + CHUNK_SIZE; tx++) {
      const kind = found[map.tileIndex(tx, ty)]!;
      if (!kind) continue;
      const raw = map.rawCorners(tx, ty);
      for (let e = 0; e < 4; e++) {
        const nx = tx + EDGE_DX[e]!;
        const ny = ty + EDGE_DY[e]!;
        // Both edges list their corners in the same order (west to east, north to south).
        const [ta, tb] = map.edgeCorners(tx, ty, e);
        const [la, lb] = map.inBounds(nx, ny) ? map.edgeCorners(nx, ny, (e + 2) & 3) : EDGE_CORNERS[e]!.map((c) => raw[c]!);
        const [ca, cb] = EDGE_CORNERS[e]!;
        wall(tx + CORNER_XZ[ca]![0], ty + CORNER_XZ[ca]![1], tx + CORNER_XZ[cb]![0], ty + CORNER_XZ[cb]![1], ta, la!, tb, lb!, EDGE_DX[e]!, EDGE_DY[e]!);
      }
      const k = halfCorner(kind);
      if (k >= 0) {
        // Across the tile between the corners beside the raised one, facing the low corner.
        const top = Math.max(...raw);
        const [a, b, low] = [(k + 1) & 3, (k + 3) & 3, (k + 2) & 3];
        const [ax, az] = CORNER_XZ[a]!;
        const [bx, bz] = CORNER_XZ[b]!;
        wall(tx + ax, ty + az, tx + bx, ty + bz, top, raw[a]!, top, raw[b]!, CORNER_XZ[low]![0] - CORNER_XZ[k]![0], CORNER_XZ[low]![1] - CORNER_XZ[k]![1]);
      }
    }
  }
  return out;
}

/** Floor level of a tunnel portal's cutting, or -1 if the tile isn't a portal. */
function cuttingLevel(map: GameMap, x: number, y: number): number {
  const i = map.tileIndex(x, y);
  if (map.layers.type[i] !== TileType.Rail) return -1;
  const info = headInfo(map, i);
  return info?.kind === 'tunnel' ? headLevel(map, i, info) : -1;
}

/**
 * Build a flat-shaded terrain mesh for one chunk. Non-indexed so every triangle has its
 * own normal (the faceted low-poly look). Edges get skirts to hide LOD seams.
 */
export function buildTerrainGeometry(map: GameMap, cx: number, cy: number, lod: Lod): THREE.BufferGeometry {
  const step = 1 << lod;
  const cells = CHUNK_SIZE / step;
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  // Tunnel portals are cut level into the hill (close up), with walls up to the ground around.
  const cuttings: number[] = [];
  if (lod === 0) {
    for (let ty = y0; ty < y0 + CHUNK_SIZE; ty++) {
      for (let tx = x0; tx < x0 + CHUNK_SIZE; tx++) if (cuttingLevel(map, tx, ty) >= 0) cuttings.push(tx, ty);
    }
  }
  // Levelled tiles (close up) are flat at their foundation's top, with cliff walls around them.
  const walls = lod === 0 ? foundationWalls(map, x0, y0) : [];
  const triCount = cells * cells * 2 + cells * 4 * 2 + (cuttings.length / 2) * 3 * 4 + (walls.length / 8) * 2;
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
      let nw = H(tx, ty), ne = H(ex, ty), se = H(ex, ey), sw = H(tx, ey);
      tileColor(map, tx + (step >> 1), ty + (step >> 1), color);
      const cut = lod === 0 ? cuttingLevel(map, tx, ty) : -1;
      const kind = lod === 0 ? map.layers.foundation[map.tileIndex(tx, ty)]! : 0;
      const half = halfCorner(kind);
      // Counter-clockwise when seen from above (+Y), with Z pointing "south".
      if (half >= 0) {
        // The triangle at the raised corner is level with it; the cliff runs along the diagonal.
        const top = Math.max(nw, ne, se, sw);
        if (half === 1 || half === 3) {
          const up = half === 1;
          pushTri(tx, up ? top : nw, ty, ex, up ? top : se, ey, ex, up ? top : ne, ty);
          pushTri(tx, up ? nw : top, ty, tx, up ? sw : top, ey, ex, up ? se : top, ey);
        } else {
          const up = half === 0;
          pushTri(tx, up ? top : nw, ty, tx, up ? top : sw, ey, ex, up ? top : ne, ty);
          pushTri(ex, up ? ne : top, ty, tx, up ? sw : top, ey, ex, up ? se : top, ey);
        }
        continue;
      }
      if (kind) [nw, ne, se, sw] = map.tileCorners(tx, ty).map((h) => h * HEIGHT_SCALE) as [number, number, number, number];
      if (cut >= 0) {
        const h = cut * HEIGHT_SCALE;
        pushTri(tx, h, ty, ex, h, ey, ex, h, ty);
        pushTri(tx, h, ty, tx, h, ey, ex, h, ey);
      } else if (tileSplitsNWSE(nw, ne, se, sw)) {
        pushTri(tx, nw, ty, ex, se, ey, ex, ne, ty);
        pushTri(tx, nw, ty, tx, sw, ey, ex, se, ey);
      } else {
        pushTri(tx, nw, ty, tx, sw, ey, ex, ne, ty);
        pushTri(ex, ne, ty, tx, sw, ey, ex, se, ey);
      }
    }
  }

  // Cutting walls from the level floor up to the real ground on each edge that rises above it
  // (unless a neighbouring portal is cut at the same level). Drawn both ways round.
  for (let k = 0; k < cuttings.length; k += 2) {
    const tx = cuttings[k]!;
    const ty = cuttings[k + 1]!;
    const floor = cuttingLevel(map, tx, ty);
    const corners = map.tileCorners(tx, ty);
    const f = floor * HEIGHT_SCALE;
    color[0] = ROCK[0] * 0.85;
    color[1] = ROCK[1] * 0.85;
    color[2] = ROCK[2] * 0.85;
    for (let e = 0; e < 4; e++) {
      const [ca, cb] = EDGE_CORNERS[e]!;
      if (corners[ca] === floor && corners[cb] === floor) continue;
      const nx = tx + [0, 1, 0, -1][e]!;
      const ny = ty + [-1, 0, 1, 0][e]!;
      if (map.inBounds(nx, ny) && cuttingLevel(map, nx, ny) === floor) continue;
      const [ax, az] = CORNER_XZ[ca]!;
      const [bx, bz] = CORNER_XZ[cb]!;
      const ha = corners[ca]! * HEIGHT_SCALE;
      const hb = corners[cb]! * HEIGHT_SCALE;
      pushTri(tx + ax, f, ty + az, tx + bx, f, ty + bz, tx + bx, hb, ty + bz);
      pushTri(tx + ax, f, ty + az, tx + bx, hb, ty + bz, tx + ax, ha, ty + az);
      pushTri(tx + ax, f, ty + az, tx + bx, hb, ty + bz, tx + bx, f, ty + bz);
      pushTri(tx + ax, f, ty + az, tx + ax, ha, ty + az, tx + bx, hb, ty + bz);
    }
  }

  color[0] = FOUNDATION[0];
  color[1] = FOUNDATION[1];
  color[2] = FOUNDATION[2];
  for (let k = 0; k < walls.length; k += 8) {
    const [ax, az, bx, bz] = [walls[k]!, walls[k + 1]!, walls[k + 2]!, walls[k + 3]!];
    const [ta, la, tb, lb] = [walls[k + 4]!, walls[k + 5]!, walls[k + 6]!, walls[k + 7]!].map((h) => h * HEIGHT_SCALE) as [number, number, number, number];
    pushTri(ax, ta, az, bx, tb, bz, bx, lb, bz);
    pushTri(ax, ta, az, bx, lb, bz, ax, la, az);
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
    const ha = H(ax, az) - SKIRT_INSET;
    const hb = H(bx, bz) - SKIRT_INSET;
    pushTri(ax, ha, az, bx, hb, bz, ax, bottom, az);
    pushTri(bx, hb, bz, bx, bottom, bz, ax, bottom, az);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  return geo;
}

/** Is a flat river tile at `level` next to (x, y), diagonals included? */
function besideRiverAt(map: GameMap, x: number, y: number, level: number): boolean {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx;
      const ny = y + dy;
      if ((dx === 0 && dy === 0) || !map.inBounds(nx, ny)) continue;
      const i = map.tileIndex(nx, ny);
      if (isRiver(map, i) && !isRapids(map, i) && map.cornerHeight(nx, ny) === level) return true;
    }
  }
  return false;
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
  // Rivers, canals, locks and ship depots above sea level, tile by tile at their own level:
  // x, z, width, depth, then the surface level at the NW, NE, SE and SW corners.
  const raised: number[] = [];
  // Sides of rapids facing land, from the sloping surface down to the ground: x1, z1, x2, z2,
  // then the ground level at each end.
  const sides: number[] = [];
  for (let ty = y0; ty < y0 + CHUNK_SIZE; ty++) {
    for (let tx = x0; tx < x0 + CHUNK_SIZE; tx++) {
      const i = map.tileIndex(tx, ty);
      const t = map.layers.type[i];
      const min = map.tileMinHeight(tx, ty);
      if (t !== TileType.Water && t !== TileType.Lock && t !== TileType.ShipDepot) {
        // River banks: water at the river's level over the low part of the bank, so the
        // shoreline follows the ground instead of the tile edge.
        if (min > 0 && besideRiverAt(map, tx, ty, min)) raised.push(tx, ty, 1, 1, min, min, min, min);
        continue;
      }
      if (min === 0 && t !== TileType.Lock && !isRapids(map, i)) continue; // under the sea plane
      if (t === TileType.Lock) {
        // Two halves, each at its own level, meeting at the middle gate.
        const [nw, ne, , sw] = map.tileCorners(tx, ty);
        if (waterAxis(map, i) === 0) {
          raised.push(tx, ty, 0.5, 1, nw, nw, nw, nw, tx + 0.5, ty, 0.5, 1, ne, ne, ne, ne);
        } else {
          raised.push(tx, ty, 1, 0.5, nw, nw, nw, nw, tx, ty + 0.5, 1, 0.5, sw, sw, sw, sw);
        }
      } else if (isRapids(map, i)) {
        const c = map.tileCorners(tx, ty);
        raised.push(tx, ty, 1, 1, ...c); // follows the slope
        const [nw, ne, se, sw] = c;
        const dry = (x: number, y: number) => map.inBounds(x, y) && map.layers.type[map.tileIndex(x, y)] !== TileType.Water;
        if (dry(tx, ty - 1)) sides.push(tx, ty, tx + 1, ty, nw, ne);
        if (dry(tx, ty + 1)) sides.push(tx, ty + 1, tx + 1, ty + 1, sw, se);
        if (dry(tx - 1, ty)) sides.push(tx, ty, tx, ty + 1, nw, sw);
        if (dry(tx + 1, ty)) sides.push(tx + 1, ty, tx + 1, ty + 1, ne, se);
      } else raised.push(tx, ty, 1, 1, min, min, min, min);
    }
  }
  if (quads.length === 0 && raised.length === 0) return null;
  // Each side is drawn both ways round, so it shows from either bank.
  const n = quads.length / 2 + raised.length / 8 + (sides.length / 6) * 2;
  const pos = new Float32Array(n * 18);
  let q = 0;
  for (let k = 0; k < quads.length; k += 2, q++) {
    const x = quads[k]!;
    const z = quads[k + 1]!;
    const e = x + step;
    const s = z + step;
    pos.set([x, WATER_Y, z, x, WATER_Y, s, e, WATER_Y, z, e, WATER_Y, z, x, WATER_Y, s, e, WATER_Y, s], q * 18);
  }
  for (let k = 0; k < raised.length; k += 8, q++) {
    const x = raised[k]!;
    const z = raised[k + 1]!;
    const e = x + raised[k + 2]!;
    const s = z + raised[k + 3]!;
    const [nw, ne, se, sw] = [4, 5, 6, 7].map((o) => raised[k + o]! * HEIGHT_SCALE + WATER_Y) as [number, number, number, number];
    pos.set([x, nw, z, x, sw, s, e, ne, z, e, ne, z, x, sw, s, e, se, s], q * 18);
  }
  for (let k = 0; k < sides.length; k += 6, q += 2) {
    const [x1, z1, x2, z2] = [sides[k]!, sides[k + 1]!, sides[k + 2]!, sides[k + 3]!];
    const g1 = sides[k + 4]! * HEIGHT_SCALE;
    const g2 = sides[k + 5]! * HEIGHT_SCALE;
    const t1 = g1 + WATER_Y;
    const t2 = g2 + WATER_Y;
    pos.set([x1, t1, z1, x1, g1, z1, x2, t2, z2, x2, t2, z2, x1, g1, z1, x2, g2, z2], q * 18);
    pos.set([x1, t1, z1, x2, t2, z2, x1, g1, z1, x2, t2, z2, x2, g2, z2, x1, g1, z1], (q + 1) * 18);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const normals = new Float32Array(n * 18);
  for (let k = 0; k < n * 6; k++) normals[k * 3 + 1] = 1;
  geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  geo.computeBoundingSphere();
  return geo;
}
