import { Ground, TileType } from '../world/constants.ts';
import type { GameMap } from '../world/map.ts';

/** Base construction costs (before economy difficulty scaling). */
export const COSTS = {
  terraformCorner: 400,
  /** Levelling a sloped tile to build on it (see Foundation). */
  foundation: 300,
  clearTree: 60,
  /** Buying up a piece of a farm's field to build on it. */
  clearField: 700,
  railPiece: 250,
  railRemove: 40,
  levelCrossing: 600,
  stationTile: 700,
  stationRemove: 150,
  depot: 1800,
  depotRemove: 300,
  signal: 350,
  tunnelPerTile: 1_600,
  structureRemove: 400,
  road: 180,
  roadRemove: 40,
  roadStop: 900,
  roadDepot: 1_500,
  /** A company's headquarters (building it again elsewhere moves it). */
  headquarters: 25_000,
  /** Demolishing a town's house: a base and so much per resident. */
  houseRemove: 400,
  houseRemovePerResident: 20,
  /** Town actions (see town/actions.ts). */
  advertSmall: 8_000,
  advertMedium: 16_000,
  advertLarge: 35_000,
  roadWorks: 135_000,
  statue: 185_000,
  fundBuildings: 235_000,
  exclusiveRights: 330_000,
  bribe: 400_000,
} as const;

/** What it costs to clear a tile of open land for building: its trees, or its field. */
export function clearCost(map: GameMap, x: number, y: number): number {
  const i = map.tileIndex(x, y);
  if (map.layers.type[i] !== TileType.Clear) return 0;
  const field = ((map.layers.data[i]! >> 3) & 0x7) === Ground.Field;
  return map.treeCount(x, y) * COSTS.clearTree + (field ? COSTS.clearField : 0);
}
