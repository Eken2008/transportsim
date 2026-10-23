import { CROSSING_FLAG, HEIGHT_SCALE, TileType, hasPiece, type GameMap } from '@transportsim/shared';
import * as THREE from 'three';
import type { ClientWorld } from '../game/clientWorld.ts';
import { GeoBuilder, lin } from './geoBuilder.ts';

/**
 * Crossing layout in tile-local coordinates for track along X (road along Y). For track along
 * Y everything is rotated 90° about the tile centre. Barrier arms pivot at the road edge on
 * each side of the track and swing down across the road.
 */
const ARM_LENGTH = 0.58;
/** Arm pivot height: a barrier is about waist-high to a bus. */
const POST_H = 0.13;
const PIVOTS: readonly { x: number; z: number; yaw: number }[] = [
  { x: 0.82, z: 0.17, yaw: Math.PI }, // north side, arm reaching west
  { x: 0.18, z: 0.83, yaw: 0 }, // south side, arm reaching east
];
const SIGNS: readonly { x: number; z: number }[] = [
  { x: 0.16, z: 0.13 },
  { x: 0.84, z: 0.87 },
];

const POST = lin('#2e3237');
const WHITE = lin('#f4f4f4');
const RED = lin('#c8302a');

/** Static posts and crossbuck signs, merged into the chunk's track geometry. */
export function addCrossingFurniture(g: GeoBuilder, map: GameMap, x: number, y: number, trackAlongX: boolean): void {
  const h = map.tileMaxHeight(x, y) * HEIGHT_SCALE + 0.01;
  const place = (lx: number, lz: number) => (trackAlongX ? { px: x + lx, pz: y + lz } : { px: x + 1 - lz, pz: y + lx });
  for (const p of PIVOTS) {
    const { px, pz } = place(p.x, p.z);
    g.color(POST).aabb(px - 0.025, h, pz - 0.025, px + 0.025, h + POST_H, pz + 0.025);
    g.color(POST).aabb(px - 0.035, h + POST_H - 0.02, pz - 0.035, px + 0.035, h + POST_H + 0.04, pz + 0.035);
  }
  for (const sgn of SIGNS) {
    const { px, pz } = place(sgn.x, sgn.z);
    g.color(POST).aabb(px - 0.015, h, pz - 0.015, px + 0.015, h + 0.27, pz + 0.015);
    // Crossbuck: two crossed white boards
    const top = h + 0.25;
    const a = new THREE.Vector3(px - 0.08, top - 0.06, pz);
    const b = new THREE.Vector3(px + 0.08, top + 0.06, pz);
    const c = new THREE.Vector3(px - 0.08, top + 0.06, pz);
    const d = new THREE.Vector3(px + 0.08, top - 0.06, pz);
    g.color(WHITE).box(a, b, 0.008, 0.03);
    g.color(WHITE).box(c, d, 0.008, 0.03);
  }
}

function armGeometry(): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const n = 6;
  for (let i = 0; i < n; i++) {
    g.color(i % 2 === 0 ? RED : WHITE).aabb((i / n) * ARM_LENGTH, -0.012, -0.012, ((i + 1) / n) * ARM_LENGTH, 0.012, 0.012);
  }
  return g.build()!;
}

interface Barrier {
  tile: number;
  pivot: THREE.Vector3;
  yaw: number;
}

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler(0, 0, 0, 'YZX');
const _s = new THREE.Vector3(1, 1, 1);
const CLOSED_COLOR = new THREE.Color('#ff2a1a').multiplyScalar(2.5);
const OFF_COLOR = new THREE.Color('#3a1512');

/** Animated barrier arms and flashing lamps for level crossings near the camera. */
export class CrossingBooms {
  readonly root = new THREE.Group();
  private arms: THREE.InstancedMesh;
  private lamps: THREE.InstancedMesh;
  /** Arm angle per crossing tile (0 = raised, 1 = lowered). */
  private angle = new Map<number, number>();

