import { STATION_CATCHMENT, TileType, houseType, type GameMap } from '@transportsim/shared';

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** The catchment rectangle around a station footprint, clipped to the map. */
export function catchmentRect(map: GameMap, r: Rect): Rect {
  return {
    x0: Math.max(0, r.x0 - STATION_CATCHMENT),
    y0: Math.max(0, r.y0 - STATION_CATCHMENT),
    x1: Math.min(map.width - 1, r.x1 + STATION_CATCHMENT),
    y1: Math.min(map.height - 1, r.y1 + STATION_CATCHMENT),
  };
}

/** Residents of the houses inside a rectangle. */
export function residentsIn(map: GameMap, r: Rect): number {
  let pop = 0;
  for (let y = r.y0; y <= r.y1; y++) {
    for (let x = r.x0; x <= r.x1; x++) {
      const i = map.tileIndex(x, y);
      if (map.layers.type[i] === TileType.House) pop += houseType(map.layers.data[i]!).population;
    }
  }
  return pop;
}

export function rectTiles(r: Rect): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) out.push({ x, y });
  return out;
}
