import {
  GameMap,
  GameState,
  applyChunk,
  type ChunkData,
  type GameSettings,
  type GlobalState,
  type Town,
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

  onChunk(fn: (cx: number, cy: number) => void): () => void {
    this.chunkListeners.add(fn);
    return () => this.chunkListeners.delete(fn);
  }
}
