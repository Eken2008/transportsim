import {
  COMPANY_COLORS,
  HEIGHT_SCALE,
  KMH_PER_TILE_PER_S,
  UNIT_GAP,
  isSpanTd,
  pieceLength,
  railVehicle,
  roadSegPoint,
  rsLength,
  segHeights,
  segLength,
  segPoint,
  segTd,
  segTile,
  spanOver,
  tdPiece,
  type GameMap,
  type TrainMotion,
  type UnitModel,
} from '@transportsim/shared';
import * as THREE from 'three';
import type { ClientWorld } from '../game/clientWorld.ts';
import { UNIT_MODELS } from './trainModels.ts';
import { TRACK_LIFT, curveParamAt, curvePoint, type TrackCurves } from './trackCurves.ts';
import { WATER_Y } from './terrainMesh.ts';

/** Height of the rail head above the terrain surface. */
const RAIL_TOP = 0.088;
/** World units per tile of aircraft height. */
const AIR_HEIGHT = 0.9;
/** Don't extrapolate further than this past the last update (seconds). */
const MAX_EXTRAPOLATION = 0.6;

const _f = new THREE.Vector3();
const _b = new THREE.Vector3();
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _s = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

let curves: TrackCurves | null = null;

/** World position at distance `d` along a segment (tiles), on top of the rails. */
function segWorld(map: GameMap, s: number, d: number, out: THREE.Vector3): void {
  const tile = segTile(s);
  const td = segTd(s);
  if (curves && !isSpanTd(td)) {
    const c = curves.get(tile, td >> 1);
    const f = Math.min(1, Math.max(0, d / pieceLength(tdPiece(td))));
    curvePoint(c, curveParamAt(c, td & 1 ? 1 - f : f), out);
    out.y += RAIL_TOP - TRACK_LIFT;
    return;
  }
  const [ha, hb] = segHeights(map, tile, td);
  const t = d / pieceLength(tdPiece(td));
  const p = segPoint(map, s, d);
  out.set(p.x, (ha + (hb - ha) * t) * HEIGHT_SCALE + RAIL_TOP, p.y);
}

/**
 * Point `back` tiles behind the head (segs head-first, head at `pos`). Returns the segment it
 * lies on, or -1 if that part of the train is still inside a depot.
 */
function pointBehind(map: GameMap, segs: readonly number[], pos: number, back: number, out: THREE.Vector3): number {
  if (back <= pos) {
    segWorld(map, segs[0]!, pos - back, out);
    return segs[0]!;
  }
  let rest = back - pos;
  for (let i = 1; i < segs.length; i++) {
    const len = segLength(segs[i]!);
    if (rest <= len) {
      segWorld(map, segs[i]!, len - rest, out);
      return segs[i]!;
    }
    rest -= len;
  }
  return -1;
}

/** Units inside a tunnel aren't drawn. */
function inTunnel(map: GameMap, s: number): boolean {
  const td = segTd(s);
  return isSpanTd(td) && spanOver(map, segTile(s), td < 14 ? 0 : 1)?.kind === 'tunnel';
}

interface ModelMeshes {
  body: THREE.InstancedMesh;
  detail: THREE.InstancedMesh;
  count: number;
}

export interface UnitPick {
  trainId: number;
  pos: THREE.Vector3;
}

/** Draws every visible train unit with instancing, extrapolating motion between updates. */
export class TrainRenderer {
  readonly root = new THREE.Group();
  /** Unit centres from the last frame, for click picking. */
  readonly picks: UnitPick[] = [];
  private meshes = new Map<UnitModel, ModelMeshes>();
  private readonly bodyMat = new THREE.MeshLambertMaterial({ flatShading: true });
  private readonly detailMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
  private readonly colors = COMPANY_COLORS.map((c) => new THREE.Color(c));
  private segs: number[] = [];

  constructor(
    private readonly world: ClientWorld,
    trackCurves?: TrackCurves,
  ) {
    curves = trackCurves ?? null;
  }

  private meshesFor(model: UnitModel, need: number): ModelMeshes {
    let m = this.meshes.get(model);
    if (!m || m.body.instanceMatrix.count < need) {
      const cap = Math.max(16, need * 2);
      if (m) {
        this.root.remove(m.body, m.detail);
        m.body.dispose();
        m.detail.dispose();
      }
      const geo = UNIT_MODELS[model];
      const body = new THREE.InstancedMesh(geo.body, this.bodyMat, cap);
      const detail = new THREE.InstancedMesh(geo.detail, this.detailMat, cap);
      body.setColorAt(0, new THREE.Color());
      for (const mesh of [body, detail]) {
        mesh.frustumCulled = false;
        mesh.count = 0;
        this.root.add(mesh);
      }
      m = { body, detail, count: 0 };
      this.meshes.set(model, m);
    }
    return m;
  }

