import type { PlacedPiece } from '@transportsim/shared';
import type { GameMap } from '@transportsim/shared';
import * as THREE from 'three';
import { GeoBuilder } from './geoBuilder.ts';
import { pieceEndpoints } from './trackMesh.ts';

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const WHITE = new THREE.Color('#ffffff');

/** Translucent preview of track pieces about to be built or removed. */
export class TrackGhost {
  readonly mesh: THREE.Mesh;
  private readonly material = new THREE.MeshBasicMaterial({
    vertexColors: true,
    transparent: true,
    opacity: 0.55,
    depthWrite: false,
  });

  constructor(private readonly map: GameMap) {
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.renderOrder = 5;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  show(pieces: PlacedPiece[], color: string): void {
    const g = new GeoBuilder().color(WHITE);
    for (const p of pieces) {
      if (!this.map.inBounds(p.x, p.y)) continue;
      pieceEndpoints(this.map, p.x, p.y, p.piece, _a, _b);
      g.box(_a.setY(_a.y + 0.02), _b.setY(_b.y + 0.02), 0.34, 0.07, false);
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
