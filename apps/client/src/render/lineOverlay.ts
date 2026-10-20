import { HEIGHT_SCALE, LINE_COLORS, type Line } from '@transportsim/shared';
import * as THREE from 'three';
import type { ClientWorld } from '../game/clientWorld.ts';
import { useApp } from '../store.ts';

/** Height of the ribbons above the ground (world units). */
const LIFT = 0.7;
/** Tiles between height samples along a ribbon. */
const STEP = 2;

/**
 * Lines drawn on the map as coloured ribbons from stop to stop (and back to the first), while
 * their windows are open. Lines sharing a stretch run side by side.
 */
export class LineOverlay {
  readonly mesh: THREE.Mesh;
  private readonly material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide });
  private key = '';

  constructor(private readonly world: ClientWorld) {
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    this.mesh.renderOrder = 10;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
  }

  /** The lines whose windows are open. */
  private shown(): Line[] {
    const lines = this.world.state.lines;
    const ids = new Set<number>();
    for (const w of useApp.getState().windows) if (w.kind === 'line' && lines.has(w.id)) ids.add(w.id);
    return [...ids].sort((a, b) => a - b).map((id) => lines.get(id)!);
  }

  update(distance: number): void {
    const lines = this.shown();
    const width = Math.max(0.25, distance * 0.012);
    const key = `${this.world.linesRev}|${this.world.stationsRev}|${this.world.waypointsRev}|${lines.map((l) => l.id).join()}|${width.toFixed(2)}`;
    if (key === this.key) return;
    this.key = key;
    this.mesh.visible = lines.length > 0;
    if (!lines.length) return;
    const pos: number[] = [];
    const col: number[] = [];
    const color = new THREE.Color();
    const map = this.world.map;
    const ground = (x: number, z: number) => map.heightAt(Math.max(0, Math.min(map.width - 0.01, x)), Math.max(0, Math.min(map.height - 0.01, z))) * HEIGHT_SCALE + LIFT;
    const quad = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number) => {
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz);
      for (let k = 0; k < 6; k++) col.push(color.r, color.g, color.b);
    };
    lines.forEach((line, i) => {
      const stops = this.stops(line);
      if (stops.length === 0) return;
      color.set(LINE_COLORS[line.color] ?? '#ffffff');
      // Side by side: each line keeps its own lane.
      const lane = (i - (lines.length - 1) / 2) * width * 1.1;
      for (const [x, z] of stops) {
        const y = ground(x, z);
        const r = width * 1.2;
        quad(x - r, y, z - r, x + r, y, z - r, x + r, y, z + r, x - r, y, z + r);
      }
      if (stops.length < 2) return;
      for (let k = 0; k < stops.length; k++) {
        const [ax, az] = stops[k]!;
        const [bx, bz] = stops[(k + 1) % stops.length]!;
        const len = Math.hypot(bx - ax, bz - az);
        if (len < 1e-3) continue;
        const nx = (-(bz - az) / len) * 1;
        const nz = ((bx - ax) / len) * 1;
        const n = Math.max(1, Math.ceil(len / STEP));
        for (let s = 0; s < n; s++) {
          const t0 = s / n;
          const t1 = (s + 1) / n;
          const x0 = ax + (bx - ax) * t0 + nx * lane;
          const z0 = az + (bz - az) * t0 + nz * lane;
          const x1 = ax + (bx - ax) * t1 + nx * lane;
          const z1 = az + (bz - az) * t1 + nz * lane;
          const y0 = ground(x0, z0);
          const y1 = ground(x1, z1);
          const hx = (nx * width) / 2;
          const hz = (nz * width) / 2;
          quad(x0 - hx, y0, z0 - hz, x1 - hx, y1, z1 - hz, x1 + hx, y1, z1 + hz, x0 + hx, y0, z0 + hz);
        }
      }
    });
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
  }

  /** Map positions (tile units) of a line's stations and waypoints, in order. */
  private stops(line: Line): [number, number][] {
    const s = this.world.state;
    const w = this.world.map.width;
    const out: [number, number][] = [];
    for (const o of line.orders) {
      if (o.kind === 'station') {
        const st = s.stations.get(o.station);
        if (st) out.push([(st.x0 + st.x1 + 1) / 2, (st.y0 + st.y1 + 1) / 2]);
      } else if (o.kind === 'waypoint') {
        const wp = s.waypoints.get(o.waypoint);
        if (wp) out.push([(wp.tile % w) + 0.5, Math.floor(wp.tile / w) + 0.5]);
      }
    }
    return out;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}
