import type { GameMap } from '../world/map.ts';
import { TileType } from '../world/constants.ts';
import type { Town } from '../town/towns.ts';

export interface Station {
  id: number;
  name: string;
  owner: number;
  /** Sign position (tile), roughly the middle of the station. */
  x: number;
  y: number;
  /** Bounding box of station tiles (inclusive). */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  tiles: number;
  townId: number | null;
  builtDays: number;
  /** Passengers waiting, by destination station id. */
  waiting: Record<number, number>;
  /** Total waiting (cached sum of `waiting`). */
  waitingTotal: number;
  /** 0..255 like OpenTTD; affects how much cargo the station receives. */
  rating: number;
  /** Day a train last picked up passengers here. */
  lastPickup?: number;
}

/** Catchment radius around rail station tiles. */
export const STATION_CATCHMENT = 3;
export const MAX_PLATFORMS = 8;
export const MAX_PLATFORM_LENGTH = 16;
/** Max distance (tiles) between a new platform and an existing station to join it. */
export const STATION_JOIN_DISTANCE = 1;

const SUFFIXES = ['Central', 'North', 'South', 'East', 'West', 'Junction', 'Halt', 'Parkway', 'Road', 'Exchange', 'Bridge', 'Cross'];

/** Pick a unique name for a new station from the nearest town. */
export function stationName(x: number, y: number, towns: Iterable<Town>, existing: Iterable<Station>): { name: string; townId: number | null } {
  let best: Town | null = null;
  let bestD = Infinity;
  for (const t of towns) {
    const d = Math.abs(t.x - x) + Math.abs(t.y - y);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  const used = new Set([...existing].map((s) => s.name));
  const base = best ? best.name : 'Station';
  if (!used.has(base)) return { name: base, townId: best?.id ?? null };
  const dx = best ? x - best.x : 0;
  const dy = best ? y - best.y : 0;
  const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'East' : 'West') : dy > 0 ? 'South' : 'North';
  for (const s of [dir, ...SUFFIXES]) {
    const name = `${base} ${s}`;
    if (!used.has(name)) return { name, townId: best?.id ?? null };
  }
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!used.has(name)) return { name, townId: best?.id ?? null };
  }
}

/** Recompute bounding box, tile count and sign position from the map. */
export function recomputeStationExtent(map: GameMap, st: Station): void {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
  // Search a generous window around the previous bbox (stations only grow by joining nearby).
  const sx0 = Math.max(0, Math.min(st.x0, st.x) - MAX_PLATFORM_LENGTH - 2);
  const sy0 = Math.max(0, Math.min(st.y0, st.y) - MAX_PLATFORM_LENGTH - 2);
  const sx1 = Math.min(map.width - 1, Math.max(st.x1, st.x) + MAX_PLATFORM_LENGTH + 2);
  const sy1 = Math.min(map.height - 1, Math.max(st.y1, st.y) + MAX_PLATFORM_LENGTH + 2);
  for (let y = sy0; y <= sy1; y++) {
    for (let x = sx0; x <= sx1; x++) {
      const i = map.tileIndex(x, y);
      if (map.layers.type[i] !== TileType.Station || map.layers.data[i] !== st.id) continue;
      n++;
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
  }
  st.tiles = n;
  if (n === 0) return;
  st.x0 = x0;
  st.y0 = y0;
  st.x1 = x1;
  st.y1 = y1;
  st.x = Math.floor((x0 + x1) / 2);
  st.y = Math.floor((y0 + y1) / 2);
}

/** Depot tiles: `data` bits 0-1 hold the exit edge. */
export const depotExit = (data: number) => (data & 3) as 0 | 1 | 2 | 3;
