import type { TerraformCommand, TerraformMode } from '@transportsim/shared';
import { client } from '../net/client.ts';
import type { Cursor } from '../render/cursor.ts';
import type { TerrainHit } from '../render/picking.ts';
import { toast, useApp } from '../store.ts';
import type { Tool } from './tool.ts';

/**
 * Click a corner to raise/lower it by one level, or drag to affect a rectangle.
 * Level mode flattens the dragged rectangle to the height of the first corner.
 */
export class TerraformTool implements Tool {
  private start: { x: number; y: number; h: number } | null = null;
  private last: { x: number; y: number } | null = null;

  constructor(
    private readonly mode: TerraformMode,
    private readonly cursor: Cursor,
  ) {}

  private command(x: number, y: number): TerraformCommand {
    const s = this.start ?? { x, y, h: 0 };
    return { type: 'terraform', x0: s.x, y0: s.y, x1: x, y1: y, mode: this.mode, level: this.mode === 'level' ? s.h : undefined };
  }

  onHover(hit: TerrainHit | null): void {
    if (!hit) {
      if (!this.start) this.cursor.hide();
      useApp.setState({ hover: null });
      return;
    }
    const x = hit.cornerX;
    const y = hit.cornerY;
    if (this.last && this.last.x === x && this.last.y === y) return;
    this.last = { x, y };
    const world = client.world;
    if (!world) return;
    const s = this.start ?? { x, y };
    this.cursor.showCornerRect(s.x, s.y, x, y);
    const height = world.map.cornerHeight(x, y);
    // Level needs an area; previewing a single corner would always say "Already level".
    if (this.mode === 'level' && !this.start) {
      this.cursor.setValid(true);
      useApp.setState({ hover: { x, y, height } });
      return;
    }
    const r = client.preview(this.command(x, y));
    this.cursor.setValid(!!r?.ok);
    useApp.setState({ hover: { x, y, height, cost: r?.ok ? r.cost : undefined, error: r && !r.ok ? r.error : undefined } });
  }

  onDown(hit: TerrainHit): void {
    const map = client.world?.map;
    if (!map) return;
    this.start = { x: hit.cornerX, y: hit.cornerY, h: map.cornerHeight(hit.cornerX, hit.cornerY) };
    this.last = null;
    this.onHover(hit);
  }

  onUp(hit: TerrainHit | null): void {
    if (!this.start) return;
    const end = hit ? { x: hit.cornerX, y: hit.cornerY } : this.last;
    if (end) {
      const cmd = this.command(end.x, end.y);
      void client.command(cmd).then((r) => {
        if (!r.ok && r.error) toast(r.error, 'error', 2500);
      });
    }
    this.start = null;
    this.last = null;
    this.onHover(hit);
  }

  /** Map data changed under the cursor: recompute the preview on the next hover. */
  invalidate(): void {
    this.last = null;
  }

  cancel(): void {
    this.start = null;
    this.last = null;
    this.cursor.hide();
    useApp.setState({ hover: null });
  }
}
