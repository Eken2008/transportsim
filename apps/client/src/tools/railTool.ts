import { autorailPath, nearestPiece, type Command, type PlacedPiece, type Piece } from '@transportsim/shared';
import { client } from '../net/client.ts';
import type { TerrainHit } from '../render/picking.ts';
import type { TrackGhost } from '../render/trackGhost.ts';
import { toast, useApp } from '../store.ts';
import type { Modifiers, Tool } from './tool.ts';

const BUILD_OK = '#7ee787';
const REMOVE_OK = '#ffa657';
const BAD = '#ff5a5f';

/**
 * Click to place the piece nearest the cursor, drag to lay a straight or diagonal line
 * (autorail). Hold Ctrl — or use the remove tool — to remove track instead.
 */
export class RailTool implements Tool {
  private start: PlacedPiece | null = null;
  private lastKey = '';
  private lastHit: TerrainHit | null = null;

  constructor(
    private readonly ghost: TrackGhost,
    private readonly removeMode: boolean,
  ) {}

  private pieceUnder(hit: TerrainHit): PlacedPiece {
    const fx = hit.point.x - hit.tileX;
    const fy = hit.point.z - hit.tileY;
    return { x: hit.tileX, y: hit.tileY, piece: nearestPiece(fx, fy) as Piece };
  }

  private pieces(hit: TerrainHit): PlacedPiece[] {
    if (!this.start) return [this.pieceUnder(hit)];
    return autorailPath(this.start.x, this.start.y, this.start.piece, hit.tileX, hit.tileY);
  }

  private command(pieces: PlacedPiece[], remove: boolean): Command {
    return { type: remove ? 'removeTrack' : 'buildTrack', pieces: pieces.flatMap((p) => [p.x, p.y, p.piece]) };
  }

  onHover(hit: TerrainHit | null, mods: Modifiers): void {
    this.lastHit = hit;
    if (!hit) {
      if (!this.start) this.ghost.hide();
      useApp.setState({ hover: null });
      this.lastKey = '';
      return;
    }
    const remove = this.removeMode || mods.ctrl;
    const pieces = this.pieces(hit);
    const key = `${remove}|${pieces.map((p) => `${p.x},${p.y},${p.piece}`).join(';')}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const r = client.preview(this.command(pieces, remove));
    this.ghost.show(pieces, r?.ok ? (remove ? REMOVE_OK : BUILD_OK) : BAD);
    const height = client.world?.map.cornerHeight(hit.cornerX, hit.cornerY) ?? 0;
    useApp.setState({
      hover: { x: hit.tileX, y: hit.tileY, height, cost: r?.ok ? r.cost : undefined, error: r && !r.ok ? r.error : undefined },
    });
  }

  onDown(hit: TerrainHit, mods: Modifiers): void {
    this.start = this.pieceUnder(hit);
    this.lastKey = '';
    this.onHover(hit, mods);
  }

  onUp(hit: TerrainHit | null, mods: Modifiers): void {
    if (!this.start) return;
    const target = hit ?? this.lastHit;
    if (target) {
      const cmd = this.command(this.pieces(target), this.removeMode || mods.ctrl);
      void client.command(cmd).then((r) => {
        if (!r.ok && r.error && r.error !== 'Already built') toast(r.error, 'error', 2500);
      });
    }
    this.start = null;
    this.lastKey = '';
    this.onHover(hit, mods);
  }

  invalidate(): void {
    this.lastKey = '';
  }

  cancel(): void {
    this.start = null;
    this.lastKey = '';
    this.ghost.hide();
    useApp.setState({ hover: null });
  }
}
