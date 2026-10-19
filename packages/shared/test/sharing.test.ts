import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  Edge,
  GameMap,
  GameState,
  HOUSE_TYPES,
  Piece,
  TICKS_PER_DAY,
  TileType,
  encodeSnapshot,
  executeCommand,
  nextSegments,
  restoreSnapshot,
  seg,
  segTile,
  trackdir,
  type Access,
  type Command,
} from '../src/index.ts';

const TOWNHOUSE = HOUSE_TYPES.findIndex((h) => h.model === 'townhouse');

/**
 * Company A owns a line x=3..40 on y=10 with stations at both ends and its own depot at x=2.
 * Company B owns a depot at x=44 and track x=41..43 that meets A's line end to end.
 */
function world() {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, startYear: 1900 }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  for (const cx of [7, 35]) {
    for (let x = cx - 2; x <= cx + 2; x++) {
      const i = map.tileIndex(x, 12);
      map.layers.type[i] = TileType.House;
      map.layers.data[i] = TOWNHOUSE;
    }
  }
  const company = (name: string) => {
    const p = state.addPlayer(name, false);
    const c = state.foundCompany(p, `${name} Rail`)!;
    c.money = 1e7;
    const ctx = { playerId: p.id, companyId: c.id };
    const run = (cmd: Command) => executeCommand(state, ctx, cmd);
    const must = (cmd: Command) => {
      const r = run(cmd);
      if (!r.ok) throw new Error(`${name} ${cmd.type}: ${r.error}`);
    };
    return { c, run, must };
  };
  const a = company('A');
  const b = company('B');
  a.must({ type: 'buildDepot', x: 2, y: 10, exit: Edge.E });
  const line: number[] = [];
  for (let x = 3; x <= 40; x++) line.push(x, 10, Piece.X);
  a.must({ type: 'buildTrack', pieces: line });
  a.must({ type: 'buildStation', x: 5, y: 10, axis: 0, platforms: 1, length: 4 });
  a.must({ type: 'buildStation', x: 33, y: 10, axis: 0, platforms: 1, length: 4 });
  b.must({ type: 'buildDepot', x: 44, y: 10, exit: Edge.W });
  b.must({ type: 'buildTrack', pieces: [41, 10, Piece.X, 42, 10, Piece.X, 43, 10, Piece.X] });
  b.must({ type: 'buyTrain', depot: map.tileIndex(44, 10), units: ['kestrel', 'coach_wood'] });
  const train = [...state.trains.values()].find((t) => t.owner === b.c.id)!;
  const [west, east] = [...state.stations.values()];
  const days = (n: number) => {
    for (let i = 0; i < TICKS_PER_DAY * n; i++) state.step();
  };
  /** Tiles reachable from B's track at x=41 under the given access. */
  const reach = (access: Access) => {
    const out = new Set<number>();
    for (const dir of [0, 1]) for (const n of nextSegments(map, seg(map.tileIndex(41, 10), trackdir(Piece.X, dir)), access)) out.add(segTile(n));
    return out;
  };
  const share = (stations = true, fee = 1000) => {
    b.must({ type: 'proposeSharing', partner: a.c.id, role: 'guest', stations, fee });
    const ag = [...state.agreements.values()].at(-1)!;
    a.must({ type: 'answerSharing', id: ag.id, accept: true });
    return ag;
  };
  return { state, map, a, b, train, west: west!, east: east!, days, reach, share };
}

