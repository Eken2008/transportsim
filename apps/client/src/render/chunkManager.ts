import { CHUNK_SIZE, HEIGHT_SCALE, MAX_HEIGHT } from '@transportsim/shared';
import * as THREE from 'three';
import type { ClientWorld } from '../game/clientWorld.ts';
import { buildTerrainGeometry, buildWaterGeometry, type Lod } from './terrainMesh.ts';
import { buildTrackGeometry } from './trackMesh.ts';
import { buildTrees } from './trees.ts';

interface ChunkView {
  cx: number;
  cy: number;
  lod: Lod;
  group: THREE.Group;
  /** Data version this view was built from (bumped locally when new data arrives). */
  builtRev: number;
  lastWanted: number;
}

const BUILD_BUDGET_MS = 6;
const UNLOAD_AFTER_MS = 4000;
const MAX_SUBSCRIBED = 700;

/**
 * Decides which chunks are visible, keeps the server subscription in sync, and builds
 * terrain/water/tree meshes (with LOD by distance) within a per-frame time budget.
 */
export class ChunkManager {
  readonly root = new THREE.Group();
  private views = new Map<number, ChunkView>();
  /** Increments when fresh data arrives for a chunk. */
  private dataRev: Uint32Array;
  private wanted = new Map<number, Lod>();
  private lastSubKey = '';
  private lastSubAt = 0;
  private frustum = new THREE.Frustum();
  private projScreen = new THREE.Matrix4();
  private box = new THREE.Box3();

  readonly terrainMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  readonly waterMaterial = new THREE.MeshStandardMaterial({
    color: '#2c6f9c',
    roughness: 0.25,
    metalness: 0.05,
    transparent: true,
    opacity: 0.82,
    depthWrite: false,
  });

  private readonly world: ClientWorld;
  private readonly subscribe: (chunks: number[]) => void;
  private unlisten: () => void;

  constructor(world: ClientWorld, subscribe: (chunks: number[]) => void) {
    this.world = world;
    this.subscribe = subscribe;
    this.dataRev = new Uint32Array(world.map.chunksX * world.map.chunksY);
    this.unlisten = world.onChunk((cx, cy) => this.dataRev[cy * world.map.chunksX + cx]!++);
  }

  /** Force the subscription to be re-sent (after a reconnect). */
  resubscribe(): void {
    this.lastSubKey = '';
  }

  update(camera: THREE.PerspectiveCamera, target: THREE.Vector3, distance: number): void {
    const map = this.world.map;
    const now = performance.now();
    this.projScreen.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    this.frustum.setFromProjectionMatrix(this.projScreen);

    // Visible radius grows with zoom; LOD thresholds measured from the camera target.
    const radius = Math.min(distance * 2.6 + CHUNK_SIZE * 1.5, 1600);
    const tcx = target.x / CHUNK_SIZE;
    const tcy = target.z / CHUNK_SIZE;
    const rc = Math.ceil(radius / CHUNK_SIZE);
    const margin = CHUNK_SIZE * 0.5;
    this.wanted.clear();
    const order: { id: number; d: number }[] = [];
    for (let cy = Math.max(0, Math.floor(tcy - rc)); cy <= Math.min(map.chunksY - 1, Math.ceil(tcy + rc)); cy++) {
      for (let cx = Math.max(0, Math.floor(tcx - rc)); cx <= Math.min(map.chunksX - 1, Math.ceil(tcx + rc)); cx++) {
        const ccx = (cx + 0.5) * CHUNK_SIZE;
        const ccz = (cy + 0.5) * CHUNK_SIZE;
        const d = Math.hypot(ccx - target.x, ccz - target.z);
        if (d > radius) continue;
        this.box.min.set(cx * CHUNK_SIZE - margin, -2, cy * CHUNK_SIZE - margin);
        this.box.max.set((cx + 1) * CHUNK_SIZE + margin, MAX_HEIGHT * HEIGHT_SCALE, (cy + 1) * CHUNK_SIZE + margin);
        if (!this.frustum.intersectsBox(this.box)) continue;
        const dd = Math.max(0, d - CHUNK_SIZE * 0.7) / Math.max(distance, 30);
        const lod: Lod = dd < 1.6 ? 0 : dd < 3 ? 1 : dd < 5 ? 2 : 3;
        const id = cy * map.chunksX + cx;
        this.wanted.set(id, lod);
        order.push({ id, d });
      }
    }
    order.sort((a, b) => a.d - b.d);

    // Sync the server subscription (throttled; nearest chunks first, capped).
    const subIds = order.slice(0, MAX_SUBSCRIBED).map((o) => o.id);
    const key = subIds.slice().sort((a, b) => a - b).join(',');
    if (key !== this.lastSubKey && now - this.lastSubAt > 250) {
      this.lastSubKey = key;
      this.lastSubAt = now;
      this.subscribe(subIds);
    }

    // Build or rebuild meshes nearest-first within the frame budget.
    const start = performance.now();
    for (const { id } of order) {
      if (performance.now() - start > BUILD_BUDGET_MS) break;
      const cx = id % map.chunksX;
      const cy = (id - cx) / map.chunksX;
      if (!this.world.isLoaded(cx, cy)) continue;
      const lod = this.wanted.get(id)!;
      const view = this.views.get(id);
      if (view) view.lastWanted = now;
      if (view && view.lod === lod && view.builtRev === this.dataRev[id]) continue;
      this.build(id, cx, cy, lod, now);
    }

    // Unload views that have not been wanted for a while.
    for (const [id, view] of this.views) {
      if (this.wanted.has(id)) view.lastWanted = now;
      else if (now - view.lastWanted > UNLOAD_AFTER_MS) this.disposeView(id, view);
    }
  }

  private build(id: number, cx: number, cy: number, lod: Lod, now: number): void {
    const old = this.views.get(id);
    if (old) this.disposeView(id, old);
    const map = this.world.map;
    const group = new THREE.Group();
    group.name = `chunk-${cx}-${cy}`;
    const terrain = new THREE.Mesh(buildTerrainGeometry(map, cx, cy, lod), this.terrainMaterial);
    terrain.matrixAutoUpdate = false;
    group.add(terrain);
    const waterGeo = buildWaterGeometry(map, cx, cy, lod);
    if (waterGeo) {
      const water = new THREE.Mesh(waterGeo, this.waterMaterial);
      water.renderOrder = 1;
      water.matrixAutoUpdate = false;
      group.add(water);
    }
    const trackGeo = buildTrackGeometry(map, cx, cy, lod);
    if (trackGeo) {
      const track = new THREE.Mesh(trackGeo, this.terrainMaterial);
      track.matrixAutoUpdate = false;
      group.add(track);
    }
    if (lod <= 2) for (const t of buildTrees(map, cx, cy, lod >= 1)) group.add(t);
    this.root.add(group);
    this.views.set(id, { cx, cy, lod, group, builtRev: this.dataRev[id]!, lastWanted: now });
  }

  private disposeView(id: number, view: ChunkView): void {
    this.root.remove(view.group);
    view.group.traverse((o) => {
      if (o instanceof THREE.InstancedMesh) o.dispose();
      else if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    this.views.delete(id);
  }

  get stats(): { views: number; wanted: number } {
    return { views: this.views.size, wanted: this.wanted.size };
  }

  dispose(): void {
    this.unlisten();
    for (const [id, v] of this.views) this.disposeView(id, v);
    this.terrainMaterial.dispose();
    this.waterMaterial.dispose();
  }
}
