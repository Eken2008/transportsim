import { TileType, hasPiece, nearestPiece, type Command, type PlacedPiece, type Piece } from '@transportsim/shared';
import { client } from '../net/client.ts';
import type { TerrainHit } from '../render/picking.ts';
import type { TrackGhost } from '../render/trackGhost.ts';
import { toast, useApp } from '../store.ts';
import type { Modifiers, Tool } from './tool.ts';

const NAMES = ['no signal', 'one-way signal', 'one-way signal (other direction)', 'two-way signals'];

/**
 * Click a piece of plain track to cycle its signals: one way → the other way → both → none.
 * Ctrl-click removes them.
 */
export class SignalTool implements Tool {
  private lastKey = '';

  constructor(private readonly ghost: TrackGhost) {}

  private target(hit: TerrainHit): { piece: PlacedPiece; next: number } | null {
    const map = client.world?.map;
    if (!map) return null;
    const i = map.tileIndex(hit.tileX, hit.tileY);
    const bits = map.layers.track[i]!;
    if (map.layers.type[i] !== TileType.Rail || bits === 0) return null;
    const piece = nearestPiece(hit.point.x - hit.tileX, hit.point.z - hit.tileY, bits) as Piece;
    if (!hasPiece(bits, piece)) return null;
    const current = (map.layers.signals[i]! >> (piece * 2)) & 3;
    return { piece: { x: hit.tileX, y: hit.tileY, piece }, next: (current + 1) % 4 };
  }

  private command(t: { piece: PlacedPiece; next: number }, mods: Modifiers): Command {
    return { type: 'setSignal', x: t.piece.x, y: t.piece.y, piece: t.piece.piece, dirs: mods.ctrl ? 0 : t.next };
  }

  onHover(hit: TerrainHit | null, mods: Modifiers): void {
    const t = hit ? this.target(hit) : null;
    if (!hit || !t) {
      this.ghost.hide();
      this.lastKey = '';
      useApp.setState({ hover: null });
      return;
    }
    const cmd = this.command(t, mods);
    const key = JSON.stringify(cmd);
    if (key === this.lastKey) return;
    this.lastKey = key;
    const r = client.preview(cmd);
    this.ghost.show([t.piece], r?.ok ? '#ffd166' : '#ff5a5f');
    const dirs = mods.ctrl ? 0 : t.next;
    useApp.setState({
      hover: {
        x: hit.tileX,
        y: hit.tileY,
        height: client.world?.map.cornerHeight(hit.cornerX, hit.cornerY) ?? 0,
        cost: r?.ok ? r.cost : undefined,
        error: r && !r.ok ? r.error : `Click: ${NAMES[dirs]}`,
      },
    });
  }

  onDown(): void {}

  onUp(hit: TerrainHit | null, mods: Modifiers): void {
    const t = hit ? this.target(hit) : null;
    if (!t) return;
    void client.command(this.command(t, mods)).then((r) => {
      if (!r.ok && r.error) toast(r.error, 'error', 2500);
    });
    this.lastKey = '';
  }

  invalidate(): void {
    this.lastKey = '';
  }

  cancel(): void {
    this.ghost.hide();
    this.lastKey = '';
    useApp.setState({ hover: null });
  }
}
