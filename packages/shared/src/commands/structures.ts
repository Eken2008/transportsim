import { COSTS } from '../economy/costs.ts';
import {
  BRIDGE_TYPES,
  MAX_TUNNEL_LENGTH,
  headData,
  structuresAt,
} from '../rail/structures.ts';
import { EDGE_DX, EDGE_DY, Edge, OPPOSITE_EDGE, Piece, edgeHeight, pieceFitsSlope } from '../rail/track.ts';
import { ymdFromDays } from '../sim/date.ts';
import type { GameState } from '../sim/state.ts';
import { TileType } from '../world/constants.ts';
import { fail, isInt, type CommandHandler, type PlanResult } from './types.ts';

export interface BuildBridgeCommand {
  type: 'buildBridge';
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  bridgeType: number;
}

export interface BuildTunnelCommand {
  type: 'buildTunnel';
  x: number;
  y: number;
  /** Edge of the entrance tile the tunnel heads into. */
  dir: number;
}

const dirBetween = (dx: number, dy: number): Edge => (dx > 0 ? Edge.E : dx < 0 ? Edge.W : dy > 0 ? Edge.S : Edge.N);

/** Can this tile become a bridge head / tunnel portal? Returns extra cost or an error. */
function headTileCost(state: GameState, company: number, i: number, piece: number): number | string {
  const map = state.map;
  const type = map.layers.type[i];
  const x = i % map.width;
  const y = (i - x) / map.width;
  if (type === TileType.Clear) return map.treeCount(x, y) * COSTS.clearTree;
  if (type === TileType.Rail) {
    if (map.layers.owner[i] !== company) return `Track belongs to another company (${x},${y})`;
    if (map.layers.track[i] !== 1 << piece || map.layers.data[i] !== 0 || map.layers.signals[i] !== 0) {
      return `Only plain straight track can become a bridge or tunnel end (${x},${y})`;
    }
    if (state.isPieceOccupied(i, piece)) return `A train is in the way (${x},${y})`;
    return 0;
  }
  return `Object in the way (${x},${y})`;
}

export const buildBridgeHandler: CommandHandler<BuildBridgeCommand> = {
  needsCompany: true,
  plan(state, ctx, cmd): PlanResult {
    const { x0, y0, x1, y1, bridgeType } = cmd;
    if (![x0, y0, x1, y1, bridgeType].every(isInt)) return fail('Invalid bridge');
    const kind = BRIDGE_TYPES[bridgeType];
    if (!kind) return fail('Unknown bridge type');
    const map = state.map;
    if (!map.inBounds(x0, y0) || !map.inBounds(x1, y1)) return fail('Out of bounds');
    if (x0 !== x1 && y0 !== y1) return fail('Bridges must be straight');
    const len = Math.abs(x1 - x0) + Math.abs(y1 - y0) - 1;
    if (len < 1) return fail('A bridge needs at least one tile to span');
    if (len > kind.maxSpan) return fail(`A ${kind.name.toLowerCase()} bridge spans at most ${kind.maxSpan} tiles`);
    const year = ymdFromDays(state.date).year;
    if (state.settings.timeline === 'era' && kind.intro > year) return fail(`${kind.name} bridges arrive in ${kind.intro}`);

    const dir = dirBetween(x1 - x0, y1 - y0);
    const back = OPPOSITE_EDGE[dir];
    const piece = dir === Edge.E || dir === Edge.W ? Piece.X : Piece.Y;
    const company = ctx.companyId!;
    const a = map.tileIndex(x0, y0);
    const b = map.tileIndex(x1, y1);
    const ca = map.tileCorners(x0, y0);
    const cb = map.tileCorners(x1, y1);
    // Bridge ends sit on flat ground or a slope along the bridge (a slope falling towards the
    // bridge gets a level foundation); the deck is at the higher edge of each end.
    if (!pieceFitsSlope(ca, piece) || !pieceFitsSlope(cb, piece)) return fail('Bridge ends need flat ground or a slope along the bridge');
    const level = Math.max(edgeHeight(ca, dir), edgeHeight(ca, back));
    if (level < 1 || Math.max(edgeHeight(cb, dir), edgeHeight(cb, back)) !== level) return fail('Both ends of a bridge must be at the same height');
    let cost = len * kind.costPerTile + 2 * COSTS.railPiece;
    for (const i of [a, b]) {
      const c = headTileCost(state, company, i, piece);
      if (typeof c === 'string') return fail(c);
      cost += c;
      if (structuresAt(map, i).some((s) => s.kind === 'bridge')) return fail('Another bridge is in the way');
    }
    for (let k = 1; k <= len; k++) {
      const x = x0 + EDGE_DX[dir] * k;
      const y = y0 + EDGE_DY[dir] * k;
      const i = map.tileIndex(x, y);
      const type = map.layers.type[i];
      const top = map.tileMaxHeight(x, y);
      if (type === TileType.Rail || type === TileType.Road) {
        if (top > level - 2) return fail(`Not enough clearance over the line at ${x},${y}`);
        if (map.layers.data[i]! & 0x600) return fail(`Can't bridge over a bridge or tunnel end (${x},${y})`);
      } else if (type === TileType.Clear || type === TileType.Water) {
        if (top > level - 1) return fail(`The ground at ${x},${y} is too high for the bridge`);
      } else {
        return fail(`Can't bridge over that building (${x},${y})`);
      }
      if (structuresAt(map, i).some((s) => s.kind === 'bridge')) return fail('Another bridge is in the way');
    }
    return {
      ok: true,
      cost: state.cost(cost),
      commit() {
        const dirtyChunks = new Set<number>();
        for (const [i, d] of [[a, dir], [b, back]] as const) {
          map.layers.type[i] = TileType.Rail;
          map.layers.owner[i] = company;
          map.layers.track[i] = 1 << piece;
          map.layers.data[i] = headData('bridge', d, bridgeType);
          map.layers.signals[i] = 0;
          map.layers.town[i] = 0;
        }
        for (let k = 0; k <= len + 1; k++) map.touchTile(x0 + EDGE_DX[dir] * k, y0 + EDGE_DY[dir] * k, dirtyChunks);
        state.onTrackChanged();
        return { dirtyChunks };
      },
    };
  },
};

