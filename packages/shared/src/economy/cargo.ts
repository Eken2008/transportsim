export const CARGO_IDS = [
  'passengers',
  'mail',
  'coal',
  'iron_ore',
  'steel',
  'wood',
  'goods',
  'grain',
  'livestock',
  'food',
  'oil',
  // All climates
  'stone',
  'building_materials',
  'chemicals',
  // Sub-arctic
  'paper',
  'gold',
  // Sub-tropical
  'copper_ore',
  'rubber',
  'fruit',
  'water',
  'diamonds',
  'cotton',
] as const;
export type CargoId = (typeof CARGO_IDS)[number];

export interface CargoType {
  id: CargoId;
  name: string;
  /** Unit for amounts (passengers, bags, tonnes, kilolitres, heads). */
  unit: string;
  /** Map and UI colour. */
  color: string;
  /**
   * £ per unit per tile for a prompt delivery. Freight rates step up evenly by what a typical
   * wagonload earns (about 12% a step), from raw bulk to finished goods.
   */
  rate: number;
  /**
   * How long the cargo keeps its value: a delivery taking (3 + distance/8) × patience days (its
   * prompt time) still earns 99%, and pays gradually less the longer it takes (towards 25%).
   */
  patience: number;
  /** Tonnes per unit (adds to the train's mass). */
  weight: number;
}

export const CARGOS: Record<CargoId, CargoType> = {
  passengers: { id: 'passengers', name: 'Passengers', unit: 'passengers', color: '#58a6ff', rate: 0.73, patience: 1, weight: 0.08 },
  mail: { id: 'mail', name: 'Mail', unit: 'bags', color: '#e3c565', rate: 0.98, patience: 0.8, weight: 0.05 },
  coal: { id: 'coal', name: 'Coal', unit: 'tonnes', color: '#3b3b3b', rate: 1.05, patience: 3, weight: 1 },
  iron_ore: { id: 'iron_ore', name: 'Iron ore', unit: 'tonnes', color: '#a0522d', rate: 1.17, patience: 3, weight: 1 },
  steel: { id: 'steel', name: 'Steel', unit: 'tonnes', color: '#8fa3b8', rate: 2.04, patience: 2, weight: 1 },
  wood: { id: 'wood', name: 'Wood', unit: 'tonnes', color: '#8b5a2b', rate: 1.32, patience: 3, weight: 1 },
  goods: { id: 'goods', name: 'Goods', unit: 'crates', color: '#d97b4a', rate: 3.18, patience: 1.5, weight: 0.5 },
  grain: { id: 'grain', name: 'Grain', unit: 'tonnes', color: '#e8c547', rate: 1.47, patience: 2, weight: 1 },
  livestock: { id: 'livestock', name: 'Livestock', unit: 'head', color: '#b5835a', rate: 2.64, patience: 1.2, weight: 0.6 },
  food: { id: 'food', name: 'Food', unit: 'tonnes', color: '#6abf69', rate: 2.85, patience: 1, weight: 1 },
  oil: { id: 'oil', name: 'Oil', unit: 'kilolitres', color: '#2f2f4f', rate: 1.8, patience: 2.5, weight: 0.9 },
  stone: { id: 'stone', name: 'Stone', unit: 'tonnes', color: '#9a978f', rate: 1.05, patience: 3, weight: 1 },
  building_materials: { id: 'building_materials', name: 'Building materials', unit: 'tonnes', color: '#c25b56', rate: 2.04, patience: 2.5, weight: 1 },
  chemicals: { id: 'chemicals', name: 'Chemicals', unit: 'kilolitres', color: '#a06cc9', rate: 2.28, patience: 2, weight: 1 },
  paper: { id: 'paper', name: 'Paper', unit: 'tonnes', color: '#e4dcc6', rate: 1.92, patience: 2, weight: 1 },
  gold: { id: 'gold', name: 'Gold', unit: 'bags', color: '#d4af37', rate: 4.8, patience: 1.2, weight: 0.2 },
  copper_ore: { id: 'copper_ore', name: 'Copper ore', unit: 'tonnes', color: '#b87333', rate: 1.17, patience: 3, weight: 1 },
  rubber: { id: 'rubber', name: 'Rubber', unit: 'kilolitres', color: '#6b5a48', rate: 1.8, patience: 2.5, weight: 0.9 },
  fruit: { id: 'fruit', name: 'Fruit', unit: 'tonnes', color: '#f2a03d', rate: 2.46, patience: 1, weight: 0.8 },
  water: { id: 'water', name: 'Water', unit: 'kilolitres', color: '#5fb6d9', rate: 1.5, patience: 2, weight: 1 },
  diamonds: { id: 'diamonds', name: 'Diamonds', unit: 'bags', color: '#b9e8f5', rate: 5.4, patience: 1.2, weight: 0.1 },
  cotton: { id: 'cotton', name: 'Cotton', unit: 'bales', color: '#f3f1ea', rate: 1.65, patience: 2.5, weight: 0.5 },
};

/** Share of the rate a very late delivery still earns. */
const LATE_FLOOR = 0.25;

export const isCargo = (c: unknown): c is CargoId => typeof c === 'string' && (CARGO_IDS as readonly string[]).includes(c);

/** Payment for `n` units of `cargo` carried `dist` tiles, taking `days` days in all. */
export function cargoPayment(cargo: CargoId, n: number, dist: number, days: number): number {
  const c = CARGOS[cargo];
  const prompt = (3 + dist / 8) * c.patience;
  // The pay eases off smoothly from the start, like 1 − 0.009t² for t prompt-times taken
  // (99% at 1, 96% at 2, 92% at 3), then levels out towards the floor (74% at 6, 48% at 10).
  const t = days / prompt;
  const factor = LATE_FLOOR + (1 - LATE_FLOOR) * Math.exp(-0.012 * t * t);
  return Math.round(n * dist * c.rate * factor);
}

/** Format an amount of cargo with its unit. */
export function cargoAmount(cargo: CargoId, n: number): string {
  return `${Math.round(n).toLocaleString('en-GB')} ${CARGOS[cargo].unit}`;
}
