import {
  AirportRole,
  EDGE_DX,
  EDGE_DY,
  WATER_BUOY,
  WATER_CANAL,
  waterAxis,
  waterLevelAt,
  CHUNK_SIZE,
  EDGE_MID_X,
  EDGE_MID_Y,
  HEIGHT_SCALE,
  ROAD_EDGE_BITS,
  ROAD_ONE_WAY,
  ROAD_ONE_WAY_REVERSED,
  ROADSTOP_TRUCK,
  TileType,
  edgeHeight,
  houseType,
  type GameMap,
  type HouseType,
} from '@transportsim/shared';
import * as THREE from 'three';
import { GeoBuilder, lin } from './geoBuilder.ts';
import { WATER_Y, tileHash } from './terrainMesh.ts';

type Model = HouseType['model'];

interface ModelGeo {
  walls: THREE.BufferGeometry;
  roof: THREE.BufferGeometry;
}

const WHITE = lin('#ffffff');
const WINDOW = lin('#3a4552');

function windows(g: GeoBuilder, x0: number, x1: number, z: number, floors: number, floorH: number, base = 0.06): void {
  g.color(WINDOW);
  const cols = Math.max(1, Math.round((x1 - x0) / 0.16));
  const w = ((x1 - x0) / cols) * 0.45;
  for (let f = 0; f < floors; f++) {
    const y = base + f * floorH + floorH * 0.35;
    for (let c = 0; c < cols; c++) {
      const cx = x0 + ((c + 0.5) * (x1 - x0)) / cols;
      g.aabb(cx - w / 2, y, z - 0.008, cx + w / 2, y + floorH * 0.35, z + 0.008);
    }
  }
  g.color(WHITE);
}

/** Building models: walls (tinted per instance) and roofs (tinted separately). Front faces +Z. */
function makeModel(model: Model): ModelGeo {
  const w = new GeoBuilder().color(WHITE);
  const r = new GeoBuilder().color(WHITE);
  switch (model) {
    case 'cottage':
      w.aabb(-0.24, 0, -0.2, 0.24, 0.3, 0.2);
      windows(w, -0.2, 0.2, 0.2, 1, 0.24);
      r.gable(-0.24, -0.2, 0.24, 0.2, 0.3, 0.22);
      break;
    case 'terrace':
      w.aabb(-0.4, 0, -0.2, 0.4, 0.42, 0.2);
      windows(w, -0.36, 0.36, 0.2, 2, 0.18);
      r.gable(-0.4, -0.2, 0.4, 0.2, 0.42, 0.2);
      break;
    case 'shop':
      w.aabb(-0.32, 0, -0.28, 0.32, 0.36, 0.28);
      windows(w, -0.28, 0.28, 0.28, 1, 0.3, 0.02);
      r.aabb(-0.35, 0.36, -0.31, 0.35, 0.4, 0.31);
      r.aabb(-0.32, 0.2, 0.28, 0.32, 0.23, 0.38); // awning
      break;
    case 'townhouse':
      w.aabb(-0.3, 0, -0.26, 0.3, 0.72, 0.26);
      windows(w, -0.26, 0.26, 0.26, 3, 0.22);
      r.gable(-0.3, -0.26, 0.3, 0.26, 0.72, 0.24);
      break;
    case 'church':
      w.aabb(-0.2, 0, -0.36, 0.2, 0.42, 0.2);
      w.aabb(-0.12, 0, 0.2, 0.12, 0.95, 0.38); // tower
      r.gable(-0.36, -0.2, 0.2, 0.2, 0.42, 0.24);
      r.pyramid(0, 0.29, 0.13, 0.95, 0.42);
      break;
    case 'flats':
      w.aabb(-0.36, 0, -0.3, 0.36, 1.15, 0.3);
      windows(w, -0.32, 0.32, 0.3, 5, 0.21);
      r.aabb(-0.38, 1.15, -0.32, 0.38, 1.2, 0.32);
      break;
    case 'office':
      w.aabb(-0.34, 0, -0.34, 0.34, 1.9, 0.34);
      windows(w, -0.3, 0.3, 0.34, 8, 0.22);
      r.aabb(-0.36, 1.9, -0.36, 0.36, 1.96, 0.36);
      r.aabb(-0.1, 1.96, -0.1, 0.1, 2.12, 0.1);
      break;
  }
  return { walls: w.build()!, roof: r.build()! };
}

