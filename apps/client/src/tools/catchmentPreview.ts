import { findJoinStation } from '@transportsim/shared';
import { catchmentRect, rectTiles, residentsIn } from '../game/catchment.ts';
import { client } from '../net/client.ts';
import type { AreaGhost } from '../render/areaGhost.ts';
import { useApp } from '../store.ts';

const COLOR = '#58a6ff';

/**
 * Shows the catchment a station would have once something is placed on `tiles`: its own area,
 * or the area of the station of ours nearby it would join. Adds the residents to the hover info.
 */
export class CatchmentPreview {
  private key = '';

  constructor(private readonly overlay: AreaGhost) {}

  update(tiles: { x: number; y: number }[] | null): void {
    const w = client.world;
    if (!tiles || tiles.length === 0 || !w) return this.hide();
    const map = w.map;
    const xs = tiles.map((t) => t.x);
    const ys = tiles.map((t) => t.y);
    const r = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
    const room = useApp.getState().room;
    const company = room ? w.state.players.get(room.playerId)?.companyId : undefined;
    const join = company != null ? findJoinStation(map, w.state.stations, company, r.x0, r.y0, r.x1, r.y1) : undefined;
    if (join) {
      r.x0 = Math.min(r.x0, join.x0);
      r.y0 = Math.min(r.y0, join.y0);
      r.x1 = Math.max(r.x1, join.x1);
      r.y1 = Math.max(r.y1, join.y1);
    }
    const c = catchmentRect(map, r);
    const key = JSON.stringify(c);
    if (key !== this.key) {
      this.key = key;
      this.overlay.show(rectTiles(c), COLOR);
    }
    const hover = useApp.getState().hover;
    if (!hover) return;
    const residents = `Catchment: ${residentsIn(map, c).toLocaleString('en-GB')} residents`;
    useApp.setState({ hover: { ...hover, info: join ? `Joins ${join.name} · ${residents}` : residents } });
  }

  invalidate(): void {
    this.key = '';
  }

  hide(): void {
    this.key = '';
    this.overlay.hide();
  }
}
