import { SIGNAL_ONE_WAY, TileType, hasPiece, nearestPiece, type Command, type PlacedPiece, type Piece } from '@transportsim/shared';
import { client } from '../net/client.ts';
import type { TerrainHit } from '../render/picking.ts';
import type { TrackGhost } from '../render/trackGhost.ts';
import { toast, useApp } from '../store.ts';
import type { Modifiers, Tool } from './tool.ts';

/**
 * Click plain track to place a signal facing one way, click again to turn it round, a third
 * time to remove it. The options panel chooses normal or one-way signals; clicking a signal
 * of the other type converts it. Ctrl-click removes.
 */
export class SignalTool implements Tool {
  private lastKey = '';

  constructor(private readonly ghost: TrackGhost) {}

  private target(hit: TerrainHit): { piece: PlacedPiece; dirs: number; oneWay: boolean; label: string } | null {
    const map = client.world?.map;
    if (!map) return null;
    const i = map.tileIndex(hit.tileX, hit.tileY);
    const bits = map.layers.track[i]!;
    if (map.layers.type[i] !== TileType.Rail || bits === 0) return null;
    const piece = nearestPiece(hit.point.x - hit.tileX, hit.point.z - hit.tileY, bits) as Piece;
    if (!hasPiece(bits, piece)) return null;
    const sig = map.layers.signals[i]!;
    const current = (sig >> (piece * 2)) & 3;
    const oneWay = useApp.getState().signalOneWay;
    const kind = oneWay ? 'one-way signal' : 'signal';
    let dirs: number;
    let label: string;
    if (current !== 0 && ((sig & SIGNAL_ONE_WAY) !== 0) !== oneWay) {
      dirs = current;
      label = `Click: change to ${kind}`;
    } else if (current === 0) {
      dirs = 1;
      label = `Click: place ${kind}`;
    } else if (current === 1) {
      dirs = 2;
      label = `Click: turn ${kind} around`;
    } else {
      dirs = 0;
      label = 'Click: remove signal';
    }
    return { piece: { x: hit.tileX, y: hit.tileY, piece }, dirs, oneWay, label };
  }

  private command(t: NonNullable<ReturnType<SignalTool['target']>>, mods: Modifiers): Command {
    return { type: 'setSignal', x: t.piece.x, y: t.piece.y, piece: t.piece.piece, dirs: mods.ctrl ? 0 : t.dirs, oneWay: t.oneWay };
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
    useApp.setState({
      hover: {
        x: hit.tileX,
        y: hit.tileY,
        height: client.world?.map.cornerHeight(hit.cornerX, hit.cornerY) ?? 0,
        cost: r?.ok ? r.cost : undefined,
        error: r && !r.ok ? r.error : mods.ctrl ? 'Click: remove signal' : t.label,
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
