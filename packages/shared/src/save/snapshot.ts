import { COMPANY_ROLES, MAX_MEMBERS, type Company, type CompanyMember } from '../company/company.ts';
import type { Station } from '../rail/station.ts';
import { railVehicle } from '../vehicles/catalog.ts';
import { linkAllByGeometry } from '../rail/links.ts';
import type { Train } from '../vehicles/train.ts';
import { HEIGHT_SCALE, TileType, WATER_BUOY } from '../world/constants.ts';
import { recountTowns, type Town, type TownStats } from '../town/towns.ts';
import { REPUTATION_MAX, REPUTATION_MIN } from '../town/reputation.ts';
import { decode, encode } from '../protocol/codec.ts';
import { sanitizeNews, type NewsItem } from '../news/news.ts';
import { sanitizeAgreements, type Agreement } from '../company/sharing.ts';
import { WAYPOINT_FLAG, type Waypoint } from '../rail/waypoint.ts';
import { JUMP_CONDITIONS, type AirPhase, type AirState, type Order, type ShipState } from '../vehicles/train.ts';
import { LINE_COLORS, VEHICLE_MODES, addLine, vehicleMode, type Line } from '../vehicles/lines.ts';
import { isCargo } from '../economy/cargo.ts';
import { industryType, newIndustry, type CargoAmounts, type Industry } from '../economy/industries.ts';
import type { StationPacket } from '../economy/cargoSystem.ts';
import { emptyInfrastructure, sanitizeDelivered, sanitizeFinances, sanitizeHistory, sanitizeLedger, sanitizeModes } from '../economy/finance.ts';
import { sanitizeSettings, type GameSettings, type ServerLimits } from '../sim/settings.ts';
import { GameState } from '../sim/state.ts';
import { TICKS_PER_DAY, daysFromYmd } from '../sim/date.ts';
import { GameMap, LAYER_NAMES, TILE_LAYERS, type LayerArray, type LayerName } from '../world/map.ts';

