/**
 * Server configuration. Everything is overridable through environment variables so
 * self-hosters can tune limits without touching code, e.g.
 *   MAX_PLAYERS=32 MAX_MAP_SIZE=4096 bun run start
 */
export interface ServerConfig {
  port: number;
  /** Upper bound for players per game. The hosted server uses 15. */
  maxPlayers: number;
  /** Largest allowed map side in tiles. */
  maxMapSize: number;
  /** Concurrent games on this server. */
  maxRooms: number;
  /** How long a room waits for a disconnected host before shutting down. */
  hostGraceMs: number;
  /** Minimum real time between autosaves sent to the host. */
  autosaveMinIntervalMs: number;
  /** Directory with the built client to serve (optional). */
  staticDir: string | null;
}

const int = (name: string, fallback: number): number => {
  const v = Number.parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};

export function loadConfig(): ServerConfig {
  return {
    port: int('PORT', 8787),
    maxPlayers: int('MAX_PLAYERS', 15),
    maxMapSize: int('MAX_MAP_SIZE', 2048),
    maxRooms: int('MAX_ROOMS', 20),
    hostGraceMs: int('HOST_GRACE_SECONDS', 60) * 1000,
    autosaveMinIntervalMs: int('AUTOSAVE_MIN_SECONDS', 60) * 1000,
    staticDir: process.env.STATIC_DIR ?? null,
  };
}
