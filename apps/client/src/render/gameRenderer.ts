import * as THREE from 'three';
import type { ClientWorld } from '../game/clientWorld.ts';
import { client } from '../net/client.ts';
import { useApp, type ToolId } from '../store.ts';
import { RailTool } from '../tools/railTool.ts';
import { TerraformTool } from '../tools/terraformTool.ts';
import type { Modifiers, Tool } from '../tools/tool.ts';
import { CameraController } from './camera.ts';
import { ChunkManager } from './chunkManager.ts';
import { Cursor } from './cursor.ts';
import { LabelLayer } from './labels.ts';
import { pickTerrain, type TerrainHit } from './picking.ts';
import { TrackGhost } from './trackGhost.ts';

const SKY = new THREE.Color('#a8c8e6');

/** Owns the Three.js scene for one game session. */
export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
  readonly controller: CameraController;
  readonly chunks: ChunkManager;
  readonly cursor: Cursor;
  readonly ghost: TrackGhost;
  readonly labels: LabelLayer;

  private readonly canvas: HTMLCanvasElement;
  private readonly world: ClientWorld;
  private readonly sun = new THREE.DirectionalLight('#fff3dc', 3.1);
  private tool: Tool | null = null;
  private lastPointer: { x: number; y: number } | null = null;
  private hoverDirty = false;
  private toolDown = false;
  private mods: Modifiers = { ctrl: false, shift: false };
  private raf = 0;
  private lastTime = performance.now();
  private disposers: (() => void)[] = [];
  onStats: ((s: { fps: number; chunks: number }) => void) | null = null;
  private fpsFrames = 0;
  private fpsTime = 0;

  constructor(canvas: HTMLCanvasElement, world: ClientWorld) {
    this.canvas = canvas;
    this.world = world;
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.toneMappingExposure = 1.0;

    this.scene.background = SKY;
    this.scene.fog = new THREE.Fog(SKY, 200, 1200);
    this.scene.add(new THREE.HemisphereLight('#e4f0ff', '#4f5a3c', 1.05));
    this.sun.position.set(-0.75, 0.62, 0.4).normalize();
    this.scene.add(this.sun, this.sun.target);

    this.controller = new CameraController(this.camera, canvas, world.map);
    this.chunks = new ChunkManager(world, (ids) => client.subscribe(ids));
    this.cursor = new Cursor(world.map);
    this.ghost = new TrackGhost(world.map);
    this.labels = new LabelLayer(canvas.parentElement!, world);
    this.scene.add(this.chunks.root, this.cursor.root, this.ghost.mesh);
    client.resubscribe = () => this.chunks.resubscribe();

    this.disposers.push(
      world.onChunk(() => {
        this.tool?.invalidate?.();
        this.hoverDirty = true;
      }),
    );
    this.listen(canvas, 'pointermove', ((e: PointerEvent) => {
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.setMods(e);
      this.hoverDirty = true;
    }) as EventListener);
    this.listen(canvas, 'pointerleave', () => {
      this.lastPointer = null;
      this.hoverDirty = true;
    });
    this.listen(canvas, 'pointerdown', ((e: PointerEvent) => {
      if (e.button !== 0 || !this.tool) return;
      const hit = this.pick(e.clientX, e.clientY);
      if (!hit) return;
      canvas.setPointerCapture(e.pointerId);
      this.toolDown = true;
      this.setMods(e);
      this.tool.onDown(hit, this.mods);
    }) as EventListener);
    this.listen(canvas, 'pointerup', ((e: PointerEvent) => {
      if (e.button !== 0 || !this.toolDown) return;
      this.toolDown = false;
      this.setMods(e);
      this.tool?.onUp(this.pick(e.clientX, e.clientY), this.mods);
    }) as EventListener);
    this.listen(window, 'keydown', ((e: KeyboardEvent) => {
      if (e.code === 'Escape') useApp.setState({ tool: null });
      this.setMods(e);
    }) as EventListener);
    this.listen(window, 'keyup', ((e: KeyboardEvent) => this.setMods(e)) as EventListener);

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.disposers.push(() => ro.disconnect());
    this.disposers.push(useApp.subscribe((s, prev) => s.tool !== prev.tool && this.setTool(s.tool)));
    this.setTool(useApp.getState().tool);
    this.resize();
    this.loop();
  }

  private listen(el: EventTarget, type: string, fn: EventListener): void {
    el.addEventListener(type, fn);
    this.disposers.push(() => el.removeEventListener(type, fn));
  }

  lookAt(x: number, z: number): void {
    this.controller.lookAt(x, z);
  }

  private setTool(id: ToolId | null): void {
    this.tool?.cancel();
    this.toolDown = false;
    this.ghost.hide();
    this.cursor.hide();
    if (id === 'rail' || id === 'removeRail') this.tool = new RailTool(this.ghost, id === 'removeRail');
    else this.tool = id ? new TerraformTool(id, this.cursor) : null;
    this.canvas.style.cursor = id ? 'crosshair' : 'default';
    this.hoverDirty = true;
  }

  private setMods(e: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): void {
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl !== this.mods.ctrl || e.shiftKey !== this.mods.shift) {
      this.mods = { ctrl, shift: e.shiftKey };
      this.hoverDirty = true;
    }
  }

  private pick(clientX: number, clientY: number): TerrainHit | null {
    return pickTerrain(this.world.map, this.controller.rayAt(clientX, clientY));
  }

  private resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastTime) / 1000);
    this.lastTime = now;

    this.controller.update(dt);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = this.controller.distance * 2.5;
    fog.far = this.controller.distance * 9 + 300;
    this.chunks.update(this.camera, this.controller.target, this.controller.distance);

    if (this.hoverDirty && this.tool) {
      this.hoverDirty = false;
      this.tool.onHover(
        this.lastPointer && !this.controller.isDragging ? this.pick(this.lastPointer.x, this.lastPointer.y) : null,
        this.mods,
      );
    }

    this.renderer.render(this.scene, this.camera);
    this.labels.update(this.camera, this.canvas.clientWidth, this.canvas.clientHeight, this.controller.distance);

    this.fpsFrames++;
    if (now - this.fpsTime > 1000) {
      this.onStats?.({ fps: Math.round((this.fpsFrames * 1000) / (now - this.fpsTime)), chunks: this.chunks.stats.views });
      this.fpsFrames = 0;
      this.fpsTime = now;
    }
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.tool?.cancel();
    for (const d of this.disposers) d();
    this.controller.dispose();
    this.chunks.dispose();
    this.ghost.dispose();
    this.labels.dispose();
    if (client.resubscribe) client.resubscribe = null;
    this.renderer.dispose();
  }
}
