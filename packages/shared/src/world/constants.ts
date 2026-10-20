/** Side length of a map chunk in tiles. Map dimensions must be multiples of this. */
export const CHUNK_SIZE = 64;
/** Highest allowed corner height level. */
export const MAX_HEIGHT = 40;
/** World units per height level (a tile is 1×1 world units). */
export const HEIGHT_SCALE = 0.3;
/** Height level at which snow starts to appear (visual + tree line). */
export const SNOW_LINE = 26;

export const MAP_SIZES = [128, 256, 512, 1024, 2048, 4096] as const;

export const TileType = {
  Clear: 0,
  Water: 1,
  Rail: 2,
  Road: 3,
  Station: 4,
  House: 5,
  Industry: 6,
  Depot: 7,
  /** Drive-through bus or truck stop (part of a station): data = station id, track = road bits | ROADSTOP_TRUCK. */
  RoadStop: 8,
  /** Road vehicle depot: data bits 0-1 = exit edge. */
  RoadDepot: 9,
  /** Airport tile (part of a station): data = station id, track = AirportRole. */
  Airport: 10,
  /** Canal lock on a straight slope: data bit 0 = axis (0 along X, 1 along Y). */
  Lock: 11,
  /** Dock on the shore (part of a station): data = station id, track = edge facing the water. */
  Dock: 12,
  /** Ship depot on water: data bit 0 = axis, bit 1 = built on a canal. */
  ShipDepot: 13,
} as const;
export type TileType = (typeof TileType)[keyof typeof TileType];

/** Owner value meaning "nobody". */
export const OWNER_NONE = 0xff;

/**
 * Layout of `data` for Clear tiles:
 *  bits 0-2: tree count (0-4)
 *  bits 3-5: ground variant
 *  bits 6-8: farm fields only: crop (bits 6-7) and rows running north-south (bit 8)
 */
export const Ground = {
  Grass: 0,
  Rough: 1,
  Rocks: 2,
  Sand: 3,
  Snow: 4,
  /** A farm's field: open land anyone may build on. */
  Field: 5,
} as const;
export type Ground = (typeof Ground)[keyof typeof Ground];

export const FIELD_CROP_SHIFT = 6;
export const FIELD_CROPS = 4;
export const FIELD_ROWS_Y = 0x100;

export const MAX_TREES = 4;

/** Layout of `data` for Water tiles. */
export const WATER_CANAL = 0x1;
/** A buoy floats on this water tile (it is a waypoint). */
export const WATER_BUOY = 0x2;
/** A river: flat water at any height that nobody owns. */
export const WATER_RIVER = 0x4;
/** River rapids: a straight slope where the river drops a level. Ships need a lock to pass. */
export const WATER_RAPIDS = 0x8;
