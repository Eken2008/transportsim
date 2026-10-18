import type { Company } from '../company/company.ts';
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
  return state;
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
