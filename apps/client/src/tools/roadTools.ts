import { AIRPORT_TYPES, EDGE_DX, EDGE_DY, TileType, roadBitsAt, ROAD_EDGE_BITS, OPPOSITE_EDGE, type Command } from '@transportsim/shared';
import { client } from '../net/client.ts';
import type { AreaGhost } from '../render/areaGhost.ts';
import type { TerrainHit } from '../render/picking.ts';
import { toast, useApp } from '../store.ts';
import type { Modifiers, Tool } from './tool.ts';
import { CatchmentPreview } from './catchmentPreview.ts';

const OK = '#7ee787';
const REMOVE = '#ffa657';
const BAD = '#ff5a5f';

/** Drag a straight road from tile to tile (Ctrl, or the remove tool, removes road instead). */
export class RoadTool implements Tool {
  private start: { x: number; y: number } | null = null;
  private lastKey = '';
  private lastHit: TerrainHit | null = null;
  private mods: Modifiers = { ctrl: false, shift: false };

  constructor(
    private readonly ghost: AreaGhost,
    private readonly removeMode: boolean,
  ) {}

  private plan(hit: TerrainHit): { cmd: Command; tiles: { x: number; y: number }[] } {
    const s = this.start ?? { x: hit.tileX, y: hit.tileY };
    // Snap to the longer axis.
    const alongX = Math.abs(hit.tileX - s.x) >= Math.abs(hit.tileY - s.y);
    const x1 = alongX ? hit.tileX : s.x;
    const y1 = alongX ? s.y : hit.tileY;
    const tiles: { x: number; y: number }[] = [];
    const n = Math.abs(x1 - s.x) + Math.abs(y1 - s.y);
    for (let k = 0; k <= n; k++) tiles.push({ x: s.x + Math.sign(x1 - s.x) * k, y: s.y + Math.sign(y1 - s.y) * k });
    const remove = this.removeMode || this.mods.ctrl;
    return { cmd: { type: remove ? 'removeRoad' : 'buildRoad', x0: s.x, y0: s.y, x1, y1 }, tiles };
  }

  onHover(hit: TerrainHit | null, mods: Modifiers): void {
    this.lastHit = hit;
    this.mods = mods;
    if (!hit) {
      this.ghost.hide();
      useApp.setState({ hover: null });
      return;
    }
    const { cmd, tiles } = this.plan(hit);
    const key = JSON.stringify(cmd);
    if (key === this.lastKey) return;
    this.lastKey = key;
    const r = this.start ? client.preview(cmd) : null;
    const remove = cmd.type === 'removeRoad';
    this.ghost.show(tiles, !this.start || r?.ok ? (remove ? REMOVE : OK) : BAD, undefined, r?.ok ? r.foundations : undefined);
    useApp.setState({
      hover: {
        x: hit.tileX,
        y: hit.tileY,
        height: client.world?.map.cornerHeight(hit.cornerX, hit.cornerY) ?? 0,
        cost: r?.ok ? r.cost : undefined,
        error: r && !r.ok ? r.error : undefined,
        info: this.start ? (r?.ok ? r.note : undefined) : remove ? 'Drag along a road to remove it' : 'Drag to build a straight road',
      },
    });
  }

  onDown(hit: TerrainHit, mods: Modifiers): void {
    this.start = { x: hit.tileX, y: hit.tileY };
    this.lastKey = '';
    this.onHover(hit, mods);
  }

