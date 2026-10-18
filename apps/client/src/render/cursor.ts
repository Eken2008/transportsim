import { HEIGHT_SCALE, type GameMap } from '@transportsim/shared';
import * as THREE from 'three';

const OK = new THREE.Color('#ffe066');
const BAD = new THREE.Color('#ff5a5f');
const MAX_POINTS = 4 * 130 + 1;
const LIFT = 0.04;

/** Terrain-hugging selection outline plus corner markers, used by build tools. */
export class Cursor {
  readonly root = new THREE.Group();
  private readonly map: GameMap;
  private readonly line: THREE.Line;
  private readonly linePos: Float32Array;
  private readonly markers: THREE.InstancedMesh;
  private readonly lineMat = new THREE.LineBasicMaterial({ color: OK, depthTest: false, transparent: true });
  private readonly markerMat = new THREE.MeshBasicMaterial({ color: OK, depthTest: false, transparent: true, opacity: 0.95 });
  private readonly tmp = new THREE.Object3D();

  constructor(map: GameMap) {
    this.map = map;
    this.linePos = new Float32Array(MAX_POINTS * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(this.linePos, 3).setUsage(THREE.DynamicDrawUsage));
    this.line = new THREE.Line(geo, this.lineMat);
    this.line.frustumCulled = false;
    this.line.renderOrder = 10;
    this.markers = new THREE.InstancedMesh(new THREE.OctahedronGeometry(0.09), this.markerMat, 4);
    this.markers.frustumCulled = false;
    this.markers.renderOrder = 11;
    this.root.add(this.line, this.markers);
    this.hide();
  }

  hide(): void {
    this.root.visible = false;
  }

  setValid(valid: boolean): void {
    const c = valid ? OK : BAD;
    this.lineMat.color.copy(c);
    this.markerMat.color.copy(c);
  }

  /** Highlight a rectangle of corners (inclusive). A single corner shows just a marker. */
  showCornerRect(x0: number, y0: number, x1: number, y1: number): void {
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
    const ay = Math.min(y0, y1), by = Math.max(y0, y1);
    this.root.visible = true;
    const pts: number[] = [];
    const push = (x: number, y: number) => pts.push(x, this.map.cornerHeight(x, y) * HEIGHT_SCALE + LIFT, y);
    if (ax !== bx || ay !== by) {
      for (let x = ax; x <= bx; x++) push(x, ay);
      for (let y = ay + 1; y <= by; y++) push(bx, y);
      for (let x = bx - 1; x >= ax; x--) push(x, by);
      for (let y = by - 1; y >= ay; y--) push(ax, y);
    }
    const n = Math.min(pts.length / 3, MAX_POINTS);
    this.linePos.set(pts.slice(0, n * 3));
    const attr = this.line.geometry.getAttribute('position') as THREE.BufferAttribute;
    attr.needsUpdate = true;
    this.line.geometry.setDrawRange(0, n);

    const corners = ax === bx && ay === by ? [[ax, ay]] : [[ax, ay], [bx, ay], [bx, by], [ax, by]];
    corners.forEach(([x, y], i) => {
      this.tmp.position.set(x!, this.map.cornerHeight(x!, y!) * HEIGHT_SCALE + 0.12, y!);
      this.tmp.updateMatrix();
      this.markers.setMatrixAt(i, this.tmp.matrix);
    });
    this.markers.count = corners.length;
    this.markers.instanceMatrix.needsUpdate = true;
  }
}
