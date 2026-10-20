import { EDGE_MID_X, EDGE_MID_Y, HEIGHT_SCALE, PIECE_EDGES, foundationEdge, type PlacedPiece } from '@transportsim/shared';
import type { GameMap } from '@transportsim/shared';
import * as THREE from 'three';
import { GeoBuilder } from './geoBuilder.ts';
import { pieceEndpoints } from './trackMesh.ts';
import { TRACK_LIFT } from './trackCurves.ts';

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

  /**
   * `foundations` (tile → Foundation) are those the build would lay, so the preview sits on the
   * surface the track will have. Elsewhere, an edge that isn't level is shown at its higher corner.
   * `thin` pieces are drawn as a narrow line, e.g. the stretch a signal drag covers.
   */
  show(pieces: PlacedPiece[], color: string, foundations?: ReadonlyMap<number, number>, thin: PlacedPiece[] = []): void {
    const map = this.map;
    const g = new GeoBuilder().color(WHITE);
    const all = [...pieces, ...thin];
    for (let k = 0; k < all.length; k++) {
      const p = all[k]!;
      if (!map.inBounds(p.x, p.y)) continue;
      const kind = foundations?.get(map.tileIndex(p.x, p.y));
      const [e1, e2] = PIECE_EDGES[p.piece]!;
      if (kind === undefined && map.edgeLevel(p.x, p.y, e1) >= 0 && map.edgeLevel(p.x, p.y, e2) >= 0) {
        pieceEndpoints(map, p.x, p.y, p.piece, _a, _b); // bridge ends and tunnel portals included
      } else {
        const raw = map.rawCorners(p.x, p.y);
        const h = (e: number) => Math.max(...(kind === undefined ? map.edgeCorners(p.x, p.y, e) : foundationEdge(raw, kind, e))) * HEIGHT_SCALE + TRACK_LIFT;
        _a.set(p.x + EDGE_MID_X[e1], h(e1), p.y + EDGE_MID_Y[e1]);
        _b.set(p.x + EDGE_MID_X[e2], h(e2), p.y + EDGE_MID_Y[e2]);
      }
      g.box(_a.setY(_a.y + 0.02), _b.setY(_b.y + 0.02), k < pieces.length ? 0.34 : 0.14, 0.07, false);
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
