import { HEIGHT_SCALE, TileType, type Command } from '@transportsim/shared';
import * as THREE from 'three';
import { client } from '../net/client.ts';
import { useApp } from '../store.ts';
import type { GameRenderer } from './gameRenderer.ts';

export interface ViewParams {
  x?: number;
  y?: number;
  distance?: number;
  yaw?: number;
  pitch?: number;
}

/**
 * `window.transportsim`: a small automation/debug API used by the smoke test and handy
 * from the browser console. Only exposes what a player could do through the UI.
 */
export function installDebugHook(r: GameRenderer): () => void {
  const api = {
    get spawn() {
      return useApp.getState().room?.spawn ?? null;
    },
    lookAt(x: number, y: number, distance?: number) {
      r.lookAt(x, y);
      if (distance) r.controller.distance = distance;
    },
    view(v: ViewParams) {
      const c = r.controller;
      if (v.x !== undefined && v.y !== undefined) r.lookAt(v.x, v.y);
      if (v.distance !== undefined) c.distance = v.distance;
      if (v.yaw !== undefined) c.yaw = v.yaw;
      if (v.pitch !== undefined) c.pitch = v.pitch;
      c.apply();
    },
    /** Client-space pixel position of a tile's centre with the current camera. */
    tileToScreen(x: number, y: number): { x: number; y: number } {
      r.controller.apply();
      const map = client.world!.map;
      const p = new THREE.Vector3(x + 0.5, map.heightAt(x + 0.5, y + 0.5) * HEIGHT_SCALE, y + 0.5).project(r.camera);
      const rect = r.renderer.domElement.getBoundingClientRect();
      return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
    },
    /** Raw tile data for inspection. */
    tile(x: number, y: number) {
      const map = client.world!.map;
      const i = map.tileIndex(x, y);
      return { type: map.layers.type[i], data: map.layers.data[i], track: map.layers.track[i], signals: map.layers.signals[i], corners: map.tileCorners(x, y) };
    },
    /** A straight town road tile near (x, y) where a level crossing could go. */
    findCrossingSpot(x: number, y: number) {
      const map = client.world!.map;
      for (let r = 0; r < 40; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || !map.inBounds(x + dx, y + dy)) continue;
            const i = map.tileIndex(x + dx, y + dy);
            const road = map.layers.data[i]! & 0xf;
            if (map.layers.type[i] === TileType.Road && map.isFlat(x + dx, y + dy) && (road === 5 || road === 10)) {
              return { x: x + dx, y: y + dy, piece: road === 5 ? 0 : 1 };
            }
          }
        }
      }
      return null;
    },
    command(cmd: Command) {
      return client.command(cmd);
    },
  };
  const w = window as unknown as { transportsim?: typeof api };
  w.transportsim = api;
  return () => {
    if (w.transportsim === api) delete w.transportsim;
  };
}
