import type { Town } from '../town/towns.ts';

/** Rail tile `data` bit 11: the tile's straight piece is a waypoint. */
export const WAYPOINT_FLAG = 0x800;

/** A named point on the line that orders can route trains through without stopping. */
export interface Waypoint {
  id: number;
  name: string;
  owner: number;
  tile: number;
  /** A buoy on water (for ships) rather than a rail waypoint. */
  buoy?: boolean;
}

/** A unique name from the nearest town. */
export function waypointName(x: number, y: number, towns: Iterable<Town>, existing: Iterable<Waypoint>, kind = 'Waypoint'): string {
  let best: Town | null = null;
  let bestD = Infinity;
  for (const t of towns) {
    const d = Math.abs(t.x - x) + Math.abs(t.y - y);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  const used = new Set([...existing].map((w) => w.name));
  const base = `${best?.name ?? 'Line'} ${kind}`;
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
}
