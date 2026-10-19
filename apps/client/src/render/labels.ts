import { COMPANY_COLORS, HEIGHT_SCALE } from '@transportsim/shared';
import * as THREE from 'three';
import type { ClientWorld } from '../game/clientWorld.ts';

interface LabelItem {
  key: string;
  x: number;
  y: number;
  /** World height offset above the ground. */
  lift: number;
  title: string;
  sub: string;
  importance: number;
  kind: 'town' | 'station' | 'waypoint';
  color?: string;
}

const _v = new THREE.Vector3();

/**
 * HTML labels pinned to world positions (town names, later stations). DOM nodes are pooled
 * and positioned with transforms each frame; far or off-screen labels are hidden.
 */
export class LabelLayer {
  readonly el: HTMLDivElement;
  private nodes = new Map<string, HTMLDivElement>();
  private items: LabelItem[] = [];
  private rev = '';

  constructor(
    parent: HTMLElement,
    private readonly world: ClientWorld,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'labels';
    // Directly after the canvas so HUD panels stay on top.
    parent.insertBefore(this.el, parent.querySelector('canvas')?.nextSibling ?? null);
  }

  private refresh(): void {
    this.rev = this.revKey();
    const state = this.world.state;
    const towns: LabelItem[] = [...state.towns.values()].map((t) => ({
      key: `t${t.id}`,
      x: t.x + 0.5,
      y: t.y + 0.5,
      lift: 1.6,
      title: t.name,
      sub: t.population.toLocaleString('en-GB'),
      importance: Math.log10(Math.max(10, t.population)),
      kind: 'town',
    }));
    const stations: LabelItem[] = [...state.stations.values()].map((s) => {
      const company = state.companies.get(s.owner);
      return {
        key: `s${s.id}`,
        x: (s.x0 + s.x1 + 1) / 2,
        y: (s.y0 + s.y1 + 1) / 2,
        lift: 0.9,
        title: s.name,
        sub: s.waitingTotal > 0 ? `${s.waitingTotal} waiting` : '',
        importance: 2.2,
        kind: 'station',
        color: company ? COMPANY_COLORS[company.color % COMPANY_COLORS.length] : '#888',
      };
    });
    const w = this.world.map.width;
    const waypoints: LabelItem[] = [...state.waypoints.values()].map((wp) => ({
      key: `w${wp.id}`,
      x: (wp.tile % w) + 0.5,
      y: Math.floor(wp.tile / w) + 0.5,
      lift: 0.6,
      title: wp.name,
      sub: '',
      importance: 1.2,
      kind: 'waypoint',
    }));
    this.items = [...towns, ...stations, ...waypoints];
    const keep = new Set(this.items.map((i) => i.key));
    for (const [k, n] of this.nodes) {
      if (!keep.has(k)) {
        n.remove();
        this.nodes.delete(k);
      }
    }
    for (const item of this.items) {
      let n = this.nodes.get(item.key);
      if (!n) {
        n = document.createElement('div');
        n.className = `label ${item.kind}`;
        n.innerHTML = '<b></b><span></span>';
        this.el.appendChild(n);
        this.nodes.set(item.key, n);
      }
      n.firstElementChild!.textContent = item.title;
      n.lastElementChild!.textContent = item.sub;
      if (item.color) n.style.setProperty('--company', item.color);
    }
  }

  update(camera: THREE.PerspectiveCamera, width: number, height: number, distance: number): void {
    if (this.rev !== this.revKey()) this.refresh();
    const map = this.world.map;
    const maxDist = distance * 6 + 60;
    const camPos = camera.position;
    for (const item of this.items) {
      const n = this.nodes.get(item.key)!;
      _v.set(item.x, map.heightAt(item.x, item.y) * HEIGHT_SCALE + item.lift, item.y);
      const d = _v.distanceTo(camPos);
      // Small towns fade out sooner when zoomed out.
      const limit = maxDist * (0.45 + item.importance * 0.25);
      _v.project(camera);
      if (d > limit || _v.z > 1 || _v.x < -1.1 || _v.x > 1.1 || _v.y < -1.1 || _v.y > 1.1) {
        if (n.style.display !== 'none') n.style.display = 'none';
        continue;
      }
      if (n.style.display === 'none') n.style.display = '';
      const sx = ((_v.x + 1) / 2) * width;
      const sy = ((1 - _v.y) / 2) * height;
      n.style.transform = `translate(-50%, -100%) translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px)`;
    }
  }

  private revKey(): string {
    return `${this.world.townsRev}:${this.world.stationsRev}:${this.world.waypointsRev}`;
  }

  dispose(): void {
    this.el.remove();
  }
}
