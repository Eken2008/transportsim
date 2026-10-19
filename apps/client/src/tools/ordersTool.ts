import { AirportRole, TileType, WAYPOINT_FLAG, type Order } from '@transportsim/shared';
import { client } from '../net/client.ts';
import type { AreaGhost } from '../render/areaGhost.ts';
import type { TerrainHit } from '../render/picking.ts';
import { toast, useApp } from '../store.ts';
import type { Modifiers, Tool } from './tool.ts';

/** Click stations, waypoints or depots to append them to the selected train's orders. Esc or right-click ends. */
export class OrdersTool implements Tool {
  private last = -1;

  constructor(private readonly ghost: AreaGhost) {}

  private stationAt(hit: TerrainHit): number | null {
    const map = client.world?.map;
    if (!map) return null;
    const i = map.tileIndex(hit.tileX, hit.tileY);
    const type = map.layers.type[i];
    if (type === TileType.Airport) return map.layers.track[i] === AirportRole.Hangar ? null : map.layers.data[i]!;
    return type === TileType.Station || type === TileType.RoadStop ? map.layers.data[i]! : null;
  }

  /** The order a click on this tile adds: a station, a waypoint, or a depot service. */
  private orderAt(hit: TerrainHit): Order | null {
    const map = client.world?.map;
    if (!map) return null;
    const station = this.stationAt(hit);
    if (station !== null) return { kind: 'station', station };
    const i = map.tileIndex(hit.tileX, hit.tileY);
    if (map.layers.type[i] === TileType.Depot || map.layers.type[i] === TileType.RoadDepot || map.layers.type[i] === TileType.Airport) return { kind: 'depot' };
    if (map.layers.type[i] === TileType.Rail && map.layers.data[i]! & WAYPOINT_FLAG) {
      const wp = [...(client.world?.state.waypoints.values() ?? [])].find((w) => w.tile === i);
      if (wp) return { kind: 'waypoint', waypoint: wp.id };
    }
    return null;
  }

  onHover(hit: TerrainHit | null, _mods: Modifiers): void {
    if (!hit) {
      this.ghost.hide();
      this.last = -1;
      return;
    }
    const id = this.stationAt(hit);
    const st = id !== null ? client.world?.state.stations.get(id) : undefined;
    const key = st ? st.id : -2 - hit.tileX - hit.tileY * 65536;
    if (key === this.last) return;
    this.last = key;
    if (st) {
      const tiles: { x: number; y: number }[] = [];
      for (let y = st.y0; y <= st.y1; y++) for (let x = st.x0; x <= st.x1; x++) tiles.push({ x, y });
      const state = client.world?.state;
      const company = state?.players.get(useApp.getState().room!.playerId)?.companyId;
      const own = !!state && company != null && state.canUseStation(company, st);
      this.ghost.show(tiles, own ? '#58a6ff' : '#ff5a5f');
    } else {
      this.ghost.show([{ x: hit.tileX, y: hit.tileY }], this.orderAt(hit) ? '#58a6ff' : '#8ea0b6');
    }
  }

  onDown(): void {}

  onUp(hit: TerrainHit | null): void {
    const trainId = useApp.getState().ordersFor;
    const train = trainId !== null ? client.world?.trains.get(trainId) : undefined;
    if (!hit || !train) return;
    const order = this.orderAt(hit);
    if (!order) return toast('Click a station, waypoint or depot to add it to the orders', 'info', 2000);
    const orders = [...train.orders, order];
    void client.command({ type: 'setOrders', id: train.id, orders }).then((r) => {
      if (!r.ok && r.error) toast(r.error, 'error');
    });
  }

  cancel(): void {
    this.ghost.hide();
    this.last = -1;
  }
}
