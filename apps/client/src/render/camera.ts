import { HEIGHT_SCALE, type GameMap } from '@transportsim/shared';
import * as THREE from 'three';
import { pickTerrain, rayPlane } from './picking.ts';

const MIN_DIST = 6;
const MAX_DIST = 420;
const MIN_PITCH = 0.35;
const MAX_PITCH = 1.45;

interface Drag {
  mode: 'pan' | 'rotate';
  x: number;
  y: number;
  anchor: THREE.Vector3 | null;
  planeY: number;
}

/**
 * Tilted orbit camera around a ground target. Right-drag pans (grab), middle-drag or
 * Alt+right-drag rotates/tilts, wheel zooms toward the cursor, WASD/arrows pan,
 * Q/E rotate, PageUp/PageDown tilt.
 */
export class CameraController {
  readonly camera: THREE.PerspectiveCamera;
  readonly target = new THREE.Vector3();
  yaw = Math.PI / 4;
  pitch = 0.95;
  distance = 70;

  private readonly map: GameMap;
  private readonly dom: HTMLElement;
  private keys = new Set<string>();
  private drag: Drag | null = null;
  private raycaster = new THREE.Raycaster();
  private groundY = 0;
  private disposers: (() => void)[] = [];

  constructor(camera: THREE.PerspectiveCamera, dom: HTMLElement, map: GameMap) {
    this.camera = camera;
    this.dom = dom;
    this.map = map;
    this.target.set(map.width / 2, 0, map.height / 2);
    this.listen(dom, 'pointerdown', this.onDown as EventListener);
    this.listen(window, 'pointermove', this.onMove as EventListener);
    this.listen(window, 'pointerup', this.onUp as EventListener);
    this.listen(dom, 'wheel', this.onWheel as EventListener, { passive: false });
    this.listen(dom, 'contextmenu', (e) => e.preventDefault());
    this.listen(window, 'keydown', this.onKey as EventListener);
    this.listen(window, 'keyup', ((e: KeyboardEvent) => void this.keys.delete(e.code)) as EventListener);
    this.listen(window, 'blur', () => this.keys.clear());
  }

  private listen(el: EventTarget, type: string, fn: EventListener, opts?: AddEventListenerOptions): void {
    el.addEventListener(type, fn, opts);
    this.disposers.push(() => el.removeEventListener(type, fn, opts));
  }

  dispose(): void {
    for (const d of this.disposers) d();
  }

  get isDragging(): boolean {
    return this.drag !== null;
  }

  lookAt(x: number, z: number): void {
    this.target.set(x, this.map.heightAt(x, z) * HEIGHT_SCALE, z);
    this.groundY = this.target.y;
  }

  /** Ray through a client-space pointer position. */
  rayAt(clientX: number, clientY: number): THREE.Ray {
    const r = this.dom.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray.clone();
  }

  private onDown = (e: PointerEvent) => {
    if (e.button === 1 || (e.button === 2 && e.altKey)) {
      this.drag = { mode: 'rotate', x: e.clientX, y: e.clientY, anchor: null, planeY: 0 };
      e.preventDefault();
    } else if (e.button === 2) {
      const ray = this.rayAt(e.clientX, e.clientY);
      const hit = pickTerrain(this.map, ray);
      const planeY = hit ? hit.point.y : this.target.y;
      this.drag = { mode: 'pan', x: e.clientX, y: e.clientY, anchor: hit?.point ?? rayPlane(ray, planeY), planeY };
    }
  };

  private onMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    if (d.mode === 'rotate') {
      this.yaw -= (e.clientX - d.x) * 0.005;
      this.pitch = clamp(this.pitch + (e.clientY - d.y) * 0.004, MIN_PITCH, MAX_PITCH);
      d.x = e.clientX;
      d.y = e.clientY;
      return;
    }
    if (!d.anchor) return;
    // Keep the grabbed point under the cursor.
    this.apply();
    const p = rayPlane(this.rayAt(e.clientX, e.clientY), d.planeY);
    if (!p) return;
    this.target.x += d.anchor.x - p.x;
    this.target.z += d.anchor.z - p.z;
    this.clampTarget();
  };

  private onUp = (e: PointerEvent) => {
    if (this.drag && (e.button === 1 || e.button === 2)) this.drag = null;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const factor = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) * 0.0018);
    const next = clamp(this.distance * factor, MIN_DIST, MAX_DIST);
    // Zoom toward the point under the cursor.
    if (next < this.distance) {
      const hit = pickTerrain(this.map, this.rayAt(e.clientX, e.clientY));
      if (hit) {
        const k = 1 - next / this.distance;
        this.target.x += (hit.point.x - this.target.x) * k;
        this.target.z += (hit.point.z - this.target.z) * k;
        this.clampTarget();
      }
    }
    this.distance = next;
  };

  private onKey = (e: KeyboardEvent) => {
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    this.keys.add(e.code);
  };

  private clampTarget(): void {
    this.target.x = clamp(this.target.x, 0, this.map.width);
    this.target.z = clamp(this.target.z, 0, this.map.height);
  }

  /** Per-frame update: keyboard movement, smooth ground following, camera placement. */
  update(dt: number): void {
    const k = this.keys;
    let mx = 0; // + = right
    let mf = 0; // + = forward
    if (k.has('KeyW') || k.has('ArrowUp')) mf += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) mf -= 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) mx -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
    if (mx || mf) {
      const speed = this.distance * 1.2 * dt;
      const sin = Math.sin(this.yaw);
      const cos = Math.cos(this.yaw);
      // The camera sits at +(sin, cos) from the target, so forward = (-sin, -cos), right = (cos, -sin).
      this.target.x += (mx * cos - mf * sin) * speed;
      this.target.z += (-mx * sin - mf * cos) * speed;
      this.clampTarget();
    }
    if (k.has('KeyQ')) this.yaw += dt * 1.6;
    if (k.has('KeyE')) this.yaw -= dt * 1.6;
    if (k.has('PageUp')) this.pitch = clamp(this.pitch + dt, MIN_PITCH, MAX_PITCH);
    if (k.has('PageDown')) this.pitch = clamp(this.pitch - dt, MIN_PITCH, MAX_PITCH);
    if (k.has('Equal') || k.has('NumpadAdd')) this.distance = clamp(this.distance * (1 - dt * 1.5), MIN_DIST, MAX_DIST);
    if (k.has('Minus') || k.has('NumpadSubtract')) this.distance = clamp(this.distance * (1 + dt * 1.5), MIN_DIST, MAX_DIST);

    const ground = this.map.heightAt(this.target.x, this.target.z) * HEIGHT_SCALE;
    this.groundY += (ground - this.groundY) * Math.min(1, dt * 6);
    this.target.y = this.groundY;
    this.apply();
  }

  apply(): void {
    const cp = Math.cos(this.pitch);
    const c = this.camera;
    c.position.set(
      this.target.x + Math.sin(this.yaw) * cp * this.distance,
      this.target.y + Math.sin(this.pitch) * this.distance,
      this.target.z + Math.cos(this.yaw) * cp * this.distance,
    );
    c.lookAt(this.target);
    c.near = Math.max(0.1, this.distance * 0.02);
    c.far = this.distance * 12 + 400;
    c.updateProjectionMatrix();
    c.updateMatrixWorld();
  }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
