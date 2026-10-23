/**
 * Frame cost check: plays a game on an emulated phone in headless Chrome and measures how many
 * frames it draws, how busy the page's main thread is and how much CPU the browser uses in all,
 * near a running train, watching it, paused, and panning. Run `bun run build` first.
 *
 *   node --experimental-strip-types scripts/perf.ts [cpuSlowdown]
 *
 * GRAPHICS=saver|balanced|high picks the graphics setting, DPR the phone's pixel density, and
 * SOFTWARE=1 draws in software (where drawing is CPU time) instead of on this machine's GPU.
 * A CPU slowdown makes the main thread's share like a cheap phone's, but the browser's total
 * then counts the throttling too.
 */
import { spawn } from 'node:child_process';
import { chromium, type CDPSession, type Page } from 'playwright-core';

const SLOWDOWN = Number(process.argv[2] ?? 1);
const PORT = 8794;
const server = spawn(process.env.BUN_PATH ?? 'bun', ['apps/server/src/index.ts'], {
  shell: process.platform === 'win32',
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 1200));
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: process.env.SOFTWARE ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] : ['--enable-gpu', '--ignore-gpu-blocklist'],
});

type Hook = {
  spawn: { x: number; y: number };
  view(v: object): void;
  command(cmd: object): Promise<{ ok: boolean; error?: string; id?: number }>;
  trains(): { id: number; status: string }[];
  stations(): { id: number; name: string }[];
  frames(): number;
  drawn(): { calls: number; triangles: number; geometries: number };
};

const hook = <T>(page: Page, fn: (h: Hook, arg: never) => T, arg?: unknown) =>
  page.evaluate(
    ([f, x]) => new Function('h', 'arg', `return (${f})(h, arg)`)((window as unknown as { transportsim: Hook }).transportsim, x),
    [fn.toString(), arg] as const,
  ) as Promise<T>;

let browserCdp: CDPSession;
/** Frames drawn per second, main-thread busy share and the browser's CPU use over `ms`, while `during` runs. */
async function measure(page: Page, cdp: CDPSession, what: string, ms: number, during?: () => Promise<void>) {
  const metric = async () => {
    const { metrics } = (await cdp.send('Performance.getMetrics')) as { metrics: { name: string; value: number }[] };
    const get = (n: string) => metrics.find((m) => m.name === n)?.value ?? 0;
    return { task: get('TaskDuration'), script: get('ScriptDuration'), style: get('RecalcStyleDuration') + get('LayoutDuration') };
  };
  const cpu = async () => {
    const { processInfo } = (await browserCdp.send('SystemInfo.getProcessInfo')) as { processInfo: { type: string; cpuTime: number }[] };
    return processInfo.reduce((sum, p) => sum + p.cpuTime, 0);
  };
  // News headlines show a live view of the place: not what is measured here.
  while ((await page.locator('.news-headline').count()) > 0) await page.locator('.news-headline button[aria-label="Close"]').first().dispatchEvent('click');
  const f0 = await hook(page, (h) => h.frames());
  const m0 = await metric();
  const c0 = await cpu();
  const t0 = Date.now();
  if (during) await during();
  const left = ms - (Date.now() - t0);
  if (left > 0) await page.waitForTimeout(left);
  const secs = (Date.now() - t0) / 1000;
  const m1 = await metric();
  const c1 = await cpu();
  const f1 = await hook(page, (h) => h.frames());
  const drawn = await hook(page, (h) => h.drawn());
  const pct = (v: number) => `${((v / secs) * 100).toFixed(0).padStart(3)}%`;
  console.log(
    `${what.padEnd(24)} frames/s ${((f1 - f0) / secs).toFixed(1).padStart(5)}   main thread busy ${pct(m1.task - m0.task)} (script ${pct(m1.script - m0.script)}, style+layout ${pct(m1.style - m0.style)})   all processes ${pct(c1 - c0)} of a core   ${drawn.calls} draws, ${(drawn.triangles / 1000).toFixed(0)}k triangles`,
  );
}