export const SAVE_FORMAT = 'transportsim-save';
export const SAVE_VERSION = 3;

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
  lines?: Line[];
  nextLineId?: number;
  news?: NewsItem[];
  nextNewsId?: number;
  agreements?: Agreement[];
  nextAgreementId?: number;
  waypoints?: Waypoint[];
  nextWaypointId?: number;
  /** Cargo waiting at stations: [station id, packets]. */
  cargoPackets?: [number, StationPacket[]][];
  industries?: Industry[];
  nextIndustryId?: number;
  inflation?: { costs: number; payments: number };
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
    lines: [...state.lines.values()],
    nextLineId: state.nextLineId,
    news: state.news,
    nextNewsId: state.nextNewsId,
    agreements: [...state.agreements.values()],
    nextAgreementId: state.nextAgreementId,
    waypoints: [...state.waypoints.values()],
    nextWaypointId: state.nextWaypointId,
    cargoPackets: [...state.cargo.packets.entries()],
    industries: [...state.industries.values()],
    nextIndustryId: state.nextIndustryId,
    inflation: state.inflation,
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
      history: sanitizeHistory(c.history),
      month: { ledger: sanitizeLedger(c.month?.ledger), modes: sanitizeModes(c.month?.modes), delivered: sanitizeDelivered(c.month?.delivered) },
      badQuarters: Math.max(0, Math.floor(num(c.badQuarters, 0))),
      infrastructure: emptyInfrastructure(),
      value: num(c.value, 0),
      autorenew: c.autorenew !== false,
      replace: Object.fromEntries(
        Object.entries(c.replace ?? {}).filter(([from, to]) => typeof to === 'string' && railVehicle(from) && railVehicle(to)),
      ),
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
      growth: typeof t.growth === 'number' ? Math.max(0, Math.min(1, t.growth)) : undefined,
      stats: townStats(t.stats),
      lastStats: townStats(t.lastStats),
      ratings: townRatings(t.ratings),
    });
  }
  recountTowns(map, state.towns.values());
  const amounts = (v: unknown): CargoAmounts =>
    Object.fromEntries(Object.entries(v && typeof v === 'object' ? v : {}).filter(([c, n]) => isCargo(c) && typeof n === 'number' && n >= 0));
  for (const ind of Array.isArray(snap.industries) ? snap.industries : []) {
    const type = ind && typeof ind.id === 'number' ? industryType(String(ind.type)) : undefined;
    if (!type) continue;
    state.industries.set(ind.id, {
      ...newIndustry(ind.id, type, num(ind.x, 0), num(ind.y, 0), String(ind.name ?? type.name).slice(0, 60)),
      level: Math.max(0.25, Math.min(8, num(ind.level, 1))),
      input: amounts(ind.input),
      produced: amounts(ind.produced),
      transported: amounts(ind.transported),
      delivered: amounts(ind.delivered),
      lastProduced: amounts(ind.lastProduced),
      lastTransported: amounts(ind.lastTransported),
      lastDelivered: amounts(ind.lastDelivered),
      idleMonths: typeof ind.idleMonths === 'number' ? Math.max(0, Math.floor(ind.idleMonths)) : undefined,
    });
  }
  state.inflation.costs = Math.max(1, Math.min(20, num(snap.inflation?.costs, 1)));
  state.inflation.payments = Math.max(1, Math.min(20, num(snap.inflation?.payments, 1)));
  state.nextIndustryId = Math.max(num(snap.nextIndustryId, 0), ...[...state.industries.keys()].map((k) => k + 1));
  const savedPackets = new Map(Array.isArray(snap.cargoPackets) ? snap.cargoPackets : []);
  for (const s of Array.isArray(snap.stations) ? snap.stations : []) {
    if (!s || typeof s.id !== 'number' || s.id < 0 || s.id > 0xffff) continue;
    // Cargo waiting: saved packets, or (older saves) passenger counts by destination.
    const packets: StationPacket[] = [];
    const saved = savedPackets.get(s.id);
    if (Array.isArray(saved)) {
      for (const p of saved) {
        if (!p || !isCargo(p.cargo) || num(p.n, 0) <= 0) continue;
        packets.push({ cargo: p.cargo, dest: num(p.dest, -1), src: num(p.src, s.id), n: Math.floor(p.n), day: num(p.day, state.date) });
      }
    } else {
      for (const [k, v] of Object.entries((s.waiting ?? {}) as Record<string, unknown>)) {
        if (typeof v === 'number' && v > 0) packets.push({ cargo: 'passengers', dest: Number(k), src: s.id, n: Math.floor(v), day: state.date });
      }
    }
    state.cargo.packets.set(s.id, packets);
    state.stations.set(s.id, {
      id: s.id,
      name: String(s.name ?? 'Station').slice(0, 48),
      owner: num(s.owner, 0),
      x: num(s.x, 0), y: num(s.y, 0), x0: num(s.x0, 0), y0: num(s.y0, 0), x1: num(s.x1, 0), y1: num(s.y1, 0),
      tiles: num(s.tiles, 0),
      townId: typeof s.townId === 'number' ? s.townId : null,
      builtDays: num(s.builtDays, state.date),
      waiting: {},
      waitingTotal: 0,
      rating: num(s.rating, 175),
      lastPickup: typeof s.lastPickup === 'number' ? s.lastPickup : undefined,
      lastSpeed: typeof s.lastSpeed === 'number' ? s.lastSpeed : undefined,
      lastVehicleAge: typeof s.lastVehicleAge === 'number' ? s.lastVehicleAge : undefined,
      // Saves from before first-arrival news: stations that had trains already count as served.
      firstArrival: typeof s.firstArrival === 'number' ? s.firstArrival : typeof s.lastPickup === 'number' ? s.lastPickup : undefined,
      airport:
        s.airport && (s.airport.kind === 'small' || s.airport.kind === 'large') ? { kind: s.airport.kind, x: num(s.airport.x, 0), y: num(s.airport.y, 0) } : undefined,
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
    if (map.layers.type[i] === TileType.RoadDepot) state.roadDepots.add(i);
    if (map.layers.type[i] === TileType.ShipDepot) state.shipDepots.add(i);
    if (map.layers.signals[i]) state.signalTiles.add(i);
  }
  for (const l of Array.isArray(snap.lines) ? snap.lines : []) {
    if (!l || typeof l.id !== 'number' || !state.companies.has(l.owner) || !VEHICLE_MODES.includes(l.mode)) continue;
    state.lines.set(l.id, {
      id: l.id,
      owner: l.owner,
      name: String(l.name ?? 'Line').slice(0, 40),
      mode: l.mode,
      color: Number.isInteger(l.color) && l.color >= 0 && l.color < LINE_COLORS.length ? l.color : 0,
      orders: sanitizeOrders(l.orders),
    });
  }
  state.nextLineId = Math.max(num(snap.nextLineId, 0), ...[...state.lines.keys()].map((k) => k + 1));
  for (const t of Array.isArray(snap.trains) ? snap.trains : []) {
    const train = sanitizeTrain(t, state, snap.version);
    if (train) state.trains.set(train.id, train);
  }
  state.nextTrainId = Math.max(num(snap.nextTrainId, 0), ...[...state.trains.keys()].map((k) => k + 1));
  // Vehicles follow their line's orders. Saves from before lines: vehicles of a company with the
  // same orders share a new line.
  const migrated = new Map<string, Line>();
  for (const t of state.trains.values()) {
    const line = t.line !== undefined ? state.lines.get(t.line) : undefined;
    if (line && line.owner === t.owner && line.mode === vehicleMode(t)) {
      t.orders = line.orders;
      continue;
    }
    t.line = undefined;
    if (t.orders.length === 0) continue;
    const key = `${t.owner}|${vehicleMode(t)}|${JSON.stringify(t.orders)}`;
    let shared = migrated.get(key);
    if (!shared) migrated.set(key, (shared = addLine(state, t.owner, vehicleMode(t), t.orders)));
    t.line = shared.id;
    t.orders = shared.orders;
  }
  state.dirtyLines.clear();
  state.rail.rebuildOccupancy();
  state.road.rebuildOccupancy();
  state.air.rebuild();
  state.ships.rebuild();
  state.countInfrastructure();
  for (const c of state.companies.values()) if (!c.value) c.value = state.companyValue(c);
  state.setAgreements(sanitizeAgreements(snap.agreements, new Set(state.companies.keys())));
  state.nextAgreementId = Math.max(num(snap.nextAgreementId, 1), ...[...state.agreements.keys()].map((k) => k + 1));
  for (const w of Array.isArray(snap.waypoints) ? snap.waypoints : []) {
    if (!w || typeof w.id !== 'number' || typeof w.tile !== 'number') continue;
    const buoy = w.buoy === true;
    if (buoy ? map.layers.type[w.tile] !== TileType.Water || !(map.layers.data[w.tile]! & WATER_BUOY) : map.layers.type[w.tile] !== TileType.Rail || !(map.layers.data[w.tile]! & WAYPOINT_FLAG)) continue;
    state.waypoints.set(w.id, { id: w.id, name: String(w.name ?? 'Waypoint').slice(0, 48), owner: num(w.owner, 0), tile: w.tile, buoy: buoy || undefined });
  }
  state.nextWaypointId = Math.max(num(snap.nextWaypointId, 0), ...[...state.waypoints.keys()].map((k) => k + 1));
  state.news.push(...sanitizeNews(snap.news));
  state.nextNewsId = Math.max(num(snap.nextNewsId, 1), ...state.news.map((n) => n.id + 1));
  for (const st of state.stations.values()) state.cargo.summarise(st);
  state.dirtyStations.clear();
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

function townStats(v: unknown): TownStats | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const s = v as Partial<TownStats>;
  return { passengers: num(s.passengers, 0), mail: num(s.mail, 0), goods: num(s.goods, 0), food: num(s.food, 0) };
}

function townRatings(v: unknown): Record<number, number> | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const out: Record<number, number> = {};
  for (const [k, r] of Object.entries(v)) {
    if (/^\d+$/.test(k) && typeof r === 'number' && Number.isFinite(r)) out[Number(k)] = Math.round(Math.max(REPUTATION_MIN, Math.min(REPUTATION_MAX, r)));
  }
  return Object.keys(out).length ? out : undefined;
}