const MODELS: Record<Model, ModelGeo> = {
  cottage: makeModel('cottage'),
  terrace: makeModel('terrace'),
  shop: makeModel('shop'),
  townhouse: makeModel('townhouse'),
  church: makeModel('church'),
  flats: makeModel('flats'),
  office: makeModel('office'),
};

const WALLS = ['#eadfcb', '#d9c3a5', '#c98a64', '#b0603e', '#efe9df', '#c9cfd6', '#e3cf9a'].map(lin);
const ROOFS = ['#8c3b2e', '#6b4a3a', '#4a5a66', '#7b3f2a', '#3e4a52', '#5c6b3a'].map(lin);
const CHURCH_WALL = lin('#cfc6b4');
const CHURCH_ROOF = lin('#4a5560');
const MODERN_WALLS = ['#c9cfd6', '#b8c2cc', '#d6d0c4', '#9fb0bf'].map(lin);

export const buildingMaterial = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });

const tmp = new THREE.Object3D();
// Model front faces +Z; rotate it to face the road edge (N, E, S, W).
const FACE_ROT = [Math.PI, Math.PI / 2, 0, -Math.PI / 2];

/** Instanced houses for a chunk (one walls + one roof mesh per model in use). */
export function buildHouses(map: GameMap, cx: number, cy: number): THREE.InstancedMesh[] {
  const byModel = new Map<Model, number[]>();
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  for (let y = y0; y < y0 + CHUNK_SIZE; y++) {
    for (let x = x0; x < x0 + CHUNK_SIZE; x++) {
      const i = map.tileIndex(x, y);
      if (map.layers.type[i] !== TileType.House) continue;
      const m = houseType(map.layers.data[i]!).model;
      let list = byModel.get(m);
      if (!list) byModel.set(m, (list = []));
      list.push(i);
    }
  }
  const out: THREE.InstancedMesh[] = [];
  for (const [model, tiles] of byModel) {
    const geo = MODELS[model];
    const walls = new THREE.InstancedMesh(geo.walls, buildingMaterial, tiles.length);
    const roof = new THREE.InstancedMesh(geo.roof, buildingMaterial, tiles.length);
    tiles.forEach((i, k) => {
      const x = i % map.width;
      const y = (i - x) / map.width;
      const face = (map.layers.data[i]! >> 8) & 3;
      const h = tileHash(x, y, 7);
      tmp.position.set(x + 0.5, map.cornerHeight(x, y) * HEIGHT_SCALE, y + 0.5);
      tmp.rotation.set(0, FACE_ROT[face]!, 0);
      const s = 0.92 + h * 0.16;
      tmp.scale.set(s, 0.9 + tileHash(x, y, 9) * 0.25, s);
      tmp.updateMatrix();
      walls.setMatrixAt(k, tmp.matrix);
      roof.setMatrixAt(k, tmp.matrix);
      const modern = model === 'flats' || model === 'office';
      const wallPalette = modern ? MODERN_WALLS : WALLS;
      walls.setColorAt(k, model === 'church' ? CHURCH_WALL : wallPalette[Math.floor(h * wallPalette.length)]!);
      roof.setColorAt(k, model === 'church' ? CHURCH_ROOF : ROOFS[Math.floor(tileHash(x, y, 3) * ROOFS.length)]!);
    });
    for (const m of [walls, roof]) {
      m.instanceMatrix.needsUpdate = true;
      if (m.instanceColor) m.instanceColor.needsUpdate = true;
      m.computeBoundingSphere();
      out.push(m);
    }
  }
  return out;
}

const ASPHALT = lin('#53575c');
const PAVEMENT = lin('#9a958c');
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();

const MARKING = lin('#f2f2f2');
const STOP_ROOF = lin('#4a6a8a');
const STOP_YELLOW = lin('#e8c547');
const GARAGE = lin('#8d8a84');
const GARAGE_DOOR = lin('#2a2d31');
const ROOF_GREY = lin('#6c7178');

