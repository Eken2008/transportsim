import {
  EDGE_MID_X,
  EDGE_MID_Y,
  HEIGHT_SCALE,
  tdEntry,
  tdExit,
  type GameMap,
} from '@transportsim/shared';
import * as THREE from 'three';

export const SIGNAL_POST_HEIGHT = 0.5;

/**
 * Where the signal for a trackdir stands: just before the exit edge, on the right-hand
 * side of the direction of travel. Returns the post foot and the travel direction.
 */
export function signalPlacement(map: GameMap, x: number, y: number, td: number, foot: THREE.Vector3, dir: THREE.Vector3): void {
  const a = tdEntry(td);
  const b = tdExit(td);
  dir.set(EDGE_MID_X[b] - EDGE_MID_X[a], 0, EDGE_MID_Y[b] - EDGE_MID_Y[a]).normalize();
  const h = Math.max(0, map.edgeLevel(x, y, b)) * HEIGHT_SCALE;
  // Right of heading (dx, dz) in map space (z points south) is (-dz, dx).
  foot.set(x + EDGE_MID_X[b] - dir.x * 0.12 - dir.z * 0.3, h, y + EDGE_MID_Y[b] - dir.z * 0.12 + dir.x * 0.3);
}