const PHASES: AirPhase[] = ['taxi', 'gate', 'hold', 'takeoff', 'flying', 'holding', 'landing'];

function sanitizeAir(a: AirState | undefined, map: GameMap, version: number): AirState | undefined {
  if (!a || !PHASES.includes(a.phase)) return undefined;
  // Before version 3 heights were tiles above the ground below (0.9 world units each).
  const altitude = (x: number, y: number, z: number) =>
    version >= 3 ? z : map.heightAt(Math.max(0, Math.min(map.width - 0.01, x)), Math.max(0, Math.min(map.height - 0.01, y))) * HEIGHT_SCALE + z * 0.9;
  const x = num(a.x, 0);
  const y = num(a.y, 0);
  return {
    phase: a.phase,
    x,
    y,
    z: altitude(x, y, num(a.z, 0)),
    heading: num(a.heading, 0),
    airport: num(a.airport, -1),
    legs: (Array.isArray(a.legs) ? a.legs : [])
      .filter((l) => Array.isArray(l) && l.length === 3 && l.every((n) => typeof n === 'number' && Number.isFinite(n)))
      .slice(0, 256)
      .map(([lx, ly, lz]) => [lx, ly, altitude(lx, ly, lz)] as [number, number, number]),
    gate: typeof a.gate === 'number' ? a.gate : undefined,
    toHangar: a.toHangar === true || undefined,
    goal: a.goal === 'gate' || a.goal === 'hold' || a.goal === 'hangar' || a.goal === 'waitGate' ? a.goal : undefined,
  };
}

