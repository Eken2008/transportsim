import { CHUNK_SIZE, HEIGHT_SCALE, industryType, type Industry, type IndustryModel } from '@transportsim/shared';
import * as THREE from 'three';
import type { ClientWorld } from '../game/clientWorld.ts';
import { buildingMaterial } from './buildings.ts';
import { GeoBuilder, lin } from './geoBuilder.ts';

const C = {
  gravel: lin('#7d7a74'),
  soil: lin('#6b5a43'),
  forestFloor: lin('#3f5a2c'),
  pine: lin('#2f5d34'),
  trunk: lin('#5b4129'),
  pasture: lin('#7fae55'),
  barn: lin('#9c3b2e'),
  roofDark: lin('#3d4148'),
  concrete: lin('#a9a59d'),
  brick: lin('#9a5a43'),
  metal: lin('#6f7780'),
  rust: lin('#8a4b2e'),
  white: lin('#e6e3dc'),
  sand: lin('#c9b38a'),
  black: lin('#232527'),
  timber: lin('#8b6239'),
  silo: lin('#c8c4ba'),
  tank: lin('#d8d6cf'),
  jungle: lin('#2f7a2c'),
  jungleFloor: lin('#4c6b2e'),
  gold: lin('#c9a640'),
  copper: lin('#b0683a'),
  kimberlite: lin('#5d6670'),
  paper: lin('#ece6d4'),
  rubberTree: lin('#3f7d36'),
  orchard: lin('#5f9a3a'),
  fruit: lin('#f2a03d'),
  water: lin('#4f9fc4'),
  dryEarth: lin('#b89a68'),
} as const;

/** Spoil heap colour of a mine, by what it digs. */
const SPOIL: Record<string, THREE.Color> = { iron_mine: C.rust, gold_mine: C.gold, copper_mine: C.copper, diamond_mine: C.kimberlite };

const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

/** A four-sided cone (low-poly tree or spoil heap). */
function cone(g: GeoBuilder, x: number, z: number, y0: number, h: number, r: number): void {
  const top = v(x, y0 + h, z);
  const p = [v(x - r, y0, z - r), v(x + r, y0, z - r), v(x + r, y0, z + r), v(x - r, y0, z + r)];
  for (let i = 0; i < 4; i++) g.tri(p[i]!, top, p[(i + 1) % 4]!);
}

/** Ground pad over the footprint. */
function pad(g: GeoBuilder, ind: Industry, y: number, color: THREE.Color): void {
  g.color(color).aabb(ind.x + 0.05, y, ind.y + 0.05, ind.x + ind.w - 0.05, y + 0.02, ind.y + ind.h - 0.05);
}

function shed(g: GeoBuilder, x0: number, z0: number, x1: number, z1: number, y: number, h: number, wall: THREE.Color, roof: THREE.Color): void {
  g.color(wall).aabb(x0, y, z0, x1, y + h, z1);
  g.color(roof).gable(x0, z0, x1, z1, y + h, Math.min(0.25, (z1 - z0) * 0.35));
}

