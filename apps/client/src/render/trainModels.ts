import type { UnitModel } from '@transportsim/shared';
import * as THREE from 'three';
import { GeoBuilder, lin } from './geoBuilder.ts';

/**
 * Low-poly train units, built for a length of 1 along +X (front) and scaled per unit.
 * `body` is tinted with the owner's colour per instance; `detail` keeps its own colours.
 */
export interface UnitGeo {
  body: THREE.BufferGeometry;
  detail: THREE.BufferGeometry;
}

const WHITE = lin('#ffffff');
const DARK = lin('#26292d');
const STEEL = lin('#5d636b');
const ROOF = lin('#8a9097');
const GLASS = lin('#2c3a48');
const RED = lin('#8e2b22');
const CREAM = lin('#efe6cf');
const BRASS = lin('#c9a24a');
const LOAD = lin('#3a3633');
const TIMBER = lin('#7a5230');
const TANK = lin('#30343a');
const SLAT = lin('#6b4a2e');

const W = 0.135; // half width
const FLOOR = 0.035;

function bogies(g: GeoBuilder, positions: number[]): void {
  g.color(DARK);
  for (const x of positions) g.aabb(x - 0.09, 0, -W * 0.8, x + 0.09, FLOOR + 0.02, W * 0.8);
}

function windowsBand(g: GeoBuilder, x0: number, x1: number, y0: number, y1: number, count: number): void {
  g.color(GLASS);
  const step = (x1 - x0) / count;
  for (let i = 0; i < count; i++) {
    const a = x0 + step * (i + 0.18);
    const b = x0 + step * (i + 0.82);
    g.aabb(a, y0, -W - 0.004, b, y1, W + 0.004);
  }
}

/** Side windows of a road vehicle. */
function g2windows(g: GeoBuilder, r: number, count: number): void {
  g.color(GLASS);
  const step = 0.86 / count;
  for (let i = 0; i < count; i++) {
    const a = -0.44 + step * (i + 0.15);
    const b = -0.44 + step * (i + 0.85);
    g.aabb(a, 0.17, -r - 0.004, b, 0.26, r + 0.004);
  }
}