describe('track sharing', () => {
  test('track of different owners links, but nobody crosses without an agreement', () => {
    const { state, map, a, b, train, west, reach } = world();
    const aTile = map.tileIndex(40, 10);
    const anyone = { uses: new Uint8Array(256).fill(1), joins: new Uint8Array(256 * 256).fill(1) };
    expect(reach(anyone).has(aTile)).toBe(true);
    expect(reach(state.blockAccess).has(aTile)).toBe(false);
    expect(reach(state.accessFor(b.c.id)).has(aTile)).toBe(false);
    expect(state.rail.blockOfPiece(aTile * 8 + Piece.X)).not.toBe(state.rail.blockOfPiece(map.tileIndex(41, 10) * 8 + Piece.X));
    expect(b.run({ type: 'setOrders', id: train.id, orders: [{ kind: 'station', station: west.id }] })).toMatchObject({
      ok: false,
      error: expect.stringContaining('another company'),
    });
    // A's trains can't use B's track either
    expect(state.accessFor(a.c.id).uses[b.c.id]).toBe(0);
  });

  test('propose, accept: guest trains run on the host track, call at its stations, and pay', () => {
    const { state, map, a, b, train, west, east, days, reach, share } = world();
    expect(b.run({ type: 'proposeSharing', partner: b.c.id, role: 'guest', stations: true, fee: 0 }).ok).toBe(false);
    expect(b.run({ type: 'proposeSharing', partner: a.c.id, role: 'guest', stations: true, fee: 99999 }).ok).toBe(false);
    const ag = share(true, 1000);
    expect(ag.status).toBe('active');
    expect(state.news.at(-1)?.text).toBe("B Rail may now use A Rail's track and stations for £1,000 per train per day");
    expect(reach(state.accessFor(b.c.id)).has(map.tileIndex(40, 10))).toBe(true);
    expect(state.rail.blockOfPiece(map.tileIndex(40, 10) * 8 + Piece.X)).toBe(state.rail.blockOfPiece(map.tileIndex(41, 10) * 8 + Piece.X));
    // The host's trains still can't use the guest's track
    expect(state.accessFor(a.c.id).uses[b.c.id]).toBe(0);

    b.must({ type: 'setOrders', id: train.id, orders: [{ kind: 'station', station: east.id }, { kind: 'station', station: west.id }] });
    b.must({ type: 'trainAction', id: train.id, action: 'start' });
    let visited = false;
    for (let d = 0; d < 40 && !visited; d++) {
      days(1);
      visited = train.lastStation === west.id;
    }
    expect(visited).toBe(true);
    const fee = (c: typeof a.c) => c.finances.reduce((s, q) => s + q.ledger.sharing, 0);
    expect(fee(b.c)).toBeLessThan(-1000);
    expect(fee(a.c)).toBeCloseTo(-fee(b.c), 6);
  });

  test('ending an agreement tows guest trains home and drops their orders there', () => {
    const { state, a, b, train, west, east, days, share } = world();
    const ag = share();
    b.must({ type: 'setOrders', id: train.id, orders: [{ kind: 'station', station: east.id }, { kind: 'station', station: west.id }] });
    b.must({ type: 'trainAction', id: train.id, action: 'start' });
    days(12);
    expect(train.status).not.toBe('depot');
    expect(b.run({ type: 'answerSharing', id: ag.id, accept: true }).ok).toBe(false);
    a.must({ type: 'endSharing', id: ag.id });
    expect(state.agreements.size).toBe(0);
    expect(train.status).toBe('depot');
    expect(train.depot).toBe(state.map.tileIndex(44, 10));
    expect(train.orders).toEqual([]);
    expect(state.news.at(-1)?.text).toBe("B Rail may no longer use A Rail's track; 1 of B Rail's trains are towed home");
    expect(state.accessFor(b.c.id).uses[a.c.id]).toBe(0);
  });

  test('proposals can be declined or withdrawn; agreements survive saves', () => {
    const { state, a, b, east, share } = world();
    b.must({ type: 'proposeSharing', partner: a.c.id, role: 'guest', stations: false, fee: 10 });
    expect(b.run({ type: 'proposeSharing', partner: a.c.id, role: 'guest', stations: false, fee: 10 }).ok).toBe(false);
    const p = [...state.agreements.values()][0]!;
    expect(b.run({ type: 'answerSharing', id: p.id, accept: true }).ok).toBe(false); // can't accept your own
    a.must({ type: 'answerSharing', id: p.id, accept: false });
    expect(state.agreements.size).toBe(0);
    a.must({ type: 'proposeSharing', partner: b.c.id, role: 'host', stations: false, fee: 0 });
    b.must({ type: 'endSharing', id: [...state.agreements.values()][0]!.id });
    expect(state.agreements.size).toBe(0);

    // Track only: the guest can't call at the host's stations
    const ag = share(false, 0);
    expect(state.canUseStation(b.c.id, east)).toBe(false);
    const restored = restoreSnapshot(encodeSnapshot(state), { maxPlayers: 15, maxMapSize: 256 });
    expect(restored.agreements.get(ag.id)).toEqual(ag);
    expect(restored.accessFor(b.c.id).uses[a.c.id]).toBe(1);
  });

  test('when the host goes bankrupt, guest trains are towed off first', () => {
    const { state, a, b, train, west, east, days, share } = world();
    share();
    b.must({ type: 'setOrders', id: train.id, orders: [{ kind: 'station', station: east.id }, { kind: 'station', station: west.id }] });
    b.must({ type: 'trainAction', id: train.id, action: 'start' });
    days(12);
    state.dissolveCompany(a.c.id);
    expect(state.agreements.size).toBe(0);
    expect(train.status).toBe('depot');
    expect(train.orders).toEqual([]);
    expect(state.trains.get(train.id)).toBe(train);
  });
});
