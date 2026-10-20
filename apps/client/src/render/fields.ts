import { CHUNK_SIZE, FIELD_CROP_SHIFT, FIELD_ROWS_Y, Ground, HEIGHT_SCALE, TileType, type GameMap } from '@transportsim/shared';
import * as THREE from 'three';
import { GeoBuilder, lin } from './geoBuilder.ts';
import { CROP_RGB } from './terrainMesh.ts';

const ROWS_PER_TILE = 4;
const RIDGE_HALF = 0.05;
const RIDGE_H = 0.025;
const HEDGE = lin('#3f6a30');
/** Ridges a shade off the field colour: furrows in ploughed soil, rows of plants otherwise. */
const RIDGE = CROP_RGB.map(([r, g, b], k) => new THREE.Color(r, g, b).multiplyScalar(k === 1 ? 0.78 : 0.82));

const isField = (map: GameMap, x: number, y: number) =>
  map.inBounds(x, y) && map.layers.type[map.tileIndex(x, y)] === TileType.Clear && ((map.layers.data[map.tileIndex(x, y)]! >> 3) & 7) === Ground.Field;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _d = new THREE.Vector3();

/** Ground height (world units) at a point, plus a lift. */
const at = (map: GameMap, x: number, z: number, lift: number, out: THREE.Vector3) => out.set(x, map.heightAt(x, z) * HEIGHT_SCALE + lift, z);

/**
 * One ridge across a tile as a low tent following the ground. A line across a tile bends where
 * it crosses the triangle diagonal, so the ridge is split there.
 */
function ridge(g: GeoBuilder, map: GameMap, tx: number, ty: number, alongY: boolean, off: number): void {
  // Split where the ridge may cross the tile's diagonal: at `off` for one split, `1 - off` for the other.
  const stops = [0, off, 1 - off, 1].filter((t, i, a) => a.indexOf(t) === i).sort((p, q) => p - q);
  const point = (t: number, side: number, lift: number, out: THREE.Vector3) =>
    alongY ? at(map, tx + off + side, ty + t, lift, out) : at(map, tx + t, ty + off + side, lift, out);
  for (let k = 0; k < stops.length - 1; k++) {
    const t0 = stops[k]!;
    const t1 = stops[k + 1]!;
    // Top line, then a sloped side down to each foot.
    point(t0, 0, 0.012 + RIDGE_H, _a);
    point(t1, 0, 0.012 + RIDGE_H, _b);
    for (const side of [-RIDGE_HALF, RIDGE_HALF]) {
      point(t1, side, 0.012, _c);
      point(t0, side, 0.012, _d);
      upQuad(g, _a, _b, _c, _d);
    }
  }
}

const _n = new THREE.Vector3();
const _e = new THREE.Vector3();

/** Quad a-b-c-d wound so it faces up. */
function upQuad(g: GeoBuilder, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): void {
  _n.subVectors(b, a).cross(_e.subVectors(c, a));
  if (_n.y >= 0) g.quad(a, b, c, d);
  else g.quad(d, c, b, a);
}

/** Crop rows on every field tile (close up only) and hedgerows where fields meet other land. */
export function addFields(g: GeoBuilder, map: GameMap, cx: number, cy: number, rows: boolean): void {
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  for (let y = y0; y < y0 + CHUNK_SIZE; y++) {
    for (let x = x0; x < x0 + CHUNK_SIZE; x++) {
      if (!isField(map, x, y)) continue;
      const data = map.layers.data[map.tileIndex(x, y)]!;
      const alongY = (data & FIELD_ROWS_Y) !== 0;
      if (rows) {
        g.color(RIDGE[(data >> FIELD_CROP_SHIFT) & 3]!);
        for (let r = 0; r < ROWS_PER_TILE; r++) ridge(g, map, x, y, alongY, (r + 0.5) / ROWS_PER_TILE);
      }
      g.color(HEDGE);
      const H = (px: number, py: number) => map.cornerHeight(px, py) * HEIGHT_SCALE;
      // Tile edges are straight on the ground, so a hedge is one box per edge, set just inside.
      const i = 0.05;
      if (!isField(map, x, y - 1)) g.box(_a.set(x, H(x, y), y + i), _b.set(x + 1, H(x + 1, y), y + i), 0.07, 0.09);
      if (!isField(map, x, y + 1)) g.box(_a.set(x, H(x, y + 1), y + 1 - i), _b.set(x + 1, H(x + 1, y + 1), y + 1 - i), 0.07, 0.09);
      if (!isField(map, x - 1, y)) g.box(_a.set(x + i, H(x, y), y), _b.set(x + i, H(x, y + 1), y + 1), 0.07, 0.09);
      if (!isField(map, x + 1, y)) g.box(_a.set(x + 1 - i, H(x + 1, y), y), _b.set(x + 1 - i, H(x + 1, y + 1), y + 1), 0.07, 0.09);
    }
  }
}
