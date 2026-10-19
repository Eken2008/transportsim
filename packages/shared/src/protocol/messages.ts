import type { Command } from '../commands/index.ts';
import type { Company } from '../company/company.ts';
import type { MonthRecord, QuarterRecord } from '../economy/finance.ts';
import type { Agreement } from '../company/sharing.ts';
import type { Waypoint } from '../rail/waypoint.ts';
import type { GameSettings, ServerLimits } from '../sim/settings.ts';
import type { Player } from '../sim/state.ts';
import type { NewsItem } from '../news/news.ts';
import type { Town } from '../town/towns.ts';
import type { Industry } from '../economy/industries.ts';
import type { Station } from '../rail/station.ts';
import type { TrainInfo, TrainMotion } from '../vehicles/train.ts';
import type { ChunkData } from '../world/chunks.ts';

export const PROTOCOL_VERSION = 2;

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
  timeline: GameSettings['timeline'];
  economy: GameSettings['economy'];
}

export interface GlobalState {
  tick: number;
  date: number;
  dayTick: number;
  speed: GameSpeed;
  companies: Company[];
  players: Player[];
  agreements: Agreement[];
  waypoints: Waypoint[];
  /** Tiles blocked by wreckage after an accident. */
  wrecks: number[];
  /** Price levels (inflation). */
  inflation: { costs: number; payments: number };
}

export type ChatChannel = 'all' | 'company';

export interface CompanyHistory {
  id: number;
  finances: QuarterRecord[];
  months: MonthRecord[];
}

/** Settings the host can change while the game runs. */
export type LiveSetting = 'name' | 'maxPlayers' | 'isPublic';

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
  /** Stations and industries the client shows in open windows (it gets their updates wherever they are). */
  | { t: 'watch'; stations: number[]; industries: number[] }
  | { t: 'command'; seq: number; cmd: Command }
  | { t: 'setSpeed'; speed: GameSpeed }
  | { t: 'autosave'; enabled: boolean }
  /** Ask for a snapshot: kept in the host's browser, or (`export`) downloaded as a file by anyone. */
  | { t: 'requestSave'; export?: boolean }
  /** `company` sends to members of the sender's company only. */
  | { t: 'chat'; text: string; channel?: ChatChannel }
  /** Host only: change lobby-level settings while the game runs. */
  | { t: 'updateSettings'; settings: Partial<Pick<GameSettings, LiveSetting>> }
  /** Host only: remove a player from the game (they can't rejoin it). */
  | { t: 'kick'; playerId: number }
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
  /** Industry list; `full` replaces the client's list. `removed` lists closed ones. */
  | { t: 'industries'; industries: Industry[]; removed: number[]; full: boolean }
  /** Station list; `full` replaces the client's list. `removed` lists deleted ids. */
  | { t: 'stations'; stations: Station[]; removed: number[]; full: boolean }
  /** Train details (all trains; changes only unless `full`). */
  | { t: 'trains'; trains: TrainInfo[]; removed: number[]; full: boolean }
  /** Positions of trains near the client's subscribed chunks (~10 Hz). */
  | { t: 'trainPos'; trains: TrainMotion[] }
  /**
   * Aspects of signals in subscribed chunks: `red[i]` is the red-trackdir mask of `tiles[i]`.
   * `reserved` lists path-reserved pieces (tile * 8 + piece) in those chunks.
   */
  | { t: 'signals'; tiles: number[]; red: number[]; reserved: number[] }
  /** A train was paid at a station (floating "+£" label). */
  | { t: 'income'; tile: number; amount: number }
  | { t: 'global'; global: GlobalState }
  /**
   * Company books and monthly statistics. `full` replaces what the client has; otherwise
   * `months` are appended and `finances` replace the quarters. (The daily `global` message only
   * carries each company's current quarter.)
   */
  | { t: 'history'; companies: CompanyHistory[]; full: boolean }
  /** Settings changed by the host during the game. */
  | { t: 'settings'; settings: GameSettings }
  | { t: 'commandResult'; seq: number; ok: boolean; error?: string; cost?: number }
  /** Host connectivity; when disconnected the room closes at `closesAt` (epoch ms). */
  | { t: 'hostStatus'; connected: boolean; closesAt?: number }
  | { t: 'autosaveStatus'; enabled: boolean }
  | { t: 'saveData'; kind: 'auto' | 'manual'; name: string; date: number; snapshot: Uint8Array; export?: boolean }
  | { t: 'chat'; from: string; text: string; at: number; system?: boolean; channel?: ChatChannel }
  /** News items; `full` replaces the client's history. */
  | { t: 'news'; items: NewsItem[]; full: boolean }
  | { t: 'pong'; at: number };
