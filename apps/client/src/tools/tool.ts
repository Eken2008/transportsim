import type { TerrainHit } from '../render/picking.ts';

/** A build/interaction tool driven by the renderer's pointer events (left button only). */
export interface Tool {
  onHover(hit: TerrainHit | null): void;
  onDown(hit: TerrainHit): void;
  onUp(hit: TerrainHit | null): void;
  /** Map data changed; recompute previews on next hover. */
  invalidate?(): void;
  /** Escape / tool switched. */
  cancel(): void;
}