  update(now: number, speedMultiplier: number): void {
    const map = this.world.map;
    for (const m of this.meshes.values()) m.count = 0;
    this.picks.length = 0;

    for (const [id, { m, at }] of this.world.motions) {
      const info = this.world.trains.get(id);
      const dt = Math.min(MAX_EXTRAPOLATION, (now - at) / 1000);
      if (info && m.air) {
        this.placeAircraft(id, info.owner, info.units[0]!.type, m.air, dt, speedMultiplier);
        continue;
      }
      if (info && m.ship) {
        this.placeShip(id, info.owner, info.units[0]!.type, m.ship, dt, speedMultiplier);
        continue;
      }
      if (!info || m.path.length === 0) continue;
      if (info.mode === 'road') {
        this.placeRoadVehicle(id, info.owner, info.units[0]!.type, m, dt, speedMultiplier);
        continue;
      }
      let pos = m.pos + (m.speed / KMH_PER_TILE_PER_S) * speedMultiplier * dt;
      const segs = this.segs;
      segs.length = 0;
      segs.push(...m.path);
      let ai = 0;
      while (pos > segLength(segs[0]!) && ai < m.ahead.length) {
        pos -= segLength(segs[0]!);
        segs.unshift(m.ahead[ai++]!);
      }
      pos = Math.min(pos, segLength(segs[0]!));

      const company = this.world.state.companies.get(info.owner);
      const color = this.colors[(company?.color ?? 0) % this.colors.length]!;
      let offset = 0;
      for (const unit of info.units) {
        const v = railVehicle(unit.type);
        if (!v) continue;
        const len = v.length / 16;
        const sf = pointBehind(map, segs, pos, offset, _f);
        const sb = pointBehind(map, segs, pos, offset + len, _b);
        offset += len + UNIT_GAP;
        if (sf < 0 || sb < 0) continue;
        if (inTunnel(map, sf) && inTunnel(map, sb)) continue;
        const mm = this.meshesFor(v.model, 1);
        const k = mm.count;
        if (k >= mm.body.instanceMatrix.count) continue; // grows next frame
        _x.subVectors(_f, _b).normalize();
        _z.crossVectors(_x, UP).normalize();
        _y.crossVectors(_z, _x);
        _m.makeBasis(_x, _y, _z);
        _m.multiply(_s.makeScale(len, 1, 1));
        _m.setPosition((_f.x + _b.x) / 2, (_f.y + _b.y) / 2, (_f.z + _b.z) / 2);
        mm.body.setMatrixAt(k, _m);
        mm.detail.setMatrixAt(k, _m);
        mm.body.setColorAt(k, color);
        mm.count++;
        this.picks.push({ trainId: id, pos: new THREE.Vector3((_f.x + _b.x) / 2, (_f.y + _b.y) / 2 + 0.15, (_f.z + _b.z) / 2) });
      }
    }

    for (const [model, mm] of this.meshes) {
      // Grow if we ran out of instances this frame.
      if (mm.count >= mm.body.instanceMatrix.count) this.meshesFor(model, mm.count + 1);
      mm.body.count = mm.count;
      mm.detail.count = mm.count;
      mm.body.instanceMatrix.needsUpdate = true;
      mm.detail.instanceMatrix.needsUpdate = true;
      if (mm.body.instanceColor) mm.body.instanceColor.needsUpdate = true;
    }
  }

  /** A bus or truck: along its road segments, in its lane, following the ground. */
  private placeRoadVehicle(id: number, owner: number, type: string, m: TrainMotion, dt: number, speedMultiplier: number): void {
    const map = this.world.map;
    const v = railVehicle(type);
    if (!v) return;
    const segs = this.segs;
    segs.length = 0;
    segs.push(...m.path);
    let pos = m.pos + (m.speed / KMH_PER_TILE_PER_S) * speedMultiplier * dt;
    let ai = 0;
    while (pos > rsLength(segs[0]!) && ai < m.ahead.length) {
      pos -= rsLength(segs[0]!);
      segs.unshift(m.ahead[ai++]!);
    }
    pos = Math.min(pos, rsLength(segs[0]!));
    const len = v.length / 16;
    const at = (back: number, out: THREE.Vector3) => {
      let d = pos - back;
      let k = 0;
      while (d < 0 && k < segs.length - 1) d += rsLength(segs[++k]!);
      const p = roadSegPoint(map, segs[k]!, Math.max(0, d));
      return out.set(p.x, map.heightAt(p.x, p.y) * HEIGHT_SCALE + 0.03, p.y);
    };
    at(0, _f);
    at(len, _b);
    const company = this.world.state.companies.get(owner);
    const color = this.colors[(company?.color ?? 0) % this.colors.length]!;
    const mm = this.meshesFor(v.model, 1);
    const k = mm.count;
    if (k >= mm.body.instanceMatrix.count) return;
    _x.subVectors(_f, _b);
    if (_x.lengthSq() < 1e-8) _x.set(1, 0, 0);
    _x.normalize();
    _z.crossVectors(_x, UP).normalize();
    _y.crossVectors(_z, _x);
    _m.makeBasis(_x, _y, _z);
    _m.multiply(_s.makeScale(len, 1, 1));
    _m.setPosition((_f.x + _b.x) / 2, (_f.y + _b.y) / 2, (_f.z + _b.z) / 2);
    mm.body.setMatrixAt(k, _m);
    mm.detail.setMatrixAt(k, _m);
    mm.body.setColorAt(k, color);
    mm.count++;
    this.picks.push({ trainId: id, pos: new THREE.Vector3((_f.x + _b.x) / 2, (_f.y + _b.y) / 2 + 0.1, (_f.z + _b.z) / 2) });
  }

