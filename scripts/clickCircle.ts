/**
 * Builds the smallest circle — eight pieces round a 3×3 ring — by clicking each piece with the
 * rail tool, as a player would, then checks a train could run all the way round both ways.
 * Done twice: clicked in order, and in a scrambled order with the camera turned. Run
 * `bun run build` first.
 *
 *   node --experimental-strip-types scripts/clickCircle.ts [outDir]
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const outDir = resolve(process.argv[2] ?? 'test-results/circle');
mkdirSync(outDir, { recursive: true });
const PORT = 8792;
const server = spawn(process.env.BUN_PATH ?? 'bun', ['apps/server/src/index.ts'], {
  shell: process.platform === 'win32',
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 1200));
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

type Step = { x: number; y: number; piece: string; ways: number };
type Hook = {
  view(v: object): void;
  command(cmd: object): Promise<{ ok: boolean; error?: string }>;
  pointToScreen(x: number, y: number): { x: number; y: number };
  tile(x: number, y: number): { track: number };
  follow(x: number, y: number, piece: number, dir: number, steps: number): Step[];
};

const X = 0, Y = 1, NE = 2, SE = 3, SW = 4, NW = 5;
const NAMES = ['X', 'Y', 'NE', 'SE', 'SW', 'NW'];
// Where to click inside a tile for each piece: its midpoint (straights: off-centre, so the
// nearest piece is unambiguous).
const CLICK: Record<number, [number, number]> = {
  [X]: [0.25, 0.5],
  [Y]: [0.5, 0.25],
  [NE]: [0.75, 0.25],
  [SE]: [0.75, 0.75],
  [SW]: [0.25, 0.75],
  [NW]: [0.25, 0.25],
};
const RING: [number, number, number][] = [
  [1, 0, X], [2, 0, SW], [2, 1, Y], [2, 2, NW], [1, 2, X], [0, 2, NE], [0, 1, Y], [0, 0, SE],
];

let failed = false;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`);
  if (!ok) failed = true;
};

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.getByText('Connected').waitFor();
  await page.getByPlaceholder('Player name').fill('Circle');
  await page.locator('label.field', { hasText: 'Seed' }).locator('input').fill('424242');
  await page.locator('label.field', { hasText: 'Sea level' }).locator('input').fill('0');
  await page.locator('label.field', { hasText: 'Economy' }).locator('select').selectOption('easy');
  await page.getByRole('button', { name: 'Create game' }).click();
  await page.getByRole('button', { name: 'Not now' }).click({ timeout: 30_000 });

  const hook = <T>(fn: (h: Hook, arg: never) => T, arg?: unknown) =>
    page.evaluate(([f, a]) => new Function('h', 'a', `return (${f})(h, a)`)((window as unknown as { transportsim: Hook }).transportsim, a), [fn.toString(), arg] as const) as Promise<Awaited<T>>;
  const run = (cmd: object) => hook((h, c: object) => h.command(c), cmd);

  // A clear, level area.
  let ox = 0;
  let oy = 0;
  search: for (let cy = 40; cy < 470; cy += 37) {
    for (let cx = 40; cx < 470; cx += 37) {
      if ((await run({ type: 'terraform', x0: cx - 4, y0: cy - 4, x1: cx + 16, y1: cy + 8, mode: 'level', level: 4 })).ok) {
        ox = cx;
        oy = cy;
        break search;
      }
    }
  }
  if (!ox) throw new Error('no clear area found');

  await page.keyboard.press('Digit4'); // rail tool
  const cases = [
    { name: 'clicked in order', at: [ox, oy], yaw: 0, order: [0, 1, 2, 3, 4, 5, 6, 7] },
    { name: 'clicked in a scrambled order, camera turned', at: [ox + 8, oy], yaw: 0.9, order: [4, 1, 6, 3, 0, 7, 2, 5] },
  ];
  for (const c of cases) {
    const [bx, by] = c.at as [number, number];
    await hook((h, v: object) => h.view(v), { x: bx + 1.5, y: by + 1.5, yaw: c.yaw, pitch: 1.2, distance: 9 });
    await page.waitForTimeout(1500);
    for (const k of c.order) {
      const [dx, dy, piece] = RING[k]!;
      const [fx, fy] = CLICK[piece]!;
      const pt = await hook((h, p: [number, number]) => h.pointToScreen(p[0], p[1]), [bx + dx + fx, by + dy + fy]);
      await page.mouse.move(pt.x, pt.y, { steps: 3 });
      await page.mouse.down();
      await page.mouse.up();
      await page.waitForTimeout(400);
      const track = (await hook((h, p: [number, number]) => h.tile(p[0], p[1]), [bx + dx, by + dy])).track;
      check(((track >> piece) & 1) === 1, `${c.name}: click placed ${NAMES[piece]} on ring tile (${dx},${dy})`);
    }
    for (const dir of [0, 1]) {
      const path = await hook((h, a: number[]) => h.follow(a[0]!, a[1]!, a[2]!, a[3]!, a[4]!), [bx + 1, by, X, dir, 9]);
      const round = path.length === 9 && path.slice(0, 8).every((s) => s.ways === 1) && path[8]!.x === bx + 1 && path[8]!.y === by && path[8]!.piece === 'X';
      check(round, `${c.name}: a train runs all the way round ${dir ? 'anticlockwise' : 'clockwise'} (${path.map((s) => `${s.x - bx},${s.y - by} ${s.piece}`).join(' → ')})`);
    }
    await page.mouse.move(5, 5);
    await page.waitForTimeout(1200);
    await page.screenshot({ path: `${outDir}/circle-${cases.indexOf(c) + 1}.png` });
  }
} finally {
  await browser.close();
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']);
  else server.kill();
}
console.log(failed ? 'CIRCLE FAILED' : 'CIRCLE OK');
process.exit(failed ? 1 : 0);
