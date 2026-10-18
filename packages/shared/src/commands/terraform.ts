import { COSTS } from '../economy/costs.ts';
import { MAX_HEIGHT, TileType } from '../world/constants.ts';
import { reclassifyTile } from '../world/terrain.ts';
import { structuresAt } from '../rail/structures.ts';
import { fail, isInt, type CommandHandler } from './types.ts';

export type TerraformMode = 'raise' | 'lower' | 'level';

/** Raise, lower or level a rectangle of corners (inclusive), propagating slopes outward. */
export interface TerraformCommand {
  type: 'terraform';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  mode: TerraformMode;
  /** Target height for 'level' */
  level?: number;
}

export const TERRAFORM_COST_PER_CORNER = COSTS.terraformCorner;
const MAX_RECT = 64;
const MAX_CHANGED_CORNERS = 20_000;

export const terraformHandler: CommandHandler<TerraformCommand> = {
  needsCompany: true,
  plan(state, _ctx, cmd) {
    const map = state.map;
    const { x0, y0, x1, y1, mode } = cmd;
    if (![x0, y0, x1, y1].every(isInt)) return fail('Invalid coordinates');
    if (mode !== 'raise' && mode !== 'lower' && mode !== 'level') return fail('Invalid mode');
    const ax = Math.min(x0, x1), bx = Math.max(x0, x1);
    const ay = Math.min(y0, y1), by = Math.max(y0, y1);
    if (!map.cornerInBounds(ax, ay) || !map.cornerInBounds(bx, by)) return fail('Out of bounds');
    if (bx - ax >= MAX_RECT || by - ay >= MAX_RECT) return fail('Area too large');
    let level = 0;
    if (mode === 'level') {
      if (!isInt(cmd.level) || cmd.level < 0 || cmd.level > MAX_HEIGHT) return fail('Invalid level');
      level = cmd.level;
    }

    const cw = map.width + 1;
    const ch = map.height + 1;
    const changes = new Map<number, number>();
    const get = (i: number) => changes.get(i) ?? map.heights[i]!;
    const queue: number[] = [];

    for (let y = ay; y <= by; y++) {
      for (let x = ax; x <= bx; x++) {
        const i = y * cw + x;
        const h = map.heights[i]!;
        const nh = mode === 'raise' ? Math.min(MAX_HEIGHT, h + 1) : mode === 'lower' ? Math.max(0, h - 1) : level;
        if (nh !== h) {
          changes.set(i, nh);
          queue.push(i);
        }
      }
    }
    if (changes.size === 0) {
      return fail(mode === 'raise' ? 'Already at maximum height' : mode === 'lower' ? 'Already at sea level' : 'Already level');
    }

    // Propagate the slope rule outward (adjacent corners differ by at most 1).
    while (queue.length) {
      const i = queue.pop()!;
      const h = get(i);
      const x = i % cw;
      const y = (i - x) / cw;
      const visit = (n: number) => {
        const hn = get(n);
        if (hn > h + 1) changes.set(n, h + 1);
        else if (hn < h - 1) changes.set(n, h - 1);
        else return;
        queue.push(n);
      };
      if (x > 0) visit(i - 1);
      if (x < cw - 1) visit(i + 1);
      if (y > 0) visit(i - cw);
      if (y < ch - 1) visit(i + cw);
      if (changes.size > MAX_CHANGED_CORNERS) return fail('Terraforming area too large');
    }

    // Every tile touching a changed corner must be bare land or water.
    const tiles = new Set<number>();
    for (const i of changes.keys()) {
      const x = i % cw;
      const y = (i - x) / cw;
      for (let ty = y - 1; ty <= y; ty++) {
        for (let tx = x - 1; tx <= x; tx++) {
          if (!map.inBounds(tx, ty)) continue;
          const t = map.type(tx, ty);
          if (t !== TileType.Clear && t !== TileType.Water) return fail(`Object in the way at ${tx},${ty}`);
          tiles.add(ty * map.width + tx);
        }
      }
    }

    // Keep clear of bridge decks above and tunnels below.
    for (const t of tiles) {
      const structures = structuresAt(map, t);
      if (structures.length === 0) continue;
      const tx = t % map.width;
      const ty = (t - tx) / map.width;
      const hs = [get(ty * cw + tx), get(ty * cw + tx + 1), get((ty + 1) * cw + tx), get((ty + 1) * cw + tx + 1)];
      for (const s of structures) {
        if (s.kind === 'bridge' && Math.max(...hs) > s.level - 1) return fail(`The bridge above ${tx},${ty} is in the way`);
        if (s.kind === 'tunnel' && Math.min(...hs) < s.level + 1) return fail(`That would cut into the tunnel under ${tx},${ty}`);
      }
    }

    return {
      ok: true,
      cost: state.cost(changes.size * TERRAFORM_COST_PER_CORNER),
      commit() {
        const dirtyChunks = new Set<number>();
        for (const [i, h] of changes) {
          map.heights[i] = h;
          const x = i % cw;
          map.touchCorner(x, (i - x) / cw, dirtyChunks);
        }
        for (const t of tiles) {
          const x = t % map.width;
          reclassifyTile(map, x, (t - x) / map.width);
        }
        return { dirtyChunks };
      },
    };
  },
};
