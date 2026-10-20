import {
  PIECE_EDGES,
  EDGE_MID_X,
  EDGE_MID_Y,
  SIGNAL_ONE_WAY,
  TileType,
  hasPiece,
  isSpanTd,
  nearestPiece,
  planSignalRun,
  segPiece,
  segTd,
  segTile,
  signalKindOf,
  type Command,
  type PlacedPiece,
  type Piece,
  type SetSignalRunCommand,
  type SignalKind,
} from '@transportsim/shared';
import { client } from '../net/client.ts';
import type { TerrainHit } from '../render/picking.ts';
import type { TrackGhost } from '../render/trackGhost.ts';
import { toast, useApp } from '../store.ts';
import type { Modifiers, Tool } from './tool.ts';

/**
 * Click plain track to place a signal facing one way, click again to turn it round, a third
 * time to remove it. The options panel chooses the kind and one-way; clicking a signal of
 * another kind converts it. Ctrl-click removes.
 *
 * Drag along track to place signals facing the way of the drag, the set spacing apart, up to
 * the next junction. Ctrl-drag removes every signal on that stretch.
 */
export class SignalTool implements Tool {
  private lastKey = '';
  /** Piece the drag started on. */
  private start: PlacedPiece | null = null;
  private lastHit: TerrainHit | null = null;

  constructor(private readonly ghost: TrackGhost) {}

  private target(hit: TerrainHit): { piece: PlacedPiece; dirs: number; oneWay: boolean; kind: SignalKind; label: string } | null {
    const map = client.world?.map;
    if (!map) return null;
    const i = map.tileIndex(hit.tileX, hit.tileY);
    const bits = map.layers.track[i]!;
    if (map.layers.type[i] !== TileType.Rail || bits === 0) return null;
    const piece = nearestPiece(hit.point.x - hit.tileX, hit.point.z - hit.tileY, bits) as Piece;
    if (!hasPiece(bits, piece)) return null;
    const sig = map.layers.signals[i]!;
    const current = (sig >> (piece * 2)) & 3;
    const { signalOneWay: oneWay, signalKind: kind } = useApp.getState();
    const name = signalName(oneWay, kind);
    let dirs: number;
    let label: string;
    if (current !== 0 && (((sig & SIGNAL_ONE_WAY) !== 0) !== oneWay || signalKindOf(sig) !== kind)) {
      dirs = current;
      label = `Click: change to ${name}`;
    } else if (current === 0) {
      dirs = 1;
      label = `Click: place ${name}`;
    } else if (current === 1) {
      dirs = 2;
      label = `Click: turn ${name} around`;
    } else {
      dirs = 0;
      label = 'Click: remove signal';
    }
    return { piece: { x: hit.tileX, y: hit.tileY, piece }, dirs, oneWay, kind, label };
  }

  private command(t: NonNullable<ReturnType<SignalTool['target']>>, mods: Modifiers): Command {
    return { type: 'setSignal', x: t.piece.x, y: t.piece.y, piece: t.piece.piece, dirs: mods.ctrl ? 0 : t.dirs, oneWay: t.oneWay, kind: t.kind };
  }

  /** The run command for a drag from the start piece towards the cursor, or null while still on the start tile. */
  private runCommand(hit: TerrainHit, mods: Modifiers): SetSignalRunCommand | null {
    const s = this.start;
    if (!s || (hit.tileX === s.x && hit.tileY === s.y)) return null;
    // Walk the piece the way that heads towards the cursor.
    const [a, b] = PIECE_EDGES[s.piece]!;
    const cx = s.x + (EDGE_MID_X[a] + EDGE_MID_X[b]) / 2;
    const cy = s.y + (EDGE_MID_Y[a] + EDGE_MID_Y[b]) / 2;
    const forward = (hit.point.x - cx) * (EDGE_MID_X[b] - EDGE_MID_X[a]) + (hit.point.z - cy) * (EDGE_MID_Y[b] - EDGE_MID_Y[a]);
    const { signalOneWay: oneWay, signalKind: kind, signalInterval: interval } = useApp.getState();
    return { type: 'setSignalRun', x: s.x, y: s.y, piece: s.piece, reverse: forward >= 0 ? 0 : 1, interval, remove: mods.ctrl, oneWay, kind };
  }

  onHover(hit: TerrainHit | null, mods: Modifiers): void {
    this.lastHit = hit;
    const run = hit ? this.runCommand(hit, mods) : null;
    if (hit && run) return this.hoverRun(hit, run);
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
    this.setHover(hit, r, mods.ctrl ? 'Click: remove signal' : `${t.label} · drag along the track for a row`);
  }

  private hoverRun(hit: TerrainHit, cmd: SetSignalRunCommand): void {
    const key = JSON.stringify(cmd);
    if (key === this.lastKey) return;
    this.lastKey = key;
    const map = client.world?.map;
    const owner = client.world?.state.players.get(useApp.getState().room?.playerId ?? -1)?.companyId;
    const plan = map && owner != null ? planSignalRun(map, cmd, owner) : null;
    const toPieces = (segs: number[]): PlacedPiece[] => {
      const w = map!.width;
      return segs.filter((s) => !isSpanTd(segTd(s))).map((s) => ({ x: segTile(s) % w, y: Math.floor(segTile(s) / w), piece: segPiece(s) as Piece }));
    };
    const r = client.preview(cmd);
    const color = !r?.ok ? '#ff5a5f' : cmd.remove ? '#ffa657' : '#ffd166';
    if (plan && typeof plan !== 'string') this.ghost.show(toPieces(plan.picks), color, undefined, toPieces(plan.run));
    else this.ghost.show([this.start!], color);
    const n = plan && typeof plan !== 'string' ? plan.picks.length : 0;
    const label = cmd.remove
      ? `Release: remove ${n} signal${n === 1 ? '' : 's'} up to the next junction`
      : `Release: ${n} ${signalName(cmd.oneWay === true, cmd.kind ?? 'block')}${n === 1 ? '' : 's'}, every ${cmd.interval} tiles up to the next junction`;
    this.setHover(hit, r, label);
  }

  private setHover(hit: TerrainHit, r: ReturnType<typeof client.preview>, label: string): void {
    useApp.setState({
      hover: {
        x: hit.tileX,
        y: hit.tileY,
        height: client.world?.map.cornerHeight(hit.cornerX, hit.cornerY) ?? 0,
        cost: r?.ok ? r.cost : undefined,
        error: r && !r.ok ? r.error : undefined,
        info: label,
      },
    });
  }

  onDown(hit: TerrainHit, mods: Modifiers): void {
    this.start = this.target(hit)?.piece ?? null;
    this.lastKey = '';
    this.onHover(hit, mods);
  }

  onUp(hit: TerrainHit | null, mods: Modifiers): void {
    const target = hit ?? this.lastHit;
    const run = target ? this.runCommand(target, mods) : null;
    const t = !run && hit ? this.target(hit) : null;
    this.start = null;
    this.lastKey = '';
    const cmd = run ?? (t ? this.command(t, mods) : null);
    if (cmd) {
      void client.command(cmd).then((r) => {
        if (!r.ok && r.error) toast(r.error, 'error', 2500);
      });
    }
    this.onHover(hit, mods);
  }

  invalidate(): void {
    this.lastKey = '';
  }

  cancel(): void {
    this.start = null;
    this.ghost.hide();
    this.lastKey = '';
    useApp.setState({ hover: null });
  }
}

const signalName = (oneWay: boolean, kind: SignalKind) => `${oneWay ? 'one-way ' : ''}${kind === 'block' ? '' : `${kind} `}signal`;
