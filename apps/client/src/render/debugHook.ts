import { HEIGHT_SCALE, PIECE_NAMES, TileType, nextSegments, seg, trackdir, type Command } from '@transportsim/shared';
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
      return api.pointToScreen(x + 0.5, y + 0.5);
    },
    /** Client-space pixel position of a map point (tile units; (x + 0.5, y + 0.5) is a tile centre). */
    pointToScreen(x: number, y: number): { x: number; y: number } {
      r.controller.apply();
      const map = client.world!.map;
      const p = new THREE.Vector3(x, map.heightAt(x, y) * HEIGHT_SCALE, y).project(r.camera);
      const rect = r.renderer.domElement.getBoundingClientRect();
      return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height };
    },
    /**
     * Follow your track from piece `piece` on (x, y) in direction `dir` (0/1), as a train would,
     * for up to `steps` pieces. Each step lists every way on; the walk takes the first.
     */
    follow(x: number, y: number, piece: number, dir: number, steps: number) {
      const world = client.world!;
      const owner = world.state.players.get(useApp.getState().room?.playerId ?? -1)?.companyId ?? -1;
      const map = world.map;
      const out: { x: number; y: number; piece: string; ways: number }[] = [];
      let s = seg(map.tileIndex(x, y), trackdir(piece, dir));
      for (let k = 0; k < steps; k++) {
        const next = nextSegments(map, s, owner);
        const tile = Math.floor(s / 16);
        out.push({ x: tile % map.width, y: Math.floor(tile / map.width), piece: PIECE_NAMES[(s % 16) >> 1]!, ways: next.length });
        if (!next.length) break;
        s = next[0]!;
      }
      return out;
    },
    /** Raw tile data for inspection. */
    tile(x: number, y: number) {
      const map = client.world!.map;
      const i = map.tileIndex(x, y);
      return { type: map.layers.type[i], data: map.layers.data[i], track: map.layers.track[i], signals: map.layers.signals[i], corners: map.tileCorners(x, y) };
    },
    /** The nearest w×h area of clear land to (x, y) (its north-west corner), searching outwards. */
    findClear(x: number, y: number, w: number, h: number) {
      const map = client.world!.map;
      const clear = (x0: number, y0: number) => {
        for (let ty = y0; ty < y0 + h; ty++) {
          for (let tx = x0; tx < x0 + w; tx++) if (!map.inBounds(tx, ty) || map.layers.type[map.tileIndex(tx, ty)] !== TileType.Clear) return false;
        }
        return true;
      };
      for (let r = 0; r < 60; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dy)) === r && clear(x + dx, y + dy)) return { x: x + dx, y: y + dy };
          }
        }
      }
      return null;
    },
    /** Stations as the client knows them. */
    stations() {
      return [...(client.world?.state.stations.values() ?? [])].map((st) => ({ id: st.id, name: st.name, airport: !!st.airport }));
    },
    /** Vehicles as the client knows them. */
    trains() {
      return [...(client.world?.trains.values() ?? [])].map((t) => ({ id: t.id, mode: t.mode, status: t.status, name: t.name, air: client.world?.motions.get(t.id)?.m.air, ship: client.world?.motions.get(t.id)?.m.ship }));
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
    /** Industries the client knows about. */
    industries() {
      return [...(client.world?.state.industries.values() ?? [])].map((i) => ({ id: i.id, type: i.type, x: i.x, y: i.y, w: i.w, h: i.h }));
    },
  };
  const w = window as unknown as { transportsim?: typeof api };
  w.transportsim = api;
  return () => {
    if (w.transportsim === api) delete w.transportsim;
  };
}
