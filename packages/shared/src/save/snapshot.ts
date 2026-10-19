import { COMPANY_ROLES, MAX_MEMBERS, type Company, type CompanyMember } from '../company/company.ts';
import type { Station } from '../rail/station.ts';
import { railVehicle } from '../vehicles/catalog.ts';
import { linkAllByGeometry } from '../rail/links.ts';
import type { Train } from '../vehicles/train.ts';
import { TileType } from '../world/constants.ts';
import { recountTowns, type Town } from '../town/towns.ts';
import { decode, encode } from '../protocol/codec.ts';
import { sanitizeNews, type NewsItem } from '../news/news.ts';
import { sanitizeAgreements, type Agreement } from '../company/sharing.ts';
import { emptyInfrastructure, sanitizeFinances } from '../economy/finance.ts';
import { sanitizeSettings, type GameSettings, type ServerLimits } from '../sim/settings.ts';
import { GameState } from '../sim/state.ts';
import { TICKS_PER_DAY, daysFromYmd } from '../sim/date.ts';
import { GameMap, LAYER_NAMES, TILE_LAYERS, type LayerArray, type LayerName } from '../world/map.ts';

export const SAVE_FORMAT = 'transportsim-save';
export const SAVE_VERSION = 2;

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
  trains?: Train[];
  nextTrainId?: number;
  news?: NewsItem[];
  nextNewsId?: number;
  agreements?: Agreement[];
  nextAgreementId?: number;
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
    trains: [...state.trains.values()],
    nextTrainId: state.nextTrainId,
    news: state.news,
    nextNewsId: state.nextNewsId,
    agreements: [...state.agreements.values()],
    nextAgreementId: state.nextAgreementId,
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
      members: sanitizeMembers(c.members, true),
      requests: Array.isArray(c.requests) ? c.requests.map(String).slice(0, 16) : [],
      invites: sanitizeMembers(c.invites, false).slice(0, 16),
      foundedDays: num(c.foundedDays, state.date),
      finances: sanitizeFinances(c.finances, state.date),
      badQuarters: Math.max(0, Math.floor(num(c.badQuarters, 0))),
      infrastructure: emptyInfrastructure(),
      value: num(c.value, 0),
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
      lastPickup: typeof s.lastPickup === 'number' ? s.lastPickup : undefined,
      lastSpeed: typeof s.lastSpeed === 'number' ? s.lastSpeed : undefined,
      lastVehicleAge: typeof s.lastVehicleAge === 'number' ? s.lastVehicleAge : undefined,
      // Saves from before first-arrival news: stations that had trains already count as served.
      firstArrival: typeof s.firstArrival === 'number' ? s.firstArrival : typeof s.lastPickup === 'number' ? s.lastPickup : undefined,
    });
  }
  if (!snap.layers?.links) linkAllByGeometry(map); // saves from before explicit links
  if (!snap.layers?.railType) {
    // Saves from before track types: electrify all track so electric trains keep running.
    for (let i = 0; i < map.layers.type.length; i++) {
      const t = map.layers.type[i];
      if (t === TileType.Rail || t === TileType.Station || t === TileType.Depot) map.layers.railType[i] = 1;
    }
  }
  for (let i = 0; i < map.layers.type.length; i++) {
    if (map.layers.type[i] === TileType.Depot) state.depots.add(i);
    if (map.layers.signals[i]) state.signalTiles.add(i);
  }
  for (const t of Array.isArray(snap.trains) ? snap.trains : []) {
    const train = sanitizeTrain(t, state);
    if (train) state.trains.set(train.id, train);
  }
  state.nextTrainId = Math.max(num(snap.nextTrainId, 0), ...[...state.trains.keys()].map((k) => k + 1));
  state.rail.rebuildOccupancy();
  state.countInfrastructure();
  for (const c of state.companies.values()) if (!c.value) c.value = state.companyValue(c);
  state.setAgreements(sanitizeAgreements(snap.agreements, new Set(state.companies.keys())));
  state.nextAgreementId = Math.max(num(snap.nextAgreementId, 1), ...[...state.agreements.keys()].map((k) => k + 1));
  state.news.push(...sanitizeNews(snap.news));
  state.nextNewsId = Math.max(num(snap.nextNewsId, 1), ...state.news.map((n) => n.id + 1));
  state.nextStationId = Math.max(num(snap.nextStationId, 0), ...[...state.stations.keys()].map((k) => k + 1));
  return state;
}

/**
 * Members as saved. Version 1 saves list plain names: the first becomes the owner and the rest
 * managers. A company always ends up with exactly one owner when it has members.
 */
function sanitizeMembers(input: unknown, needOwner: boolean): CompanyMember[] {
  if (!Array.isArray(input)) return [];
  const out: CompanyMember[] = [];
  for (const [i, m] of input.entries()) {
    const name = String(typeof m === 'string' ? m : (m as CompanyMember)?.name ?? '').slice(0, 24);
    if (!name || out.some((o) => o.name === name)) continue;
    const role = typeof m === 'string' ? (i === 0 ? 'owner' : 'manager') : (m as CompanyMember).role;
    out.push({ name, role: COMPANY_ROLES.includes(role) ? role : 'viewer' });
  }
  if (needOwner && out.length > 0) {
    const owners = out.filter((m) => m.role === 'owner');
    for (const m of owners.slice(1)) m.role = 'manager';
    if (owners.length === 0) out[0]!.role = 'owner';
  } else if (!needOwner) {
    for (const m of out) if (m.role === 'owner') m.role = 'manager';
  }
  return out.slice(0, MAX_MEMBERS);
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

const STATUSES = ['depot', 'running', 'stopped', 'loading'] as const;

function sanitizeTrain(t: Partial<Train> | null | undefined, state: GameState): Train | null {
  if (!t || typeof t.id !== 'number' || !Array.isArray(t.units)) return null;
  const units = t.units.filter((u) => u && typeof u.type === 'string' && railVehicle(u.type)).map((u) => ({ type: u.type }));
  if (units.length === 0) return null;
  const ints = (a: unknown) => (Array.isArray(a) ? a.filter((n): n is number => Number.isInteger(n) && n >= 0) : []);
  const status = STATUSES.includes(t.status as never) ? t.status! : 'stopped';
  const path = status === 'depot' ? [] : ints(t.path);
  return {
    id: t.id,
    owner: num(t.owner, 0),
    name: String(t.name ?? 'Train').slice(0, 40),
    units,
    status: path.length === 0 && status !== 'depot' ? 'stopped' : status,
    depot: num(t.depot, -1),
    path,
    pos: num(t.pos, 0),
    speed: num(t.speed, 0),
    orders: (Array.isArray(t.orders) ? t.orders : []).filter(
      (o) => o && (o.kind === 'depot' || (o.kind === 'station' && typeof o.station === 'number')),
    ),
    orderIndex: num(t.orderIndex, 0),
    toDepot: t.toDepot === true,
    route: [],
    routeFor: '',
    replanAt: 0,
    loadTicks: num(t.loadTicks, 0),
    cargo: (Array.isArray(t.cargo) ? t.cargo : []).filter((p) => p && num(p.n, 0) > 0),
    builtDays: num(t.builtDays, state.date),
    value: num(t.value, 0),
    profitThisYear: num(t.profitThisYear, 0),
    profitLastYear: num(t.profitLastYear, 0),
    lastStation: num(t.lastStation, -1),
    pbs: t.pbs === true,
  };
}
