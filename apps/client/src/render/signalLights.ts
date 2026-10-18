import * as THREE from 'three';
import type { ClientWorld } from '../game/clientWorld.ts';
import { SIGNAL_POST_HEIGHT, signalPlacement } from './signalGeometry.ts';

const RED = new THREE.Color('#ff3b30').multiplyScalar(2.2);
const GREEN = new THREE.Color('#30d158').multiplyScalar(2.2);
const _foot = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _m = new THREE.Matrix4();

/** Glowing aspect lamps on signal heads, rebuilt when aspects or track change. */
export class SignalLights {
  readonly mesh: THREE.InstancedMesh;
  private rev = '';
  private chunkRev = 0;

  constructor(private readonly world: ClientWorld) {
    const geo = new THREE.SphereGeometry(0.03, 8, 6);
    const mat = new THREE.MeshBasicMaterial({ toneMapped: false });
    this.mesh = new THREE.InstancedMesh(geo, mat, 256);
    this.mesh.setColorAt(0, RED);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    world.onChunk(() => this.chunkRev++);
  }

  update(): void {
    const key = `${this.world.signalsRev}:${this.chunkRev}`;
    if (key === this.rev) return;
    this.rev = key;
    const map = this.world.map;
    let n = 0;
    for (const [tile, red] of this.world.signalRed) {
      const bits = map.layers.signals[tile]!;
      const x = tile % map.width;
      const y = (tile - x) / map.width;
      for (let td = 0; td < 12; td++) {
        if (!((bits >> td) & 1)) continue;
        if (n >= this.mesh.instanceMatrix.count) this.grow();
        signalPlacement(map, x, y, td, _foot, _dir);
        // Lamp on the face of the head that looks back at approaching trains.
        _m.makeTranslation(_foot.x - _dir.x * 0.05, _foot.y + SIGNAL_POST_HEIGHT + 0.05, _foot.z - _dir.z * 0.05);
        this.mesh.setMatrixAt(n, _m);
        this.mesh.setColorAt(n, (red >> td) & 1 ? RED : GREEN);
        n++;
      }
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  private grow(): void {
    const old = this.mesh;
    const cap = old.instanceMatrix.count * 2;
    const arr = new Float32Array(cap * 16);
    arr.set(old.instanceMatrix.array as Float32Array);
    old.instanceMatrix = new THREE.InstancedBufferAttribute(arr, 16);
    const col = new Float32Array(cap * 3);
    if (old.instanceColor) col.set(old.instanceColor.array as Float32Array);
    old.instanceColor = new THREE.InstancedBufferAttribute(col, 3);
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
