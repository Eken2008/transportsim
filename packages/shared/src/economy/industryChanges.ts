import type { GameState } from '../sim/state.ts';
import type { Random } from '../util/random.ts';
import {
  clearIndustry,
  industryFits,
  industryName,
  industryType,
  newIndustry,
  pickIndustryType,
  placeIndustry,
  plantFarmFields,
  transportedShare,
  zoneFits,
  type Industry,
} from './industries.ts';

/** Production level bounds for primary industries. */
export const MIN_LEVEL = 0.25;
export const MAX_LEVEL = 8;
/** Months without service before an industry may close. */
export const CLOSE_AFTER_MONTHS = 60;
/** New industries per year per this many map tiles. */
const TILES_PER_NEW_INDUSTRY = 120_000;

/** Was the industry served last month (cargo taken away, or delivered to it)? */
function served(ind: Industry): boolean {
  const t = Object.values(ind.lastTransported).reduce((s, n) => s + (n ?? 0), 0);
  const d = Object.values(ind.lastDelivered).reduce((s, n) => s + (n ?? 0), 0);
  return t > 0 || d > 0;
}

/**
 * Monthly industry changes: well-served primary industries grow, neglected ones shrink;
 * industries unserved for years may close; and now and then a new one opens.
 */
export function industryMonthly(state: GameState, rng: Random, year: number): void {
  for (const ind of [...state.industries.values()]) {
    const type = industryType(ind.type);
    if (!type) continue;
    ind.idleMonths = served(ind) ? 0 : (ind.idleMonths ?? 0) + 1;
    state.dirtyIndustries.add(ind.id);

    if (type.production > 0) {
      const share = Math.min(...type.produces.map((c) => transportedShare(ind, c)));
      let factor = 1;
      if (share >= 0.6 && rng.chance(0.08)) factor = 1.25;
      else if (share < 0.2 && rng.chance(0.04)) factor = 0.8;
      else if (rng.chance(0.02)) factor = rng.chance(0.5) ? 1.1 : 0.9;
      const level = Math.max(MIN_LEVEL, Math.min(MAX_LEVEL, ind.level * factor));
      if (level !== ind.level) {
        const up = level > ind.level;
        ind.level = level;
        // Only news for industries someone serves.
        if (ind.idleMonths === 0) state.addNews('company', `${ind.name} ${up ? 'increases' : 'reduces'} production`, { tile: centre(state, ind) });
      }
    }

    // Closure: long unserved, and (primary industries) at low production.
    if ((ind.idleMonths ?? 0) >= CLOSE_AFTER_MONTHS && (type.production === 0 || ind.level <= 0.5) && rng.chance(0.1)) {
      state.addNews('company', `${ind.name} announces its closure`, { tile: centre(state, ind) });
      clearIndustry(state.map, ind);
      state.industries.delete(ind.id);
      state.dirtyIndustries.delete(ind.id);
      state.removedIndustries.add(ind.id);
    }
  }

  // New industries: about one a year per TILES_PER_NEW_INDUSTRY tiles of map.
  const perMonth = (state.map.width * state.map.height) / TILES_PER_NEW_INDUSTRY / 12;
  if (rng.chance(Math.min(0.9, perMonth))) {
    const type = pickIndustryType(rng, year, state.map.climate.id);
    const towns = [...state.towns.values()];
    const others = [...state.industries.values()];
    for (let attempt = 0; attempt < 200; attempt++) {
      const x = rng.int(2, state.map.width - type.w - 2);
      const y = rng.int(2, state.map.height - type.h - 2);
      if (!industryFits(state.map, x, y, type.w, type.h, towns, others) || !zoneFits(state.map, type, x, y)) continue;
      const ind = newIndustry(state.nextIndustryId++, type, x, y, industryName(type, x, y, towns, others));
      placeIndustry(state.map, ind);
      if (type.model === 'farm') plantFarmFields(state.map, ind, rng);
      state.industries.set(ind.id, ind);
      state.dirtyIndustries.add(ind.id);
      state.addNews('company', `New ${type.name.toLowerCase()} opens: ${ind.name}`, { tile: centre(state, ind) });
      break;
    }
  }
}

const centre = (state: GameState, ind: Industry) => (ind.y + Math.floor(ind.h / 2)) * state.map.width + ind.x + Math.floor(ind.w / 2);
