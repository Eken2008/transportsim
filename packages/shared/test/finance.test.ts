import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  ECONOMY,
  Edge,
  GameMap,
  GameState,
  LOAN_STEP,
  Piece,
  TICKS_PER_DAY,
  TileType,
  encodeSnapshot,
  executeCommand,
  restoreSnapshot,
  type Command,
} from '../src/index.ts';

function world() {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear: 1900 }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  const p = state.addPlayer('A', true);
  const c = state.foundCompany(p, 'A Rail')!;
  const ctx = { playerId: p.id, companyId: c.id };
  const run = (cmd: Command) => executeCommand(state, ctx, cmd);
  const must = (cmd: Command) => {
    const r = run(cmd);
    if (!r.ok) throw new Error(`${cmd.type}: ${r.error}`);
    return r;
  };
  const days = (n: number) => {
    for (let i = 0; i < TICKS_PER_DAY * n; i++) state.step();
  };
  const ledger = () => c.finances[c.finances.length - 1]!.ledger;
  return { state, map, p, c, run, must, days, ledger };
}

function buildLine(must: (cmd: Command) => unknown, map: GameMap) {
  must({ type: 'buildDepot', x: 2, y: 10, exit: Edge.E });
  const pieces: number[] = [];
  for (let x = 3; x <= 40; x++) pieces.push(x, 10, Piece.X);
  must({ type: 'buildTrack', pieces });
  must({ type: 'buildStation', x: 5, y: 10, axis: 0, platforms: 1, length: 4 });
  must({ type: 'buildStation', x: 34, y: 10, axis: 0, platforms: 1, length: 4 });
  must({ type: 'setSignal', x: 20, y: 10, piece: Piece.X, dirs: 1 });
  must({ type: 'buyTrain', depot: map.tileIndex(2, 10), units: ['kestrel', 'coach_wood'] });
}

