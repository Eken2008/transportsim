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

  /** Axis-aligned box (no bottom face). */
  aabb(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
    const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
    this.quad(v(x0, y1, z0), v(x0, y1, z1), v(x1, y1, z1), v(x1, y1, z0)); // top
    this.quad(v(x0, y0, z1), v(x1, y0, z1), v(x1, y1, z1), v(x0, y1, z1)); // +z
    this.quad(v(x1, y0, z0), v(x0, y0, z0), v(x0, y1, z0), v(x1, y1, z0)); // -z
    this.quad(v(x1, y0, z1), v(x1, y0, z0), v(x1, y1, z0), v(x1, y1, z1)); // +x
    this.quad(v(x0, y0, z0), v(x0, y0, z1), v(x0, y1, z1), v(x0, y1, z0)); // -x
  }

  /** Gable roof over [x0,x1]×[z0,z1] starting at height y, `rise` high. Ridge along X (or Z). */
  gable(x0: number, z0: number, x1: number, z1: number, y: number, rise: number, overhang = 0.04, alongZ = false): void {
    // For a Z ridge, build the X-ridge roof in swapped coordinates and mirror it back
    // (swapping x/z flips handedness, so the triangle order is reversed to keep faces outward).
    const v = alongZ
      ? (x: number, yy: number, z: number) => new THREE.Vector3(z, yy, x)
      : (x: number, yy: number, z: number) => new THREE.Vector3(x, yy, z);
    if (alongZ) [x0, z0, x1, z1] = [z0, x0, z1, x1];
    const tri = alongZ
      ? (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => this.tri(a, c, b)
      : (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3) => this.tri(a, b, c);
    const quad = (a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3) => {
      tri(a, b, c);
      tri(a, c, d);
    };
    const a = x0 - overhang;
    const b = x1 + overhang;
    const zm = (z0 + z1) / 2;
    const top = y + rise;
    const n = z0 - overhang;
    const s = z1 + overhang;
    quad(v(a, y, s), v(b, y, s), v(b, top, zm), v(a, top, zm)); // south slope
    quad(v(b, y, n), v(a, y, n), v(a, top, zm), v(b, top, zm)); // north slope
    tri(v(b, y, s), v(b, y, n), v(b, top, zm)); // east gable
    tri(v(a, y, n), v(a, y, s), v(a, top, zm)); // west gable
  }

  /** Closed prism (low-poly cylinder) along X from x0 to x1, centred at (cy, cz). */
  cylinderX(x0: number, x1: number, cy: number, cz: number, r: number, sides = 8): void {
    const ring = (x: number) =>
      Array.from({ length: sides }, (_, i) => {
        const a = (i / sides) * Math.PI * 2 + Math.PI / sides;
        return new THREE.Vector3(x, cy + Math.cos(a) * r, cz + Math.sin(a) * r);
      });
    const a = ring(x0);
    const b = ring(x1);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      this.quad(a[i]!, a[j]!, b[j]!, b[i]!);
    }
    const ca = new THREE.Vector3(x0, cy, cz);
    const cb = new THREE.Vector3(x1, cy, cz);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      this.tri(ca, a[j]!, a[i]!);
      this.tri(cb, b[i]!, b[j]!);
    }
  }

  /** Vertical cylinder (chimney, dome) from y0 to y1 at (cx, cz). */
  cylinderY(cx: number, cz: number, y0: number, y1: number, r: number, sides = 8): void {
    const ring = (y: number) =>
      Array.from({ length: sides }, (_, i) => {
        const a = (i / sides) * Math.PI * 2;
        return new THREE.Vector3(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r);
      });
    const a = ring(y0);
    const b = ring(y1);
    for (let i = 0; i < sides; i++) {
      const j = (i + 1) % sides;
      this.quad(a[j]!, a[i]!, b[i]!, b[j]!);
    }
    const top = new THREE.Vector3(cx, y1, cz);
    for (let i = 0; i < sides; i++) this.tri(top, b[(i + 1) % sides]!, b[i]!);
  }

  /** Four-sided pyramid (spire) over a square base. */
  pyramid(cx: number, cz: number, half: number, y: number, rise: number): void {
    const v = (x: number, yy: number, z: number) => new THREE.Vector3(x, yy, z);
    const t = v(cx, y + rise, cz);
    const p = [v(cx - half, y, cz - half), v(cx - half, y, cz + half), v(cx + half, y, cz + half), v(cx + half, y, cz - half)];
    for (let i = 0; i < 4; i++) this.tri(p[i]!, p[(i + 1) % 4]!, t);
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
