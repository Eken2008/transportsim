import * as THREE from 'three';

/** Accumulates non-indexed, flat-shaded triangles with per-vertex colors. */
export class GeoBuilder {
  private pos: number[] = [];
  private col: number[] = [];
  private r = 1;
  private g = 1;
  private b = 1;

  get empty(): boolean {
    return this.pos.length === 0;
  }

  color(c: THREE.Color): this {
    this.r = c.r;
    this.g = c.g;
    this.b = c.b;
    return this;
  }

  tri(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3): void {
    this.pos.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
    for (let i = 0; i < 3; i++) this.col.push(this.r, this.g, this.b);
  }

  /** Quad a-b-c-d, counter-clockwise when viewed from the front. */
  quad(a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3): void {
    this.tri(a, b, c);
    this.tri(a, c, d);
  }

  /**
   * Box from `a` to `b` (centre line, bottom face) with the given width and height.
   * The box's "up" is world +Y, so it follows slopes along its length.
   */
  box(a: THREE.Vector3, b: THREE.Vector3, width: number, height: number, bottom = true): void {
    const dir = _d.subVectors(b, a);
    const side = _s.set(-dir.z, 0, dir.x).normalize().multiplyScalar(width / 2);
    const a0 = _p[0]!.copy(a).sub(side);
    const a1 = _p[1]!.copy(a).add(side);
    const b0 = _p[2]!.copy(b).sub(side);
    const b1 = _p[3]!.copy(b).add(side);
    const a0t = _p[4]!.copy(a0).setY(a0.y + height);
    const a1t = _p[5]!.copy(a1).setY(a1.y + height);
    const b0t = _p[6]!.copy(b0).setY(b0.y + height);
    const b1t = _p[7]!.copy(b1).setY(b1.y + height);
    this.quad(a0t, a1t, b1t, b0t); // top
    this.quad(a1, b1, b1t, a1t); // side +
    this.quad(b0, a0, a0t, b0t); // side -
    this.quad(a0, a1, a1t, a0t); // end a
    this.quad(b1, b0, b0t, b1t); // end b
    if (bottom) this.quad(a0, b0, b1, a1);
  }

  build(): THREE.BufferGeometry | null {
    if (this.pos.length === 0) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }
}

const _d = new THREE.Vector3();
const _s = new THREE.Vector3();
const _p = Array.from({ length: 8 }, () => new THREE.Vector3());

/** sRGB hex → linear THREE.Color (vertex colors are linear). */
export const lin = (hex: string) => new THREE.Color(hex);
