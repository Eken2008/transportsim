/**
 * Visual check of track rendering: builds a small test layout through the command API and
 * takes close-up screenshots (curves, points, slopes, a train). Run `bun run build` first.
 *
 *   node --experimental-strip-types scripts/visual.ts [outDir]
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium } from 'playwright-core';

const outDir = resolve(process.argv[2] ?? 'test-results/visual');
mkdirSync(outDir, { recursive: true });
const PORT = 8791;
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

type Hook = {
  spawn: { x: number; y: number };
  view(v: object): void;
  command(cmd: object): Promise<{ ok: boolean; error?: string }>;
};

try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`http://localhost:${PORT}/`);
  await page.getByText('Connected').waitFor();
  await page.getByPlaceholder('Player name').fill('Viz');
  await page.locator('label.field', { hasText: 'Seed' }).locator('input').fill('424242');
  await page.locator('label.field', { hasText: 'Sea level' }).locator('input').fill('0');
  await page.locator('label.field', { hasText: 'Economy' }).locator('select').selectOption('easy');
  await page.getByRole('button', { name: 'Create game' }).click();
  await page.getByRole('button', { name: 'Not now' }).click({ timeout: 30_000 });

  const run = (cmd: object) =>
    page.evaluate((c) => (window as unknown as { transportsim: Hook }).transportsim.command(c), cmd);
  const view = (v: object) => page.evaluate((vv) => (window as unknown as { transportsim: Hook }).transportsim.view(vv), v);

  // Find a clear area east or west of the town and level it.
  let ox = 0;
  let oy = 0;
  search: for (let cy = 40; cy < 470; cy += 37) {
    for (let cx = 40; cx < 470; cx += 37) {
      const r = await run({ type: 'terraform', x0: cx - 16, y0: cy - 12, x1: cx + 16, y1: cy + 24, mode: 'level', level: 4 });
      if (r.ok) {
        ox = cx;
        oy = cy;
        break search;
      }
    }
  }
  if (!ox) throw new Error('no clear area found');
  const X = 0, Y = 1, NE = 2, SE = 3, SW = 4, NW = 5;
  const pieces: number[] = [];
  const add = (x: number, y: number, p: number) => pieces.push(ox + x, oy + y, p);
  // Main line west-east on row 0, with an S-bend: east, then a diagonal heading south-east, then east again.
  for (let x = -14; x <= -4; x++) add(x, 0, X);
  add(-3, 0, SW); add(-3, 1, NE); add(-2, 1, SW); add(-2, 2, NE);
  for (let x = -1; x <= 12; x++) add(x, 2, X);
  // Points: a branch leaving the straight at x = 4 heading north-east.
  add(4, 2, NW); add(4, 1, SE); add(5, 1, NW); add(5, 0, SE); add(6, 0, NW);
  for (let y = -1; y >= -6; y--) add(6, y, Y);
  // A wye: a line from the south splitting both ways onto the main line at x = 9.
  for (let y = 3; y <= 8; y++) add(9, y, Y);
  add(9, 2, SW); add(9, 2, SE);
  // A diamond crossing at x = 11.
  for (let y = -2; y <= 8; y++) add(11, y, Y);
  console.log('track', await run({ type: 'buildTrack', pieces }));
  // A hill on the east part: the line climbs and descends.
  for (let k = 0; k < 2; k++) console.log('hill', await run({ type: 'terraform', x0: ox + 17, y0: oy - 1, x1: ox + 18, y1: oy + 5, mode: 'raise' }));
  const hillPieces: number[] = [];
  for (let x = 13; x <= 22; x++) hillPieces.push(ox + x, oy + 2, X);
  console.log('hill track', await run({ type: 'buildTrack', pieces: hillPieces }));

  // Tool-drawn case, like a player would: two parallel lines, then a route from below to the far one.
  const tileToScreen = (x: number, y: number) =>
    page.evaluate(([tx, ty]) => (window as unknown as { transportsim: { tileToScreen(x: number, y: number): { x: number; y: number } } }).transportsim.tileToScreen(tx!, ty!), [x, y]);
  const drag = async (x0: number, y0: number, x1: number, y1: number) => {
    const a = await tileToScreen(x0, y0);
    const b = await tileToScreen(x1, y1);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 12 });
    await page.waitForTimeout(300);
    await page.mouse.up();
    await page.waitForTimeout(700);
  };
  await view({ x: ox, y: oy + 13, yaw: 0, pitch: 1.35, distance: 26 });
  await page.waitForTimeout(2000);
  await page.keyboard.press('Digit4');
  await drag(ox - 8, oy + 10, ox + 8, oy + 10);
  await drag(ox - 8, oy + 11, ox + 8, oy + 11); // double track: rows 10 and 11
  await drag(ox - 7, oy + 17, ox + 1, oy + 4); // a diagonal straight over both tracks
  await drag(ox + 4, oy + 18, ox + 4, oy + 10); // straight up, ending on the far track
  await page.keyboard.press('Escape');
  await view({ x: ox - 1, y: oy + 11, yaw: 0, pitch: 1.4, distance: 10 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${outDir}/tool-junction.png` });

  await view({ x: ox - 2, y: oy + 1, yaw: 0.4, pitch: 1.1, distance: 9 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: `${outDir}/curve.png` });
  await view({ x: ox + 9.5, y: oy + 3, yaw: 0.1, pitch: 1.2, distance: 9 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${outDir}/junctions.png` });
  await view({ x: ox + 4.5, y: oy + 1, yaw: 0.2, pitch: 1.0, distance: 8 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${outDir}/points.png` });
  await run({ type: 'clearArea', x0: ox + 10, y0: oy + 3, x1: ox + 26, y1: oy + 12 });
  await view({ x: ox + 17.5, y: oy + 2.5, yaw: 0.15, pitch: 0.3, distance: 7 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${outDir}/hill.png` });
  await view({ x: ox, y: oy, yaw: 0.5, pitch: 0.9, distance: 26 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${outDir}/overview.png` });
} finally {
  await browser.close();
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']);
  else server.kill();
}
