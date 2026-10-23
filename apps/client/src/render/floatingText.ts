import { HEIGHT_SCALE } from '@transportsim/shared';
import * as THREE from 'three';
import type { ClientWorld } from '../game/clientWorld.ts';

const LIFETIME = 2200;
const _v = new THREE.Vector3();

interface Floater {
  el: HTMLDivElement;
  x: number;
  y: number;
  born: number;
}

/** Rising, fading "+£1,234" labels where trains get paid. */
export class FloatingText {
  private readonly el: HTMLDivElement;
  private items: Floater[] = [];

  constructor(
    parent: HTMLElement,
    private readonly world: ClientWorld,
  ) {
    this.el = document.createElement('div');
    this.el.className = 'floaters';
    parent.insertBefore(this.el, parent.querySelector('canvas')?.nextSibling ?? null);
  }

  /** Labels are rising. */
  get active(): boolean {
    return this.items.length > 0;
  }

  add(tile: number, text: string, kind: 'income' | 'cost' = 'income'): void {
    const map = this.world.map;
    const el = document.createElement('div');
    el.className = `floater ${kind}`;
    el.textContent = text;
    this.el.appendChild(el);
    const x = tile % map.width;
    this.items.push({ el, x: x + 0.5, y: Math.floor(tile / map.width) + 0.5, born: performance.now() });
  }

  update(camera: THREE.Camera, width: number, height: number): void {
    const now = performance.now();
    const map = this.world.map;
    this.items = this.items.filter((f) => {
      const age = (now - f.born) / LIFETIME;
      if (age >= 1) {
        f.el.remove();
        return false;
      }
      _v.set(f.x, map.heightAt(f.x, f.y) * HEIGHT_SCALE + 1 + age * 1.2, f.y).project(camera);
      if (_v.z > 1) {
        f.el.style.display = 'none';
        return true;
      }
      f.el.style.display = '';
      f.el.style.opacity = String(Math.min(1, (1 - age) * 2.5));
      f.el.style.transform = `translate(-50%, -50%) translate(${((_v.x + 1) / 2) * width}px, ${((1 - _v.y) / 2) * height}px)`;
      return true;
    });
  }

  dispose(): void {
    this.el.remove();
  }
}
