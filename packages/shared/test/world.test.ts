import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_SETTINGS,
  GameMap,
  GameState,
  TICKS_PER_DAY,
  TileType,
  applyChunk,
  decode,
  encode,
  encodeSnapshot,
  enforceSlopeLimit,
  executeCommand,
  extractChunk,
  generateTerrain,
  restoreSnapshot,
  ymdFromDays,
  type GameSettings,
} from '../src/index.ts';

const LIMITS = { maxPlayers: 15, maxMapSize: 2048 };

function settings(over: Partial<GameSettings> = {}): GameSettings {
  return { ...DEFAULT_SETTINGS, mapWidth: 128, mapHeight: 128, seed: 42, ...over };
}

function assertSlopeRule(map: GameMap): void {
  const w = map.width + 1;
  for (let y = 0; y <= map.height; y++) {
    for (let x = 0; x <= map.width; x++) {
      const h = map.heights[y * w + x]!;
      if (x < map.width) expect(Math.abs(h - map.heights[y * w + x + 1]!)).toBeLessThanOrEqual(1);
      if (y < map.height) expect(Math.abs(h - map.heights[(y + 1) * w + x]!)).toBeLessThanOrEqual(1);
    }
  }
}

describe('terrain', () => {
  test('enforceSlopeLimit produces a 1-Lipschitz field that never raises corners', () => {
    const w = 20;
    const input = Uint8Array.from({ length: w * w }, (_, i) => (i * 7919) % 30);
    const out = Uint8Array.from(input);
    enforceSlopeLimit(out, w, w);
    for (let i = 0; i < out.length; i++) expect(out[i]!).toBeLessThanOrEqual(input[i]!);
    const map = new GameMap(64, 64);
    // Reuse the checker on a real map
    generateTerrain(map, { seed: 3, roughness: 'mountainous', waterLevel: 0.2, treeDensity: 1 });
    assertSlopeRule(map);
  });

  test('generation is deterministic and respects water level', () => {
    const a = GameState.create(settings({ waterLevel: 0.3 }));
    const b = GameState.create(settings({ waterLevel: 0.3 }));
    expect(a.map.heights).toEqual(b.map.heights);
    expect(a.map.layers.type).toEqual(b.map.layers.type);
    let water = 0;
    for (const t of a.map.layers.type) if (t === TileType.Water) water++;
    const frac = water / a.map.layers.type.length;
    expect(frac).toBeGreaterThan(0.1);
    expect(frac).toBeLessThan(0.5);
  });

  test('heightAt matches corners', () => {
    const map = new GameMap(64, 64);
    map.heights[map.cornerIndex(1, 0)] = 1; // NE corner of tile (0,0) raised
    expect(map.heightAt(0, 0)).toBe(0);
    expect(map.heightAt(1, 0)).toBe(1);
    expect(map.heightAt(0.5, 0.5)).toBe(0); // flat half of the one-corner slope
    expect(map.heightAt(0.9, 0.1)).toBeCloseTo(0.8);
  });
});

describe('terraform command', () => {
  function setup() {
    const state = new GameState(settings(), new GameMap(64, 64));
    const p = state.addPlayer('Alice', true);
    const c = state.foundCompany(p)!;
    return { state, ctx: { playerId: p.id, companyId: c.id }, company: c };
  }

  test('raising a corner propagates slopes and charges money', () => {
    const { state, ctx, company } = setup();
    const before = company.money;
    for (let i = 0; i < 3; i++) {
      const r = executeCommand(state, ctx, { type: 'terraform', x0: 10, y0: 10, x1: 10, y1: 10, mode: 'raise' });
      expect(r.ok).toBe(true);
    }
    const m = state.map;
    expect(m.cornerHeight(10, 10)).toBe(3);
    expect(m.cornerHeight(11, 10)).toBe(2);
    expect(m.cornerHeight(12, 10)).toBe(1);
    expect(m.cornerHeight(13, 10)).toBe(0);
    assertSlopeRule(m);
    expect(company.money).toBeLessThan(before);
  });

  test('level mode flattens a rectangle and dry runs do not mutate', () => {
    const { state, ctx } = setup();
    const cmd = { type: 'terraform', x0: 5, y0: 5, x1: 8, y1: 8, mode: 'level', level: 2 } as const;
    const dry = executeCommand(state, ctx, cmd, true);
    expect(dry.ok).toBe(true);
    expect(state.map.cornerHeight(6, 6)).toBe(0);
    const r = executeCommand(state, ctx, cmd);
    expect(r.ok && r.effects!.dirtyChunks.size).toBeGreaterThan(0);
    for (let y = 5; y <= 8; y++) for (let x = 5; x <= 8; x++) expect(state.map.cornerHeight(x, y)).toBe(2);
    assertSlopeRule(state.map);
  });

  test('rejects bad input and unaffordable work', () => {
    const { state, ctx, company } = setup();
    expect(executeCommand(state, ctx, { type: 'terraform', x0: -1, y0: 0, x1: 0, y1: 0, mode: 'raise' }).ok).toBe(false);
    expect(executeCommand(state, ctx, { type: 'terraform', x0: 0.5, y0: 0, x1: 0, y1: 0, mode: 'raise' }).ok).toBe(false);
    expect(executeCommand(state, ctx, { type: 'terraform', x0: 0, y0: 0, x1: 0, y1: 0, mode: 'lower' }).ok).toBe(false);
    expect(executeCommand(state, { ...ctx, companyId: null }, { type: 'terraform', x0: 1, y0: 1, x1: 1, y1: 1, mode: 'raise' }).ok).toBe(false);
    company.money = 10;
    const r = executeCommand(state, ctx, { type: 'terraform', x0: 1, y0: 1, x1: 1, y1: 1, mode: 'raise' });
    expect(r.ok).toBe(false);
    expect(state.map.cornerHeight(1, 1)).toBe(0);
  });
});

