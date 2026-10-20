import * as THREE from 'three';
import type { ClientWorld } from '../game/clientWorld.ts';
import { client } from '../net/client.ts';
import { useApp, type ToolId, type ViewMode } from '../store.ts';
import { sound } from '../audio/sound.ts';
import { BulldozeTool, CanalTool, ConvertTool, DepotTool, HeadquartersTool, StationTool, WaypointTool } from '../tools/placeTools.ts';
import { RoadPlaceTool, RoadTool } from '../tools/roadTools.ts';
import { RailTool } from '../tools/railTool.ts';
import { TerraformTool } from '../tools/terraformTool.ts';
import type { Modifiers, Tool } from '../tools/tool.ts';
import { AreaGhost } from './areaGhost.ts';
import { CameraController } from './camera.ts';
import { ChunkManager } from './chunkManager.ts';
import { Cursor } from './cursor.ts';
import { LabelLayer } from './labels.ts';
import { pickTerrain, type TerrainHit } from './picking.ts';
import { TrackGhost } from './trackGhost.ts';
import { motionPoint, TrainRenderer } from './trainRenderer.ts';
import { placeViews, vehicleViews } from './vehicleViews.ts';
import { SignalLights } from './signalLights.ts';
import { IndustryRenderer } from './industryMesh.ts';
import { FloatingText } from './floatingText.ts';
import { CrossingBooms } from './crossings.ts';
import { LineOverlay } from './lineOverlay.ts';
import { buildingMaterial } from './buildings.ts';
import { treeAssets } from './trees.ts';
import { SignalTool } from '../tools/signalTool.ts';
import { BridgeTool, TunnelTool } from '../tools/structureTools.ts';
import { AirportRole, HEIGHT_SCALE, TileType, type Piece } from '@transportsim/shared';
import { openWindow } from '../store.ts';
import { OrdersTool } from '../tools/ordersTool.ts';
import { catchmentRect, rectTiles } from '../game/catchment.ts';

const SKY = new THREE.Color('#a8c8e6');
/** Camera distance and tilt of the vehicle views in vehicle windows. */
const VIEW_DISTANCE = 6;
const VIEW_PITCH = 0.75;
/** Camera distance of the place views in news previews: far enough to see what happened around. */
const PLACE_VIEW_DISTANCE = 16;

