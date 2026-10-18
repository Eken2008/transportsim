import { HEIGHT_SCALE, type Command } from '@transportsim/shared';
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
