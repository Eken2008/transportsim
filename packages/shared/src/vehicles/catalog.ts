import type { CargoId } from '../economy/cargo.ts';

export type Traction = 'steam' | 'diesel' | 'electric';

/** Client render model for a unit. */
export type UnitModel =
  | 'steam'
  | 'diesel'
  | 'electric'
  | 'highspeed'
  | 'coach'
  | 'coachModern'
  | 'mailvan'
  | 'openwagon'
  | 'hopper'
  | 'boxvan'
  | 'tanker'
  | 'flatwagon'
  | 'stockcar';

export interface RailVehicleType {
  id: string;
  name: string;
  kind: 'loco' | 'wagon';
  model: UnitModel;
  traction?: Traction;
  /** Cargoes a wagon can be refitted to carry; the first is the default. */
  cargoes?: readonly CargoId[];
  capacity: number;
  /** Length in 1/16 tile. */
  length: number;
  /** km/h */
  maxSpeed: number;
  /** kW (locomotives) */
  power: number;
  /** kN at standstill (locomotives) */
  tractiveEffort: number;
  /** tonnes, empty */
  mass: number;
  cost: number;
  /** per year */
  runningCost: number;
  intro: number;
  retire: number;
  /** years */
  lifespan: number;
  /** 0..1, how rarely it breaks down */
  reliability: number;
}

const loco = (v: Omit<RailVehicleType, 'kind' | 'capacity'> & { capacity?: number }): RailVehicleType => ({
  kind: 'loco',
  capacity: 0,
  ...v,
});
const wagon = (v: Omit<RailVehicleType, 'kind' | 'power' | 'tractiveEffort' | 'reliability'>): RailVehicleType => ({
  kind: 'wagon',
  power: 0,
  tractiveEffort: 0,
  reliability: 1,
  ...v,
});

const BULK: CargoId[] = ['coal', 'iron_ore', 'grain', 'wood'];
const PIECE: CargoId[] = ['goods', 'food', 'grain', 'mail'];
const FLAT: CargoId[] = ['steel', 'wood'];

