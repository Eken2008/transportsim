/**
 * End-to-end smoke test: builds nothing itself — run `bun run build` first.
 * Starts the server (serving the built client), opens two browser tabs, hosts a game,
 * joins it from the second tab, terraforms, and saves screenshots.
 *
 *   node --experimental-strip-types scripts/smoke.ts [outDir]
 *
 * Uses an installed Chrome (CHROME_PATH to override). Run with Node (Playwright's pipe
 * transport does not work under Bun on Windows).
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type Page } from 'playwright-core';

const outDir = resolve(process.argv[2] ?? 'test-results');
mkdirSync(outDir, { recursive: true });
const PORT = 8790;
const chromePath = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const server = spawn(process.env.BUN_PATH ?? 'bun', ['apps/server/src/index.ts'], {
  shell: process.platform === 'win32',
  env: { ...process.env, PORT: String(PORT), HOST_GRACE_SECONDS: '3' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stdout.on('data', (d) => process.stdout.write(`[server] ${d}`));
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
await new Promise((r) => setTimeout(r, 1200));

const browser = await chromium.launch({
  executablePath: chromePath,
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
let failed = false;
let lastPage: Page | null = null;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? '✓' : '✗'} ${what}`);
  if (!ok) failed = true;
};

try {
  const ctxA = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  const ctxB = await browser.newContext({ viewport: { width: 1100, height: 760 } });
  const a = await ctxA.newPage();
  const b = await ctxB.newPage();
  for (const [p, n] of [[a, 'A'], [b, 'B']] as [Page, string][]) {
    p.on('console', (m) => m.type() === 'error' && console.log(`[${n} console] ${m.text()}`));
    p.on('pageerror', (e) => console.log(`[${n} pageerror] ${e.message}`));
  }

  await a.goto(`http://localhost:${PORT}/`);
  await a.getByText('Connected').waitFor({ timeout: 10_000 });
  await a.getByPlaceholder('Player name').fill('Alice');
  await a.screenshot({ path: `${outDir}/01-lobby.png` });
  await a.locator('label.field', { hasText: 'Seed' }).locator('input').fill('424242');
  await a.locator('label.field', { hasText: 'Sea level' }).locator('input').fill('0');
  await a.getByRole('button', { name: 'Create game' }).click();
  await a.getByText('Allow autosaves?').waitFor({ timeout: 30_000 });
  check(true, 'host sees autosave consent prompt');
  await a.getByRole('button', { name: 'Allow autosaves' }).click();
  await a.waitForTimeout(4000);
  await a.screenshot({ path: `${outDir}/02-game.png` });
  const chunks = Number((await a.locator('.statusbar').innerText()).match(/(\d+) chunks/)?.[1] ?? 0);
  check(chunks > 0, `terrain chunks rendered (${chunks})`);

  // Raise terrain at screen center
  await a.keyboard.press('Digit1');
  const box = (await a.locator('canvas').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  const moneyBefore = await a.locator('.money').innerText();
  for (let i = 0; i < 4; i++) {
    await a.mouse.move(cx, cy);
    await a.mouse.down();
    await a.mouse.up();
    await a.waitForTimeout(150);
  }
  await a.mouse.move(cx + 60, cy + 40);
  await a.mouse.down();
  await a.mouse.move(cx + 160, cy + 110, { steps: 6 });
  await a.mouse.up();
  await a.waitForTimeout(1500);
  const moneyAfter = await a.locator('.money').innerText();
  check(moneyBefore !== moneyAfter, `terraforming cost money (${moneyBefore} → ${moneyAfter})`);
  await a.screenshot({ path: `${outDir}/03-terraformed.png` });

  // Level a known area via the command API (track needs suitable slopes), then lay a
  // straight line and a diagonal staircase by dragging the real rail tool between tiles.
  type Hook = {
    spawn: { x: number; y: number };
    view(v: object): void;
    tileToScreen(x: number, y: number): { x: number; y: number };
    command(cmd: object): Promise<{ ok: boolean; error?: string }>;
  };
  const hook = <T>(fn: (h: Hook, arg: never) => T, arg?: unknown) =>
    a.evaluate(([f, x]) => new Function('h', 'arg', `return (${f})(h, arg)`)((window as unknown as { transportsim: Hook }).transportsim, x), [fn.toString(), arg] as const) as Promise<T>;
  const spawn = await hook((h) => h.spawn);
  const sx = spawn.x;
  const sy = spawn.y;
  const level = await hook(
    (h, s: { x: number; y: number }) =>
      h.command({ type: 'terraform', x0: s.x - 14, y0: s.y - 8, x1: s.x + 14, y1: s.y + 10, mode: 'level', level: 4 }),
    { x: sx, y: sy },
  );
  check(level.ok, `level area via command API${level.ok ? '' : `: ${level.error}`}`);
  await hook((h, s: { x: number; y: number }) => h.view({ x: s.x, y: s.y, yaw: 0.35, pitch: 1.05, distance: 34 }), { x: sx, y: sy });
  await a.waitForTimeout(2500);
  const dragTiles = async (x0: number, y0: number, x1: number, y1: number) => {
    const p0 = await hook((h, t: number[]) => h.tileToScreen(t[0]!, t[1]!), [x0, y0]);
    const p1 = await hook((h, t: number[]) => h.tileToScreen(t[0]!, t[1]!), [x1, y1]);
    await a.mouse.move(p0.x, p0.y);
    await a.mouse.down();
    await a.mouse.move(p1.x, p1.y, { steps: 10 });
    await a.mouse.up();
    await a.waitForTimeout(800);
  };
  await a.keyboard.press('Digit4');
  const beforeRail = await a.locator('.money').innerText();
  await dragTiles(sx - 10, sy - 4, sx + 10, sy - 4);
  await dragTiles(sx - 8, sy, sx - 2, sy + 6);
  await a.waitForTimeout(1200);
  const afterRail = await a.locator('.money').innerText();
  check(beforeRail !== afterRail, `building track with the rail tool cost money (${beforeRail} → ${afterRail})`);
  if (beforeRail === afterRail) console.log('  toasts:', await a.locator('.toast').allInnerTexts());
  await a.keyboard.press('Escape');
  await a.waitForTimeout(1500);
  await a.screenshot({ path: `${outDir}/03b-track.png` });

  // Second player joins by code
  const code = (await a.getByTitle('Copy game code').innerText()).trim();
  await b.goto(`http://localhost:${PORT}/`);
  await b.getByText('Connected').waitFor({ timeout: 10_000 });
  await b.getByPlaceholder('Player name').fill('Bob');
  await b.getByPlaceholder('Game code').fill(code);
  await b.getByRole('button', { name: 'Join by code' }).click();
  await b.locator('canvas').waitFor({ timeout: 15_000 });
  await b.waitForTimeout(3000);
  check(await b.getByText('Allow autosaves?').count() === 0, 'guest is not asked about autosaves');
  await b.screenshot({ path: `${outDir}/04-guest.png` });
  check((await a.locator('.chat-log').innerText()).includes('Bob joined'), 'host sees guest join message');

  // Chat round trip
  await b.getByPlaceholder(/Say something/).fill('Hello from Bob');
  await b.keyboard.press('Enter');
  await a.waitForTimeout(500);
  check((await a.locator('.chat-log').innerText()).includes('Hello from Bob'), 'chat reaches host');

  // Manual save lands in host IndexedDB
  const savedMoney = await a.locator('.money').innerText();
  await a.getByRole('button', { name: '💾 Save' }).click();
  await a.getByText('Game saved to this browser').waitFor({ timeout: 10_000 });
  check(true, 'manual save stored in host browser');

  // Host leaves → guest sees countdown, then game end
  await a.close();
  await b.getByText(/host disconnected/i).waitFor({ timeout: 5000 });
  check(true, 'guest notified that host disconnected');
  await b.getByText(/Game ended/).waitFor({ timeout: 10_000 });
  check(true, 'room closed after host grace period');
  await b.screenshot({ path: `${outDir}/05-ended.png` });

  // Host reopens and sees the save in the lobby
  const a2 = await ctxA.newPage();
  await a2.goto(`http://localhost:${PORT}/`);
  await a2.getByText('Connected').waitFor({ timeout: 10_000 });
  const saves = await a2.locator('.save').count();
  check(saves >= 1, `host lobby lists ${saves} save(s)`);
  lastPage = a2;
  a2.on('pageerror', (e) => console.log(`[A2 pageerror] ${e.message}`));
  await a2.locator('.save').first().getByRole('button', { name: 'Host' }).click();
  await a2.locator('canvas').waitFor({ timeout: 15_000 });
  await a2.waitForTimeout(2500);
  const resumedMoney = await a2.locator('.money').innerText();
  check(resumedMoney === savedMoney, `resumed game keeps company money (${resumedMoney})`);
  await a2.screenshot({ path: `${outDir}/06-resumed.png` });
} catch (e) {
  failed = true;
  console.error(e);
  if (lastPage && !lastPage.isClosed()) {
    console.log('Toasts:', await lastPage.locator('.toast').allInnerTexts());
    await lastPage.screenshot({ path: `${outDir}/failure.png` });
  }
} finally {
  await browser.close();
  // With shell: true, kill() only ends the shell; take down the whole tree on Windows.
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F']);
  else server.kill();
}
console.log(failed ? 'SMOKE FAILED' : 'SMOKE OK');
process.exit(failed ? 1 : 0);