describe('finances', () => {
  test('costs and income are booked by category', () => {
    const { c, map, must, ledger } = world();
    const start = c.money;
    buildLine(must, map);
    expect(ledger().construction).toBeLessThan(0);
    expect(ledger().vehicles).toBeLessThan(0);
    expect(ledger().construction + ledger().vehicles).toBeCloseTo(c.money - start, 6);
    expect(c.finances).toHaveLength(1);
  });

  test('month-end statistics: books, deliveries and vehicles, kept in saves', () => {
    const { state, c, map, must, days } = world();
    buildLine(must, map);
    for (const x of [4, 5, 6, 7, 8, 34, 35, 36, 37]) {
      for (const y of [12, 13]) {
        const i = map.tileIndex(x, y);
        map.layers.type[i] = TileType.House;
        map.layers.data[i] = 0;
      }
    }
    const t = [...state.trains.values()][0]!;
    must({ type: 'setOrders', id: t.id, orders: [{ kind: 'station', station: 0 }, { kind: 'station', station: 1 }] });
    must({ type: 'trainAction', id: t.id, action: 'start' });
    days(70);
    expect(c.history.length).toBeGreaterThanOrEqual(2);
    const last = c.history.at(-1)!;
    expect(last.vehicles).toBe(1);
    expect(last.date).toBeLessThanOrEqual(state.date);
    expect(last.loan).toBe(c.loan);
    expect(last.ledger.running).toBeLessThan(0);
    const delivered = c.history.reduce((n, m) => n + (m.delivered.passengers ?? 0), 0);
    expect(delivered).toBeGreaterThan(0);
    expect(c.history.reduce((n, m) => n + m.ledger.income, 0)).toBeGreaterThan(0);
    const restored = restoreSnapshot(encodeSnapshot(state), { maxPlayers: 15, maxMapSize: 256 });
    expect(restored.companies.get(c.id)!.history).toEqual(c.history);
    expect(restored.companies.get(c.id)!.month.ledger).toEqual(c.month.ledger);
  });

  test('loans: steps, limits, permissions, and money off the books', () => {
    const { state, c, run, must, ledger } = world();
    const max = ECONOMY[state.settings.economy].maxLoan;
    const money = c.money;
    must({ type: 'loan', action: 'borrow', amount: 5 * LOAN_STEP });
    expect(c.loan).toBe(5 * LOAN_STEP);
    expect(c.money).toBe(money + 5 * LOAN_STEP);
    expect(Object.values(ledger()).every((v) => v === 0)).toBe(true);
    expect(run({ type: 'loan', action: 'borrow', amount: 1234 }).ok).toBe(false);
    expect(run({ type: 'loan', action: 'borrow', amount: max }).ok).toBe(false);
    expect(run({ type: 'loan', action: 'repay', amount: 6 * LOAN_STEP }).ok).toBe(false);
    must({ type: 'loan', action: 'repay', amount: 2 * LOAN_STEP });
    expect(c.loan).toBe(3 * LOAN_STEP);
    // Repaying needs the money
    c.money = LOAN_STEP / 2;
    expect(run({ type: 'loan', action: 'repay', amount: LOAN_STEP }).ok).toBe(false);
    // Operators cannot borrow
    const op = state.addPlayer('Op', false);
    state.addMember(c, 'Op', 'operator');
    expect(executeCommand(state, { playerId: op.id, companyId: c.id }, { type: 'loan', action: 'borrow', amount: LOAN_STEP }).ok).toBe(false);
  });

  test('monthly interest and property maintenance; quarters roll over', () => {
    const { state, c, map, must, days, ledger } = world();
    buildLine(must, map);
    must({ type: 'loan', action: 'borrow', amount: 100 * LOAN_STEP });
    days(32); // into February
    const rate = ECONOMY[state.settings.economy].interestRate;
    expect(ledger().interest).toBe(-Math.round((100 * LOAN_STEP * rate) / 12));
    expect(ledger().property).toBeLessThan(0);
    expect(c.infrastructure.depots).toBe(1);
    expect(c.infrastructure.stations).toBe(8);
    expect(c.infrastructure.signals).toBe(1);
    expect(c.infrastructure.track).toBe(38 - 8);
    expect(c.value).toBeGreaterThan(0);
    days(70); // past 1 April
    expect(c.finances).toHaveLength(2);
    expect(c.finances[0]).toMatchObject({ year: 1900, quarter: 0 });
    expect(c.finances[1]).toMatchObject({ year: 1900, quarter: 1 });
    expect(c.badQuarters).toBe(0);

    // Books survive a save
    const restored = restoreSnapshot(encodeSnapshot(state), { maxPlayers: 15, maxMapSize: 256 });
    expect(restored.companies.get(c.id)!.finances).toEqual(c.finances);
    expect(restored.companies.get(c.id)!.infrastructure).toEqual(c.infrastructure);
  });

  test('three quarters in the red: warnings, then bankruptcy removes everything', () => {
    const { state, c, p, map, must, days } = world();
    buildLine(must, map);
    const other = state.addPlayer('B', false);
    const b = state.foundCompany(other, 'B Rail')!;
    c.money = -1e7;
    days(95); // 1 April
    expect(c.badQuarters).toBe(1);
    expect(b.badQuarters).toBe(0);
    expect(state.news.at(-1)?.text).toContain('financial trouble');
    days(91); // 1 July
    expect(c.badQuarters).toBe(2);
    expect(state.news.at(-1)?.text).toContain('goes bankrupt at the end of this quarter');
    days(93); // 1 October
    expect(state.companies.has(c.id)).toBe(false);
    expect(state.companies.has(b.id)).toBe(true);
    expect(state.news.at(-1)?.text).toContain('has gone bankrupt');
    expect(p.companyId).toBeNull();
    expect([...state.trains.values()].filter((t) => t.owner === c.id)).toHaveLength(0);
    expect(state.stations.size).toBe(0);
    expect(state.depots.size).toBe(0);
    expect(state.signalTiles.size).toBe(0);
    for (let x = 2; x <= 40; x++) expect(map.layers.type[map.tileIndex(x, 10)]).toBe(TileType.Clear);
  });

  test('getting back into the black resets the count', () => {
    const { c, days } = world();
    c.money = -1000;
    days(95);
    expect(c.badQuarters).toBe(1);
    c.money = 1e6;
    days(91);
    expect(c.badQuarters).toBe(0);
  });
});
