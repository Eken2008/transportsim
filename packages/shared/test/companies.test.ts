import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  GameMap,
  GameState,
  encode,
  encodeSnapshot,
  executeCommand,
  restoreSnapshot,
  takeSnapshot,
  type Command,
} from '../src/index.ts';

function world() {
  const state = new GameState({ ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128 }, new GameMap(128, 128));
  const map = state.map;
  map.heights.fill(2);
  for (let i = 0; i < map.width * map.height; i++) map.setClear(i, 0, 0);
  const players = Object.fromEntries(['Ann', 'Bob', 'Cid', 'Dee'].map((n) => [n, state.addPlayer(n, n === 'Ann')]));
  const run = (who: string, cmd: Command) => {
    const p = players[who]!;
    return executeCommand(state, { playerId: p.id, companyId: p.companyId }, cmd);
  };
  const must = (who: string, cmd: Command) => {
    const r = run(who, cmd);
    if (!r.ok) throw new Error(`${who} ${cmd.type}: ${r.error}`);
  };
  return { state, players, run, must };
}

const raise = { type: 'terraform', x0: 3, y0: 3, x1: 3, y1: 3, mode: 'raise' } as const;

describe('companies', () => {
  test('players start without a company and found one as owner', () => {
    const { state, players, run, must } = world();
    expect(players.Ann!.companyId).toBeNull();
    expect(run('Ann', raise).ok).toBe(false);
    must('Ann', { type: 'foundCompany', name: 'Ann Rail', color: 3 });
    const c = state.companies.get(players.Ann!.companyId!)!;
    expect(c).toMatchObject({ name: 'Ann Rail', color: 3, members: [{ name: 'Ann', role: 'owner' }] });
    expect(run('Ann', raise).ok).toBe(true);
    expect(state.news.map((n) => n.text)).toEqual(['Ann founds Ann Rail']);
    // Names and colours are unique; one company per player
    expect(run('Bob', { type: 'foundCompany', name: 'ann rail', color: 4 }).ok).toBe(false);
    expect(run('Bob', { type: 'foundCompany', name: 'Bob Lines', color: 3 }).ok).toBe(false);
    expect(run('Ann', { type: 'foundCompany', name: 'Second', color: 5 }).ok).toBe(false);
  });

  test('join requests, invitations and roles gate commands', () => {
    const { state, players, run, must } = world();
    must('Ann', { type: 'foundCompany', name: 'Ann Rail', color: 0 });
    const c = state.companies.get(players.Ann!.companyId!)!;

    // Bob asks; Ann accepts him as operator
    must('Bob', { type: 'joinCompany', company: c.id });
    expect(c.requests).toEqual(['Bob']);
    expect(players.Bob!.companyId).toBeNull();
    must('Ann', { type: 'answerJoin', name: 'Bob', accept: true, role: 'operator' });
    expect(players.Bob!.companyId).toBe(c.id);
    expect(c.requests).toEqual([]);

    // Operators cannot build or manage members
    expect(run('Bob', raise)).toMatchObject({ ok: false, error: expect.stringContaining('managers') });
    expect(run('Bob', { type: 'invitePlayer', name: 'Cid' }).ok).toBe(false);

    // Promoted to manager, Bob builds and invites Cid, but cannot appoint managers
    must('Ann', { type: 'setMemberRole', name: 'Bob', role: 'manager' });
    expect(run('Bob', raise).ok).toBe(true);
    expect(run('Bob', { type: 'invitePlayer', name: 'Cid', role: 'manager' }).ok).toBe(false);
    must('Bob', { type: 'invitePlayer', name: 'Cid', role: 'viewer' });
    must('Cid', { type: 'joinCompany', company: c.id });
    expect(state.roleOf(players.Cid!.id, c.id)).toBe('viewer');
    expect(run('Cid', { type: 'leaveCompany' }).ok).toBe(true);
    expect(players.Cid!.companyId).toBeNull();

    // Only the owner changes roles, removes members and edits settings
    expect(run('Bob', { type: 'companySettings', name: 'Bob Rail' }).ok).toBe(false);
    must('Ann', { type: 'companySettings', name: 'Ann & Bob', color: 7 });
    expect(c).toMatchObject({ name: 'Ann & Bob', color: 7 });
    expect(run('Ann', { type: 'removeMember', name: 'Ann' }).ok).toBe(false);
    must('Ann', { type: 'removeMember', name: 'Bob' });
    expect(players.Bob!.companyId).toBeNull();

    // Declined requests and cancelled invitations
    must('Dee', { type: 'joinCompany', company: c.id });
    expect(run('Dee', { type: 'joinCompany', company: c.id }).ok).toBe(false);
    must('Ann', { type: 'answerJoin', name: 'Dee', accept: false });
    expect(c.requests).toEqual([]);
    must('Ann', { type: 'invitePlayer', name: 'Dee' });
    must('Dee', { type: 'cancelJoin', company: c.id });
    expect(c.invites).toEqual([]);
  });

  test('ownership hands over, and a company without members can be adopted', () => {
    const { state, players, run, must } = world();
    must('Ann', { type: 'foundCompany', name: 'Ann Rail', color: 0 });
    const c = state.companies.get(players.Ann!.companyId!)!;
    must('Ann', { type: 'invitePlayer', name: 'Bob', role: 'manager' });
    must('Bob', { type: 'joinCompany', company: c.id });
    must('Ann', { type: 'invitePlayer', name: 'Cid', role: 'operator' });
    must('Cid', { type: 'joinCompany', company: c.id });

    // Explicit hand-over: Ann becomes a manager
    must('Ann', { type: 'setMemberRole', name: 'Bob', role: 'owner' });
    expect(state.roleOf(players.Ann!.id, c.id)).toBe('manager');
    expect(state.roleOf(players.Bob!.id, c.id)).toBe('owner');
    expect(run('Ann', { type: 'setMemberRole', name: 'Cid', role: 'manager' }).ok).toBe(false);

    // The owner leaving passes ownership to the most senior member
    must('Bob', { type: 'leaveCompany' });
    expect(state.roleOf(players.Ann!.id, c.id)).toBe('owner');
    must('Ann', { type: 'leaveCompany' });
    must('Cid', { type: 'leaveCompany' });
    expect(c.members).toEqual([]);

    expect(state.news.at(-1)?.text).toBe('Ann Rail has no members left; anyone can take it over');

    // Anyone can adopt it
    must('Dee', { type: 'joinCompany', company: c.id });
    expect(state.roleOf(players.Dee!.id, c.id)).toBe('owner');
    expect(state.news.at(-1)).toMatchObject({ kind: 'company', company: c.id, text: 'Dee takes over Ann Rail' });
  });

  test('joining another company leaves the current one', () => {
    const { state, players, must } = world();
    must('Ann', { type: 'foundCompany', name: 'A', color: 0 });
    must('Bob', { type: 'foundCompany', name: 'B', color: 1 });
    const a = state.companies.get(players.Ann!.companyId!)!;
    const b = state.companies.get(players.Bob!.companyId!)!;
    must('Bob', { type: 'joinCompany', company: a.id });
    must('Ann', { type: 'answerJoin', name: 'Bob', accept: true });
    expect(players.Bob!.companyId).toBe(a.id);
    expect(b.members).toEqual([]);
  });

  test('membership survives renames and saves; old saves get roles', () => {
    const { state, players, must } = world();
    must('Ann', { type: 'foundCompany', name: 'Ann Rail', color: 0 });
    must('Ann', { type: 'invitePlayer', name: 'Bob', role: 'manager' });
    must('Bob', { type: 'joinCompany', company: 0 });
    state.renamePlayer(players.Bob!, 'Robert');
    expect(state.companies.get(0)!.members.map((m) => m.name)).toEqual(['Ann', 'Robert']);

    const limits = { maxPlayers: 15, maxMapSize: 256 };
    const restored = restoreSnapshot(encodeSnapshot(state), limits);
    expect(restored.addPlayer('Robert', false).companyId).toBe(0);
    expect(restored.news.map((n) => n.text)).toEqual(state.news.map((n) => n.text));
    expect(restored.nextNewsId).toBe(state.nextNewsId);
    expect(restored.companies.get(0)!.members).toEqual([
      { name: 'Ann', role: 'owner' },
      { name: 'Robert', role: 'manager' },
    ]);

    // Version 1 saves listed plain names
    const old = takeSnapshot(state);
    const legacy = { ...old, companies: old.companies.map((c) => ({ ...c, members: ['Ann', 'Robert'], requests: undefined, invites: undefined })) };
    const fromOld = restoreSnapshot(encode(legacy), limits);
    expect(fromOld.companies.get(0)!.members).toEqual([
      { name: 'Ann', role: 'owner' },
      { name: 'Robert', role: 'manager' },
    ]);
    expect(fromOld.companies.get(0)!.requests).toEqual([]);
  });
});