  onUp(hit: TerrainHit | null, mods: Modifiers): void {
    const target = hit ?? this.lastHit;
    if (this.start && target) {
      void client.command(this.plan(target).cmd).then((r) => {
        if (!r.ok && r.error) toast(r.error, 'error', 2500);
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

/** Single-tile road tools: stops, depots and one-way roads. */
export class RoadPlaceTool implements Tool {
  private lastKey = '';
  /** Stops, airports and docks show the catchment of the station they would make or join. */
  private readonly catchment: CatchmentPreview | null;

  constructor(
    private readonly ghost: AreaGhost,
    private readonly kind: 'roadStop' | 'roadDepot' | 'oneWay' | 'airport' | 'lock' | 'dock' | 'shipDepot' | 'buoy',
    catchment: AreaGhost,
  ) {
    this.catchment = kind === 'roadStop' || kind === 'airport' || kind === 'dock' ? new CatchmentPreview(catchment) : null;
  }

  /** Tiles the thing being placed covers (an airport's north-west corner is under the cursor). */
  private footprint(hit: TerrainHit): { x: number; y: number }[] {
    if (this.kind !== 'airport') return [{ x: hit.tileX, y: hit.tileY }];
    const t = AIRPORT_TYPES[useApp.getState().airportKind];
    const out: { x: number; y: number }[] = [];
    for (let dy = 0; dy < t.h; dy++) for (let dx = 0; dx < t.w; dx++) out.push({ x: hit.tileX + dx, y: hit.tileY + dy });
    return out;
  }

  private command(hit: TerrainHit): { cmd: Command; arrow?: { x: number; y: number; edge: number } } {
    const { tileX: x, tileY: y } = hit;
    if (this.kind === 'airport') return { cmd: { type: 'buildAirport', x, y, kind: useApp.getState().airportKind } };
    if (this.kind === 'lock') return { cmd: { type: 'buildLock', x, y } };
    if (this.kind === 'buoy') return { cmd: { type: 'buildBuoy', x, y } };
    if (this.kind === 'shipDepot') return { cmd: { type: 'buildShipDepot', x, y } };
    if (this.kind === 'dock') {
      // Face the side of the tile the cursor is nearest, if there is water there.
      const fx = hit.point.x - x - 0.5;
      const fy = hit.point.z - y - 0.5;
      const edge = Math.abs(fx) > Math.abs(fy) ? (fx > 0 ? 1 : 3) : fy > 0 ? 2 : 0;
      const map = client.world?.map;
      const nx = x + EDGE_DX[edge as 0]!;
      const ny = y + EDGE_DY[edge as 0]!;
      const wet = map && map.inBounds(nx, ny) && map.layers.type[map.tileIndex(nx, ny)] === TileType.Water;
      return { cmd: { type: 'buildDock', x, y, edge: wet ? edge : undefined }, arrow: wet ? { x, y, edge } : undefined };
    }
    if (this.kind === 'roadStop') return { cmd: { type: 'buildRoadStop', x, y, kind: useApp.getState().roadStopKind } };
    if (this.kind === 'oneWay') return { cmd: { type: 'setOneWay', x, y } };
    // Depot: face a neighbouring road if there is one, else the side of the tile clicked.
    const fx = hit.point.x - x - 0.5;
    const fy = hit.point.z - y - 0.5;
    let exit = Math.abs(fx) > Math.abs(fy) ? (fx > 0 ? 1 : 3) : fy > 0 ? 2 : 0;
    const map = client.world?.map;
    if (map) {
      const roads = [0, 1, 2, 3].filter((e) => {
        const nx = x + EDGE_DX[e as 0]!;
        const ny = y + EDGE_DY[e as 0]!;
        if (!map.inBounds(nx, ny)) return false;
        const i = map.tileIndex(nx, ny);
        return map.layers.type[i] === TileType.Road || roadBitsAt(map.layers.type[i]!, map.layers.data[i]!, map.layers.track[i]!) & ROAD_EDGE_BITS[OPPOSITE_EDGE[e as 0]]!;
      });
      if (roads.length === 1) exit = roads[0]!;
      else if (roads.length > 1 && !roads.includes(exit)) exit = roads[0]!;
    }
    return { cmd: { type: 'buildRoadDepot', x, y, exit }, arrow: { x, y, edge: exit } };
  }

  onHover(hit: TerrainHit | null): void {
    if (!hit) {
      this.ghost.hide();
      this.catchment?.hide();
      useApp.setState({ hover: null });
      this.lastKey = '';
      return;
    }
    const { cmd, arrow } = this.command(hit);
    const key = JSON.stringify(cmd);
    if (key === this.lastKey) return;
    this.lastKey = key;
    const r = client.preview(cmd);
    this.ghost.show(this.footprint(hit), r?.ok ? OK : BAD, arrow, r?.ok ? r.foundations : undefined);
    useApp.setState({
      hover: {
        x: hit.tileX,
        y: hit.tileY,
        height: client.world?.map.cornerHeight(hit.cornerX, hit.cornerY) ?? 0,
        cost: r?.ok ? r.cost : undefined,
        error: r && !r.ok ? r.error : undefined,
      },
    });
    this.catchment?.update(this.footprint(hit));
  }

  onDown(): void {}

  onUp(hit: TerrainHit | null): void {
    if (!hit) return;
    void client.command(this.command(hit).cmd).then((r) => {
      if (!r.ok && r.error) toast(r.error, 'error', 2500);
    });
    this.lastKey = '';
  }

  invalidate(): void {
    this.lastKey = '';
    this.catchment?.invalidate();
  }

  cancel(): void {
    this.lastKey = '';
    this.ghost.hide();
    this.catchment?.hide();
    useApp.setState({ hover: null });
  }
}
