import type { Command } from '../commands/index.ts';
import type { Company } from '../company/company.ts';
import type { GameSettings, ServerLimits } from '../sim/settings.ts';
import type { Player } from '../sim/state.ts';
import type { Town } from '../town/towns.ts';
import type { Station } from '../rail/station.ts';
import type { TrainInfo, TrainMotion } from '../vehicles/train.ts';
import type { ChunkData } from '../world/chunks.ts';

export const PROTOCOL_VERSION = 1;

/** Game speed multiplier; 0 = paused. */
export type GameSpeed = 0 | 1 | 2 | 4 | 8;
export const GAME_SPEEDS: readonly GameSpeed[] = [0, 1, 2, 4, 8];

export interface RoomSummary {
  id: string;
  name: string;
  hostName: string;
  players: number;
  maxPlayers: number;
  mapWidth: number;
  mapHeight: number;
  year: number;
}

export interface GlobalState {
  tick: number;
  date: number;
  dayTick: number;
  speed: GameSpeed;
  companies: Company[];
  players: Player[];
}

// ---- client → server --------------------------------------------------------

export type ClientMessage =
  | { t: 'hello'; protocol: number; clientId: string; name: string }
  | { t: 'listRooms' }
  /** `save` is an uncompressed snapshot (see save/snapshot.ts) to resume from. */
  | { t: 'createRoom'; settings: Partial<GameSettings>; save?: Uint8Array }
  | { t: 'joinRoom'; roomId: string }
  | { t: 'leaveRoom' }
  /** Full set of chunk ids the client wants to receive (replaces previous set). */
  | { t: 'subscribe'; chunks: number[] }
  | { t: 'command'; seq: number; cmd: Command }
  | { t: 'setSpeed'; speed: GameSpeed }
  | { t: 'autosave'; enabled: boolean }
  | { t: 'requestSave' }
  | { t: 'chat'; text: string }
  | { t: 'ping'; at: number };

// ---- server → client --------------------------------------------------------

export type ServerMessage =
  | { t: 'welcome'; protocol: number; limits: ServerLimits }
  | { t: 'error'; message: string }
  | { t: 'roomList'; rooms: RoomSummary[] }
  | {
      t: 'roomJoined';
      roomId: string;
      playerId: number;
      isHost: boolean;
      settings: GameSettings;
      global: GlobalState;
      autosave: boolean;
      /** Suggested initial camera position (tile coordinates). */
      spawn: { x: number; y: number };
    }
  | { t: 'roomClosed'; reason: string }
  | { t: 'chunk'; data: ChunkData }
  /** Town list; `full` replaces the client's list, otherwise entries are upserted. */
  | { t: 'towns'; towns: Town[]; full: boolean }
  /** Station list; `full` replaces the client's list. `removed` lists deleted ids. */
  | { t: 'stations'; stations: Station[]; removed: number[]; full: boolean }
  /** Train details (all trains; changes only unless `full`). */
  | { t: 'trains'; trains: TrainInfo[]; removed: number[]; full: boolean }
  /** Positions of trains near the client's subscribed chunks (~10 Hz). */
  | { t: 'trainPos'; trains: TrainMotion[] }
  /** Aspects of signals in subscribed chunks: `red[i]` is the red-trackdir mask of `tiles[i]`. */
  | { t: 'signals'; tiles: number[]; red: number[] }
  /** A train was paid at a station (floating "+£" label). */
  | { t: 'income'; tile: number; amount: number }
  | { t: 'global'; global: GlobalState }
  | { t: 'commandResult'; seq: number; ok: boolean; error?: string; cost?: number }
  /** Host connectivity; when disconnected the room closes at `closesAt` (epoch ms). */
  | { t: 'hostStatus'; connected: boolean; closesAt?: number }
  | { t: 'autosaveStatus'; enabled: boolean }
  | { t: 'saveData'; kind: 'auto' | 'manual'; name: string; date: number; snapshot: Uint8Array }
  | { t: 'chat'; from: string; text: string; at: number; system?: boolean }
  | { t: 'pong'; at: number };