/** Road surfaces for a chunk (roads, road stops and depots; level crossings are drawn with the track). */
export function addRoads(g: GeoBuilder, map: GameMap, cx: number, cy: number): void {
  const x0 = cx * CHUNK_SIZE;
  const y0 = cy * CHUNK_SIZE;
  for (let y = y0; y < y0 + CHUNK_SIZE; y++) {
    for (let x = x0; x < x0 + CHUNK_SIZE; x++) {
      const i = map.tileIndex(x, y);
      const type = map.layers.type[i];
      if (type === TileType.RoadDepot) {
        addRoadDepot(g, map, x, y, map.layers.data[i]! & 3);
        continue;
      }
      if (type === TileType.Airport) {
        addAirportTile(g, map, x, y, map.layers.track[i]!);
        continue;
      }
      if (type === TileType.Water || type === TileType.Lock || type === TileType.ShipDepot || type === TileType.Dock) {
        addWaterworks(g, map, x, y, i);
        continue;
      }
      if (type !== TileType.Road && type !== TileType.RoadStop) continue;
      const bits = type === TileType.RoadStop ? map.layers.track[i]! & 0xf : map.layers.data[i]! & 0xf;
      const corners = map.tileCorners(x, y);
      const centre = ((corners[0] + corners[1] + corners[2] + corners[3]) / 4) * HEIGHT_SCALE + 0.01;
      _a.set(x + 0.5, centre, y + 0.5);
      const flat = map.isFlat(x, y);
      if (flat) g.color(PAVEMENT).box(_b.set(x + 0.5, centre - 0.002, y + 0.08), _a.clone().setZ(y + 0.92), 0.84, 0.018, false);
      for (let e = 0; e < 4; e++) {
        if (!(bits & ROAD_EDGE_BITS[e]!)) continue;
        const eh = Math.max(0, edgeHeight(corners, e as 0 | 1 | 2 | 3)) * HEIGHT_SCALE + 0.01;
        _b.set(x + EDGE_MID_X[e]!, eh, y + EDGE_MID_Y[e]!);
        g.color(ASPHALT).box(_a, _b, 0.56, 0.03, false);
      }
      if (flat) g.color(ASPHALT).box(_b.set(x + 0.5, centre, y + 0.22), _a.clone().setZ(y + 0.78), 0.56, 0.03, false);
      const data = map.layers.data[i]!;
      if (type === TileType.Road && data & ROAD_ONE_WAY) addOneWayArrow(g, x, y, centre + 0.022, bits, (data & ROAD_ONE_WAY_REVERSED) !== 0);
      if (type === TileType.RoadStop) addStopFurniture(g, x, y, centre, (bits & ROAD_EDGE_BITS[1]!) !== 0, (map.layers.track[i]! & ROADSTOP_TRUCK) !== 0);
    }
  }
}

/** A white arrow on the road surface pointing the way traffic flows. */
function addOneWayArrow(g: GeoBuilder, x: number, y: number, h: number, bits: number, reversed: boolean): void {
  const alongX = (bits & ROAD_EDGE_BITS[1]!) !== 0;
  const sign = reversed ? -1 : 1;
  const p = (along: number, across: number) =>
    alongX ? new THREE.Vector3(x + 0.5 + along * sign, h, y + 0.5 + across) : new THREE.Vector3(x + 0.5 + across, h, y + 0.5 + along * sign);
  g.color(MARKING);
  const tip = p(0.28, 0);
  const l = p(0.08, -0.1);
  const r = p(0.08, 0.1);
  g.tri(l, tip, r);
  g.tri(r, tip, l);
  g.box(p(-0.22, 0), p(0.1, 0), 0.05, 0.003, false);
}

/** Bus stop shelters (or truck loading bays) on both sides of a drive-through stop. */
function addStopFurniture(g: GeoBuilder, x: number, y: number, h: number, alongX: boolean, truck: boolean): void {
  for (const side of [-1, 1]) {
    const off = 0.4 * side;
    const [x0, z0, x1, z1] = alongX ? [x + 0.2, y + 0.5 + off - 0.07, x + 0.8, y + 0.5 + off + 0.07] : [x + 0.5 + off - 0.07, y + 0.2, x + 0.5 + off + 0.07, y + 0.8];
    if (truck) {
      g.color(STOP_YELLOW).aabb(x0, h, z0, x1, h + 0.08, z1); // loading bay edge
    } else {
      g.color(GARAGE_DOOR).aabb(x0, h, z0, x0 + 0.02, h + 0.26, z0 + 0.02);
      g.color(GARAGE_DOOR).aabb(x1 - 0.02, h, z1 - 0.02, x1, h + 0.26, z1);
      g.color(STOP_ROOF).aabb(x0 - 0.02, h + 0.26, z0 - 0.02, x1 + 0.02, h + 0.29, z1 + 0.02); // shelter roof
    }
  }
}