try {
  browserCdp = await browser.newBrowserCDPSession();
  const dpr = Number(process.env.DPR ?? 2.625);
  const ctx = await browser.newContext({ viewport: { width: 412, height: 860 }, isMobile: true, hasTouch: true, deviceScaleFactor: dpr });
  if (process.env.GRAPHICS) await ctx.addInitScript((g) => localStorage.setItem('ts.graphics', g), process.env.GRAPHICS);
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const cdp = await ctx.newCDPSession(page);
  await page.goto(`http://localhost:${PORT}/`);
  await page.getByText('Connected').waitFor();
  await page.getByPlaceholder('Player name').fill('Perf');
  await page.locator('label.field', { hasText: 'Seed' }).locator('input').fill('424242');
  await page.locator('label.field', { hasText: 'Timeline' }).locator('select').selectOption('sandbox');
  await page.getByRole('button', { name: 'Create game' }).tap();
  await page.getByText('Allow autosaves?').waitFor({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Not now' }).tap();
  const companyWin = page.locator('.window', { hasText: 'Found a company' });
  await companyWin.waitFor({ timeout: 5000 });
  await companyWin.getByRole('textbox', { name: 'Company name' }).fill('Perf Rail');
  await companyWin.getByRole('button', { name: 'Found', exact: true }).tap();
  await page.waitForTimeout(800);
  while ((await page.locator('.window').count()) > 0) await page.locator('.window button[aria-label="Close"]').first().tap();

  // A train running between two stations near the start town.
  const spawnAt = await hook(page, (h) => h.spawn);
  await hook(page, (h) => h.command({ type: 'loan', action: 'borrow', amount: 500_000 }));
  let at: { x: number; y: number } | null = null;
  for (const [dx, dy] of [[24, 0], [-24, 0], [0, 24], [0, -24], [30, 30], [-30, -30], [40, 0]]) {
    const p = { x: spawnAt.x + dx!, y: spawnAt.y + dy! };
    const r = await hook(page, (h, s: { x: number; y: number }) => h.command({ type: 'terraform', x0: s.x - 14, y0: s.y - 3, x1: s.x + 14, y1: s.y + 3, mode: 'level', level: 4 }), p);
    if (r.ok) {
      at = p;
      break;
    }
  }
  if (!at) throw new Error('found no land to level');
  const y = at.y;
  const pieces: number[] = [];
  for (let x = at.x - 12; x <= at.x + 12; x++) pieces.push(x, y, 0);
  const steps: object[] = [
    { type: 'buildTrack', pieces },
    { type: 'buildStation', x: at.x - 10, y, axis: 0, platforms: 1, length: 4 },
    { type: 'buildStation', x: at.x + 7, y, axis: 0, platforms: 1, length: 4 },
    { type: 'buildDepot', x: at.x - 13, y, exit: 1 },
  ];
  for (const c of steps) {
    const r = await hook(page, (h, cmd: object) => h.command(cmd), c);
    if (!r.ok) throw new Error(`${JSON.stringify(c)}: ${r.error}`);
  }
  const depot = y * (await hook(page, (h) => h.width)) + at.x - 13;
  const buy = await hook(page, (h, d: number) => h.command({ type: 'buyTrain', depot: d, units: ['kestrel', 'coach_wood', 'coach_wood', 'coach_wood'] }), depot);
  if (!buy.ok) throw new Error(`buyTrain: ${buy.error}`);
  await page.waitForTimeout(500);
  const trainId = (await hook(page, (h) => h.trains()))[0]!.id;
  const st = await hook(page, (h) => h.stations());
  for (const c of [
    { type: 'setOrders', id: trainId, orders: st.slice(0, 2).map((s) => ({ kind: 'station', station: s.id })) },
    { type: 'trainAction', id: trainId, action: 'start' },
  ]) {
    const r = await hook(page, (h, cmd: object) => h.command(cmd), c);
    if (!r.ok) throw new Error(`${JSON.stringify(c)}: ${r.error}`);
  }
  await page.waitForTimeout(3000);
  while ((await page.locator('.window').count()) > 0) await page.locator('.window button[aria-label="Close"]').first().tap();
  await cdp.send('Performance.enable');
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: SLOWDOWN });
  console.log(await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2')!;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  }));
  console.log(`${process.env.GRAPHICS ?? 'default'} graphics, CPU slowed down ${SLOWDOWN}×, ${await page.evaluate(() => devicePixelRatio)} device pixels per CSS pixel`);

  // Looking at the town, the train in sight further off.
  await hook(page, (h, s: { x: number; y: number }) => h.view({ x: s.x, y: s.y, distance: 40, yaw: 0.6, pitch: 0.9 }), spawnAt);
  await page.waitForTimeout(3000);
  await measure(page, cdp, 'town, a train nearby', 5000);
  // Watching the train.
  await hook(page, (h, s: { x: number; y: number }) => h.view({ x: s.x, y: s.y, distance: 30 }), at);
  await page.waitForTimeout(3000);
  await measure(page, cdp, 'watching a train', 5000);
  // The same, paused (Space pauses for the host).
  await page.keyboard.press('Space');
  await page.waitForTimeout(1000);
  await measure(page, cdp, 'paused', 5000);
  await page.keyboard.press('Space');
  // Panning with a finger.
  await measure(page, cdp, 'panning', 4000, async () => {
    for (let i = 0; i < 6; i++) {
      const steps = Array.from({ length: 20 }, (_, k) => [{ x: 206, y: 300 + (i % 2 ? 20 - k : k) * 12 }]);
      for (const f of steps) {
        await cdp.send('Input.dispatchTouchEvent', { type: f === steps[0] ? 'touchStart' : 'touchMove', touchPoints: f.map((p, id) => ({ ...p, id })) });
        await new Promise((r) => setTimeout(r, 16));
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    }
  });
} finally {
  await browser.close();
  server.kill();
}
