import {
  EDGE_DX,
  EDGE_DY,
  OPPOSITE_EDGE,
  PIECE_EDGES,
  TileType,
  hasPiece,
  type Command,
} from '@transportsim/shared';
import { client } from '../net/client.ts';
import type { AreaGhost } from '../render/areaGhost.ts';
import type { TerrainHit } from '../render/picking.ts';
import { toast, useApp } from '../store.ts';
import type { Modifiers, Tool } from './tool.ts';
import { catchmentRect, rectTiles, residentsIn } from '../game/catchment.ts';

const OK = '#7ee787';
const BAD = '#ff5a5f';
const DEMOLISH = '#ffa657';

/** Shared plumbing: preview a command for the hovered tile(s) and send it on click. */
abstract class PreviewTool implements Tool {
  protected lastKey = '';
  protected lastHit: TerrainHit | null = null;

  constructor(protected readonly ghost: AreaGhost) {}

  /** Tiles to highlight, the command to run, and an optional exit arrow. */
  protected abstract describe(hit: TerrainHit): {
    tiles: { x: number; y: number }[];
    cmd: Command;
    arrow?: { x: number; y: number; edge: number };
    color?: string;
  };

  onHover(hit: TerrainHit | null, _mods: Modifiers): void {
    this.lastHit = hit;
    if (!hit) {
      this.ghost.hide();
      useApp.setState({ hover: null });
      this.lastKey = '';
      return;
    }
    const d = this.describe(hit);
    const key = JSON.stringify(d.cmd);
    if (key === this.lastKey) return;
    this.lastKey = key;
    const r = client.preview(d.cmd);
    this.ghost.show(d.tiles, r?.ok ? (d.color ?? OK) : BAD, d.arrow);
    const height = client.world?.map.cornerHeight(hit.cornerX, hit.cornerY) ?? 0;
    useApp.setState({
      hover: { x: hit.tileX, y: hit.tileY, height, cost: r?.ok ? r.cost : undefined, error: r && !r.ok ? r.error : undefined },
    });
  }

  onDown(_hit: TerrainHit, _mods: Modifiers): void {}

  onUp(hit: TerrainHit | null, mods: Modifiers): void {
    const target = hit ?? this.lastHit;
    if (!target) return;
    void client.command(this.describe(target).cmd).then((r) => {
      if (!r.ok && r.error) toast(r.error, 'error', 2500);
    });
    this.lastKey = '';
    this.onHover(hit, mods);
  }

  invalidate(): void {
    this.lastKey = '';
  }

  cancel(): void {
    this.lastKey = '';
    this.ghost.hide();
    useApp.setState({ hover: null });
  }
}

/** Place a rectangular station; size and orientation come from the options panel (R rotates). */
export class StationTool extends PreviewTool {
  private catchKey = '';

  constructor(
    ghost: AreaGhost,
    private readonly catchment: AreaGhost,
  ) {
    super(ghost);
  }

  override onHover(hit: TerrainHit | null, mods: Modifiers): void {
    super.onHover(hit, mods);
    const map = client.world?.map;
    if (!hit || !map) {
      this.catchment.hide();
      this.catchKey = '';
      return;
    }
    const d = this.describe(hit);
    const xs = d.tiles.map((t) => t.x);
    const ys = d.tiles.map((t) => t.y);
    const r = catchmentRect(map, { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) });
    const key = JSON.stringify(r);
    if (key !== this.catchKey) {
      this.catchKey = key;
      this.catchment.show(rectTiles(r), '#58a6ff');
    }
    const hover = useApp.getState().hover;
    if (hover) useApp.setState({ hover: { ...hover, info: `Catchment: ${residentsIn(map, r).toLocaleString('en-GB')} residents` } });
  }

  override invalidate(): void {
    super.invalidate();
    this.catchKey = '';
  }

  override cancel(): void {
    super.cancel();
    this.catchment.hide();
    this.catchKey = '';
  }

  protected describe(hit: TerrainHit) {
    const { axis, platforms, length } = useApp.getState().stationOpts;
    const w = axis === 0 ? length : platforms;
    const h = axis === 0 ? platforms : length;
    const tiles: { x: number; y: number }[] = [];
    for (let y = hit.tileY; y < hit.tileY + h; y++) for (let x = hit.tileX; x < hit.tileX + w; x++) tiles.push({ x, y });
    return { tiles, cmd: { type: 'buildStation', x: hit.tileX, y: hit.tileY, axis, platforms, length } as Command };
  }
}

/**
 * Place a depot. Its exit faces adjacent track that could connect to it if there is any,
 * otherwise the tile edge nearest the cursor.
 */
export class DepotTool extends PreviewTool {
  protected describe(hit: TerrainHit) {
    const x = hit.tileX;
    const y = hit.tileY;
    const fx = hit.point.x - x - 0.5;
    const fy = hit.point.z - y - 0.5;
    let exit = Math.abs(fx) > Math.abs(fy) ? (fx > 0 ? 1 : 3) : fy > 0 ? 2 : 0;
    const map = client.world?.map;
    if (map) {
      const connecting = [0, 1, 2, 3].filter((e) => {
        const nx = x + EDGE_DX[e as 0]!;
        const ny = y + EDGE_DY[e as 0]!;
        if (!map.inBounds(nx, ny)) return false;
        const t = map.type(nx, ny);
        if (t !== TileType.Rail && t !== TileType.Station) return false;
        const bits = map.layers.track[map.tileIndex(nx, ny)]!;
        const back = OPPOSITE_EDGE[e as 0];
        return PIECE_EDGES.some((edges, p) => hasPiece(bits, p) && (edges[0] === back || edges[1] === back));
      });
      if (connecting.length === 1) exit = connecting[0]!;
      else if (connecting.length > 1 && !connecting.includes(exit)) exit = connecting[0]!;
    }
    return { tiles: [{ x, y }], cmd: { type: 'buildDepot', x, y, exit } as Command, arrow: { x, y, edge: exit } };
  }
}

/** Drag a rectangle to bulldoze your own track, stations, depots and trees. */
export class BulldozeTool extends PreviewTool {
  private start: { x: number; y: number } | null = null;

  protected describe(hit: TerrainHit) {
    const s = this.start ?? { x: hit.tileX, y: hit.tileY };
    const x0 = Math.min(s.x, hit.tileX);
    const x1 = Math.max(s.x, hit.tileX);
    const y0 = Math.min(s.y, hit.tileY);
    const y1 = Math.max(s.y, hit.tileY);
    const tiles: { x: number; y: number }[] = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) tiles.push({ x, y });
    return { tiles, cmd: { type: 'clearArea', x0, y0, x1, y1 } as Command, color: DEMOLISH };
  }

  override onDown(hit: TerrainHit, mods: Modifiers): void {
    this.start = { x: hit.tileX, y: hit.tileY };
    this.lastKey = '';
    this.onHover(hit, mods);
  }

  override onUp(hit: TerrainHit | null, mods: Modifiers): void {
    if (!this.start) return;
    super.onUp(hit, mods);
    this.start = null;
    this.lastKey = '';
    this.onHover(hit, mods);
  }

  override cancel(): void {
    this.start = null;
    super.cancel();
  }
}