/** All rail vehicles, 1850–2050 and beyond. Names are fictional. */
export const RAIL_VEHICLES: readonly RailVehicleType[] = [
  // Passenger and mixed-traffic engines
  loco({ id: 'puffin', name: 'Puffin 2-4-0 (steam)', model: 'steam', traction: 'steam', length: 11, maxSpeed: 64, power: 330, tractiveEffort: 70, mass: 40, cost: 32_000, runningCost: 2_600, intro: 1850, retire: 1915, lifespan: 30, reliability: 0.75 }),
  loco({ id: 'kestrel', name: 'Kestrel 4-4-0 (steam)', model: 'steam', traction: 'steam', length: 12, maxSpeed: 96, power: 720, tractiveEffort: 110, mass: 62, cost: 52_000, runningCost: 3_400, intro: 1878, retire: 1940, lifespan: 35, reliability: 0.8 }),
  loco({ id: 'atlas', name: 'Atlas 4-6-2 (steam)', model: 'steam', traction: 'steam', length: 14, maxSpeed: 128, power: 1_650, tractiveEffort: 170, mass: 105, cost: 96_000, runningCost: 5_200, intro: 1912, retire: 1965, lifespan: 40, reliability: 0.82 }),
  loco({ id: 'badger', name: 'Badger (diesel)', model: 'diesel', traction: 'diesel', length: 12, maxSpeed: 112, power: 1_100, tractiveEffort: 190, mass: 78, cost: 88_000, runningCost: 4_100, intro: 1936, retire: 1995, lifespan: 30, reliability: 0.88 }),
  loco({ id: 'condor', name: 'Condor (diesel)', model: 'diesel', traction: 'diesel', length: 13, maxSpeed: 160, power: 2_400, tractiveEffort: 260, mass: 98, cost: 150_000, runningCost: 6_000, intro: 1962, retire: 2030, lifespan: 30, reliability: 0.92 }),
  loco({ id: 'volta', name: 'Volta (electric)', model: 'electric', traction: 'electric', length: 12, maxSpeed: 160, power: 3_600, tractiveEffort: 280, mass: 84, cost: 170_000, runningCost: 4_800, intro: 1955, retire: 2020, lifespan: 35, reliability: 0.94 }),
  loco({ id: 'swift', name: 'Swift (high-speed electric)', model: 'highspeed', traction: 'electric', length: 14, maxSpeed: 270, power: 6_400, tractiveEffort: 300, mass: 70, cost: 360_000, runningCost: 9_500, intro: 1990, retire: 2060, lifespan: 30, reliability: 0.96 }),
  loco({ id: 'arrow', name: 'Arrow (high-speed electric)', model: 'highspeed', traction: 'electric', length: 14, maxSpeed: 330, power: 9_200, tractiveEffort: 320, mass: 68, cost: 520_000, runningCost: 12_000, intro: 2018, retire: 2100, lifespan: 30, reliability: 0.97 }),
  // Freight engines: slower, with more pull
  loco({ id: 'mule', name: 'Mule 0-8-0 (steam freight)', model: 'steam', traction: 'steam', length: 12, maxSpeed: 64, power: 900, tractiveEffort: 230, mass: 85, cost: 60_000, runningCost: 3_800, intro: 1880, retire: 1955, lifespan: 35, reliability: 0.8 }),
  loco({ id: 'bison', name: 'Bison 2-10-0 (steam freight)', model: 'steam', traction: 'steam', length: 14, maxSpeed: 88, power: 1_900, tractiveEffort: 310, mass: 125, cost: 105_000, runningCost: 5_600, intro: 1925, retire: 1968, lifespan: 40, reliability: 0.82 }),
  loco({ id: 'ox', name: 'Ox (heavy diesel)', model: 'diesel', traction: 'diesel', length: 14, maxSpeed: 105, power: 2_600, tractiveEffort: 410, mass: 120, cost: 165_000, runningCost: 6_400, intro: 1955, retire: 2035, lifespan: 35, reliability: 0.9 }),
  loco({ id: 'titan', name: 'Titan (electric freight)', model: 'electric', traction: 'electric', length: 14, maxSpeed: 140, power: 6_000, tractiveEffort: 460, mass: 120, cost: 290_000, runningCost: 7_000, intro: 1975, retire: 2100, lifespan: 35, reliability: 0.95 }),
  loco({ id: 'hauler', name: 'Hauler (modern diesel)', model: 'diesel', traction: 'diesel', length: 15, maxSpeed: 120, power: 4_400, tractiveEffort: 520, mass: 132, cost: 260_000, runningCost: 8_200, intro: 2000, retire: 2100, lifespan: 30, reliability: 0.96 }),

  // Passenger coaches and mail
  wagon({ id: 'coach_wood', name: 'Wooden coach', model: 'coach', cargoes: ['passengers'], capacity: 30, length: 10, maxSpeed: 90, mass: 18, cost: 6_000, runningCost: 300, intro: 1850, retire: 1935, lifespan: 35 }),
  wagon({ id: 'coach_steel', name: 'Steel coach', model: 'coach', cargoes: ['passengers'], capacity: 48, length: 11, maxSpeed: 145, mass: 30, cost: 11_000, runningCost: 450, intro: 1922, retire: 1990, lifespan: 40 }),
  wagon({ id: 'coach_modern', name: 'Modern coach', model: 'coachModern', cargoes: ['passengers'], capacity: 64, length: 12, maxSpeed: 200, mass: 36, cost: 19_000, runningCost: 600, intro: 1972, retire: 2100, lifespan: 40 }),
  wagon({ id: 'coach_hs', name: 'High-speed coach', model: 'coachModern', cargoes: ['passengers'], capacity: 72, length: 12, maxSpeed: 330, mass: 40, cost: 32_000, runningCost: 900, intro: 1990, retire: 2100, lifespan: 35 }),
  wagon({ id: 'mail_van', name: 'Mail van', model: 'mailvan', cargoes: ['mail'], capacity: 30, length: 9, maxSpeed: 120, mass: 20, cost: 7_000, runningCost: 350, intro: 1850, retire: 2100, lifespan: 40 }),

  // Early freight wagons
  wagon({ id: 'open_wagon', name: 'Open wagon', model: 'openwagon', cargoes: BULK, capacity: 20, length: 8, maxSpeed: 80, mass: 8, cost: 3_500, runningCost: 180, intro: 1850, retire: 1950, lifespan: 40 }),
  wagon({ id: 'covered_van', name: 'Covered van', model: 'boxvan', cargoes: PIECE, capacity: 16, length: 8, maxSpeed: 90, mass: 9, cost: 4_200, runningCost: 200, intro: 1850, retire: 1955, lifespan: 40 }),
  wagon({ id: 'stock_car', name: 'Cattle wagon', model: 'stockcar', cargoes: ['livestock'], capacity: 14, length: 8, maxSpeed: 80, mass: 8, cost: 4_000, runningCost: 200, intro: 1850, retire: 1975, lifespan: 40 }),
  wagon({ id: 'tank_wagon', name: 'Tank wagon', model: 'tanker', cargoes: ['oil'], capacity: 18, length: 8, maxSpeed: 80, mass: 9, cost: 4_800, runningCost: 220, intro: 1870, retire: 1965, lifespan: 40 }),
  wagon({ id: 'flat_wagon', name: 'Flat wagon', model: 'flatwagon', cargoes: FLAT, capacity: 20, length: 8, maxSpeed: 85, mass: 8, cost: 3_800, runningCost: 180, intro: 1855, retire: 1960, lifespan: 40 }),
  // Bogie freight wagons
  wagon({ id: 'hopper', name: 'Steel hopper', model: 'hopper', cargoes: BULK, capacity: 45, length: 9, maxSpeed: 120, mass: 20, cost: 9_500, runningCost: 360, intro: 1935, retire: 2100, lifespan: 45 }),
  wagon({ id: 'box_wagon', name: 'Bogie box wagon', model: 'boxvan', cargoes: PIECE, capacity: 36, length: 10, maxSpeed: 120, mass: 22, cost: 11_000, runningCost: 380, intro: 1945, retire: 2100, lifespan: 45 }),
  wagon({ id: 'tanker', name: 'Bogie tanker', model: 'tanker', cargoes: ['oil'], capacity: 48, length: 10, maxSpeed: 120, mass: 24, cost: 12_500, runningCost: 400, intro: 1955, retire: 2100, lifespan: 45 }),
  wagon({ id: 'bogie_flat', name: 'Bogie flat', model: 'flatwagon', cargoes: FLAT, capacity: 50, length: 10, maxSpeed: 120, mass: 22, cost: 10_000, runningCost: 360, intro: 1955, retire: 2100, lifespan: 45 }),
  wagon({ id: 'stock_modern', name: 'Livestock transporter', model: 'stockcar', cargoes: ['livestock'], capacity: 30, length: 10, maxSpeed: 140, mass: 20, cost: 12_000, runningCost: 420, intro: 1975, retire: 2100, lifespan: 40 }),
  wagon({ id: 'reefer', name: 'Refrigerated van', model: 'boxvan', cargoes: ['food', 'goods'], capacity: 34, length: 10, maxSpeed: 160, mass: 24, cost: 15_000, runningCost: 520, intro: 1965, retire: 2100, lifespan: 40 }),
  wagon({ id: 'freight_hs', name: 'Express freight van', model: 'boxvan', cargoes: ['goods', 'mail', 'food'], capacity: 32, length: 12, maxSpeed: 220, mass: 26, cost: 26_000, runningCost: 800, intro: 2005, retire: 2100, lifespan: 35 }),
];

const BY_ID = new Map(RAIL_VEHICLES.map((v) => [v.id, v]));
export const railVehicle = (id: string): RailVehicleType | undefined => BY_ID.get(id);

/** Whether a vehicle can be bought in the given year under the timeline setting. */
export function isAvailable(v: RailVehicleType, year: number, timeline: 'era' | 'sandbox'): boolean {
  return timeline === 'sandbox' || (v.intro <= year && year < v.retire);
}

/** The cargo a unit carries: its refit, or the wagon's default; undefined for engines. */
export function unitCargo(u: { type: string; cargo?: CargoId }): CargoId | undefined {
  const v = railVehicle(u.type);
  if (!v?.cargoes?.length) return undefined;
  return u.cargo && v.cargoes.includes(u.cargo) ? u.cargo : v.cargoes[0];
}