/** Draw a shared material normally, see-through or not at all. */
function applyViewMode(mat: THREE.Material, mode: ViewMode, opacity: number): void {
  const transparent = mode === 'transparent';
  mat.visible = mode !== 'hidden';
  if (mat.transparent !== transparent) {
    mat.transparent = transparent;
    mat.depthWrite = !transparent;
    mat.needsUpdate = true;
  }
  mat.opacity = transparent ? opacity : 1;
}

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
  readonly area: AreaGhost;
  /** Station catchment overlay (station tool preview or a station window toggle). */
  readonly catchment: AreaGhost;
  readonly trains: TrainRenderer;
  readonly signalLights: SignalLights;
  private readonly industries: IndustryRenderer;
  /** Tiles blocked by accident wreckage. */
  private readonly wrecks: AreaGhost;
  private wrecksKey = '';
  /** When the followed vehicle was last drawn. */
  private followSeen = 0;
  /** Path reservations overlay (toggled from the signal options). */
  private readonly reservations: TrackGhost;
  private reservationsRev = '';
  readonly floaters: FloatingText;
  readonly crossings: CrossingBooms;
  /** Lines on the map while the lines window (or a line's) is open. */
  private readonly lineOverlay: LineOverlay;
  private downAt: { x: number; y: number } | null = null;
  /** Camera of the vehicle views in vehicle windows. */
  private readonly viewCamera = new THREE.PerspectiveCamera(45, 1, 0.1, 600);
  /** Where each viewed vehicle roughly is: its tiles stay loaded and it is drawn even when far away. */
  private viewPoints = new Map<number, { x: number; z: number }>();
  /** The places shown in place views: their tiles stay loaded. */
  private placePoints: { x: number; z: number }[] = [];

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
    this.controller.onPan = () => {
      if (useApp.getState().follow !== null) useApp.setState({ follow: null });
    };
    this.chunks = new ChunkManager(world, (ids) => client.subscribe(ids));
    this.cursor = new Cursor(world.map);
    this.ghost = new TrackGhost(world.map);
    this.area = new AreaGhost(world.map);
    this.scene.add(this.area.mesh);
    this.catchment = new AreaGhost(world.map, 0.2);
    this.catchment.mesh.renderOrder = 4;
    this.scene.add(this.catchment.mesh);
    this.trains = new TrainRenderer(world, this.chunks.curves);
    this.scene.add(this.trains.root);
    this.signalLights = new SignalLights(world);
    this.scene.add(this.signalLights.mesh);
    this.reservations = new TrackGhost(world.map);
    this.scene.add(this.reservations.mesh);
    this.wrecks = new AreaGhost(world.map, 0.55);
    this.scene.add(this.wrecks.mesh);
    this.industries = new IndustryRenderer(world);
    this.scene.add(this.industries.mesh);
    this.floaters = new FloatingText(canvas.parentElement!, world);
    this.crossings = new CrossingBooms(world);
    this.scene.add(this.crossings.root);
    this.lineOverlay = new LineOverlay(world);
    this.scene.add(this.lineOverlay.mesh);
    world.onIncome = (tile, amount) => {
      this.floaters.add(tile, '+£' + Math.round(amount).toLocaleString('en-GB'));
      // Coin only when the payment is near the focus, fading out with distance and zoom.
      const t = this.controller.target;
      const d = Math.hypot((tile % world.map.width) + 0.5 - t.x, Math.floor(tile / world.map.width) + 0.5 - t.z);
      const near = 1 - Math.min(1, Math.max(0, (d - 8) / 16));
      sound.coin(near * Math.min(1, Math.max(0.15, 30 / this.controller.distance)));
    };
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
      if (e.button === 0) this.downAt = { x: e.clientX, y: e.clientY };
      if (e.button !== 0 || !this.tool) return;
      const hit = this.pick(e.clientX, e.clientY);
      if (!hit) return;
      canvas.setPointerCapture(e.pointerId);
      this.toolDown = true;
      this.setMods(e);
      this.tool.onDown(hit, this.mods);
    }) as EventListener);
    this.listen(canvas, 'pointerup', ((e: PointerEvent) => {
      const click = e.button === 0 && this.downAt && Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) < 5;
      if (click && !this.tool) this.select(e.clientX, e.clientY);
      if (e.button !== 0 || !this.toolDown) return;
      this.toolDown = false;
      this.setMods(e);
      this.tool?.onUp(this.pick(e.clientX, e.clientY), this.mods);
    }) as EventListener);
    this.listen(window, 'keydown', ((e: KeyboardEvent) => {
      if (e.code === 'Escape') useApp.setState({ tool: null, ordersFor: null, follow: null });
      this.setMods(e);
    }) as EventListener);
    this.listen(window, 'keyup', ((e: KeyboardEvent) => this.setMods(e)) as EventListener);

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.disposers.push(() => ro.disconnect());
    this.disposers.push(
      useApp.subscribe((s, prev) => {
        if (s.treeView !== prev.treeView || s.buildingView !== prev.buildingView) this.applyViewModes();
        if (s.focus && s.focus !== prev.focus) this.lookAt(s.focus.x + 0.5, s.focus.y + 0.5);
        if (s.follow !== prev.follow) this.followSeen = performance.now();
        if (s.tool !== prev.tool) this.setTool(s.tool);
        if (s.catchmentFor !== prev.catchmentFor || s.tool !== prev.tool) this.showStationCatchment();
        else if (
          s.stationOpts !== prev.stationOpts ||
          s.bridgeType !== prev.bridgeType ||
          s.signalOneWay !== prev.signalOneWay ||
          s.signalKind !== prev.signalKind ||
          s.signalInterval !== prev.signalInterval ||
          s.railType !== prev.railType ||
          s.roadStopKind !== prev.roadStopKind ||
          s.airportKind !== prev.airportKind
        ) {
          this.tool?.invalidate?.();
          this.hoverDirty = true;
        }
      }),
    );
    this.applyViewModes();
    this.setTool(useApp.getState().tool);
    this.resize();
    this.loop();
  }

  /** Hold the camera on the followed vehicle; stop once it has been gone a moment (e.g. into a depot). */
  private followVehicle(now: number): void {
    const id = useApp.getState().follow;
    this.controller.following = id !== null;
    if (id === null) return;
    // The first pick of a vehicle is its lead unit.
    const p = this.trains.picks.find((q) => q.trainId === id);
    if (p) {
      this.followSeen = now;
      this.controller.target.x = p.pos.x;
      this.controller.target.z = p.pos.z;
      this.controller.apply();
    } else if (now - this.followSeen > 1000) {
      useApp.setState({ follow: null });
    }
  }

  /** Rough positions of the vehicles shown in vehicle windows (on their way, or in their depot), and the places in place views. */
  private locateViews(): void {
    this.viewPoints.clear();
    const map = this.world.map;
    for (const id of vehicleViews.values()) {
      const m = this.world.motions.get(id)?.m;
      const p = m && motionPoint(map, m);
      const t = this.world.trains.get(id);
      if (p) this.viewPoints.set(id, { x: p.x + 0.5, z: p.y + 0.5 });
      else if (t && t.status === 'depot' && t.depot >= 0) this.viewPoints.set(id, { x: (t.depot % map.width) + 0.5, z: Math.floor(t.depot / map.width) + 0.5 });
    }
    this.placePoints = [...placeViews.values()].map((tile) => ({ x: (tile % map.width) + 0.5, z: Math.floor(tile / map.width) + 0.5 }));
  }

  /**
   * Draws each vehicle and place view into a corner of the main canvas and copies it to the
   * view's own canvas, before the main frame is drawn over it.
   */
  private drawViews(): void {
    if (vehicleViews.size === 0 && placeViews.size === 0) return;
    const r = this.renderer;
    const ratio = r.getPixelRatio();
    const fullW = this.canvas.clientWidth;
    const fullH = this.canvas.clientHeight;
    const bufferH = this.canvas.height;
    const cam = this.viewCamera;
    const yaw = this.controller.yaw;
    const cp = Math.cos(VIEW_PITCH);
    const fog = this.scene.fog as THREE.Fog;
    const { near, far } = fog;
    const draw = (canvas: HTMLCanvasElement, at: { x: number; y: number; z: number } | undefined, distance: number) => {
      const ctx = canvas.getContext('2d');
      const w = Math.min(canvas.clientWidth, fullW);
      const h = Math.min(canvas.clientHeight, fullH);
      if (!ctx || w === 0 || h === 0) return;
      const bw = Math.round(w * ratio);
      const bh = Math.round(h * ratio);
      if (canvas.width !== bw) canvas.width = bw;
      if (canvas.height !== bh) canvas.height = bh;
      if (!at) {
        ctx.fillStyle = '#1b2430';
        ctx.fillRect(0, 0, bw, bh);
        return;
      }
      fog.near = distance * 2.5;
      fog.far = distance * 9 + 300;
      cam.aspect = w / h;
      cam.position.set(at.x + Math.sin(yaw) * cp * distance, at.y + Math.sin(VIEW_PITCH) * distance, at.z + Math.cos(yaw) * cp * distance);
      cam.lookAt(at.x, at.y, at.z);
      cam.updateProjectionMatrix();
      r.setViewport(0, 0, w, h);
      r.setScissor(0, 0, w, h);
      r.render(this.scene, cam);
      // The drawing buffer's origin is at the bottom left, the image's at the top left.
      ctx.drawImage(this.canvas, 0, bufferH - bh, bw, bh, 0, 0, bw, bh);
    };
    const ground = (p: { x: number; z: number }) => ({ x: p.x, y: this.world.map.heightAt(p.x, p.z) * HEIGHT_SCALE, z: p.z });
    r.setScissorTest(true);
    for (const [canvas, id] of vehicleViews) {
      // The lead unit as drawn this frame, else roughly where the vehicle is.
      const pick = this.trains.picks.find((q) => q.trainId === id);
      const p = this.viewPoints.get(id);
      draw(canvas, pick ? pick.pos : p && ground(p), VIEW_DISTANCE);
    }
    const w = this.world.map.width;
    for (const [canvas, tile] of placeViews) draw(canvas, ground({ x: (tile % w) + 0.5, z: Math.floor(tile / w) + 0.5 }), PLACE_VIEW_DISTANCE);
    r.setScissorTest(false);
    r.setViewport(0, 0, fullW, fullH);
    fog.near = near;
    fog.far = far;
  }

  /** Trees, houses and industries share materials, so one change covers every chunk. */
  private applyViewModes(): void {
    const { treeView, buildingView } = useApp.getState();
    applyViewMode(treeAssets.material, treeView, 0.3);
    applyViewMode(buildingMaterial, buildingView, 0.35);
  }

  private updateWrecks(): void {
    const tiles = useApp.getState().global?.wrecks ?? [];
    const key = tiles.join(',');
    if (key === this.wrecksKey) return;
    this.wrecksKey = key;
    const w = this.world.map.width;
    if (tiles.length) this.wrecks.show(tiles.map((t) => ({ x: t % w, y: Math.floor(t / w) })), '#ff5a1f');
    else this.wrecks.hide();
  }

  private updateReservations(): void {
    const show = useApp.getState().showReservations;
    const key = show ? `${this.world.signalsRev}` : 'off';
    if (key === this.reservationsRev) return;
    this.reservationsRev = key;
    if (!show) {
      this.reservations.hide();
      return;
    }
    const w = this.world.map.width;
    const pieces = this.world.reserved
      .filter((k) => k % 8 < 6)
      .map((k) => {
        const tile = Math.floor(k / 8);
        return { x: tile % w, y: Math.floor(tile / w), piece: (k % 8) as Piece };
      });
    if (pieces.length) this.reservations.show(pieces, '#ffffff');
    else this.reservations.hide();
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
    this.area.hide();
    switch (id) {
      case null:
        this.tool = null;
        break;
      case 'rail':
      case 'removeRail':
        this.tool = new RailTool(this.ghost, id === 'removeRail');
        break;
      case 'station':
        this.tool = new StationTool(this.area, this.catchment);
        break;
      case 'depot':
        this.tool = new DepotTool(this.area);
        break;
      case 'bulldoze':
        this.tool = new BulldozeTool(this.area);
        break;
      case 'convert':
        this.tool = new ConvertTool(this.area);
        break;
      case 'canal':
        this.tool = new CanalTool(this.area);
        break;
      case 'waypoint':
        this.tool = new WaypointTool(this.area);
        break;
      case 'headquarters':
        this.tool = new HeadquartersTool(this.area);
        break;
      case 'road':
      case 'removeRoad':
        this.tool = new RoadTool(this.area, id === 'removeRoad');
        break;
      case 'roadStop':
      case 'roadDepot':
      case 'oneWay':
      case 'airport':
      case 'lock':
      case 'dock':
      case 'shipDepot':
      case 'buoy':
        this.tool = new RoadPlaceTool(this.area, id, this.catchment);
        break;
      case 'orders':
        this.tool = new OrdersTool(this.area);
        break;
      case 'signal':
        this.tool = new SignalTool(this.ghost);
        break;
      case 'bridge':
        this.tool = new BridgeTool(this.area);
        break;
      case 'tunnel':
        this.tool = new TunnelTool(this.area);
        break;
      default:
        this.tool = new TerraformTool(id, this.cursor);
    }
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

  /** Show the catchment of the station picked in its window (unless a station-placing tool is using the overlay). */
  private showStationCatchment(): void {
    const s = useApp.getState();
    if (s.tool === 'station' || s.tool === 'roadStop' || s.tool === 'airport' || s.tool === 'dock') return;
    const st = s.catchmentFor !== null ? this.world.state.stations.get(s.catchmentFor) : undefined;
    if (!st) return this.catchment.hide();
    this.catchment.show(rectTiles(catchmentRect(this.world.map, st)), '#58a6ff');
  }

  /** Click with no tool: open the train, depot or station under the cursor. */
  private select(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    let best: number | null = null;
    let bestD = 22;
    const v = new THREE.Vector3();
    for (const p of this.trains.picks) {
      v.copy(p.pos).project(this.camera);
      if (v.z > 1) continue;
      const d = Math.hypot(rect.left + ((v.x + 1) / 2) * rect.width - clientX, rect.top + ((1 - v.y) / 2) * rect.height - clientY);
      if (d < bestD) {
        bestD = d;
        best = p.trainId;
      }
    }
    if (best !== null) return openWindow({ kind: 'train', id: best });
    const hit = this.pick(clientX, clientY);
    if (!hit) return;
    const map = this.world.map;
    const i = map.tileIndex(hit.tileX, hit.tileY);
    const type = map.layers.type[i];
    if (type === TileType.Depot) openWindow({ kind: 'depot', id: i });
    else if (type === TileType.RoadDepot) openWindow({ kind: 'roadDepot', id: i });
    else if (type === TileType.RoadStop) openWindow({ kind: 'station', id: map.layers.data[i]! });
    else if (type === TileType.Airport && map.layers.track[i] === AirportRole.Hangar) openWindow({ kind: 'hangar', id: i });
    else if (type === TileType.Airport) openWindow({ kind: 'station', id: map.layers.data[i]! });
    else if (type === TileType.Dock) openWindow({ kind: 'station', id: map.layers.data[i]! });
    else if (type === TileType.ShipDepot) openWindow({ kind: 'shipDepot', id: i });
    else if (type === TileType.Station) openWindow({ kind: 'station', id: map.layers.data[i]! });
    else if (type === TileType.Industry) openWindow({ kind: 'industry', id: map.layers.data[i]! });
    else if (type === TileType.Headquarters) {
      // Your own headquarters open your company; another company's, its books.
      const owner = map.layers.owner[i]!;
      const s = useApp.getState();
      const mine = s.global?.players.find((p) => p.id === s.room?.playerId)?.companyId === owner;
      openWindow(mine ? { kind: 'company', id: 0 } : { kind: 'finances', id: owner });
    }
    else if ((type === TileType.House || type === TileType.Road || type === TileType.Statue) && map.layers.town[i]) openWindow({ kind: 'town', id: map.layers.town[i]! - 1 });
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
    this.locateViews();
    this.trains.update(now, useApp.getState().global?.speed ?? 1, this.controller.target, this.controller.distance, new Set(this.viewPoints.keys()));
    this.followVehicle(now);
    // Ambient rumble: louder with more vehicles near the focus, and when zoomed in.
    const t = this.controller.target;
    let near = 0;
    for (const p of this.trains.picks) if (Math.abs(p.pos.x - t.x) < 24 && Math.abs(p.pos.z - t.z) < 24) near++;
    sound.setTraffic((Math.min(near, 12) / 12) * Math.min(1, Math.max(0.15, 30 / this.controller.distance)));
    this.signalLights.update();
    this.updateReservations();
    this.updateWrecks();
    this.industries.update(now);
    this.crossings.update(dt, now, this.controller.target);
    this.lineOverlay.update(this.controller.distance);
    const fog = this.scene.fog as THREE.Fog;
    fog.near = this.controller.distance * 2.5;
    fog.far = this.controller.distance * 9 + 300;
    this.chunks.update(this.camera, this.controller.target, this.controller.distance, [...this.viewPoints.values(), ...this.placePoints]);

    if (this.hoverDirty && this.tool) {
      this.hoverDirty = false;
      this.tool.onHover(
        this.lastPointer && !this.controller.isDragging ? this.pick(this.lastPointer.x, this.lastPointer.y) : null,
        this.mods,
      );
    }

    this.drawViews();
    this.renderer.render(this.scene, this.camera);
    this.labels.update(this.camera, this.canvas.clientWidth, this.canvas.clientHeight, this.controller.distance);
    this.floaters.update(this.camera, this.canvas.clientWidth, this.canvas.clientHeight);

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
    this.area.dispose();
    this.catchment.dispose();
    this.trains.dispose();
    this.signalLights.dispose();
    this.industries.dispose();
    this.floaters.dispose();
    this.crossings.dispose();
    this.lineOverlay.dispose();
    this.world.onIncome = null;
    if (client.resubscribe) client.resubscribe = null;
    this.renderer.dispose();
  }
}
