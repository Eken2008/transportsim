import type { ChatChannel, GameSettings, GlobalState, NewsItem, RoomSummary, ServerLimits, SignalKind } from '@transportsim/shared';
import { create } from 'zustand';
import type { ConnectionStatus } from './net/connection.ts';
import type { SaveRecord } from './saves/saveStore.ts';

export type ToolId = 'raise' | 'lower' | 'level' | 'rail' | 'removeRail' | 'station' | 'depot' | 'bulldoze' | 'orders' | 'signal' | 'bridge' | 'tunnel' | 'convert' | 'waypoint' | 'road' | 'removeRoad' | 'roadStop' | 'roadDepot' | 'oneWay' | 'airport' | 'canal' | 'lock' | 'dock' | 'shipDepot' | 'buoy' | 'headquarters';

export interface StationOptions {
  axis: 0 | 1;
  platforms: number;
  length: number;
}

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'success';
}

export interface ChatLine {
  from: string;
  text: string;
  at: number;
  system?: boolean;
  channel?: ChatChannel;
}

export interface RoomInfo {
  id: string;
  playerId: number;
  isHost: boolean;
  settings: GameSettings;
  spawn: { x: number; y: number };
}

/** Hover readout from the active tool (shown in the status bar). */
export interface HoverInfo {
  x: number;
  y: number;
  height: number;
  cost?: number;
  error?: string;
  /** Neutral extra information (e.g. catchment residents). */
  info?: string;
}

export interface AppState {
  conn: ConnectionStatus;
  limits: ServerLimits | null;
  rooms: RoomSummary[];
  room: RoomInfo | null;
  global: GlobalState | null;
  hostStatus: { connected: boolean; closesAt?: number };
  autosave: boolean;
  autosavePrompt: boolean;
  chat: ChatLine[];
  /** News history, oldest first. */
  news: NewsItem[];
  /** The latest news item, shown briefly in the ticker. */
  ticker: NewsItem | null;
  toasts: Toast[];
  tool: ToolId | null;
  hover: HoverInfo | null;
  closedReason: string | null;
  saves: SaveRecord[];
  busy: string | null;
  stationOpts: StationOptions;
  /** Bridge type for the bridge tool; null picks the cheapest that fits. */
  bridgeType: number | null;
  /** Signal tool places one-way signals (no passing from behind). */
  signalOneWay: boolean;
  /** Road stop tool builds bus (passengers, mail) or truck (freight) stops. */
  roadStopKind: 'bus' | 'truck';
  /** Airport tool builds a small or a large airport. */
  airportKind: 'small' | 'large';
  /** Track type for new track, stations, depots, bridges, tunnels and conversion. */
  railType: number;
  /** Kind of signal the signal tool places. */
  signalKind: SignalKind;
  /** Tiles of track between the signals a drag with the signal tool places. */
  signalInterval: number;
  /** Draw path reservations on the track. */
  showReservations: boolean;
  /** How trees are drawn. */
  treeView: ViewMode;
  /** How houses and industries are drawn. */
  buildingView: ViewMode;
  /** Station whose catchment area is shown (toggled from its window). */
  catchmentFor: number | null;
  /** Bumped when train details change, so windows re-render. */
  trainsRev: number;
  /** Bumped when lines change, so windows re-render. */
  linesRev: number;
  /** Line whose orders the orders tool is adding to. */
  ordersFor: number | null;
  /** Camera focus request (renderer watches `seq`). */
  focus: { x: number; y: number; seq: number } | null;
  /** Vehicle the camera is following (cleared when the player moves the camera). */
  follow: number | null;
  windows: GameWindow[];
  /** Open window asked to come to the front and flash (its window key; `seq` makes repeats count). */
  raise: { key: string; seq: number } | null;
  /** The getting-started guide is showing. */
  tutorial: boolean;
  /** Kinds of command this player has carried out (the guide ticks steps off with them). */
  doneCommands: string[];
}

/** Trees and buildings can be drawn see-through or hidden to see what is behind them. */
export type ViewMode = 'normal' | 'transparent' | 'hidden';

export const nextViewMode = (m: ViewMode): ViewMode => (m === 'normal' ? 'transparent' : m === 'transparent' ? 'hidden' : 'normal');

export type GameWindow =
  | { kind: 'train'; id: number }
  | { kind: 'trainInfo'; id: number }
  | { kind: 'depot'; id: number }
  | { kind: 'station'; id: number }
  | { kind: 'trains'; id: 0 }
  | { kind: 'lines'; id: 0 }
  | { kind: 'line'; id: number }
  | { kind: 'company'; id: 0 }
  | { kind: 'news'; id: 0 }
  | { kind: 'finances'; id: number }
  | { kind: 'league'; id: 0 }
  | { kind: 'game'; id: 0 }
  | { kind: 'industry'; id: number }
  | { kind: 'town'; id: number }
  | { kind: 'roadDepot'; id: number }
  | { kind: 'hangar'; id: number }
  | { kind: 'shipDepot'; id: number }
  | { kind: 'stats'; id: 0 }
  /** `select`: the chain node to show (an industry type `t:<id>`, a cargo `c:<id>` or `towns`). */
  | { kind: 'cargo'; id: 0; select?: string };

export const windowKey = (w: GameWindow) => `${w.kind}:${w.id}`;

/** Opens a window, or brings an already open one to the front and flashes it. */
export function openWindow(w: GameWindow): void {
  const key = windowKey(w);
  useApp.setState((s) =>
    s.windows.some((o) => windowKey(o) === key)
      ? { windows: s.windows.map((o) => (windowKey(o) === key ? w : o)), raise: { key, seq: (s.raise?.seq ?? 0) + 1 } }
      : { windows: [...s.windows, w] },
  );
}

export function closeWindow(w: GameWindow): void {
  useApp.setState((s) => ({ windows: s.windows.filter((o) => windowKey(o) !== windowKey(w)) }));
}

export const useApp = create<AppState>(() => ({
  conn: 'closed',
  limits: null,
  rooms: [],
  room: null,
  global: null,
  hostStatus: { connected: true },
  autosave: false,
  autosavePrompt: false,
  chat: [],
  news: [],
  ticker: null,
  toasts: [],
  tool: null,
  hover: null,
  closedReason: null,
  saves: [],
  busy: null,
  stationOpts: { axis: 0, platforms: 2, length: 5 },
  bridgeType: null,
  signalOneWay: false,
  signalKind: 'block',
  signalInterval: 4,
  railType: 0,
  roadStopKind: 'bus',
  airportKind: 'small',
  showReservations: false,
  treeView: 'normal',
  buildingView: 'normal',
  catchmentFor: null,
  trainsRev: 0,
  linesRev: 0,
  ordersFor: null,
  focus: null,
  follow: null,
  windows: [],
  raise: null,
  tutorial: false,
  doneCommands: [],
}));

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 4000): void {
  const id = ++toastId;
  useApp.setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, text, kind }] }));
  setTimeout(() => useApp.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}
