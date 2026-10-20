/** Road connection bits (on Road tiles and level crossings, `data` bits 0-3). */
export const ROAD_N = 1;
export const ROAD_E = 2;
export const ROAD_S = 4;
export const ROAD_W = 8;
/** Indexed by Edge (N, E, S, W). */
export const ROAD_EDGE_BITS = [ROAD_N, ROAD_E, ROAD_S, ROAD_W] as const;

/**
 * Road tile `data` bit 4: one-way. Traffic flows south (N-S roads) or east (E-W roads); with
 * bit 5 set, the other way. Only straight roads can be one-way.
 */
export const ROAD_ONE_WAY = 0x10;
export const ROAD_ONE_WAY_REVERSED = 0x20;
/** Road tile `data` bit 6: road works (a town's road reconstruction); road vehicles crawl past. */
export const ROAD_WORKS = 0x40;
/** Top speed (km/h) of road vehicles through road works. */
export const ROAD_WORKS_KMH = 15;
/** Road stop tiles: `track` bit 4 marks a truck stop (otherwise a bus stop); bits 0-3 are road bits. */
export const ROADSTOP_TRUCK = 0x10;

export const isStraightRoad = (bits: number) => (bits & 0xf) === (ROAD_N | ROAD_S) || (bits & 0xf) === (ROAD_E | ROAD_W);

/** Road bits of any tile that carries road (roads, level crossings, road stops); 0 otherwise. */
export function roadBitsAt(type: number, data: number, track: number): number {
  if (type === 3) return data & 0xf; // Road
  if (type === 2 && data & 0x100) return data & 0xf; // level crossing
  if (type === 8) return track & 0xf; // road stop
  return 0;
}

/**
 * May traffic leave a tile through edge `exit` (one-way roads)? `data` is the Road tile's data.
 */
export function oneWayAllows(data: number, exit: number): boolean {
  if (!(data & ROAD_ONE_WAY)) return true;
  const reversed = (data & ROAD_ONE_WAY_REVERSED) !== 0;
  // exit edges: N=0 E=1 S=2 W=3. Forward flow leaves through S or E.
  const forward = exit === 2 || exit === 1;
  return forward !== reversed;
}