  /** An aircraft: at its position, height above the ground and heading, climbing or descending. */
  private placeAircraft(id: number, owner: number, type: string, air: NonNullable<TrainMotion['air']>, dt: number, speedMultiplier: number): void {
    const map = this.world.map;
    const v = railVehicle(type);
    if (!v) return;
    const [x0, y0, z, heading, speed] = air;
    const step = speed * speedMultiplier * dt;
    const x = Math.max(0, Math.min(map.width - 0.01, x0 + Math.cos(heading) * step));
    const y = Math.max(0, Math.min(map.height - 0.01, y0 + Math.sin(heading) * step));
    const ground = map.heightAt(x, y) * HEIGHT_SCALE + 0.02;
    const len = (v.length / 16) * 0.85;
    const company = this.world.state.companies.get(owner);
    const color = this.colors[(company?.color ?? 0) % this.colors.length]!;
    const mm = this.meshesFor(v.model, 1);
    const k = mm.count;
    if (k >= mm.body.instanceMatrix.count) return;
    _x.set(Math.cos(heading), 0, Math.sin(heading));
    _z.crossVectors(_x, UP).normalize();
    _y.crossVectors(_z, _x);
    _m.makeBasis(_x, _y, _z);
    _m.multiply(_s.makeScale(len, len, len));
    _m.setPosition(x, ground + z * AIR_HEIGHT, y);
    mm.body.setMatrixAt(k, _m);
    mm.detail.setMatrixAt(k, _m);
    mm.body.setColorAt(k, color);
    mm.count++;
    this.picks.push({ trainId: id, pos: new THREE.Vector3(x, ground + z * AIR_HEIGHT + 0.1, y) });
  }

  /** A ship: on the water surface at its level, heading where it sails. */
  private placeShip(id: number, owner: number, type: string, ship: NonNullable<TrainMotion['ship']>, dt: number, speedMultiplier: number): void {
    const map = this.world.map;
    const v = railVehicle(type);
    if (!v) return;
    const [x0, y0, level, heading, speed] = ship;
    const step = Math.min(0.5, speed * speedMultiplier * dt);
    const x = Math.max(0, Math.min(map.width - 0.01, x0 + Math.cos(heading) * step));
    const y = Math.max(0, Math.min(map.height - 0.01, y0 + Math.sin(heading) * step));
    const len = (v.length / 16) * 0.9;
    const company = this.world.state.companies.get(owner);
    const color = this.colors[(company?.color ?? 0) % this.colors.length]!;
    const mm = this.meshesFor(v.model, 1);
    const k = mm.count;
    if (k >= mm.body.instanceMatrix.count) return;
    _x.set(Math.cos(heading), 0, Math.sin(heading));
    _z.crossVectors(_x, UP).normalize();
    _y.crossVectors(_z, _x);
    _m.makeBasis(_x, _y, _z);
    _m.multiply(_s.makeScale(len, len, len));
    const surface = level * HEIGHT_SCALE + WATER_Y - 0.03;
    _m.setPosition(x, surface, y);
    mm.body.setMatrixAt(k, _m);
    mm.detail.setMatrixAt(k, _m);
    mm.body.setColorAt(k, color);
    mm.count++;
    this.picks.push({ trainId: id, pos: new THREE.Vector3(x, surface + 0.15, y) });
  }

  dispose(): void {
    for (const m of this.meshes.values()) {
      m.body.dispose();
      m.detail.dispose();
    }
    this.bodyMat.dispose();
    this.detailMat.dispose();
  }
}
