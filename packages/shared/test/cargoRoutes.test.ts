import { describe, expect, test } from 'bun:test';
import { FREIGHT_CARGOS, GOODS_RESIDENTS, cargoChain, chainTiers, cargoDestinations, cargoSources, industryType, newIndustry, type Town } from '../src/index.ts';

const at = (id: number, type: string, x: number, y: number) => newIndustry(id, industryType(type)!, x, y, `${type} ${id}`);
const town = (id: number, x: number, y: number, population: number) => ({ id, name: `Town ${id}`, x, y, population, houses: 0 }) as Town;

describe('cargo routes', () => {
  test('freight cargoes are the ones industries make or take', () => {
    expect(FREIGHT_CARGOS).toContain('coal');
    expect(FREIGHT_CARGOS).toContain('goods');
    expect(FREIGHT_CARGOS).not.toContain('passengers');
    expect(FREIGHT_CARGOS).not.toContain('mail');
  });

  test('chains name who makes and who takes a cargo', () => {
    const coal = cargoChain('coal');
    expect(coal.producers.map((t) => t.id)).toEqual(['coal_mine']);
    expect(coal.acceptors.map((t) => t.id).sort()).toEqual(['power_station', 'steel_mill']);
    expect(coal.towns).toBe(false);
    expect(cargoChain('goods').towns).toBe(true);
  });

  test('tiers count the steps from raw material', () => {
    const tiers = chainTiers();
    expect(tiers.get('coal_mine')).toBe(0);
    expect(tiers.get('farm')).toBe(0);
    expect(tiers.get('steel_mill')).toBe(1);
    expect(tiers.get('power_station')).toBe(1);
    expect(tiers.get('sawmill')).toBe(1);
    expect(tiers.get('factory')).toBe(2);
  });

  test('sources and destinations are the matching industries, nearest first', () => {
    const mill = at(0, 'steel_mill', 50, 50);
    const industries = [mill, at(1, 'coal_mine', 90, 50), at(2, 'coal_mine', 60, 50), at(3, 'iron_mine', 50, 40), at(4, 'forest', 52, 52), at(5, 'factory', 30, 50), at(6, 'factory', 80, 80)];
    expect(cargoSources(mill, 'coal', industries).map((e) => e.id)).toEqual([2, 1]);
    expect(cargoSources(mill, 'iron_ore', industries).map((e) => e.id)).toEqual([3]);
    expect(cargoSources(mill, 'coal', industries, 1)).toHaveLength(1);
    const to = cargoDestinations(mill, 'steel', industries, []);
    expect(to.map((e) => e.id)).toEqual([5, 6]);
    expect(to[0]!.dist).toBe(21); // centres (52, 51) and (31, 51)
  });

  test('goods go to towns big enough to take them', () => {
    const factory = at(0, 'factory', 50, 50);
    const towns = [town(1, 55, 51, GOODS_RESIDENTS - 1), town(2, 70, 51, GOODS_RESIDENTS + 50)];
    const to = cargoDestinations(factory, 'goods', [factory], towns);
    expect(to).toEqual([{ kind: 'town', id: 2, name: 'Town 2', x: 70, y: 51, dist: 19 }]);
  });
});
