import { EDGE_MID_X, EDGE_MID_Y, HEIGHT_SCALE, foundationCorners, type GameMap } from '@transportsim/shared';
import * as THREE from 'three';
import { GeoBuilder } from './geoBuilder.ts';

const WHITE = new THREE.Color('#ffffff');
const LIFT = 0.06;

/** Translucent tile highlights following the terrain, with an optional exit arrow. */
export class AreaGhost {
  readonly mesh: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;

  constructor(
    private readonly map: GameMap,
    opacity = 0.45,
  ) {
    this.material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity, depthWrite: false });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.renderOrder = 5;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** `foundations` (tile → Foundation) are those a build would lay, so the highlight sits on the built surface. */
  show(tiles: { x: number; y: number }[], color: string, arrow?: { x: number; y: number; edge: number }, foundations?: ReadonlyMap<number, number>): void {
    const map = this.map;
    const g = new GeoBuilder().color(WHITE);
    for (const { x, y } of tiles) {
      if (!map.inBounds(x, y)) continue;
      const kind = foundations?.get(map.tileIndex(x, y));
      const [nw, ne, se, sw] = kind === undefined ? map.tileCorners(x, y) : foundationCorners(map.rawCorners(x, y), kind);
      const v = (cx: number, cy: number, h: number) => new THREE.Vector3(cx, h * HEIGHT_SCALE + LIFT, cy);
      g.quad(v(x, y, nw), v(x, y + 1, sw), v(x + 1, y + 1, se), v(x + 1, y, ne));
    }
    if (arrow && map.inBounds(arrow.x, arrow.y)) {
      const h = map.tileMaxHeight(arrow.x, arrow.y) * HEIGHT_SCALE + LIFT + 0.02;
      const cx = arrow.x + 0.5;
      const cz = arrow.y + 0.5;
      const ex = arrow.x + EDGE_MID_X[arrow.edge as 0]!;
      const ez = arrow.y + EDGE_MID_Y[arrow.edge as 0]!;
      const dx = ex - cx;
      const dz = ez - cz;
      const tip = new THREE.Vector3(cx + dx * 1.5, h, cz + dz * 1.5);
      const l = new THREE.Vector3(cx + dx * 0.6 - dz * 0.35, h, cz + dz * 0.6 + dx * 0.35);
      const r = new THREE.Vector3(cx + dx * 0.6 + dz * 0.35, h, cz + dz * 0.6 - dx * 0.35);
      g.tri(l, tip, r);
      g.tri(r, tip, l);
    }
    const geo = g.build();
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo ?? new THREE.BufferGeometry();
    this.material.color.set(color);
    this.mesh.visible = geo !== null;
  }

  hide(): void {
    this.mesh.visible = false;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