function build(g: GeoBuilder, ind: Industry, model: IndustryModel, y: number): void {
  const { x, y: z, w, h } = ind;
  const cx = x + w / 2;
  const cz = z + h / 2;
  const top = y + 0.02;
  switch (model) {
    case 'mine': {
      pad(g, ind, y, C.gravel);
      // Headframe over the shaft, winding house, spoil heap
      g.color(C.rust);
      for (const [dx, dz] of [[-0.2, -0.2], [0.2, -0.2], [-0.2, 0.2], [0.2, 0.2]] as const) g.aabb(cx + dx - 0.03, top, cz + dz - 0.03, cx + dx + 0.03, top + 1.1, cz + dz + 0.03);
      g.color(C.black).cylinderX(cx - 0.3, cx + 0.3, top + 1.15, cz, 0.12, 8);
      shed(g, x + 0.2, z + 0.2, x + 1.3, z + 1.0, top, 0.45, C.brick, C.roofDark);
      g.color(SPOIL[ind.type] ?? C.black);
      cone(g, x + w - 0.8, z + h - 0.8, top, 0.6, 0.6);
      break;
    }
    case 'forest': {
      const tropical = ind.type === 'lumber_camp';
      pad(g, ind, y, tropical ? C.jungleFloor : C.forestFloor);
      for (let i = 0; i < w * h * 3; i++) {
        const tx = x + 0.25 + ((i * 0.618) % 1) * (w - 0.5);
        const tz = z + 0.25 + ((i * 0.377 + 0.13) % 1) * (h - 0.5);
        const s = 0.7 + ((i * 0.29) % 1) * 0.5;
        g.color(C.trunk).aabb(tx - 0.02, top, tz - 0.02, tx + 0.02, top + 0.12 * s, tz + 0.02);
        g.color(tropical ? C.jungle : C.pine);
        cone(g, tx, tz, top + 0.08 * s, 0.55 * s, 0.17 * s);
      }
      // Log pile by the track side
      g.color(C.timber).cylinderX(x + 0.3, x + 1.3, top + 0.08, z + h - 0.3, 0.08, 6);
      break;
    }
    case 'farm': {
      // Farmstead (the fields lie around it): a yard with barn, silos and farmhouse, and a
      // fenced paddock with cattle.
      const px = x + w * 0.55;
      g.color(C.soil).aabb(x + 0.05, y, z + 0.05, px, y + 0.02, z + h - 0.05);
      g.color(C.pasture).aabb(px, y, z + 0.05, x + w - 0.05, y + 0.02, z + h - 0.05);
      shed(g, x + 0.2, z + 0.25, x + 1.5, z + 1.25, top, 0.42, C.barn, C.roofDark);
      g.color(C.silo);
      for (const k of [0, 1]) g.cylinderY(x + 0.45 + k * 0.42, z + 1.65, top, top + 0.85, 0.17, 10);
      g.color(C.roofDark);
      for (const k of [0, 1]) g.pyramid(x + 0.45 + k * 0.42, z + 1.65, 0.13, top + 0.85, 0.12);
      shed(g, x + 1.15, z + h - 0.9, x + 2.0, z + h - 0.3, top, 0.32, C.white, C.brick); // farmhouse
      g.color(C.timber);
      const fx0 = px + 0.1, fx1 = x + w - 0.15, fz0 = z + 0.15, fz1 = z + h - 0.15;
      for (const fz of [fz0, fz1]) g.aabb(fx0, top + 0.06, fz - 0.01, fx1, top + 0.08, fz + 0.01);
      for (const fx of [fx0, fx1]) g.aabb(fx - 0.01, top + 0.06, fz0, fx + 0.01, top + 0.08, fz1);
      for (let k = 0; k <= 6; k++) {
        const t = fx0 + ((fx1 - fx0) * k) / 6;
        for (const fz of [fz0, fz1]) g.aabb(t - 0.012, top, fz - 0.012, t + 0.012, top + 0.1, fz + 0.012);
      }
      // Cattle only where the farm keeps livestock.
      const herd = industryType(ind.type)?.produces.includes('livestock') ? 5 : 0;
      for (const [cx2, cz2, white] of ([[0.3, 0.6, true], [0.65, 1.3, false], [0.4, 2.1, true], [1.05, 1.9, false], [1.15, 0.8, true]] as const).slice(0, herd)) {
        const ax = px + cx2, az = z + cz2;
        g.color(white ? C.white : C.barn).aabb(ax - 0.1, top + 0.05, az - 0.045, ax + 0.1, top + 0.13, az + 0.045);
        g.color(C.black).aabb(ax + 0.1, top + 0.08, az - 0.03, ax + 0.15, top + 0.14, az + 0.03); // head
        g.color(C.black);
        for (const lx of [-0.07, 0.07]) for (const lz of [-0.03, 0.03]) g.aabb(ax + lx - 0.012, top, az + lz - 0.012, ax + lx + 0.012, top + 0.05, az + lz + 0.012);
      }
      break;
    }
    case 'oilwells': {
      pad(g, ind, y, C.sand);
      for (const [dx, dz] of [[0.7, 0.7], [2.2, 0.8], [1.4, 2.1], [2.4, 2.3]] as const) {
        if (dx > w || dz > h) continue;
        g.color(C.black).aabb(x + dx - 0.04, top, z + dz - 0.04, x + dx + 0.04, top + 0.35, z + dz + 0.04);
        g.color(C.black).aabb(x + dx - 0.3, top + 0.33, z + dz - 0.03, x + dx + 0.25, top + 0.39, z + dz + 0.03);
        g.color(C.rust).aabb(x + dx - 0.36, top + 0.2, z + dz - 0.06, x + dx - 0.26, top + 0.38, z + dz + 0.06);
      }
      g.color(C.tank).cylinderY(x + 0.6, z + h - 0.6, top, top + 0.4, 0.3, 10);
      break;
    }
    case 'mill': {
      pad(g, ind, y, C.concrete);
      shed(g, x + 0.2, z + 0.2, x + w - 1.2, z + h - 0.3, top, 0.8, C.metal, C.roofDark);
      g.color(C.rust).cylinderY(x + w - 0.7, z + 0.9, top, top + 1.3, 0.35, 10); // blast furnace
      g.color(C.brick);
      for (const k of [0, 1, 2]) g.cylinderY(x + 0.6 + k * 0.6, z + h - 0.4, top, top + 1.8, 0.09, 8);
      break;
    }
    case 'factory': {
      pad(g, ind, y, C.concrete);
      g.color(C.brick).aabb(x + 0.2, top, z + 0.3, x + w - 0.2, top + 0.6, z + h - 0.3);
      // Saw-tooth roof
      g.color(C.roofDark);
      for (let k = 0; k < 4; k++) {
        const x0 = x + 0.2 + (k * (w - 0.4)) / 4;
        const x1 = x0 + (w - 0.4) / 4;
        g.quad(v(x0, top + 0.6, z + 0.3), v(x0, top + 0.6, z + h - 0.3), v(x1, top + 0.85, z + h - 0.3), v(x1, top + 0.85, z + 0.3));
        g.quad(v(x1, top + 0.85, z + 0.3), v(x1, top + 0.85, z + h - 0.3), v(x1, top + 0.6, z + h - 0.3), v(x1, top + 0.6, z + 0.3));
      }
      g.color(C.brick).cylinderY(x + w - 0.5, z + 0.4, top, top + 1.6, 0.1, 8);
      break;
    }
    case 'sawmill': {
      pad(g, ind, y, C.soil);
      shed(g, x + 0.2, z + 0.2, x + 1.8, z + h - 0.2, top, 0.45, C.timber, C.roofDark);
      g.color(C.timber);
      for (let k = 0; k < 4; k++) g.cylinderX(x + 1.95, x + w - 0.15, top + 0.07 + (k % 2) * 0.13, z + 0.4 + Math.floor(k / 2) * 0.3, 0.07, 6);
      break;
    }
    case 'foodplant': {
      pad(g, ind, y, C.concrete);
      shed(g, x + 0.2, z + 0.2, x + w - 0.9, z + h - 0.2, top, 0.6, C.white, C.roofDark);
      g.color(C.silo);
      for (const k of [0, 1]) g.cylinderY(x + w - 0.5, z + 0.6 + k * 1.1, top, top + 1.0, 0.25, 10);
      break;
    }
    case 'refinery': {
      pad(g, ind, y, C.concrete);
      g.color(C.tank);
      for (const [dx, dz] of [[0.8, 0.8], [0.8, 2.0], [2.0, 0.8]] as const) g.cylinderY(x + dx, z + dz, top, top + 0.45, 0.42, 12);
      g.color(C.metal);
      for (const k of [0, 1]) g.cylinderY(x + w - 0.9 + k * 0.4, z + h - 0.9, top, top + 1.6, 0.12, 8);
      g.color(C.rust).aabb(x + 1.6, top, z + 1.6, x + w - 0.3, top + 0.3, z + h - 0.3);
      break;
    }
    case 'papermill': {
      pad(g, ind, y, C.concrete);
      shed(g, x + 0.2, z + 0.2, x + w - 1.3, z + h - 0.3, top, 0.75, C.paper, C.roofDark);
      // Pulp digesters, a tall chimney, and logs waiting by the yard.
      g.color(C.metal);
      for (const k of [0, 1]) g.cylinderY(x + w - 0.75, z + 0.6 + k * 0.85, top, top + 1.1, 0.26, 10);
      g.color(C.brick).cylinderY(x + w - 0.35, z + h - 0.4, top, top + 2.0, 0.1, 8);
      g.color(C.timber);
      for (let k = 0; k < 3; k++) g.cylinderX(x + 0.3, x + 1.6, top + 0.07 + (k === 2 ? 0.12 : 0), z + h - 0.25 - (k % 2) * 0.14, 0.07, 6);
      break;
    }
    case 'printworks': {
      pad(g, ind, y, C.concrete);
      // A long brick hall with roof lights, and an office at the front.
      g.color(C.brick).aabb(x + 0.2, top, z + 0.9, x + w - 0.2, top + 0.55, z + h - 0.2);
      g.color(C.roofDark).aabb(x + 0.18, top + 0.55, z + 0.88, x + w - 0.18, top + 0.6, z + h - 0.18);
      g.color(C.white);
      for (let k = 0; k < 3; k++) g.gable(x + 0.4 + k * 0.8, z + 1.2, x + 0.9 + k * 0.8, z + h - 0.5, top + 0.6, 0.12, 0.01);
      shed(g, x + 0.4, z + 0.2, x + 1.6, z + 0.85, top, 0.75, C.white, C.roofDark);
      g.color(C.paper).aabb(x + 1.9, top, z + 0.3, x + 2.5, top + 0.18, z + 0.7); // paper rolls on the dock
      break;
    }
    case 'plantation': {
      // Rubber trees in rows, a latex tank and a drying shed.
      pad(g, ind, y, C.jungleFloor);
      for (let r = 0; r < h * 2 - 1; r++) {
        for (let k = 0; k < w * 2 - 2; k++) {
          const tx = x + 0.3 + k * 0.5;
          const tz = z + 0.3 + r * 0.5;
          if (tx > x + w - 1.3 && tz < z + 1.3) continue; // the yard
          g.color(C.trunk).aabb(tx - 0.02, top, tz - 0.02, tx + 0.02, top + 0.22, tz + 0.02);
          g.color(C.rubberTree).cylinderY(tx, tz, top + 0.2, top + 0.42, 0.17, 6);
          g.color(C.rubberTree).pyramid(tx, tz, 0.12, top + 0.42, 0.1);
        }
      }
      shed(g, x + w - 1.2, z + 0.15, x + w - 0.2, z + 0.7, top, 0.3, C.timber, C.roofDark);
      g.color(C.tank).cylinderY(x + w - 0.5, z + 1.05, top, top + 0.35, 0.2, 10);
      break;
    }
    case 'orchard': {
      // Fruit trees in rows, and a packing shed.
      pad(g, ind, y, C.pasture);
      for (let r = 0; r < h * 2 - 1; r++) {
        for (let k = 0; k < w * 2 - 1; k++) {
          const tx = x + 0.3 + k * 0.5;
          const tz = z + 0.3 + r * 0.5;
          if (tx < x + 1.6 && tz < z + 1.1) continue; // the packing shed
          g.color(C.trunk).aabb(tx - 0.02, top, tz - 0.02, tx + 0.02, top + 0.12, tz + 0.02);
          g.color(C.orchard).cylinderY(tx, tz, top + 0.1, top + 0.3, 0.15, 6);
          g.color(C.orchard).pyramid(tx, tz, 0.1, top + 0.3, 0.08);
          g.color(C.fruit).aabb(tx + 0.08, top + 0.16, tz - 0.03, tx + 0.15, top + 0.22, tz + 0.03);
        }
      }
      shed(g, x + 0.2, z + 0.15, x + 1.4, z + 0.9, top, 0.32, C.white, C.barn);
      break;
    }
    case 'watersupply': {
      // A pump house over the well, a water tank on legs and pipes.
      pad(g, ind, y, C.dryEarth);
      shed(g, x + 0.15, z + 0.2, x + 0.9, z + 0.8, top, 0.32, C.white, C.roofDark);
      g.color(C.metal);
      const tx = x + w - 0.6;
      const tz = z + h - 0.6;
      for (const [dx, dz] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]] as const) g.aabb(tx + dx - 0.025, top, tz + dz - 0.025, tx + dx + 0.025, top + 0.7, tz + dz + 0.025);
      g.color(C.water).cylinderY(tx, tz, top + 0.7, top + 1.05, 0.3, 12);
      g.color(C.roofDark).pyramid(tx, tz, 0.22, top + 1.05, 0.1);
      g.color(C.metal).cylinderX(x + 0.9, tx, top + 0.06, z + 0.5, 0.04, 6);
      break;
    }
    case 'power': {
      pad(g, ind, y, C.concrete);
      shed(g, x + 0.2, z + 0.2, x + 1.6, z + h - 0.2, top, 0.7, C.brick, C.roofDark);
      g.color(C.concrete).cylinderY(x + w - 0.8, z + h / 2, top, top + 1.4, 0.55, 14); // cooling tower
      g.color(C.brick).cylinderY(x + 1.0, z + 0.5, top + 0.7, top + 2.0, 0.09, 8);
      break;
    }
  }
}

