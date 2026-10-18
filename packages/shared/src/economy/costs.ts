/** Base construction costs (before economy difficulty scaling). */
export const COSTS = {
  terraformCorner: 400,
  clearTree: 60,
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
} as const;
