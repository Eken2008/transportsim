import type { Company } from '../company/company.ts';
import type { Station } from '../rail/station.ts';
import { recountTowns, type Town } from '../town/towns.ts';
import { decode, encode } from '../protocol/codec.ts';
import { sanitizeSettings, type GameSettings, type ServerLimits } from '../sim/settings.ts';
import { GameState } from '../sim/state.ts';
import { TICKS_PER_DAY, daysFromYmd } from '../sim/date.ts';
import { GameMap, LAYER_NAMES, TILE_LAYERS, type LayerArray, type LayerName } from '../world/map.ts';

export const SAVE_FORMAT = 'transportsim-save';
export const SAVE_VERSION = 1;

export interface Snapshot {
  format: typeof SAVE_FORMAT;
  version: number;
  savedAt: number;
  settings: GameSettings;
  tick: number;
  date: number;
  dayTick: number;
  heights: Uint8Array;
  layers: Record<LayerName, LayerArray>;
  companies: Company[];
  towns: Town[];
  stations?: Station[];
  nextStationId?: number;
}

export function takeSnapshot(state: GameState): Snapshot {
  const layers = {} as Record<LayerName, LayerArray>;
  for (const name of LAYER_NAMES) layers[name] = state.map.layers[name];
  return {
    format: SAVE_FORMAT,
    version: SAVE_VERSION,
    savedAt: Date.now(),
    settings: state.settings,
    tick: state.tick,
    date: state.date,
    dayTick: state.dayTick,
    heights: state.map.heights,
    layers,
    companies: [...state.companies.values()],
    towns: [...state.towns.values()],
    stations: [...state.stations.values()],
    nextStationId: state.nextStationId,
  };
}

/** Encode a snapshot to bytes (msgpack, uncompressed; the browser gzips for storage). */
export function encodeSnapshot(state: GameState): Uint8Array {
  return encode(takeSnapshot(state));
}

/**
 * Rebuild a GameState from untrusted snapshot bytes. Throws on malformed input.
 * Settings are re-sanitized against the server's limits.
 */
export function restoreSnapshot(bytes: Uint8Array, limits: ServerLimits, overrides: Partial<GameSettings> = {}): GameState {
  const snap = decode<Snapshot>(bytes);
  if (!snap || snap.format !== SAVE_FORMAT) throw new Error('Not a TransportSim save');
  if (snap.version > SAVE_VERSION) throw new Error('Save was made by a newer version');
  const settings = sanitizeSettings({ ...snap.settings, ...overrides }, limits);
  if (settings.mapWidth !== snap.settings.mapWidth || settings.mapHeight !== snap.settings.mapHeight) {
    throw new Error('Save map size exceeds server limits');
  }
  const map = new GameMap(settings.mapWidth, settings.mapHeight);
  if (!(snap.heights instanceof Uint8Array) || snap.heights.length !== map.heights.length) {
    throw new Error('Corrupt save (heights)');
  }
  map.heights.set(snap.heights);
  for (const name of LAYER_NAMES) {
    const src = snap.layers?.[name];
    const dst = map.layers[name] as LayerArray;
    if (!src) continue; // layer added after this save was made: keep defaults
    if (!(src instanceof TILE_LAYERS[name]) || src.length !== dst.length) {
      throw new Error(`Corrupt save (${name})`);
    }
    dst.set(src);
  }
  const state = new GameState(settings, map, num(snap.date, daysFromYmd(settings.startYear, 0, 1)));
  state.tick = num(snap.tick, 0);
  state.dayTick = Math.min(TICKS_PER_DAY - 1, Math.max(0, num(snap.dayTick, 0)));
  for (const c of Array.isArray(snap.companies) ? snap.companies : []) {
    if (!c || typeof c.id !== 'number') continue;
    state.companies.set(c.id, {
      id: c.id,
      name: String(c.name ?? 'Company').slice(0, 40),
      color: num(c.color, 0),
      money: num(c.money, 0),
      loan: num(c.loan, 0),
      members: Array.isArray(c.members) ? c.members.map(String) : [],
      foundedDays: num(c.foundedDays, state.date),
    });
  }
  for (const t of Array.isArray(snap.towns) ? snap.towns : []) {
    if (!t || typeof t.id !== 'number') continue;
    state.towns.set(t.id, {
      id: t.id,
      name: String(t.name ?? 'Town').slice(0, 40),
      x: num(t.x, 0),
      y: num(t.y, 0),
      population: 0,
      houses: 0,
    });
  }
  recountTowns(map, state.towns.values());
  for (const s of Array.isArray(snap.stations) ? snap.stations : []) {
    if (!s || typeof s.id !== 'number' || s.id < 0 || s.id > 0xffff) continue;
    const waiting: Record<number, number> = {};
    let total = 0;
    for (const [k, v] of Object.entries(s.waiting ?? {})) {
      const n = num(v, 0);
      if (n > 0) {
        waiting[Number(k)] = n;
        total += n;
      }
    }
    state.stations.set(s.id, {
      id: s.id,
      name: String(s.name ?? 'Station').slice(0, 48),
      owner: num(s.owner, 0),
      x: num(s.x, 0), y: num(s.y, 0), x0: num(s.x0, 0), y0: num(s.y0, 0), x1: num(s.x1, 0), y1: num(s.y1, 0),
      tiles: num(s.tiles, 0),
      townId: typeof s.townId === 'number' ? s.townId : null,
      builtDays: num(s.builtDays, state.date),
      waiting,
      waitingTotal: total,
      rating: num(s.rating, 175),
    });
  }
  state.nextStationId = Math.max(num(snap.nextStationId, 0), ...[...state.stations.keys()].map((k) => k + 1));
  return state;
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