const RUNWAY = lin('#3d4045');
const TAXIWAY = lin('#5a5e63');
const CONCRETE = lin('#a8a59e');
const TAXI_LINE = lin('#e0b83a');
const TERMINAL = lin('#c9d3da');
const TERMINAL_GLASS = lin('#3b5770');
const HANGAR = lin('#7f8a93');

/** One airport tile, by its role (runway along the north row, gates and hangar along the south). */
function addAirportTile(g: GeoBuilder, map: GameMap, x: number, y: number, role: number): void {
  const h = map.cornerHeight(x, y) * HEIGHT_SCALE + 0.012;
  const isRole = (dx: number, r: number) => map.inBounds(x + dx, y) && map.layers.type[map.tileIndex(x + dx, y)] === TileType.Airport && map.layers.track[map.tileIndex(x + dx, y)] === r;
  switch (role) {
    case AirportRole.Runway: {
      g.color(RUNWAY).aabb(x, h - 0.01, y, x + 1, h, y + 1);
      g.color(MARKING);
      g.aabb(x, h, y + 0.08, x + 1, h + 0.003, y + 0.11); // edge lines
      g.aabb(x, h, y + 0.89, x + 1, h + 0.003, y + 0.92);
      g.aabb(x + 0.15, h, y + 0.48, x + 0.6, h + 0.003, y + 0.52); // centre dash
      // Threshold stripes at either end
      for (const end of [isRole(-1, AirportRole.Runway) ? null : x + 0.06, isRole(1, AirportRole.Runway) ? null : x + 0.82]) {
        if (end === null) continue;
        for (let k = 0; k < 5; k++) g.aabb(end, h, y + 0.18 + k * 0.14, end + 0.12, h + 0.003, y + 0.24 + k * 0.14);
      }
      break;
    }
    case AirportRole.Taxiway:
      g.color(TAXIWAY).aabb(x, h - 0.01, y, x + 1, h, y + 1);
      g.color(TAXI_LINE).aabb(x, h, y + 0.48, x + 1, h + 0.003, y + 0.52);
      break;
    case AirportRole.Apron:
      g.color(CONCRETE).aabb(x, h - 0.01, y, x + 1, h, y + 1);
      break;
    case AirportRole.Terminal: {
      g.color(CONCRETE).aabb(x, h - 0.01, y, x + 1, h, y + 1);
      g.color(TAXI_LINE).aabb(x + 0.48, h, y, x + 0.52, h + 0.003, y + 0.5); // stand line
      g.color(TERMINAL).aabb(x, h, y + 0.66, x + 1, h + 0.3, y + 0.98);
      g.color(TERMINAL_GLASS).aabb(x + 0.04, h + 0.08, y + 0.655, x + 0.96, h + 0.24, y + 0.66);
      g.color(ROOF_GREY).aabb(x - 0.005, h + 0.3, y + 0.64, x + 1.005, h + 0.33, y + 0.99);
      g.color(TERMINAL).aabb(x + 0.62, h + 0.1, y + 0.45, x + 0.7, h + 0.19, y + 0.66); // jet bridge
      break;
    }
    case AirportRole.Hangar: {
      g.color(CONCRETE).aabb(x, h - 0.01, y, x + 1, h, y + 1);
      g.color(HANGAR).aabb(x + 0.06, h, y + 0.3, x + 0.94, h + 0.34, y + 0.96);
      g.color(STOP_ROOF).gable(x + 0.06, y + 0.3, x + 0.94, y + 0.96, h + 0.34, 0.12, 0.03, false);
      g.color(GARAGE_DOOR).aabb(x + 0.14, h, y + 0.296, x + 0.86, h + 0.28, y + 0.3);
      break;
    }
  }
}

