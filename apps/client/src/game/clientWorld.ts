import {
  GameMap,
  GameState,
  applyChunk,
  type ChunkData,
  type GameSettings,
  type GlobalState,
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
  /** All trains (details), and the latest motion sample for trains near our view. */
  readonly trains = new Map<number, TrainInfo>();
  trainsRev = 0;
  readonly motions = new Map<number, { m: TrainMotion; at: number }>();

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
    this.loaded[data.cy * this.state.map.chunksX + data.cx] = 1;
    for (const l of this.chunkListeners) l(data.cx, data.cy);
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
  }

  applyTowns(towns: Town[], full: boolean): void {
    if (full) this.state.towns.clear();
    for (const t of towns) this.state.towns.set(t.id, t);
    this.townsRev++;
  }

  applyStations(stations: Station[], removed: number[], full: boolean): void {
    const s = this.state.stations;
    if (full) s.clear();
    for (const st of stations) s.set(st.id, st);
    for (const id of removed) s.delete(id);
    this.stationsRev++;
  }

  applyTrains(trains: TrainInfo[], removed: number[], full: boolean): void {
    if (full) this.trains.clear();
    for (const t of trains) this.trains.set(t.id, t);
    for (const id of removed) {
      this.trains.delete(id);
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

  onChunk(fn: (cx: number, cy: number) => void): () => void {
    this.chunkListeners.add(fn);
    return () => this.chunkListeners.delete(fn);
  }
}