export const buildTunnelHandler: CommandHandler<BuildTunnelCommand> = {
  needsCompany: true,
  plan(state, ctx, cmd): PlanResult {
    const { x, y, dir } = cmd;
    if (![x, y, dir].every(isInt) || dir < 0 || dir > 3) return fail('Invalid tunnel');
    const map = state.map;
    if (!map.inBounds(x, y)) return fail('Out of bounds');
    const d = dir as Edge;
    const back = OPPOSITE_EDGE[d];
    const piece = d === Edge.E || d === Edge.W ? Piece.X : Piece.Y;
    const ca = map.tileCorners(x, y);
    const level = edgeHeight(ca, back);
    if (level < 0 || edgeHeight(ca, d) !== level + 1) return fail('Tunnels start on a slope rising into a hill');
    const company = ctx.companyId!;
    const a = map.tileIndex(x, y);
    let cost = 2 * COSTS.railPiece;
    const ac = headTileCost(state, company, a, piece);
    if (typeof ac === 'string') return fail(ac);
    cost += ac;
    let b = -1;
    let len = 0;
    for (let k = 1; k <= MAX_TUNNEL_LENGTH + 1; k++) {
      const tx = x + EDGE_DX[d] * k;
      const ty = y + EDGE_DY[d] * k;
      if (!map.inBounds(tx, ty)) return fail('The tunnel would leave the map');
      const i = map.tileIndex(tx, ty);
      const c = map.tileCorners(tx, ty);
      if (k > 1 && edgeHeight(c, back) === level + 1 && edgeHeight(c, d) === level) {
        b = i;
        break;
      }
      if (Math.min(...c) < level + 1) return fail(`The tunnel would come out on unsuitable ground at ${tx},${ty}`);
      if (structuresAt(map, i).some((s) => s.kind === 'tunnel' && s.level === level)) return fail('Another tunnel is in the way');
      len++;
    }
    if (b < 0) return fail(`Tunnels can be at most ${MAX_TUNNEL_LENGTH} tiles long`);
    const bc = headTileCost(state, company, b, piece);
    if (typeof bc === 'string') return fail(bc);
    cost += bc + len * COSTS.tunnelPerTile;
    return {
      ok: true,
      cost: state.cost(cost),
      commit() {
        const dirtyChunks = new Set<number>();
        for (const [i, hd] of [[a, d], [b, back]] as const) {
          map.layers.type[i] = TileType.Rail;
          map.layers.owner[i] = company;
          map.layers.track[i] = 1 << piece;
          map.layers.data[i] = headData('tunnel', hd);
          map.layers.signals[i] = 0;
          map.layers.town[i] = 0;
          const tx = i % map.width;
          map.touchTile(tx, (i - tx) / map.width, dirtyChunks);
        }
        state.onTrackChanged();
        return { dirtyChunks };
      },
    };
  },
};

/** Tiles under a bridge can't hold tall things (stations, depots). */
export function underBridge(state: GameState, i: number): boolean {
  return structuresAt(state.map, i).some((s) => s.kind === 'bridge');
}