const STONE = lin('#8f8a80');
const TIMBER_DECK = lin('#7b5a3c');
const GATE = lin('#3b2f26');
const BUOY_RED = lin('#c8352b');
const SHED = lin('#6f7f8c');

/** Canal banks, locks, ship depots, docks and buoys. */
function addWaterworks(g: GeoBuilder, map: GameMap, x: number, y: number, i: number): void {
  const type = map.layers.type[i];
  const data = map.layers.data[i]!;
  const level = waterLevelAt(map, x, y);
  const surface = level * HEIGHT_SCALE + WATER_Y;
  const isWet = (tx: number, ty: number) => {
    if (!map.inBounds(tx, ty)) return true;
    const t = map.layers.type[map.tileIndex(tx, ty)];
    return t === TileType.Water || t === TileType.Lock || t === TileType.ShipDepot;
  };
  if (type === TileType.Water) {
    // Stone banks where a canal meets land.
    if (data & WATER_CANAL) {
      const base = map.tileMinHeight(x, y) * HEIGHT_SCALE - 0.02;
      const top = surface + 0.05;
      g.color(STONE);
      if (!isWet(x, y - 1)) g.aabb(x, base, y, x + 1, top, y + 0.06);
      if (!isWet(x, y + 1)) g.aabb(x, base, y + 0.94, x + 1, top, y + 1);
      if (!isWet(x - 1, y)) g.aabb(x, base, y, x + 0.06, top, y + 1);
      if (!isWet(x + 1, y)) g.aabb(x + 0.94, base, y, x + 1, top, y + 1);
    }
    if (data & WATER_BUOY) {
      g.color(BUOY_RED).cylinderY(x + 0.5, y + 0.5, surface - 0.03, surface + 0.12, 0.07, 8);
      g.color(MARKING).cylinderY(x + 0.5, y + 0.5, surface + 0.12, surface + 0.16, 0.05, 8);
      g.color(BUOY_RED).cylinderY(x + 0.5, y + 0.5, surface + 0.16, surface + 0.24, 0.025, 6);
    }
    return;
  }
  if (type === TileType.Lock) {
    const alongX = waterAxis(map, i) === 0;
    const top = map.tileMaxHeight(x, y) * HEIGHT_SCALE + WATER_Y + 0.08;
    const base = map.tileMinHeight(x, y) * HEIGHT_SCALE - 0.02;
    g.color(STONE);
    if (alongX) {
      g.aabb(x, base, y, x + 1, top, y + 0.12);
      g.aabb(x, base, y + 0.88, x + 1, top, y + 1);
    } else {
      g.aabb(x, base, y, x + 0.12, top, y + 1);
      g.aabb(x + 0.88, base, y, x + 1, top, y + 1);
    }
    // Gates at both ends and in the middle.
    g.color(GATE);
    for (const f of [0.03, 0.5, 0.97]) {
      const [nw, ne, , sw] = map.tileCorners(x, y);
      const far = alongX ? ne : sw;
      const h = (nw + (far - nw) * f) * HEIGHT_SCALE;
      if (alongX) g.aabb(x + f - 0.03, h - 0.05, y + 0.12, x + f + 0.03, Math.max(h, nw * HEIGHT_SCALE, far * HEIGHT_SCALE) + WATER_Y + 0.06, y + 0.88);
      else g.aabb(x + 0.12, h - 0.05, y + f - 0.03, x + 0.88, Math.max(h, nw * HEIGHT_SCALE, far * HEIGHT_SCALE) + WATER_Y + 0.06, y + f + 0.03);
    }
    return;
  }
  if (type === TileType.ShipDepot) {
    // An open-ended boat shed over the water, lengthways along its axis.
    const alongX = waterAxis(map, i) === 0;
    const roof = surface + 0.45;
    g.color(SHED);
    if (alongX) {
      g.aabb(x + 0.04, surface - 0.05, y + 0.08, x + 0.96, roof, y + 0.14);
      g.aabb(x + 0.04, surface - 0.05, y + 0.86, x + 0.96, roof, y + 0.92);
    } else {
      g.aabb(x + 0.08, surface - 0.05, y + 0.04, x + 0.14, roof, y + 0.96);
      g.aabb(x + 0.86, surface - 0.05, y + 0.04, x + 0.92, roof, y + 0.96);
    }
    g.color(STOP_ROOF).gable(x + 0.04, y + 0.04, x + 0.96, y + 0.96, roof, 0.16, 0.05, !alongX);
    return;
  }
  // Dock: a timber deck over the shore, reaching out over its berth, with a crane.
  const edge = map.layers.track[i]! & 3;
  const deck = map.tileMaxHeight(x, y) * HEIGHT_SCALE + 0.05;
  const berthLevel = map.tileMinHeight(x, y) * HEIGHT_SCALE + WATER_Y;
  const ex = EDGE_DX[edge as 0]!;
  const ey = EDGE_DY[edge as 0]!;
  const reach = 0.3;
  const x0 = Math.min(x, x + ex * reach);
  const x1 = Math.max(x + 1, x + 1 + ex * reach);
  const z0 = Math.min(y, y + ey * reach);
  const z1 = Math.max(y + 1, y + 1 + ey * reach);
  g.color(TIMBER_DECK).aabb(x0, deck - 0.04, z0, x1, deck, z1);
  g.color(GATE);
  for (const [px, pz] of [
    [x0 + 0.05, z0 + 0.05],
    [x1 - 0.05, z0 + 0.05],
    [x0 + 0.05, z1 - 0.05],
    [x1 - 0.05, z1 - 0.05],
  ] as const) {
    g.aabb(px - 0.025, berthLevel - 0.2, pz - 0.025, px + 0.025, deck - 0.04, pz + 0.025);
  }
  // Warehouse at the back, crane at the front.
  const bx = x + 0.5 - ex * 0.25;
  const bz = y + 0.5 - ey * 0.25;
  g.color(GARAGE).aabb(bx - 0.22, deck, bz - 0.22, bx + 0.22, deck + 0.24, bz + 0.22);
  g.color(STOP_ROOF).gable(bx - 0.24, bz - 0.24, bx + 0.24, bz + 0.24, deck + 0.24, 0.09, 0.02, ex !== 0);
  const cx = x + 0.5 + ex * 0.3;
  const cz = y + 0.5 + ey * 0.3;
  g.color(STOP_YELLOW).aabb(cx - 0.03, deck, cz - 0.03, cx + 0.03, deck + 0.42, cz + 0.03);
  g.color(STOP_YELLOW).aabb(Math.min(cx, cx + ex * 0.35) - 0.02, deck + 0.4, Math.min(cz, cz + ey * 0.35) - 0.02, Math.max(cx, cx + ex * 0.35) + 0.02, deck + 0.44, Math.max(cz, cz + ey * 0.35) + 0.02);
}

