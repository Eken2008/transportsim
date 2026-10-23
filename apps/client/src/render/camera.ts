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

interface Point {
  x: number;
  y: number;
}

/** A two-finger touch gesture. */
interface Pinch {
  /** Ground points under the two fingers when the gesture began: they stay under the fingers. */
  a: THREE.Vector3;
  b: THREE.Vector3;
  planeY: number;
  /** Where the fingers went down. */
  from: [Point, Point];
  /** Fingers moving up or down together tilt; anything else pans, zooms and turns. Decided once they have moved a little. */
  mode: 'undecided' | 'move' | 'tilt';
  /** Height of the fingers' midpoint last move, while tilting. */
  lastY: number;
}

/** Pixels the fingers move before a two-finger gesture is read as a tilt or not. */
const DECIDE_PX = 10;

/**
 * Tilted orbit camera around a ground target. Right-drag pans (grab), middle-drag or
 * Alt+right-drag rotates/tilts, wheel zooms toward the cursor, WASD/arrows pan,
 * Q/E rotate, PageUp/PageDown tilt.
 *
 * Touch: one finger pans (unless a build tool has it); two fingers keep the ground under them,
 * so pinching zooms, twisting turns and moving both pans. Two fingers moved up or down together tilt.
 */
export class CameraController {
  readonly camera: THREE.PerspectiveCamera;
  readonly target = new THREE.Vector3();
  yaw = Math.PI / 4;
  pitch = 0.95;
  distance = 70;
  /** The target is held on a vehicle: zoom stays centred on it. */
  following = false;
  /** Called when the player pans the camera by hand. */
  onPan: (() => void) | null = null;
  /** One finger pans; off while a build tool is picked, as the finger is the tool's. */
  oneFingerPan = true;
  /** Called when a second finger goes down: the gesture is the camera's now. */
  onMultiTouch: (() => void) | null = null;

