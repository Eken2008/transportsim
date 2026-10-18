/** Cargo carried by a vehicle unit. Only passengers are simulated so far. */
export type CargoType = 'passengers' | 'mail';

export type Traction = 'steam' | 'diesel' | 'electric';

/** Client render model for a unit. */
export type UnitModel = 'steam' | 'diesel' | 'electric' | 'highspeed' | 'coach' | 'coachModern' | 'mailvan';

export interface RailVehicleType {
  id: string;
  name: string;
  kind: 'loco' | 'wagon';
  model: UnitModel;
  traction?: Traction;
  cargo?: CargoType;
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
  /** 0..1, chance-weighted against breakdowns (later milestones) */
  reliability: number;
}

const loco = (v: Omit<RailVehicleType, 'kind' | 'capacity'> & { capacity?: number }): RailVehicleType => ({
  kind: 'loco',
  capacity: 0,
  ...v,
});
const wagon = (v: Omit<RailVehicleType, 'kind' | 'power' | 'tractiveEffort'>): RailVehicleType => ({
  kind: 'wagon',
  power: 0,
  tractiveEffort: 0,
  ...v,
});

/** All rail vehicles. Names are fictional. */
export const RAIL_VEHICLES: readonly RailVehicleType[] = [
  loco({ id: 'puffin', name: 'Puffin 2-4-0 (steam)', model: 'steam', traction: 'steam', length: 11, maxSpeed: 64, power: 330, tractiveEffort: 70, mass: 40, cost: 32_000, runningCost: 2_600, intro: 1850, retire: 1915, lifespan: 30, reliability: 0.75 }),
  loco({ id: 'kestrel', name: 'Kestrel 4-4-0 (steam)', model: 'steam', traction: 'steam', length: 12, maxSpeed: 96, power: 720, tractiveEffort: 110, mass: 62, cost: 52_000, runningCost: 3_400, intro: 1878, retire: 1940, lifespan: 35, reliability: 0.8 }),
  loco({ id: 'atlas', name: 'Atlas 4-6-2 (steam)', model: 'steam', traction: 'steam', length: 14, maxSpeed: 128, power: 1_650, tractiveEffort: 170, mass: 105, cost: 96_000, runningCost: 5_200, intro: 1912, retire: 1965, lifespan: 40, reliability: 0.82 }),
  loco({ id: 'badger', name: 'Badger (diesel)', model: 'diesel', traction: 'diesel', length: 12, maxSpeed: 112, power: 1_100, tractiveEffort: 190, mass: 78, cost: 88_000, runningCost: 4_100, intro: 1936, retire: 1995, lifespan: 30, reliability: 0.88 }),
  loco({ id: 'condor', name: 'Condor (diesel)', model: 'diesel', traction: 'diesel', length: 13, maxSpeed: 160, power: 2_400, tractiveEffort: 260, mass: 98, cost: 150_000, runningCost: 6_000, intro: 1962, retire: 2030, lifespan: 30, reliability: 0.92 }),
  loco({ id: 'volta', name: 'Volta (electric)', model: 'electric', traction: 'electric', length: 12, maxSpeed: 160, power: 3_600, tractiveEffort: 280, mass: 84, cost: 170_000, runningCost: 4_800, intro: 1955, retire: 2020, lifespan: 35, reliability: 0.94 }),
  loco({ id: 'swift', name: 'Swift (high-speed electric)', model: 'highspeed', traction: 'electric', length: 14, maxSpeed: 270, power: 6_400, tractiveEffort: 300, mass: 70, cost: 360_000, runningCost: 9_500, intro: 1990, retire: 2060, lifespan: 30, reliability: 0.96 }),
  loco({ id: 'arrow', name: 'Arrow (high-speed electric)', model: 'highspeed', traction: 'electric', length: 14, maxSpeed: 330, power: 9_200, tractiveEffort: 320, mass: 68, cost: 520_000, runningCost: 12_000, intro: 2018, retire: 2100, lifespan: 30, reliability: 0.97 }),

  wagon({ id: 'coach_wood', name: 'Wooden coach', model: 'coach', cargo: 'passengers', capacity: 30, length: 10, maxSpeed: 90, mass: 18, cost: 6_000, runningCost: 300, intro: 1850, retire: 1935, lifespan: 35, reliability: 1 }),
  wagon({ id: 'coach_steel', name: 'Steel coach', model: 'coach', cargo: 'passengers', capacity: 48, length: 11, maxSpeed: 145, mass: 30, cost: 11_000, runningCost: 450, intro: 1922, retire: 1990, lifespan: 40, reliability: 1 }),
  wagon({ id: 'coach_modern', name: 'Modern coach', model: 'coachModern', cargo: 'passengers', capacity: 64, length: 12, maxSpeed: 200, mass: 36, cost: 19_000, runningCost: 600, intro: 1972, retire: 2100, lifespan: 40, reliability: 1 }),
  wagon({ id: 'coach_hs', name: 'High-speed coach', model: 'coachModern', cargo: 'passengers', capacity: 72, length: 12, maxSpeed: 330, mass: 40, cost: 32_000, runningCost: 900, intro: 1990, retire: 2100, lifespan: 35, reliability: 1 }),
  wagon({ id: 'mail_van', name: 'Mail van', model: 'mailvan', cargo: 'mail', capacity: 30, length: 9, maxSpeed: 120, mass: 20, cost: 7_000, runningCost: 350, intro: 1850, retire: 2100, lifespan: 40, reliability: 1 }),
];

const BY_ID = new Map(RAIL_VEHICLES.map((v) => [v.id, v]));
export const railVehicle = (id: string): RailVehicleType | undefined => BY_ID.get(id);

/** Whether a vehicle can be bought in the given year under the timeline setting. */
export function isAvailable(v: RailVehicleType, year: number, timeline: 'era' | 'sandbox'): boolean {
  return timeline === 'sandbox' || (v.intro <= year && year < v.retire);
}