/** A garage with its door to the road at `exit`. */
function addRoadDepot(g: GeoBuilder, map: GameMap, x: number, y: number, exit: number): void {
  const h = map.cornerHeight(x, y) * HEIGHT_SCALE;
  const m = 0.1;
  g.color(GARAGE).aabb(x + m, h, y + m, x + 1 - m, h + 0.42, y + 1 - m);
  g.color(STOP_ROOF).gable(x + m, y + m, x + 1 - m, y + 1 - m, h + 0.42, 0.14, 0.04, exit === 1 || exit === 3);
  const d = 0.004;
  g.color(GARAGE_DOOR);
  if (exit === 0) g.aabb(x + 0.25, h, y + m - d, x + 0.75, h + 0.32, y + m);
  else if (exit === 2) g.aabb(x + 0.25, h, y + 1 - m, x + 0.75, h + 0.32, y + 1 - m + d);
  else if (exit === 1) g.aabb(x + 1 - m, h, y + 0.25, x + 1 - m + d, h + 0.32, y + 0.75);
  else g.aabb(x + m - d, h, y + 0.25, x + m, h + 0.32, y + 0.75);
  // Apron to the road
  const ex = x + EDGE_MID_X[exit]!;
  const ez = y + EDGE_MID_Y[exit]!;
  g.color(ASPHALT).box(_a.set(x + 0.5 + (ex - x - 0.5) * 0.75, h + 0.01, y + 0.5 + (ez - y - 0.5) * 0.75), _b.set(ex, h + 0.01, ez), 0.5, 0.03, false);
}