  private readonly map: GameMap;
  private readonly dom: HTMLElement;
  private keys = new Set<string>();
  private drag: Drag | null = null;
  /** Fingers on the map, by pointer id. */
  private touches = new Map<number, Point>();
  private pinch: Pinch | null = null;
  /** Fingers moved since the two-finger gesture was last applied (once a frame, when every finger has reported). */
  private pinchMoved = false;
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
    this.listen(window, 'pointercancel', this.onUp as EventListener);
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
    return this.drag !== null || this.pinch !== null;
  }

  /** Fingers on the map. */
  get touchCount(): number {
    return this.touches.size;
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
    if (e.pointerType !== 'mouse') {
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.startTouch();
      if (this.touches.size === 2) this.onMultiTouch?.();
    } else if (e.button === 1 || (e.button === 2 && e.altKey)) {
      this.drag = { mode: 'rotate', x: e.clientX, y: e.clientY, anchor: null, planeY: 0 };
      e.preventDefault();
    } else if (e.button === 2) {
      this.drag = this.grab(e.clientX, e.clientY);
    }
  };

  /** Start panning with the ground under a screen point held there. */
  private grab(x: number, y: number): Drag {
    const ray = this.rayAt(x, y);
    const hit = pickTerrain(this.map, ray);
    const planeY = hit ? hit.point.y : this.target.y;
    this.onPan?.();
    return { mode: 'pan', x, y, anchor: hit?.point ?? rayPlane(ray, planeY), planeY };
  }

  /** (Re)start the touch gesture for the fingers now down. */
  private startTouch(): void {
    const [p, q] = [...this.touches.values()];
    this.drag = null;
    this.pinch = null;
    if (p && q) this.pinch = this.startPinch(p, q);
    else if (p && this.oneFingerPan) this.drag = this.grab(p.x, p.y);
  }

  private startPinch(p: Point, q: Point): Pinch | null {
    const mx = (p.x + q.x) / 2;
    const my = (p.y + q.y) / 2;
    const hit = pickTerrain(this.map, this.rayAt(mx, my));
    const planeY = hit ? hit.point.y : this.target.y;
    const a = rayPlane(this.rayAt(p.x, p.y), planeY);
    const b = rayPlane(this.rayAt(q.x, q.y), planeY);
    this.onPan?.();
    // A finger above the horizon has no ground under it: try again when they move.
    if (!a || !b) return null;
    return { a, b, planeY, from: [{ ...p }, { ...q }], mode: 'undecided', lastY: my };
  }

  private onMove = (e: PointerEvent) => {
    const t = this.touches.get(e.pointerId);
    if (t) {
      t.x = e.clientX;
      t.y = e.clientY;
      if (this.touches.size > 1) {
        this.pinchMoved = true;
      } else if (this.drag) {
        this.panTo(this.drag, t.x, t.y);
      }
      return;
    }
    const d = this.drag;
    if (!d) return;
    if (d.mode === 'rotate') {
      this.yaw -= (e.clientX - d.x) * 0.005;
      this.pitch = clamp(this.pitch + (e.clientY - d.y) * 0.004, MIN_PITCH, MAX_PITCH);
      d.x = e.clientX;
      d.y = e.clientY;
      return;
    }
    this.panTo(d, e.clientX, e.clientY);
  };

  /** Keep the grabbed point under the pointer. */
  private panTo(d: Drag, x: number, y: number): void {
    if (!d.anchor) return;
    this.apply();
    const p = rayPlane(this.rayAt(x, y), d.planeY);
    if (!p) return;
    this.target.x += d.anchor.x - p.x;
    this.target.z += d.anchor.z - p.z;
    this.clampTarget();
  }

  private movePinch(): void {
    const [p, q] = [...this.touches.values()];
    if (!p || !q) return;
    this.pinch ??= this.startPinch(p, q);
    const g = this.pinch;
    if (!g) return;
    const mx = (p.x + q.x) / 2;
    const my = (p.y + q.y) / 2;
    if (g.mode === 'undecided') {
      const dp = { x: p.x - g.from[0].x, y: p.y - g.from[0].y };
      const dq = { x: q.x - g.from[1].x, y: q.y - g.from[1].y };
      if (Math.max(Math.hypot(dp.x, dp.y), Math.hypot(dq.x, dq.y)) < DECIDE_PX) return;
      const upright = (v: Point) => Math.abs(v.y) > 2 * Math.abs(v.x);
      const spread = Math.abs(Math.hypot(p.x - q.x, p.y - q.y) - Math.hypot(g.from[0].x - g.from[1].x, g.from[0].y - g.from[1].y));
      g.mode = upright(dp) && upright(dq) && Math.sign(dp.y) === Math.sign(dq.y) && spread < DECIDE_PX ? 'tilt' : 'move';
    }
    if (g.mode === 'tilt') {
      this.pitch = clamp(this.pitch + (my - g.lastY) * 0.004, MIN_PITCH, MAX_PITCH);
      g.lastY = my;
      return;
    }
    // Turn and zoom so the ground under the fingers lines up with the held points, then pan the
    // held midpoint back under the fingers' midpoint. Measured afresh every move, so it settles.
    this.apply();
    const a = rayPlane(this.rayAt(p.x, p.y), g.planeY);
    const b = rayPlane(this.rayAt(q.x, q.y), g.planeY);
    if (!a || !b) return;
    // Angles measured like yaw, so turning the camera by d turns the ground under the screen by d.
    const turn = Math.atan2(g.b.x - g.a.x, g.b.z - g.a.z) - Math.atan2(b.x - a.x, b.z - a.z);
    this.yaw += Math.atan2(Math.sin(turn), Math.cos(turn));
    const span = Math.hypot(b.x - a.x, b.z - a.z);
    if (span > 1e-3) this.distance = clamp((this.distance * g.a.distanceTo(g.b)) / span, MIN_DIST, MAX_DIST);
    this.apply();
    const m = rayPlane(this.rayAt(mx, my), g.planeY);
    if (!m) return;
    this.target.x += (g.a.x + g.b.x) / 2 - m.x;
    this.target.z += (g.a.z + g.b.z) / 2 - m.z;
    this.clampTarget();
  }

  private onUp = (e: PointerEvent) => {
    // A finger lifting restarts the gesture with the fingers left, so nothing jumps.
    if (this.touches.delete(e.pointerId)) this.startTouch();
    else if (this.drag && (e.button === 1 || e.button === 2)) this.drag = null;
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const factor = Math.exp(Math.sign(e.deltaY) * Math.min(Math.abs(e.deltaY), 120) * 0.0018);
    const next = clamp(this.distance * factor, MIN_DIST, MAX_DIST);
    // Zoom toward the point under the cursor.
    if (next < this.distance && !this.following) {
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
    if (this.pinchMoved) {
      this.pinchMoved = false;
      this.movePinch();
    }
    const k = this.keys;
    let mx = 0; // + = right
    let mf = 0; // + = forward
    if (k.has('KeyW') || k.has('ArrowUp')) mf += 1;
    if (k.has('KeyS') || k.has('ArrowDown')) mf -= 1;
    if (k.has('KeyA') || k.has('ArrowLeft')) mx -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
    if (mx || mf) {
      this.onPan?.();
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
