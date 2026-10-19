import { BRIDGE_TYPES, EDGE_DX, EDGE_DY, OPPOSITE_EDGE, edgeHeight, ymdFromDays, type BuildBridgeCommand, type Command } from '@transportsim/shared';
import { client } from '../net/client.ts';
import type { AreaGhost } from '../render/areaGhost.ts';
import type { TerrainHit } from '../render/picking.ts';
import { toast, useApp } from '../store.ts';
import type { Modifiers, Tool } from './tool.ts';

const OK = '#7ee787';
const BAD = '#ff5a5f';

/** Bridge types that may be built now, given the timeline. */
export function availableBridges(): number[] {
  const s = useApp.getState();
  const year = s.global ? ymdFromDays(s.global.date).year : 1900;
  return BRIDGE_TYPES.map((_, i) => i).filter((i) => s.room?.settings.timeline === 'sandbox' || BRIDGE_TYPES[i]!.intro <= year);
}

/** Drag from one end of the bridge to the other. */
export class BridgeTool implements Tool {
  private start: { x: number; y: number } | null = null;
  private lastKey = '';
  private lastHit: TerrainHit | null = null;

  constructor(private readonly ghost: AreaGhost) {}

  private command(hit: TerrainHit): { cmd: Command; tiles: { x: number; y: number }[] } | null {
    if (!this.start) return null;
    const { x: x0, y: y0 } = this.start;
    // Snap to the dominant axis.
    const horizontal = Math.abs(hit.tileX - x0) >= Math.abs(hit.tileY - y0);
    const x1 = horizontal ? hit.tileX : x0;
    const y1 = horizontal ? y0 : hit.tileY;
    const len = Math.abs(x1 - x0) + Math.abs(y1 - y0) - 1;
    const chosen = useApp.getState().bridgeType;
    const options = availableBridges();
    const auto = options.filter((i) => BRIDGE_TYPES[i]!.maxSpan >= len).sort((a, b) => BRIDGE_TYPES[a]!.costPerTile - BRIDGE_TYPES[b]!.costPerTile)[0];
    const bridgeType = chosen ?? auto ?? options.at(-1) ?? 0;
    const tiles: { x: number; y: number }[] = [];
    const n = len + 2;
    const sx = Math.sign(x1 - x0);
    const sy = Math.sign(y1 - y0);
    for (let k = 0; k < n; k++) tiles.push({ x: x0 + sx * k, y: y0 + sy * k });
    return { cmd: { type: 'buildBridge', x0, y0, x1, y1, bridgeType, railType: useApp.getState().railType }, tiles };
  }

  onHover(hit: TerrainHit | null, _mods: Modifiers): void {
    this.lastHit = hit ?? this.lastHit;
    if (!hit) return;
    if (!this.start) {
      this.ghost.show([{ x: hit.tileX, y: hit.tileY }], OK);
      useApp.setState({ hover: { x: hit.tileX, y: hit.tileY, height: client.world?.map.cornerHeight(hit.cornerX, hit.cornerY) ?? 0, error: 'Drag to the other end of the bridge' } });
      return;
    }
    const c = this.command(hit)!;
    const key = JSON.stringify(c.cmd);
    if (key === this.lastKey) return;
    this.lastKey = key;
    const r = client.preview(c.cmd);
    this.ghost.show(c.tiles, r?.ok ? OK : BAD);
    const type = BRIDGE_TYPES[(c.cmd as { bridgeType: number }).bridgeType]!;
    useApp.setState({
      hover: {
        x: hit.tileX,
        y: hit.tileY,
        height: client.world?.map.cornerHeight(hit.cornerX, hit.cornerY) ?? 0,
        cost: r?.ok ? r.cost : undefined,
        error: r && !r.ok ? r.error : `${type.name} — ${type.maxSpeed} km/h`,
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
    const c = target ? this.command(target) : null;
    this.start = null;
    this.lastKey = '';
    const cmd = c?.cmd as BuildBridgeCommand | undefined;
    if (cmd && (cmd.x0 !== cmd.x1 || cmd.y0 !== cmd.y1)) {
      void client.command(cmd).then((r) => {
        if (!r.ok && r.error) toast(r.error, 'error', 3000);
      });
    }
    if (hit) this.onHover(hit, mods);
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

/** Click a slope that rises into a hill; the tunnel runs straight through to the far side. */
export class TunnelTool implements Tool {
  private lastKey = '';

  constructor(private readonly ghost: AreaGhost) {}

  private command(hit: TerrainHit): { cmd: Command; dir: number } | null {
    const map = client.world?.map;
    if (!map) return null;
    const c = map.tileCorners(hit.tileX, hit.tileY);
    for (let dir = 0; dir < 4; dir++) {
      const inner = edgeHeight(c, dir as 0);
      const outer = edgeHeight(c, OPPOSITE_EDGE[dir as 0]);
      if (inner >= 0 && outer >= 0 && inner === outer + 1) return { cmd: { type: 'buildTunnel', x: hit.tileX, y: hit.tileY, dir, railType: useApp.getState().railType }, dir };
    }
    return null;
  }

  onHover(hit: TerrainHit | null, _mods: Modifiers): void {
    if (!hit) {
      this.ghost.hide();
      return;
    }
    const c = this.command(hit);
    const key = c ? JSON.stringify(c.cmd) : `none${hit.tileX},${hit.tileY}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    const height = client.world?.map.cornerHeight(hit.cornerX, hit.cornerY) ?? 0;
    if (!c) {
      this.ghost.show([{ x: hit.tileX, y: hit.tileY }], BAD);
      useApp.setState({ hover: { x: hit.tileX, y: hit.tileY, height, error: 'Tunnels start on a slope rising into a hill' } });
      return;
    }
    const r = client.preview(c.cmd);
    const tiles = [{ x: hit.tileX, y: hit.tileY }];
    for (let k = 1; k <= 3; k++) tiles.push({ x: hit.tileX + EDGE_DX[c.dir as 0]! * k, y: hit.tileY + EDGE_DY[c.dir as 0]! * k });
    this.ghost.show(tiles, r?.ok ? OK : BAD, { x: hit.tileX, y: hit.tileY, edge: c.dir });
    useApp.setState({ hover: { x: hit.tileX, y: hit.tileY, height, cost: r?.ok ? r.cost : undefined, error: r && !r.ok ? r.error : undefined } });
  }

  onDown(): void {}

  onUp(hit: TerrainHit | null): void {
    const c = hit ? this.command(hit) : null;
    if (!c) return;
    void client.command(c.cmd).then((r) => {
      if (!r.ok && r.error) toast(r.error, 'error', 3000);
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
