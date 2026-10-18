import { HEIGHT_SCALE, MAX_HEIGHT, type GameMap } from '@transportsim/shared';
import * as THREE from 'three';

export interface TerrainHit {
  point: THREE.Vector3;
  /** Tile under the point */
  tileX: number;
  tileY: number;
  /** Nearest corner */
  cornerX: number;
  cornerY: number;
}

const STEP = 0.3;
const MAX_T = 4000;

/**
 * Ray-march the heightfield analytically (much faster than raycasting meshes and
 * independent of which chunks are currently built). Refines with bisection.
 */
export function pickTerrain(map: GameMap, ray: THREE.Ray): TerrainHit | null {
  const top = MAX_HEIGHT * HEIGHT_SCALE + 0.01;
  const o = ray.origin;
  const d = ray.direction;
  let t = 0;
  if (o.y > top) {
    if (d.y >= 0) return null;
    t = (o.y - top) / -d.y;
  }
  const below = (tt: number) => {
    const x = o.x + d.x * tt;
    const z = o.z + d.z * tt;
    if (x < 0 || z < 0 || x > map.width || z > map.height) return false;
    return o.y + d.y * tt <= map.heightAt(x, z) * HEIGHT_SCALE;
  };
  let prev = t;
  for (; t < MAX_T; t += STEP) {
    if (o.y + d.y * t < -1) return null;
    if (below(t)) {
      let lo = prev;
      let hi = t;
      for (let i = 0; i < 12; i++) {
        const mid = (lo + hi) / 2;
        if (below(mid)) hi = mid;
        else lo = mid;
      }
      const point = ray.at(hi, new THREE.Vector3());
      return {
        point,
        tileX: clamp(Math.floor(point.x), 0, map.width - 1),
        tileY: clamp(Math.floor(point.z), 0, map.height - 1),
        cornerX: clamp(Math.round(point.x), 0, map.width),
        cornerY: clamp(Math.round(point.z), 0, map.height),
      };
    }
    prev = t;
  }
  return null;
}

/** Intersect a ray with a horizontal plane y = h. */
export function rayPlane(ray: THREE.Ray, h: number, out = new THREE.Vector3()): THREE.Vector3 | null {
  if (Math.abs(ray.direction.y) < 1e-6) return null;
  const t = (h - ray.origin.y) / ray.direction.y;
  if (t < 0) return null;
  return ray.at(t, out);
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