  constructor(private readonly world: ClientWorld) {
    this.arms = new THREE.InstancedMesh(armGeometry(), new THREE.MeshLambertMaterial({ vertexColors: true }), 512);
    this.lamps = new THREE.InstancedMesh(new THREE.SphereGeometry(0.022, 6, 4), new THREE.MeshBasicMaterial({ toneMapped: false }), 512);
    this.lamps.setColorAt(0, OFF_COLOR);
    for (const m of [this.arms, this.lamps]) {
      m.count = 0;
      m.frustumCulled = false;
      this.root.add(m);
    }
  }

  /** Returns whether anything moves or flashes. */
  update(dt: number, now: number, focus: THREE.Vector3): boolean {
    const map = this.world.map;
    // Crossings the server has closed to road traffic (a train is on them or about to arrive).
    const busy = this.world.closedCrossings;
    const barriers: Barrier[] = [];
    let moving = false;
    for (const tile of this.world.crossings) {
      const x = tile % map.width;
      const y = (tile - x) / map.width;
      if (Math.abs(x - focus.x) > 90 || Math.abs(y - focus.z) > 90) continue;
      if (map.layers.type[tile] !== TileType.Rail || !(map.layers.data[tile]! & CROSSING_FLAG)) continue;
      const alongX = hasPiece(map.layers.track[tile]!, 0);
      const h = map.tileMaxHeight(x, y) * HEIGHT_SCALE + 0.01 + POST_H - 0.04;
      for (const p of PIVOTS) {
        const px = alongX ? x + p.x : x + 1 - p.z;
        const pz = alongX ? y + p.z : y + p.x;
        barriers.push({ tile, pivot: new THREE.Vector3(px, h, pz), yaw: p.yaw - (alongX ? 0 : Math.PI / 2) });
      }
      const target = busy.has(tile) ? 1 : 0;
      const cur = this.angle.get(tile) ?? 0;
      this.angle.set(tile, cur + Math.max(-dt * 1.2, Math.min(dt * 1.2, target - cur)));
      // Lamps flash while an arm is down.
      if (cur !== target || cur > 0.02) moving = true;
    }
    if (barriers.length > this.arms.instanceMatrix.count) {
      this.grow(barriers.length * 2);
    }
    const flash = Math.floor(now / 450) % 2 === 0;
    barriers.forEach((b, i) => {
      const a = this.angle.get(b.tile) ?? 0;
      // Raised arms stand almost vertical; lowered ones lie across the road.
      _e.set(0, b.yaw, (1 - a) * (Math.PI / 2 - 0.08));
      _q.setFromEuler(_e);
      _m.compose(b.pivot, _q, _s);
      this.arms.setMatrixAt(i, _m);
      _m.makeTranslation(b.pivot.x, b.pivot.y + 0.07, b.pivot.z);
      this.lamps.setMatrixAt(i, _m);
      const lit = a > 0.02 && (i % 2 === 0 ? flash : !flash);
      this.lamps.setColorAt(i, lit ? CLOSED_COLOR : OFF_COLOR);
    });
    this.arms.count = barriers.length;
    this.lamps.count = barriers.length;
    this.arms.instanceMatrix.needsUpdate = true;
    this.lamps.instanceMatrix.needsUpdate = true;
    if (this.lamps.instanceColor) this.lamps.instanceColor.needsUpdate = true;
    return moving;
  }

  private grow(cap: number): void {
    for (const key of ['arms', 'lamps'] as const) {
      const old = this[key];
      const next = new THREE.InstancedMesh(old.geometry, old.material, cap);
      next.frustumCulled = false;
      next.count = 0;
      if (key === 'lamps') next.setColorAt(0, OFF_COLOR);
      this.root.remove(old);
      old.dispose();
      this.root.add(next);
      this[key] = next;
    }
  }

  dispose(): void {
    for (const m of [this.arms, this.lamps]) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      m.dispose();
    }
  }
}
