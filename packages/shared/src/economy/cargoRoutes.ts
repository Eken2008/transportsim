import type { Town } from '../town/towns.ts';
import { CARGO_IDS, type CargoId } from './cargo.ts';
import { FOOD_RESIDENTS, GOODS_RESIDENTS } from './cargoSystem.ts';
import { INDUSTRY_TYPES, industryType, type Industry, type IndustryType } from './industries.ts';

/** Freight cargoes: everything industries make or take (not passengers and mail). */
export const FREIGHT_CARGOS: readonly CargoId[] = CARGO_IDS.filter((c) => INDUSTRY_TYPES.some((t) => t.produces.includes(c) || t.accepts.includes(c)));

/** Residents a town needs before stations in it can take this cargo (undefined: towns never take it). */
export function townAcceptsAt(cargo: CargoId): number | undefined {
  return cargo === 'goods' ? GOODS_RESIDENTS : cargo === 'food' ? FOOD_RESIDENTS : undefined;
}

/** Which industry types make a cargo and which take it, and whether towns take it. */
export interface CargoChain {
  cargo: CargoId;
  producers: IndustryType[];
  acceptors: IndustryType[];
  towns: boolean;
}

export function cargoChain(cargo: CargoId, types: readonly IndustryType[] = INDUSTRY_TYPES): CargoChain {
  return {
    cargo,
    producers: types.filter((t) => t.produces.includes(cargo)),
    acceptors: types.filter((t) => t.accepts.includes(cargo)),
    towns: townAcceptsAt(cargo) !== undefined,
  };
}

/**
 * How far along the production chain each industry type is: 0 for primary industries, and one
 * more than the deepest industry making any of its inputs for the rest (a factory, fed by steel
 * mills fed by mines, is 2).
 */
export function chainTiers(types: readonly IndustryType[] = INDUSTRY_TYPES): Map<string, number> {
  const tiers = new Map<string, number>();
  const tierOf = (t: IndustryType, seen: Set<string>): number => {
    const known = tiers.get(t.id);
    if (known !== undefined) return known;
    if (seen.has(t.id)) return 0; // A loop in the chain: stop here.
    seen.add(t.id);
    let tier = 0;
    for (const c of t.accepts) for (const p of types) if (p.produces.includes(c)) tier = Math.max(tier, tierOf(p, seen) + 1);
    tiers.set(t.id, tier);
    return tier;
  };
  for (const t of types) tierOf(t, new Set());
  return tiers;
}

/** One end of a cargo route: an industry or a town, and how far it is. */
export interface RouteEnd {
  kind: 'industry' | 'town';
  id: number;
  name: string;
  /** Centre tile. */
  x: number;
  y: number;
  /** Tiles from the industry asked about. */
  dist: number;
}

const centre = (ind: Industry) => ({ x: ind.x + Math.floor(ind.w / 2), y: ind.y + Math.floor(ind.h / 2) });

/** Tile distance between centres, measured the way deliveries are paid. */
const tiles = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

/** Industries that make `cargo` (for `ind` to receive), nearest first. */
export function cargoSources(ind: Industry, cargo: CargoId, industries: Iterable<Industry>, limit = Infinity): RouteEnd[] {
  const at = centre(ind);
  const out: RouteEnd[] = [];
  for (const o of industries) {
    if (o.id === ind.id || !industryType(o.type)?.produces.includes(cargo)) continue;
    const c = centre(o);
    out.push({ kind: 'industry', id: o.id, name: o.name, x: c.x, y: c.y, dist: tiles(at, c) });
  }
  return out.sort((a, b) => a.dist - b.dist).slice(0, limit);
}

/** Industries, and towns big enough, that take `cargo` (for `ind` to send it to), nearest first. */
export function cargoDestinations(ind: Industry, cargo: CargoId, industries: Iterable<Industry>, towns: Iterable<Town>, limit = Infinity): RouteEnd[] {
  const at = centre(ind);
  const out: RouteEnd[] = [];
  for (const o of industries) {
    if (o.id === ind.id || !industryType(o.type)?.accepts.includes(cargo)) continue;
    const c = centre(o);
    out.push({ kind: 'industry', id: o.id, name: o.name, x: c.x, y: c.y, dist: tiles(at, c) });
  }
  const need = townAcceptsAt(cargo);
  if (need !== undefined) {
    for (const t of towns) if (t.population >= need) out.push({ kind: 'town', id: t.id, name: t.name, x: t.x, y: t.y, dist: tiles(at, t) });
  }
  return out.sort((a, b) => a.dist - b.dist).slice(0, limit);
}
