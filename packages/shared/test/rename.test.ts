import { describe, expect, test } from 'bun:test';
import { executeCommand } from '../src/index.ts';
import { loop } from './loop.ts';

describe('renaming', () => {
  test('a station can be renamed to a name no other station has', () => {
    const { state, run, exec, top, bottom } = loop();
    run({ type: 'renameStation', id: top, name: '  Grand   Central ' });
    expect(state.stations.get(top)!.name).toBe('Grand Central');
    expect(state.dirtyStations.has(top)).toBe(true);
    expect(exec({ type: 'renameStation', id: bottom, name: 'grand central' }).ok).toBe(false);
    expect(exec({ type: 'renameStation', id: bottom, name: '   ' }).ok).toBe(false);
    run({ type: 'renameStation', id: bottom, name: 'x'.repeat(60) });
    expect(state.stations.get(bottom)!.name).toHaveLength(40);
  });

  test('vehicle names are unique within the company', () => {
    const { state, run, exec, buy } = loop();
    const a = buy();
    const b = buy();
    expect([a.name, b.name]).toEqual(['Train 1', 'Train 2']);
    run({ type: 'renameVehicle', id: a.id, name: 'Flyer' });
    expect(a.name).toBe('Flyer');
    expect(exec({ type: 'renameVehicle', id: b.id, name: 'FLYER' }).ok).toBe(false);
    // A new vehicle takes the first free number.
    expect(buy().name).toBe('Train 1');
    // Another company may use the same name.
    const p = state.addPlayer('B', false);
    const other = state.foundCompany(p)!;
    other.money = 1e7;
    expect(executeCommand(state, { playerId: p.id, companyId: other.id }, { type: 'renameVehicle', id: b.id, name: 'Mine' }).ok).toBe(false);
  });

  test('viewers cannot rename', () => {
    const { state, top } = loop();
    const p = state.addPlayer('V', false);
    const company = [...state.companies.values()][0]!;
    company.members.push({ name: 'V', role: 'viewer' });
    p.companyId = company.id;
    expect(executeCommand(state, { playerId: p.id, companyId: company.id }, { type: 'renameStation', id: top, name: 'Nope' }).ok).toBe(false);
  });
});
