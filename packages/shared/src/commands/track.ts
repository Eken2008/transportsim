import { COSTS } from '../economy/costs.ts';
import { PIECE_COUNT, Piece, hasPiece, isDiagonal, pieceFitsSlope } from '../rail/track.ts';
import type { GameState } from '../sim/state.ts';
import { Ground, OWNER_NONE, TileType } from '../world/constants.ts';
import { fail, isInt, type CommandHandler, type CommandContext, type PlanResult } from './types.ts';

/** Road bits on Road tiles and level crossings (data bits 0-3): N, E, S, W. */
export const ROAD_N = 1;
export const ROAD_E = 2;
export const ROAD_S = 4;
export const ROAD_W = 8;
/** On Rail tiles, data bit 8 marks a level crossing (road bits stay in bits 0-3). */
export const CROSSING_FLAG = 0x100;

const MAX_PIECES = 512;

/** Build (or remove) a list of track pieces. `pieces` is flattened [x, y, piece, x, y, piece, ...]. */
export interface BuildTrackCommand {
  type: 'buildTrack';
  pieces: number[];
}

export interface RemoveTrackCommand {
  type: 'removeTrack';
  pieces: number[];
}

function parsePieces(state: GameState, pieces: unknown): { x: number; y: number; p: number }[] | string {
  if (!Array.isArray(pieces) || pieces.length === 0 || pieces.length % 3 !== 0) return 'Invalid track';
  if (pieces.length / 3 > MAX_PIECES) return 'Too much track at once';
  const out: { x: number; y: number; p: number }[] = [];
  const seen = new Set<number>();
  for (let i = 0; i < pieces.length; i += 3) {
    const x = pieces[i];
    const y = pieces[i + 1];
    const p = pieces[i + 2];
    if (!isInt(x) || !isInt(y) || !isInt(p) || p < 0 || p >= PIECE_COUNT) return 'Invalid track';
    if (!state.map.inBounds(x, y)) return 'Out of bounds';
    const key = (y * state.map.width + x) * 8 + p;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ x, y, p });
  }
  return out;
}

function at(x: number, y: number) {
  return `at ${x},${y}`;
}

export const buildTrackHandler: CommandHandler<BuildTrackCommand> = {
  needsCompany: true,
  plan(state, ctx, cmd): PlanResult {
    const parsed = parsePieces(state, cmd.pieces);
    if (typeof parsed === 'string') return fail(parsed);
    const map = state.map;
    const company = ctx.companyId!;
    // Accumulate new bits per tile so several pieces on one tile validate together.
    const add = new Map<number, number>();
    let cost = 0;
    for (const { x, y, p } of parsed) {
      const i = map.tileIndex(x, y);
      const type = map.layers.type[i];
      const corners = map.tileCorners(x, y);
      if (!pieceFitsSlope(corners, p)) return fail(`Track can't go on that slope ${at(x, y)}`);
      const existing = type === TileType.Rail ? map.layers.track[i]! : 0;
      const pending = add.get(i) ?? 0;
      if (hasPiece(existing | pending, p)) continue; // already built: skip silently

      if (type === TileType.Clear) {
        if (pending === 0) cost += map.treeCount(x, y) * COSTS.clearTree;
      } else if (type === TileType.Rail) {
        if (map.layers.owner[i] !== company) return fail(`Track belongs to another company ${at(x, y)}`);
        if (map.layers.data[i]! & CROSSING_FLAG) return fail(`Can't add track to a level crossing ${at(x, y)}`);
      } else if (type === TileType.Road) {
        const road = map.layers.data[i]! & 0xf;
        const okX = p === Piece.X && road === (ROAD_N | ROAD_S);
        const okY = p === Piece.Y && road === (ROAD_E | ROAD_W);
        if (!(okX || okY) || pending !== 0) return fail(`Level crossings need a straight road across the track ${at(x, y)}`);
        cost += COSTS.levelCrossing;
      } else if (type === TileType.Water) {
        return fail(`Can't build track on water ${at(x, y)}`);
      } else {
        return fail(`Object in the way ${at(x, y)}`);
      }
      add.set(i, pending | (1 << p));
      cost += isDiagonal(p) ? Math.round(COSTS.railPiece * 0.75) : COSTS.railPiece;
    }
    if (add.size === 0) return fail('Already built');

    return {
      ok: true,
      cost: state.cost(cost),
      commit() {
        const dirtyChunks = new Set<number>();
        for (const [i, bits] of add) {
          const x = i % map.width;
          const y = (i - x) / map.width;
          const type = map.layers.type[i];
          if (type === TileType.Road) {
            map.layers.data[i] = (map.layers.data[i]! & 0xf) | CROSSING_FLAG;
          } else if (type !== TileType.Rail) {
            map.layers.data[i] = 0;
          }
          map.layers.type[i] = TileType.Rail;
          map.layers.owner[i] = company;
          map.layers.track[i] = map.layers.track[i]! | bits;
          map.touchTile(x, y, dirtyChunks);
        }
        state.onTrackChanged();
        return { dirtyChunks };
      },
    };
  },
};

export const removeTrackHandler: CommandHandler<RemoveTrackCommand> = {
  needsCompany: true,
  plan(state, ctx, cmd): PlanResult {
    const parsed = parsePieces(state, cmd.pieces);
    if (typeof parsed === 'string') return fail(parsed);
    const map = state.map;
    const remove = new Map<number, number>();
    let cost = 0;
    for (const { x, y, p } of parsed) {
      const i = map.tileIndex(x, y);
      if (map.layers.type[i] !== TileType.Rail || !hasPiece(map.layers.track[i]!, p)) continue;
      if (!canModify(state, ctx, i)) return fail(`Track belongs to another company ${at(x, y)}`);
      if (state.isPieceOccupied(i, p)) return fail(`A train is in the way ${at(x, y)}`);
      remove.set(i, (remove.get(i) ?? 0) | (1 << p));
      cost += COSTS.railRemove;
    }
    if (remove.size === 0) return fail('No track to remove');
    return {
      ok: true,
      cost: state.cost(cost),
      commit() {
        const dirtyChunks = new Set<number>();
        for (const [i, bits] of remove) {
          const x = i % map.width;
          const y = (i - x) / map.width;
          const left = map.layers.track[i]! & ~bits;
          state.removeSignalsOn(i, bits);
          if (left === 0) {
            const data = map.layers.data[i]!;
            if (data & CROSSING_FLAG) {
              map.layers.type[i] = TileType.Road;
              map.layers.owner[i] = OWNER_NONE;
              map.layers.data[i] = data & 0xf;
              map.layers.track[i] = 0;
            } else {
              map.setClear(i, Ground.Rough, 0);
            }
          } else {
            map.layers.track[i] = left;
          }
          map.touchTile(x, y, dirtyChunks);
        }
        state.onTrackChanged();
        return { dirtyChunks };
      },
    };
  },
};

function canModify(state: GameState, ctx: CommandContext, i: number): boolean {
  return state.map.layers.owner[i] === ctx.companyId;
}
