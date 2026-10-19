import { MAP_SIZES } from '../world/constants.ts';
import type { TerrainRoughness } from '../world/terrain.ts';

export type TimelineMode = 'era' | 'sandbox';
export type AccidentSeverity = 'off' | 'low' | 'realistic';
export type EconomyDifficulty = 'easy' | 'normal' | 'hard';

export interface GameSettings {
  name: string;
  mapWidth: number;
  mapHeight: number;
  seed: number;
  roughness: TerrainRoughness;
  waterLevel: number;
  treeDensity: number;
  /** Era: vehicles unlock/obsolete over time. Sandbox: everything available. */
  timeline: TimelineMode;
  startYear: number;
  accidents: AccidentSeverity;
  breakdowns: boolean;
  economy: EconomyDifficulty;
  /** Player slots chosen by the host, clamped to the server's MAX_PLAYERS. */
  maxPlayers: number;
  /** Listed in the public lobby browser. */
  isPublic: boolean;
}

export const DEFAULT_SETTINGS: GameSettings = {
  name: 'New game',
  mapWidth: 512,
  mapHeight: 512,
  seed: 1,
  roughness: 'hilly',
  waterLevel: 0.22,
  treeDensity: 1,
  timeline: 'era',
  startYear: 1900,
  accidents: 'low',
  breakdowns: true,
  economy: 'normal',
  maxPlayers: 8,
  isPublic: true,
};

export const ECONOMY = {
  easy: { startMoney: 1_000_000, maxLoan: 2_000_000, costFactor: 0.75, interestRate: 0.03 },
  normal: { startMoney: 500_000, maxLoan: 1_000_000, costFactor: 1, interestRate: 0.045 },
  hard: { startMoney: 250_000, maxLoan: 500_000, costFactor: 1.35, interestRate: 0.06 },
} as const satisfies Record<EconomyDifficulty, unknown>;

export interface ServerLimits {
  maxPlayers: number;
  maxMapSize: number;
}

const oneOf = <T>(v: unknown, options: readonly T[], fallback: T): T =>
  options.includes(v as T) ? (v as T) : fallback;
const clamp = (v: unknown, lo: number, hi: number, fallback: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : fallback;

/** Sanitize untrusted settings from a client against server limits. */
export function sanitizeSettings(input: Partial<GameSettings>, limits: ServerLimits): GameSettings {
  const d = DEFAULT_SETTINGS;
  const sizes = MAP_SIZES.filter((s) => s <= limits.maxMapSize);
  return {
    name: typeof input.name === 'string' && input.name.trim() ? input.name.trim().slice(0, 48) : d.name,
    mapWidth: oneOf(input.mapWidth, sizes, Math.min(d.mapWidth, limits.maxMapSize)),
    mapHeight: oneOf(input.mapHeight, sizes, Math.min(d.mapHeight, limits.maxMapSize)),
    seed: Math.floor(clamp(input.seed, 0, 0xffffffff, Math.floor(Math.random() * 0xffffffff))),
    roughness: oneOf(input.roughness, ['flat', 'hilly', 'mountainous'] as const, d.roughness),
    waterLevel: clamp(input.waterLevel, 0, 0.8, d.waterLevel),
    treeDensity: clamp(input.treeDensity, 0, 2, d.treeDensity),
    timeline: oneOf(input.timeline, ['era', 'sandbox'] as const, d.timeline),
    startYear: Math.round(clamp(input.startYear, 1850, 2050, d.startYear)),
    accidents: oneOf(input.accidents, ['off', 'low', 'realistic'] as const, d.accidents),
    breakdowns: typeof input.breakdowns === 'boolean' ? input.breakdowns : d.breakdowns,
    economy: oneOf(input.economy, ['easy', 'normal', 'hard'] as const, d.economy),
    maxPlayers: Math.round(clamp(input.maxPlayers, 1, limits.maxPlayers, Math.min(d.maxPlayers, limits.maxPlayers))),
    isPublic: typeof input.isPublic === 'boolean' ? input.isPublic : d.isPublic,
  };
}
