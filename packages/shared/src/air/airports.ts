import { ymdFromDays } from '../sim/date.ts';
import type { GameState } from '../sim/state.ts';
import type { GameMap } from '../world/map.ts';

export type AirportKind = 'small' | 'large';

export interface AirportType {
  name: string;
  w: number;
  h: number;
  gates: number;
  intro: number;
  cost: number;
}

/** Runway along row 0 (west to east), taxiway on row 1, gates in front of the terminal on the last row. */
export const AIRPORT_TYPES: Record<AirportKind, AirportType> = {
  small: { name: 'Small airport', w: 5, h: 3, gates: 2, intro: 1930, cost: 60_000 },
  large: { name: 'City airport', w: 7, h: 4, gates: 4, intro: 1955, cost: 160_000 },
};

/** Roles of airport tiles, kept in the `track` layer of Airport tiles (for drawing). */
export const AirportRole = { Runway: 0, Taxiway: 1, Apron: 2, Terminal: 3, Hangar: 4 } as const;

export interface AirportInfo {
  kind: AirportKind;
  /** North-west corner. */
  x: number;
  y: number;
}

/** Role of the tile at (dx, dy) inside an airport. */
export function airportRole(kind: AirportKind, dx: number, dy: number): number {
  const t = AIRPORT_TYPES[kind];
  if (dy === 0) return AirportRole.Runway;
  if (dy === 1) return AirportRole.Taxiway;
  if (dy < t.h - 1) return AirportRole.Apron;
  if (dx === 0) return AirportRole.Hangar;
  if (dx <= t.gates) return AirportRole.Terminal;
  return AirportRole.Apron;
}

export interface Point {
  x: number;
  y: number;
}

/** Points aircraft move between at an airport (tile coordinates). */
export interface AirportNodes {
  /** Row of the taxiway centre. */
  taxiY: number;
  hangarDoor: Point;
  gates: Point[];
  /** Waiting point before entering the runway (west end of the taxiway). */
  hold: Point;
  runwayStart: Point;
  runwayEnd: Point;
  /** Where landing aircraft line up, west of the runway. */
  approach: Point;
  /** Where landed aircraft turn off the runway onto the taxiway. */
  exit: Point;
}

export function airportNodes(a: AirportInfo): AirportNodes {
  const t = AIRPORT_TYPES[a.kind];
  const gateY = a.y + t.h - 1 + 0.2;
  return {
    taxiY: a.y + 1.5,
    hangarDoor: { x: a.x + 0.5, y: gateY },
    gates: Array.from({ length: t.gates }, (_, i) => ({ x: a.x + 1.5 + i, y: gateY })),
    hold: { x: a.x + 0.5, y: a.y + 1.5 },
    runwayStart: { x: a.x + 0.3, y: a.y + 0.5 },
    runwayEnd: { x: a.x + t.w - 0.3, y: a.y + 0.5 },
    approach: { x: a.x - 6, y: a.y + 0.5 },
    exit: { x: a.x + t.w - 0.5, y: a.y + 1.5 },
  };
}

/** Taxi route between two ground points: via the taxiway row (Manhattan). */
export function taxiRoute(n: AirportNodes, from: Point, to: Point): Point[] {
  const out: Point[] = [];
  if (Math.abs(from.y - n.taxiY) > 0.01) out.push({ x: from.x, y: n.taxiY });
  if (Math.abs(from.x - to.x) > 0.01) out.push({ x: to.x, y: n.taxiY });
  out.push(to);
  return out;
}

/** The hangar tile of an airport (aircraft park there). */
export const hangarTile = (map: GameMap, a: AirportInfo) => map.tileIndex(a.x, a.y + AIRPORT_TYPES[a.kind].h - 1);

/** Validate an airport kind a player wants to build. */
export function airportKindError(state: GameState, kind: unknown): string | null {
  if (kind !== 'small' && kind !== 'large') return 'Invalid airport';
  const t = AIRPORT_TYPES[kind];
  const year = ymdFromDays(state.date).year;
  if (state.settings.timeline === 'era' && t.intro > year) return `${t.name}s arrive in ${t.intro}`;
  return null;
}
