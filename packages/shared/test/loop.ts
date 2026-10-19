import { DEFAULT_SETTINGS, Edge, GameMap, GameState, Piece, executeCommand, type Command, type GameSettings } from '../src/index.ts';

/**
 * A clockwise rectangular loop (45° corners of three corner pieces): stations on the top row
 * (x 14-18) and bottom row (x 30-34), a depot feeding the top row eastbound at x = 25.
 */
export function loop(settings: Partial<GameSettings> = {}) {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear: 1900, ...settings }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  const p = state.addPlayer('A', true);
  const c = state.foundCompany(p)!;
  c.money = 1e8;
  const ctx = { playerId: p.id, companyId: c.id };
  const exec = (cmd: Command) => executeCommand(state, ctx, cmd);
  const run = (cmd: Command) => {
    const r = exec(cmd);
    if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
    return r;
  };
  const pieces: number[] = [];
  for (let x = 12; x <= 38; x++) pieces.push(x, 10, Piece.X, x, 25, Piece.X);
  for (let y = 12; y <= 23; y++) pieces.push(10, y, Piece.Y, 40, y, Piece.Y);
  pieces.push(39, 10, Piece.SW, 39, 11, Piece.NE, 40, 11, Piece.SW);
  pieces.push(40, 24, Piece.NW, 39, 24, Piece.SE, 39, 25, Piece.NW);
  pieces.push(11, 25, Piece.NE, 11, 24, Piece.SW, 10, 24, Piece.NE);
  pieces.push(10, 11, Piece.SE, 11, 11, Piece.NW, 11, 10, Piece.SE);
  pieces.push(24, 9, Piece.NE, 25, 9, Piece.SW, 25, 10, Piece.NE);
  run({ type: 'buildTrack', pieces });
  run({ type: 'buildDepot', x: 24, y: 8, exit: Edge.S });
  run({ type: 'buildStation', x: 14, y: 10, axis: 0, platforms: 1, length: 5 });
  run({ type: 'buildStation', x: 30, y: 25, axis: 0, platforms: 1, length: 5 });
  const depot = map.tileIndex(24, 8);
  const [top, bottom] = [0, 1];
  const buy = (units = ['kestrel', 'coach_wood', 'coach_wood']) => {
    run({ type: 'buyTrain', depot, units });
    return [...state.trains.values()].at(-1)!;
  };
  return { state, map, company: c, exec, run, buy, depot, top, bottom };
}
