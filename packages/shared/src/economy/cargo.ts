export const CARGO_IDS = ['passengers', 'mail', 'coal', 'iron_ore', 'steel', 'wood', 'goods', 'grain', 'livestock', 'food', 'oil'] as const;
export type CargoId = (typeof CARGO_IDS)[number];

export interface CargoType {
  id: CargoId;
  name: string;
  /** Unit for amounts (passengers, bags, tonnes, kilolitres, heads). */
  unit: string;
  /** Map and UI colour. */
  color: string;
  /** £ per unit per tile for a prompt delivery. */
  rate: number;
  /**
   * How long the cargo keeps its value: a delivery is prompt within (2 + distance/10) × patience
   * days, and pays less the longer it takes after that (down to 30%).
   */
  patience: number;
  /** Tonnes per unit (adds to the train's mass). */
  weight: number;
}

export const CARGOS: Record<CargoId, CargoType> = {
  passengers: { id: 'passengers', name: 'Passengers', unit: 'passengers', color: '#58a6ff', rate: 0.45, patience: 1, weight: 0.08 },
  mail: { id: 'mail', name: 'Mail', unit: 'bags', color: '#e3c565', rate: 0.6, patience: 0.8, weight: 0.05 },
  coal: { id: 'coal', name: 'Coal', unit: 'tonnes', color: '#3b3b3b', rate: 0.32, patience: 3, weight: 1 },
  iron_ore: { id: 'iron_ore', name: 'Iron ore', unit: 'tonnes', color: '#a0522d', rate: 0.3, patience: 3, weight: 1 },
  steel: { id: 'steel', name: 'Steel', unit: 'tonnes', color: '#8fa3b8', rate: 0.42, patience: 2, weight: 1 },
  wood: { id: 'wood', name: 'Wood', unit: 'tonnes', color: '#8b5a2b', rate: 0.3, patience: 3, weight: 1 },
  goods: { id: 'goods', name: 'Goods', unit: 'crates', color: '#d97b4a', rate: 0.6, patience: 1.5, weight: 0.5 },
  grain: { id: 'grain', name: 'Grain', unit: 'tonnes', color: '#e8c547', rate: 0.34, patience: 2, weight: 1 },
  livestock: { id: 'livestock', name: 'Livestock', unit: 'head', color: '#b5835a', rate: 0.46, patience: 1.2, weight: 0.6 },
  food: { id: 'food', name: 'Food', unit: 'tonnes', color: '#6abf69', rate: 0.52, patience: 1, weight: 1 },
  oil: { id: 'oil', name: 'Oil', unit: 'kilolitres', color: '#2f2f4f', rate: 0.36, patience: 2.5, weight: 0.9 },
};

export const isCargo = (c: unknown): c is CargoId => typeof c === 'string' && (CARGO_IDS as readonly string[]).includes(c);

/** Payment for `n` units of `cargo` carried `dist` tiles, taking `days` days in all. */
export function cargoPayment(cargo: CargoId, n: number, dist: number, days: number): number {
  const c = CARGOS[cargo];
  const prompt = (2 + dist / 10) * c.patience;
  const factor = days <= prompt ? 1 : Math.max(0.3, 1 - ((days - prompt) / (prompt * 2)) * 0.7);
  return Math.round(n * dist * c.rate * factor);
}

/** Format an amount of cargo with its unit. */
export function cargoAmount(cargo: CargoId, n: number): string {
  return `${Math.round(n).toLocaleString('en-GB')} ${CARGOS[cargo].unit}`;
}
