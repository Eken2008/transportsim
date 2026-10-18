import type { TerrainHit } from '../render/picking.ts';

export interface Modifiers {
  /** Ctrl (or Cmd): alternate action, e.g. remove instead of build. */
  ctrl: boolean;
  shift: boolean;
}

/** A build/interaction tool driven by the renderer's pointer events (left button only). */
export interface Tool {
  onHover(hit: TerrainHit | null, mods: Modifiers): void;
  onDown(hit: TerrainHit, mods: Modifiers): void;
  onUp(hit: TerrainHit | null, mods: Modifiers): void;
  /** Map data changed; recompute previews on next hover. */
  invalidate?(): void;
  /** Escape / tool switched. */
  cancel(): void;
}
