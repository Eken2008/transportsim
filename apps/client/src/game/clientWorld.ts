import {
  CHUNK_SIZE,
  CROSSING_FLAG,
  TileType,
  GameMap,
  GameState,
  applyChunk,
  type ChunkData,
  type GameSettings,
  type GlobalState,
  type Industry,
  type Station,
  type Town,
  type TrainInfo,
  type TrainMotion,
} from '@transportsim/shared';

/**
 * The client's partial mirror of the game. The full-size map is allocated up front,
 * but only chunks the server has sent are valid (see `loaded`).
 */
export class ClientWorld {
  readonly state: GameState;
  readonly loaded: Uint8Array;
  private chunkListeners = new Set<(cx: number, cy: number) => void>();
  /** Bumped when the town list changes (labels re-read it). */
  townsRev = 0;
  /** Bumped when stations change. */
  stationsRev = 0;
  /** Bumped when industries change. */
  industriesRev = 0;
  /** Bumped when the waypoint list changes. */
  waypointsRev = 0;
  private waypointsKey = '';
  /** All trains (details), and the latest motion sample for trains near our view. */
  readonly trains = new Map<number, TrainInfo>();
  trainsRev = 0;
  readonly motions = new Map<number, { m: TrainMotion; at: number }>();
  /** Signal tile → mask of trackdirs showing red (only for tiles near our view). */
  readonly signalRed = new Map<number, number>();
  /** Path-reserved pieces (tile * 8 + piece) near our view. */
  reserved: number[] = [];
  signalsRev = 0;
  /** Level crossing tiles in received chunks (for barrier animation). */
  readonly crossings = new Set<number>();
  private chunkCrossings = new Map<number, number[]>();
  /** Hook for transient effects (income labels); set by the renderer. */
  onIncome: ((tile: number, amount: number) => void) | null = null;

  constructor(settings: GameSettings) {
    this.state = new GameState(settings, new GameMap(settings.mapWidth, settings.mapHeight));
    this.loaded = new Uint8Array(this.state.map.chunksX * this.state.map.chunksY);
  }

  get map(): GameMap {
    return this.state.map;
  }

  isLoaded(cx: number, cy: number): boolean {
    return this.loaded[cy * this.state.map.chunksX + cx] === 1;
  }

  applyChunk(data: ChunkData): void {
    applyChunk(this.state.map, data);
    this.indexCrossings(data.cx, data.cy);
    this.loaded[data.cy * this.state.map.chunksX + data.cx] = 1;
    for (const l of this.chunkListeners) l(data.cx, data.cy);
  }

  private indexCrossings(cx: number, cy: number): void {
    const map = this.state.map;
    const id = cy * map.chunksX + cx;
    for (const t of this.chunkCrossings.get(id) ?? []) this.crossings.delete(t);
    const found: number[] = [];
    for (let y = cy * CHUNK_SIZE; y < (cy + 1) * CHUNK_SIZE; y++) {
      for (let x = cx * CHUNK_SIZE; x < (cx + 1) * CHUNK_SIZE; x++) {
        const i = y * map.width + x;
        if (map.layers.type[i] === TileType.Rail && map.layers.data[i]! & CROSSING_FLAG) found.push(i);
      }
    }
    for (const t of found) this.crossings.add(t);
    this.chunkCrossings.set(id, found);
  }

  applyGlobal(g: GlobalState): void {
    const s = this.state;
    s.tick = g.tick;
    s.date = g.date;
    s.dayTick = g.dayTick;
    s.companies.clear();
    for (const c of g.companies) s.companies.set(c.id, c);
    s.players.clear();
    for (const p of g.players) s.players.set(p.id, p);
    s.setAgreements(g.agreements);
    if (g.inflation) Object.assign(s.inflation, g.inflation);
    const key = JSON.stringify(g.waypoints ?? []);
    if (key !== this.waypointsKey) {
      this.waypointsKey = key;
      this.waypointsRev++;
      s.waypoints.clear();
      for (const w of g.waypoints ?? []) s.waypoints.set(w.id, w);
    }
  }

  applyTowns(towns: Town[], full: boolean): void {
    if (full) this.state.towns.clear();
    for (const t of towns) this.state.towns.set(t.id, t);
    this.townsRev++;
  }

  applyIndustries(industries: Industry[], removed: number[], full: boolean): void {
    const m = this.state.industries;
    if (full) m.clear();
    for (const ind of industries) m.set(ind.id, ind);
    for (const id of removed) m.delete(id);
    this.industriesRev++;
  }

  applyStations(stations: Station[], removed: number[], full: boolean): void {
    const s = this.state.stations;
    if (full) s.clear();
    for (const st of stations) s.set(st.id, st);
    for (const id of removed) s.delete(id);
    this.stationsRev++;
  }

  applyTrains(trains: TrainInfo[], removed: number[], full: boolean): void {
    if (full) {
      this.trains.clear();
      this.state.trains.clear();
    }
    for (const t of trains) {
      this.trains.set(t.id, t);
      // Mirror into the game state so command previews (e.g. editing a consist) can validate.
      this.state.trains.set(t.id, { ...t, path: [], pos: 0, route: [], routeFor: -1, replanAt: 0 });
      this.state.rail.invalidateStats(this.state.trains.get(t.id)!);
    }
    for (const id of removed) {
      this.trains.delete(id);
      this.state.trains.delete(id);
      this.motions.delete(id);
    }
    // Trains parked in a depot are no longer on the map.
    for (const t of trains) if (t.status === 'depot') this.motions.delete(t.id);
    this.trainsRev++;
  }

  applyTrainPositions(motions: TrainMotion[]): void {
    const now = performance.now();
    const seen = new Set<number>();
    for (const m of motions) {
      this.motions.set(m.id, { m, at: now });
      seen.add(m.id);
    }
    // Drop trains that left our view (no update for a while).
    for (const [id, v] of this.motions) if (!seen.has(id) && now - v.at > 1500) this.motions.delete(id);
  }

  applySignals(tiles: number[], red: number[], reserved: number[]): void {
    this.signalRed.clear();
    tiles.forEach((t, i) => this.signalRed.set(t, red[i]!));
    this.reserved = reserved;
    this.signalsRev++;
  }

  onChunk(fn: (cx: number, cy: number) => void): () => void {
    this.chunkListeners.add(fn);
    return () => this.chunkListeners.delete(fn);
  }
}
