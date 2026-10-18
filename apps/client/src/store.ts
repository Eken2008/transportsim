import type { GameSettings, GlobalState, RoomSummary, ServerLimits } from '@transportsim/shared';
import { create } from 'zustand';
import type { ConnectionStatus } from './net/connection.ts';
import type { SaveRecord } from './saves/saveStore.ts';

export type ToolId = 'raise' | 'lower' | 'level';

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
}));

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 4000): void {
  const id = ++toastId;
  useApp.setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, text, kind }] }));
  setTimeout(() => useApp.setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}