function build(model: UnitModel): UnitGeo {
  const body = new GeoBuilder().color(WHITE);
  const d = new GeoBuilder();
  switch (model) {
    case 'steam': {
      d.color(DARK).aabb(-0.5, 0, -W * 0.9, 0.5, FLOOR + 0.02, W * 0.9); // frame
      d.color(RED);
      for (const x of [-0.05, 0.15, 0.35]) {
        d.aabb(x - 0.07, 0.005, -W * 0.92, x + 0.07, 0.145, -W * 0.72);
        d.aabb(x - 0.07, 0.005, W * 0.72, x + 0.07, 0.145, W * 0.92);
      }
      d.color(DARK).cylinderX(-0.18, 0.46, 0.2, 0, 0.1, 10); // boiler
      d.color(STEEL).cylinderX(0.4, 0.5, 0.2, 0, 0.105, 10); // smokebox
      d.color(DARK).cylinderY(0.4, 0, 0.28, 0.4, 0.03, 8); // chimney
      d.color(BRASS).cylinderY(0.12, 0, 0.28, 0.34, 0.04, 8); // dome
      body.aabb(-0.5, FLOOR, -W, -0.18, 0.36, W); // cab
      body.aabb(-0.18, FLOOR + 0.02, -W, 0.5, FLOOR + 0.06, W); // running board
      d.color(DARK).aabb(-0.52, 0.36, -W - 0.01, -0.16, 0.38, W + 0.01); // cab roof
      d.color(GLASS).aabb(-0.3, 0.24, -W - 0.004, -0.22, 0.32, W + 0.004);
      break;
    }
    case 'diesel':
    case 'electric': {
      bogies(d, [-0.3, 0.3]);
      body.aabb(-0.48, FLOOR, -W, 0.48, 0.32, W);
      d.color(ROOF).aabb(-0.46, 0.32, -W * 0.92, 0.46, 0.35, W * 0.92);
      d.color(GLASS).aabb(0.46, 0.22, -W * 0.8, 0.485, 0.3, W * 0.8);
      d.color(GLASS).aabb(-0.485, 0.22, -W * 0.8, -0.46, 0.3, W * 0.8);
      d.color(CREAM).aabb(-0.48, 0.12, -W - 0.003, 0.48, 0.14, W + 0.003); // stripe
      if (model === 'electric') {
        d.color(DARK);
        d.aabb(-0.2, 0.35, -0.01, -0.18, 0.46, 0.01);
        d.aabb(-0.26, 0.46, -0.08, -0.1, 0.47, 0.08);
      }
      break;
    }
    case 'highspeed': {
      bogies(d, [-0.32, 0.25]);
      d.color(WHITE).aabb(-0.5, FLOOR, -W, 0.25, 0.3, W);
      // Wedge nose
      const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
      const f = 0.5;
      d.color(WHITE);
      d.quad(v(0.25, 0.3, -W), v(0.25, 0.3, W), v(f, 0.1, W * 0.6), v(f, 0.1, -W * 0.6));
      d.quad(v(0.25, FLOOR, W), v(f, FLOOR, W * 0.6), v(f, 0.1, W * 0.6), v(0.25, 0.3, W));
      d.quad(v(f, FLOOR, -W * 0.6), v(0.25, FLOOR, -W), v(0.25, 0.3, -W), v(f, 0.1, -W * 0.6));
      d.quad(v(f, FLOOR, W * 0.6), v(f, FLOOR, -W * 0.6), v(f, 0.1, -W * 0.6), v(f, 0.1, W * 0.6));
      d.color(GLASS).quad(v(0.27, 0.285, -W * 0.7), v(0.27, 0.285, W * 0.7), v(0.38, 0.21, W * 0.62), v(0.38, 0.21, -W * 0.62));
      body.aabb(-0.5, 0.12, -W - 0.004, 0.3, 0.16, W + 0.004); // livery stripe
      windowsBand(d, -0.46, 0.2, 0.2, 0.26, 5);
      break;
    }
    case 'coach':
    case 'coachModern': {
      bogies(d, [-0.32, 0.32]);
      body.aabb(-0.5, FLOOR, -W, 0.5, 0.3, W);
      windowsBand(d, -0.44, 0.44, 0.17, 0.25, model === 'coach' ? 6 : 8);
      if (model === 'coach') {
        d.color(ROOF);
        const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
        d.quad(v(-0.5, 0.3, W), v(0.5, 0.3, W), v(0.5, 0.35, 0), v(-0.5, 0.35, 0));
        d.quad(v(0.5, 0.3, -W), v(-0.5, 0.3, -W), v(-0.5, 0.35, 0), v(0.5, 0.35, 0));
      } else {
        d.color(ROOF).aabb(-0.49, 0.3, -W * 0.95, 0.49, 0.33, W * 0.95);
      }
      break;
    }
    case 'mailvan': {
      bogies(d, [-0.3, 0.3]);
      body.aabb(-0.5, FLOOR, -W, 0.5, 0.29, W);
      d.color(ROOF).aabb(-0.49, 0.29, -W * 0.95, 0.49, 0.32, W * 0.95);
      d.color(DARK).aabb(-0.08, 0.06, -W - 0.004, 0.08, 0.26, W + 0.004); // doors
      break;
    }
    case 'openwagon': {
      bogies(d, [-0.28, 0.28]);
      d.color(DARK).aabb(-0.5, FLOOR, -W, 0.5, FLOOR + 0.03, W); // floor
      body.aabb(-0.5, FLOOR + 0.03, -W, 0.5, 0.2, -W + 0.02);
      body.aabb(-0.5, FLOOR + 0.03, W - 0.02, 0.5, 0.2, W);
      body.aabb(-0.5, FLOOR + 0.03, -W, -0.48, 0.2, W);
      body.aabb(0.48, FLOOR + 0.03, -W, 0.5, 0.2, W);
      d.color(LOAD).aabb(-0.47, 0.12, -W + 0.02, 0.47, 0.19, W - 0.02); // load
      break;
    }
    case 'hopper': {
      bogies(d, [-0.32, 0.32]);
      const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
      // Sloping hopper ends over a short underframe
      body.aabb(-0.42, 0.1, -W, 0.42, 0.3, W);
      body.quad(v(-0.5, 0.3, -W), v(-0.5, 0.3, W), v(-0.42, 0.1, W), v(-0.42, 0.1, -W));
      body.quad(v(0.42, 0.1, -W), v(0.42, 0.1, W), v(0.5, 0.3, W), v(0.5, 0.3, -W));
      d.color(DARK).aabb(-0.2, FLOOR, -W * 0.6, 0.2, 0.1, W * 0.6); // discharge chutes
      d.color(LOAD).aabb(-0.45, 0.3, -W + 0.015, 0.45, 0.32, W - 0.015);
      break;
    }
    case 'boxvan': {
      bogies(d, [-0.3, 0.3]);
      body.aabb(-0.5, FLOOR, -W, 0.5, 0.3, W);
      d.color(ROOF);
      const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
      d.quad(v(-0.5, 0.3, W), v(0.5, 0.3, W), v(0.5, 0.34, 0), v(-0.5, 0.34, 0));
      d.quad(v(0.5, 0.3, -W), v(-0.5, 0.3, -W), v(-0.5, 0.34, 0), v(0.5, 0.34, 0));
      d.color(DARK).aabb(-0.1, 0.06, -W - 0.004, 0.1, 0.27, W + 0.004); // sliding doors
      break;
    }
    case 'tanker': {
      bogies(d, [-0.3, 0.3]);
      d.color(DARK).aabb(-0.5, FLOOR, -W * 0.85, 0.5, FLOOR + 0.04, W * 0.85);
      d.color(TANK).cylinderX(-0.47, 0.47, 0.18, 0, 0.11, 12);
      d.color(TANK).cylinderY(0, 0, 0.29, 0.33, 0.035, 8); // dome
      body.aabb(-0.47, 0.17, -0.112, 0.47, 0.19, 0.112); // livery band
      break;
    }
    case 'flatwagon': {
      bogies(d, [-0.3, 0.3]);
      body.aabb(-0.5, FLOOR, -W, 0.5, FLOOR + 0.05, W); // deck
      d.color(DARK);
      for (const x of [-0.45, -0.15, 0.15, 0.45]) {
        d.aabb(x - 0.01, FLOOR + 0.05, -W, x + 0.01, 0.16, -W + 0.015); // stanchions
        d.aabb(x - 0.01, FLOOR + 0.05, W - 0.015, x + 0.01, 0.16, W);
      }
      d.color(TIMBER).aabb(-0.46, FLOOR + 0.05, -W + 0.02, 0.46, 0.14, W - 0.02); // load
      break;
    }
    case 'bus':
    case 'coachbus': {
      const R = 0.1;
      d.color(DARK);
      for (const x of [-0.3, 0.3]) d.cylinderX(x - 0.06, x + 0.06, 0.05, 0, 0.05, 6); // wheels
      body.aabb(-0.5, 0.05, -R, 0.5, 0.3, R);
      d.color(GLASS).aabb(0.49, 0.17, -R * 0.85, 0.505, 0.27, R * 0.85); // windscreen
      g2windows(d, R, model === 'coachbus' ? 6 : 5);
      d.color(ROOF).aabb(-0.49, 0.3, -R * 0.95, 0.49, 0.32, R * 0.95);
      break;
    }
    case 'truck':
    case 'tankertruck':
    case 'flatbed':
    case 'tipper': {
      const R = 0.1;
      d.color(DARK);
      for (const x of [-0.32, -0.1, 0.32]) d.cylinderX(x - 0.06, x + 0.06, 0.05, 0, 0.05, 6);
      d.color(DARK).aabb(-0.5, 0.05, -R * 0.8, 0.5, 0.08, R * 0.8); // chassis
      body.aabb(0.22, 0.08, -R, 0.5, 0.3, R); // cab
      d.color(GLASS).aabb(0.49, 0.18, -R * 0.85, 0.505, 0.27, R * 0.85);
      if (model === 'truck') body.aabb(-0.5, 0.08, -R, 0.18, 0.31, R);
      else if (model === 'tankertruck') d.color(lin('#c9c9c9')).cylinderX(-0.48, 0.18, 0.18, 0, 0.09, 10);
      else if (model === 'flatbed') {
        body.aabb(-0.5, 0.08, -R, 0.18, 0.11, R);
        d.color(lin('#7a5230')).aabb(-0.46, 0.11, -R * 0.8, 0.14, 0.2, R * 0.8);
      } else {
        // Tipper body, tapered
        const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
        body.aabb(-0.48, 0.1, -R, 0.18, 0.13, R);
        body.quad(v(-0.48, 0.13, -R), v(0.18, 0.13, -R), v(0.18, 0.27, -R), v(-0.48, 0.24, -R));
        body.quad(v(0.18, 0.13, R), v(-0.48, 0.13, R), v(-0.48, 0.24, R), v(0.18, 0.27, R));
        d.color(LOAD).aabb(-0.46, 0.13, -R * 0.85, 0.16, 0.22, R * 0.85);
      }
      break;
    }
    case 'stockcar': {
      bogies(d, [-0.28, 0.28]);
      body.aabb(-0.5, FLOOR, -W, 0.5, 0.09, W);
      d.color(SLAT);
      for (const y of [0.13, 0.19, 0.25]) {
        d.aabb(-0.5, y, -W, 0.5, y + 0.025, -W + 0.015);
        d.aabb(-0.5, y, W - 0.015, 0.5, y + 0.025, W);
      }
      body.aabb(-0.5, 0.09, -W, -0.47, 0.3, W);
      body.aabb(0.47, 0.09, -W, 0.5, 0.3, W);
      d.color(ROOF).aabb(-0.5, 0.3, -W, 0.5, 0.33, W);
      break;
    }
  }
  return { body: body.build() ?? new THREE.BufferGeometry(), detail: d.build() ?? new THREE.BufferGeometry() };
}

export const UNIT_MODELS: Record<UnitModel, UnitGeo> = {
  steam: build('steam'),
  diesel: build('diesel'),
  electric: build('electric'),
  highspeed: build('highspeed'),
  coach: build('coach'),
  coachModern: build('coachModern'),
  mailvan: build('mailvan'),
  openwagon: build('openwagon'),
  hopper: build('hopper'),
  boxvan: build('boxvan'),
  tanker: build('tanker'),
  flatwagon: build('flatwagon'),
  stockcar: build('stockcar'),
  bus: build('bus'),
  coachbus: build('coachbus'),
  truck: build('truck'),
  tankertruck: build('tankertruck'),
  flatbed: build('flatbed'),
  tipper: build('tipper'),
};
