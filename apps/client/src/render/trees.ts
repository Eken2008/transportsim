import { CHUNK_SIZE, HEIGHT_SCALE, SNOW_LINE, type GameMap } from '@transportsim/shared';
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { tileHash } from './terrainMesh.ts';

function colored(geo: THREE.BufferGeometry, hex: string): THREE.BufferGeometry {
  const g = geo.toNonIndexed();
  const c = new THREE.Color(hex);
  const n = g.getAttribute('position').count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) col.set([c.r, c.g, c.b], i * 3);
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.deleteAttribute('uv');
  return g;
}

function makeConifer(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.035, 0.05, 0.18, 5).translate(0, 0.09, 0);
  const low = new THREE.ConeGeometry(0.2, 0.38, 6).translate(0, 0.33, 0);
  const high = new THREE.ConeGeometry(0.14, 0.3, 6).translate(0, 0.55, 0);
  const g = mergeGeometries([colored(trunk, '#6b4a2b'), colored(low, '#ffffff'), colored(high, '#ffffff')])!;
  g.computeVertexNormals();
  return g;
}

function makeDeciduous(): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(0.035, 0.05, 0.22, 5).translate(0, 0.11, 0);
  const crown = new THREE.IcosahedronGeometry(0.2, 0).translate(0, 0.38, 0);
  const g = mergeGeometries([colored(trunk, '#6b4a2b'), colored(crown, '#ffffff')])!;
  g.computeVertexNormals();
  return g;
}

/** Shared geometry/material for all chunks. Foliage is white × instance color. */
export const treeAssets = {
  conifer: makeConifer(),
  deciduous: makeDeciduous(),
  material: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
};

const CONIFER_COLORS = ['#2f5d34', '#36673a', '#2a5530', '#3d6e3c'].map((c) => new THREE.Color(c));
const DECIDUOUS_COLORS = ['#4f8a3a', '#5e963f', '#467d35', '#6e9c44', '#7a9a3a'].map((c) => new THREE.Color(c));
// Trunk vertices are colored brown in the geometry; instance color tints everything, so
// keep foliage colors bright enough that trunks stay readable.

const tmp = new THREE.Object3D();

/** Build instanced trees for a chunk. `sparse` keeps one tree per tile (for distant LODs). */
export function buildTrees(map: GameMap, cx: number, cy: number, sparse: boolean): THREE.InstancedMesh[] {
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  const conifers: number[] = [];
  const deciduous: number[] = [];
  for (let y = y0; y < y0 + CHUNK_SIZE; y++) {
    for (let x = x0; x < x0 + CHUNK_SIZE; x++) {
      let n = map.treeCount(x, y);
      if (n === 0) continue;
      if (sparse) n = 1;
      const high = map.tileMaxHeight(x, y) > SNOW_LINE * 0.45;
      for (let k = 0; k < n; k++) {
        const ox = 0.18 + tileHash(x, y, k * 2 + 1) * 0.64;
        const oz = 0.18 + tileHash(x, y, k * 2 + 2) * 0.64;
        const coniferChance = high ? 0.85 : 0.3;
        (tileHash(x, y, 50 + k) < coniferChance ? conifers : deciduous).push(x + ox, y + oz, k);
      }
    }
  }
  const out: THREE.InstancedMesh[] = [];
  const build = (list: number[], geo: THREE.BufferGeometry, palette: THREE.Color[]) => {
    const count = list.length / 3;
    if (count === 0) return;
    const mesh = new THREE.InstancedMesh(geo, treeAssets.material, count);
    for (let i = 0; i < count; i++) {
      const wx = list[i * 3]!;
      const wz = list[i * 3 + 1]!;
      const k = list[i * 3 + 2]!;
      const h = tileHash(Math.floor(wx * 7), Math.floor(wz * 7), k);
      const s = (sparse ? 1.9 : 1.1) + h * 0.5;
      tmp.position.set(wx, map.heightAt(wx, wz) * HEIGHT_SCALE, wz);
      tmp.rotation.set(0, h * Math.PI * 2, 0);
      tmp.scale.set(s, s * (0.9 + h * 0.3), s);
      tmp.updateMatrix();
      mesh.setMatrixAt(i, tmp.matrix);
      mesh.setColorAt(i, palette[Math.floor(h * palette.length)]!);
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
    out.push(mesh);
  };
  build(conifers, treeAssets.conifer, CONIFER_COLORS);
  build(deciduous, treeAssets.deciduous, DECIDUOUS_COLORS);
  return out;
}