describe('sync and saves', () => {
  test('chunk extract/apply round-trips through the codec', () => {
    const state = GameState.create(settings());
    const client = new GameMap(128, 128);
    for (let cy = 0; cy < 2; cy++) {
      for (let cx = 0; cx < 2; cx++) {
        const msg = decode<{ data: ReturnType<typeof extractChunk> }>(
          encode({ data: extractChunk(state.map, cx, cy) }),
        );
        applyChunk(client, msg.data);
      }
    }
    expect(client.heights).toEqual(state.map.heights);
    expect(client.layers.data).toEqual(state.map.layers.data);
    expect(client.layers.owner).toEqual(state.map.layers.owner);
  });

  test('snapshot round-trip restores map, date and companies', () => {
    const state = GameState.create(settings());
    const p = state.addPlayer('Bob', true);
    state.foundCompany(p, 'Bob Rail');
    for (let i = 0; i < TICKS_PER_DAY * 40; i++) state.step();
    const restored = restoreSnapshot(encodeSnapshot(state), LIMITS);
    expect(restored.map.heights).toEqual(state.map.heights);
    expect(restored.map.layers.type).toEqual(state.map.layers.type);
    expect(restored.date).toBe(state.date);
    expect(restored.companies.get(0)!.name).toBe('Bob Rail');
    // Rejoining by name restores membership
    expect(restored.addPlayer('Bob', true).companyId).toBe(0);
  });

  test('restore rejects garbage and oversize maps', () => {
    expect(() => restoreSnapshot(encode({ hello: 1 }), LIMITS)).toThrow();
    const big = GameState.create(settings());
    expect(() => restoreSnapshot(encodeSnapshot(big), { maxPlayers: 15, maxMapSize: 64 })).toThrow();
  });

  test('calendar advances months', () => {
    const state = new GameState(settings({ startYear: 1950 }), new GameMap(64, 64));
    let months = 0;
    for (let i = 0; i < TICKS_PER_DAY * 31; i++) if (state.step().newMonth) months++;
    expect(months).toBe(1);
    expect(ymdFromDays(state.date)).toEqual({ year: 1950, month: 1, day: 1 });
  });
});

describe('wire frames', () => {
  test('small frames are plain, large frames are deflated, both round-trip', async () => {
    const { encodeFrame, decodeFrame } = await import('../src/index.ts');
    const small = encodeFrame({ t: 'ping', at: 1 });
    expect(small[0]).toBe(0);
    expect(decodeFrame(small)).toEqual({ t: 'ping', at: 1 });
    const state = GameState.create(settings());
    const msg = { t: 'chunk', data: extractChunk(state.map, 0, 0) } as const;
    const big = encodeFrame(msg);
    expect(big[0]).toBe(1);
    expect(big.length).toBeLessThan(encode(msg).length / 2);
    const back = decodeFrame<typeof msg>(big);
    expect(back.data.heights).toEqual(msg.data.heights);
    expect(() => decodeFrame(new Uint8Array([9, 1, 2]))).toThrow();
  });
});

describe('towns', () => {
  test('towns get connected roads and road-facing houses', async () => {
    const { EDGE_DX, EDGE_DY, ROAD_EDGE_BITS, OPPOSITE_EDGE } = await import('../src/index.ts');
    const state = GameState.create({ ...DEFAULT_SETTINGS, mapWidth: 256, mapHeight: 256, seed: 99, waterLevel: 0.1 });
    const map = state.map;
    expect(state.towns.size).toBeGreaterThan(3);
    let roads = 0;
    let houses = 0;
    for (let y = 0; y < map.height; y++) {
      for (let x = 0; x < map.width; x++) {
        const i = map.tileIndex(x, y);
        const t = map.layers.type[i];
        if (t === TileType.Road) {
          roads++;
          expect(map.layers.town[i]).toBeGreaterThan(0);
          for (let e = 0; e < 4; e++) {
            if (!(map.layers.data[i]! & ROAD_EDGE_BITS[e]!)) continue;
            const j = map.tileIndex(x + EDGE_DX[e]!, y + EDGE_DY[e]!);
            // Connections are symmetric
            expect(map.layers.type[j]).toBe(TileType.Road);
            expect(map.layers.data[j]! & ROAD_EDGE_BITS[OPPOSITE_EDGE[e]!]!).toBeTruthy();
          }
        } else if (t === TileType.House) {
          houses++;
          const face = (map.layers.data[i]! >> 8) & 3;
          expect(map.type(x + EDGE_DX[face]!, y + EDGE_DY[face]!)).toBe(TileType.Road);
        }
      }
    }
    expect(roads).toBeGreaterThan(20);
    expect(houses).toBeGreaterThan(20);
    const pop = [...state.towns.values()].reduce((s, t) => s + t.population, 0);
    expect(pop).toBeGreaterThan(houses * 4);
    // Deterministic, and survives save/load with recounted population
    const again = GameState.create({ ...DEFAULT_SETTINGS, mapWidth: 256, mapHeight: 256, seed: 99, waterLevel: 0.1 });
    expect([...again.towns.values()].map((t) => t.name)).toEqual([...state.towns.values()].map((t) => t.name));
    const restored = restoreSnapshot(encodeSnapshot(state), LIMITS);
    expect([...restored.towns.values()]).toEqual([...state.towns.values()]);
  });
});
