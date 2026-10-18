import type { GameSettings, GlobalState, RoomSummary, ServerLimits } from '@transportsim/shared';
import { create } from 'zustand';
import type { ConnectionStatus } from './net/connection.ts';
import type { SaveRecord } from './saves/saveStore.ts';

export type ToolId = 'raise' | 'lower' | 'level' | 'rail' | 'removeRail' | 'station' | 'depot' | 'bulldoze' | 'orders' | 'signal';

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
  toasts: Toast[];
  tool: ToolId | null;
  hover: HoverInfo | null;
  closedReason: string | null;
  saves: SaveRecord[];
  busy: string | null;
  stationOpts: StationOptions;
  /** Bumped when train details change, so windows re-render. */
  trainsRev: number;
  /** Train whose orders the orders tool is editing. */
  ordersFor: number | null;
  /** Camera focus request (renderer watches `seq`). */
  focus: { x: number; y: number; seq: number } | null;
  windows: GameWindow[];
}

export type GameWindow =
  | { kind: 'train'; id: number }
  | { kind: 'depot'; id: number }
  | { kind: 'station'; id: number }
  | { kind: 'trains'; id: 0 };

export const windowKey = (w: GameWindow) => `${w.kind}:${w.id}`;

export function openWindow(w: GameWindow): void {
  useApp.setState((s) => ({
    windows: [...s.windows.filter((o) => windowKey(o) !== windowKey(w)), w],
  }));
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
  toasts: [],
  tool: null,
  hover: null,
  closedReason: null,
  saves: [],
  busy: null,
  stationOpts: { axis: 0, platforms: 2, length: 5 },
  trainsRev: 0,
  ordersFor: null,
  focus: null,
  windows: [],
}));

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 4000): void {
  const id = ++toastId;
  useApp.setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, text, kind }] }));
  setTimeout(() => useApp.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}