/**
 * All industries as one mesh. Rebuilt (at most twice a second) when the industry list
 * changes or terrain under an industry arrives.
 */
export class IndustryRenderer {
  readonly mesh: THREE.Mesh;
  private key = '';
  private dirty = true;
  private lastBuild = 0;
  private unsub: () => void;

  constructor(private readonly world: ClientWorld) {
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), buildingMaterial);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.unsub = world.onChunk(() => (this.dirty = true));
  }

  update(now: number): void {
    const key = `${this.world.industriesRev}`;
    if (key !== this.key) {
      this.key = key;
      this.dirty = true;
    }
    if (!this.dirty || now - this.lastBuild < 500) return;
    this.dirty = false;
    this.lastBuild = now;
    const g = new GeoBuilder();
    const map = this.world.map;
    for (const ind of this.world.state.industries.values()) {
      const type = industryType(ind.type);
      if (!type || !this.world.isLoaded(Math.floor(ind.x / CHUNK_SIZE), Math.floor(ind.y / CHUNK_SIZE))) continue;
      build(g, ind, type.model, map.cornerHeight(ind.x, ind.y) * HEIGHT_SCALE);
    }
    this.mesh.geometry.dispose();
    this.mesh.geometry = g.build() ?? new THREE.BufferGeometry();
  }

  dispose(): void {
    this.unsub();
    this.mesh.geometry.dispose();
  }
}
