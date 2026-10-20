import { CHUNK_SIZE, COMPANY_COLORS, HEIGHT_SCALE, MAX_HEIGHT } from '@transportsim/shared';
import * as THREE from 'three';
import type { ClientWorld } from '../game/clientWorld.ts';
import { buildTerrainGeometry, buildWaterGeometry, type Lod } from './terrainMesh.ts';
import { addRoads, buildHeadquarters, buildHouses } from './buildings.ts';
import { addFields } from './fields.ts';
import { GeoBuilder } from './geoBuilder.ts';
import { addTrack } from './trackMesh.ts';
import { TrackCurves } from './trackCurves.ts';
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
/** How far around an extra point (tiles) chunks are shown. */
const EXTRA_RADIUS = 20;

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
  /** Smooth track centre lines shared with the train renderer. */
  readonly curves: TrackCurves;

  constructor(world: ClientWorld, subscribe: (chunks: number[]) => void) {
    this.world = world;
    this.subscribe = subscribe;
    this.dataRev = new Uint32Array(world.map.chunksX * world.map.chunksY);
    this.curves = new TrackCurves(world.map);
    this.unlisten = world.onChunk((cx, cy) => {
      // Track curves depend on neighbouring tiles, so neighbouring chunks rebuild too.
      this.curves.clear();
      const m = world.map;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && y >= 0 && x < m.chunksX && y < m.chunksY) this.dataRev[y * m.chunksX + x]!++;
        }
      }
    });
  }

  /** Force the subscription to be re-sent (after a reconnect). */
  resubscribe(): void {
    this.lastSubKey = '';
  }

  /** `extra` are points (x, z) whose surroundings are also shown in full detail, e.g. for vehicle views. */
  update(camera: THREE.PerspectiveCamera, target: THREE.Vector3, distance: number, extra: readonly { x: number; z: number }[] = []): void {
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
    for (const p of extra) {
      const r = EXTRA_RADIUS;
      for (let cy = Math.max(0, Math.floor((p.z - r) / CHUNK_SIZE)); cy <= Math.min(map.chunksY - 1, Math.floor((p.z + r) / CHUNK_SIZE)); cy++) {
        for (let cx = Math.max(0, Math.floor((p.x - r) / CHUNK_SIZE)); cx <= Math.min(map.chunksX - 1, Math.floor((p.x + r) / CHUNK_SIZE)); cx++) {
          const id = cy * map.chunksX + cx;
          if (!this.wanted.has(id)) order.push({ id, d: 0 });
          this.wanted.set(id, 0);
        }
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
    const infra = new GeoBuilder();
    if (lod <= 1) addFields(infra, map, cx, cy, lod === 0);
    addRoads(infra, map, cx, cy);
    addTrack(infra, map, cx, cy, lod, (owner) => this.companyColor(owner), this.curves);
    const infraGeo = infra.build();
    if (infraGeo) {
      const mesh = new THREE.Mesh(infraGeo, this.terrainMaterial);
      mesh.matrixAutoUpdate = false;
      group.add(mesh);
    }
    for (const h of buildHouses(map, cx, cy)) group.add(h);
    const hq = buildHeadquarters(map, cx, cy, (owner) => this.companyColor(owner));
    if (hq) group.add(hq);
    if (lod <= 2) for (const t of buildTrees(map, cx, cy, lod >= 1)) group.add(t);
    this.root.add(group);
    this.views.set(id, { cx, cy, lod, group, builtRev: this.dataRev[id]!, lastWanted: now });
  }

  private colorCache = new Map<string, THREE.Color>();

  private companyColor(owner: number): THREE.Color {
    const c = this.world.state.companies.get(owner);
    const hex = c ? COMPANY_COLORS[c.color % COMPANY_COLORS.length]! : '#888888';
    let col = this.colorCache.get(hex);
    if (!col) this.colorCache.set(hex, (col = new THREE.Color(hex)));
    return col;
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
