/** Road connection bits (on Road tiles and level crossings, `data` bits 0-3). */
export const ROAD_N = 1;
export const ROAD_E = 2;
export const ROAD_S = 4;
export const ROAD_W = 8;
/** Indexed by Edge (N, E, S, W). */
export const ROAD_EDGE_BITS = [ROAD_N, ROAD_E, ROAD_S, ROAD_W] as const;