function sanitizeShip(s: ShipState | undefined, state: GameState): ShipState | undefined {
  if (!s) return undefined;
  const map = state.map;
  const x = num(s.x, -1);
  const y = num(s.y, -1);
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return undefined;
  return {
    x,
    y,
    heading: num(s.heading, 0),
    // The route is planned again after loading.
    path: [],
    lockWait: typeof s.lockWait === 'number' && s.lockWait > 0 ? Math.min(s.lockWait, 10_000) : undefined,
  };
}

const num = (v: unknown, fallback: number) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

const STATUSES = ['depot', 'running', 'stopped', 'loading'] as const;

function sanitizeTrain(t: Partial<Train> | null | undefined, state: GameState, version: number): Train | null {
  if (!t || typeof t.id !== 'number' || !Array.isArray(t.units)) return null;
  const units = t.units
    .filter((u) => u && typeof u.type === 'string' && railVehicle(u.type))
    .map((u) => (isCargo(u.cargo) && railVehicle(u.type)!.cargoes?.includes(u.cargo) ? { type: u.type, cargo: u.cargo } : { type: u.type }));
  if (units.length === 0) return null;
  const ints = (a: unknown) => (Array.isArray(a) ? a.filter((n): n is number => Number.isInteger(n) && n >= 0) : []);
  const status = STATUSES.includes(t.status as never) ? t.status! : 'stopped';
  const free = t.mode === 'air' || t.mode === 'water';
  const path = status === 'depot' || free ? [] : ints(t.path);
  const air = t.mode === 'air' && status !== 'depot' ? sanitizeAir(t.air, state.map, version) : undefined;
  const ship = t.mode === 'water' && status !== 'depot' ? sanitizeShip(t.ship, state) : undefined;
  // An aircraft or ship out of its depot is wherever its state says; without one it is lost.
  if (free && status !== 'depot' && !air && !ship) return null;
  return {
    id: t.id,
    mode: t.mode === 'road' || t.mode === 'air' || t.mode === 'water' ? t.mode : undefined,
    air,
    ship,
    owner: num(t.owner, 0),
    name: String(t.name ?? 'Train').slice(0, 40),
    units,
    status: path.length === 0 && status !== 'depot' && !air && !ship ? 'stopped' : status,
    depot: num(t.depot, -1),
    path,
    pos: num(t.pos, 0),
    speed: num(t.speed, 0),
    line: typeof t.line === 'number' ? t.line : undefined,
    orders: sanitizeOrders(t.orders),
    orderIndex: num(t.orderIndex, 0),
    toDepot: t.toDepot === true,
    route: [],
    routeFor: -1,
    replanAt: 0,
    loadTicks: num(t.loadTicks, 0),
    cargo: (Array.isArray(t.cargo) ? t.cargo : [])
      .filter((p) => p && num(p.n, 0) > 0)
      .map((p) => ({ ...p, cargo: isCargo(p.cargo) ? p.cargo : 'passengers' })),
    builtDays: num(t.builtDays, state.date),
    value: num(t.value, 0),
    profitThisYear: num(t.profitThisYear, 0),
    profitLastYear: num(t.profitLastYear, 0),
    lastStation: num(t.lastStation, -1),
    pbs: t.pbs === true,
    departedAt: typeof t.departedAt === 'number' ? t.departedAt : undefined,
    lateness: typeof t.lateness === 'number' ? t.lateness : undefined,
    autofill: t.autofill === true || undefined,
    lastService: typeof t.lastService === 'number' ? t.lastService : undefined,
    reliability: typeof t.reliability === 'number' ? Math.max(0, Math.min(1, t.reliability)) : undefined,
    brokenDown: Math.max(0, Math.floor(num(t.brokenDown, 0))) || undefined,
    breakdowns: Math.max(0, Math.floor(num(t.breakdowns, 0))) || undefined,
    serviceTrip: t.serviceTrip === true || undefined,
    serviceInterval: typeof t.serviceInterval === 'number' ? Math.max(30, Math.min(800, Math.round(t.serviceInterval))) : undefined,
    oldWarned: t.oldWarned === true || undefined,
    brakeFail: Math.max(0, Math.floor(num(t.brakeFail, 0))) || undefined,
  };
}

function sanitizeOrders(input: unknown): Order[] {
  return (Array.isArray(input) ? (input as Order[]) : []).filter(
    (o) =>
      o &&
      (o.kind === 'depot' ||
        (o.kind === 'station' && typeof o.station === 'number') ||
        (o.kind === 'waypoint' && typeof o.waypoint === 'number') ||
        (o.kind === 'jump' && typeof o.to === 'number' && JUMP_CONDITIONS.includes(o.cond))),
  );
}
