import { storageGet, storageSet } from '../net/identity.ts';

/** How much the renderer may draw: less looks plainer but runs cooler and saves battery. */
export type Graphics = 'saver' | 'balanced' | 'high';

export interface GraphicsPreset {
  name: string;
  /** Most device pixels per CSS pixel drawn. */
  pixelRatio: number;
  antialias: boolean;
  powerPreference: WebGLPowerPreference;
  /** Frames a second while the camera moves or a tool is in use (0: as many as the screen shows). */
  fps: number;
  /** Frames a second while only vehicles and the like move. */
  movingFps: number;
  /** One bigger tree a tile even close up, as far away: forests are most of what is drawn. */
  sparseTrees: boolean;
}

export const GRAPHICS: Record<Graphics, GraphicsPreset> = {
  saver: { name: 'Battery saver', pixelRatio: 1, antialias: false, powerPreference: 'low-power', fps: 30, movingFps: 20, sparseTrees: true },
  balanced: { name: 'Balanced', pixelRatio: 1.5, antialias: true, powerPreference: 'default', fps: 60, movingFps: 30, sparseTrees: false },
  high: { name: 'Best looking', pixelRatio: 2, antialias: true, powerPreference: 'high-performance', fps: 0, movingFps: 0, sparseTrees: false },
};

export const nextGraphics = (g: Graphics): Graphics => (g === 'saver' ? 'balanced' : g === 'balanced' ? 'high' : 'saver');

const KEY = 'ts.graphics';

/** The player's pick, else battery saver on few-core or small-memory devices. */
export function loadGraphics(): Graphics {
  const saved = storageGet(KEY);
  if (saved === 'saver' || saved === 'balanced' || saved === 'high') return saved;
  const memory = (navigator as { deviceMemory?: number }).deviceMemory;
  return navigator.hardwareConcurrency <= 4 || (memory !== undefined && memory < 4) ? 'saver' : 'balanced';
}

export function saveGraphics(g: Graphics): void {
  storageSet(KEY, g);
}
