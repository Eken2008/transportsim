/**
 * Phone check: plays the game on an emulated touch phone, portrait and landscape. Screenshots
 * the lobby, the HUD, menus, a window and tool options, and checks the touch gestures (pan,
 * pinch, twist, tilt, tap to open, a second finger cancelling a build). Run `bun run build` first.
 *
 *   node --experimental-strip-types scripts/mobile.ts [outDir]
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { chromium, type CDPSession, type Page } from 'playwright-core';

const outDir = resolve(process.argv[2] ?? 'test-results/mobile');
mkdirSync(outDir, { recursive: true });
const PORT = 8793;
const server = spawn(process.env.BUN_PATH ?? 'bun', ['apps/server/src/index.ts'], {
  shell: process.platform === 'win32',
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
await new Promise((r) => setTimeout(r, 1200));
const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});

type Cam = { x: number; z: number; distance: number; yaw: number; pitch: number };
type Point = { x: number; y: number };
type Hook = {
  spawn: Point;
  findClear(x: number, y: number, w: number, h: number): Point | null;
  view(v: object): void;
  tileToScreen(x: number, y: number): Point;
  camera(): Cam;
  command(cmd: object): Promise<{ ok: boolean; error?: string }>;
};

let failures = 0;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures++;
};

/** One touch gesture: each step lists every finger's position; fingers missing from a step lift. */
async function gesture(
  cdp: CDPSession,
  steps: { x: number; y: number }[][],
  stepMs = 16,
): Promise<void> {
  let down = 0;
  for (const fingers of steps) {
    const touchPoints = fingers.map((f, id) => ({ x: f.x, y: f.y, id }));
    const type =
      fingers.length > down ? 'touchStart' : fingers.length < down ? 'touchEnd' : 'touchMove';
    await cdp.send('Input.dispatchTouchEvent', { type, touchPoints });
    down = fingers.length;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  if (down) await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await new Promise((r) => setTimeout(r, 100));
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const path = (n: number, f: (t: number) => { x: number; y: number }[]) =>
  Array.from({ length: n + 1 }, (_, i) => f(i / n));

/**
 * Nothing on the page reaches past the screen's sides (the page itself scrolls sideways
 * otherwise, or things are cut off), except inside something that clips or scrolls it.
 */
async function noHorizontalOverflow(page: Page, what: string) {
  const over = await page.evaluate(() => {
    const w = document.documentElement.clientWidth;
    const clipped = (el: Element) => {
      for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
        if (a.id === 'root') break;
        if (getComputedStyle(a).overflowX !== 'visible') return true;
      }
      return false;
    };
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || (r.left >= -1 && r.right <= w + 1)) continue;
      if (clipped(el)) continue;
      // Report the outermost offender only.
      el.dataset.over = '';
      if (el.parentElement?.dataset.over !== undefined) continue;
      out.push(
        `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} ${Math.round(r.left)}..${Math.round(r.right)}`,
      );
    }
    for (const el of document.querySelectorAll<HTMLElement>('[data-over]')) delete el.dataset.over;
    // The lobby scrolls itself: name what makes it scroll sideways.
    for (const lobby of document.querySelectorAll<HTMLElement>('.lobby')) {
      if (lobby.scrollWidth <= lobby.clientWidth + 1) continue;
      const right = lobby.getBoundingClientRect().left + lobby.clientWidth;
      const wide = [...lobby.querySelectorAll<HTMLElement>('*')].filter(
        (el) => el.getBoundingClientRect().right > right + 1,
      );
      const outer = wide.filter((el) => !wide.includes(el.parentElement!));
      out.push(
        `the lobby scrolls sideways: ${outer.map((el) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${el.textContent?.slice(0, 30)}"`).join(', ')}`,
      );
    }
    return out.slice(0, 6);
  });
  check(over.length === 0, `${what}: nothing runs off the screen sideways ${over.join(', ')}`);
}

/** A Galaxy S24 as Chrome's device toolbar has it. */
const W = 360;
const H = 780;

try {
  // ---- portrait --------------------------------------------------------------------
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    isMobile: true,
    hasTouch: true,
    deviceScaleFactor: 1,
  });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  const cdp = await ctx.newCDPSession(page);
  await page.goto(`http://localhost:${PORT}/`);
  await page.getByText('Connected').waitFor();
  await page.screenshot({ path: `${outDir}/portrait-lobby.png`, fullPage: true });
  await noHorizontalOverflow(page, 'lobby');
  await page.getByPlaceholder('Player name').fill('Phone');
  await page.locator('label.field', { hasText: 'Seed' }).locator('input').fill('424242');
  await page
    .locator('label.field', { hasText: 'Timeline' })
    .locator('select')
    .selectOption('sandbox');
  await page.getByRole('button', { name: 'Create game' }).tap();
  await page.getByText('Allow autosaves?').waitFor({ timeout: 30_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${outDir}/portrait-autosave.png` });
  await noHorizontalOverflow(page, 'autosave question');
  await page.getByRole('button', { name: 'Not now' }).tap();
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${outDir}/portrait-game.png` });
  const closeWindows = async () => {
    while ((await page.locator('.window').count()) > 0)
      await page.locator('.window button[aria-label="Close"]').first().tap();
  };
  await closeWindows();
  await noHorizontalOverflow(page, 'portrait HUD');

  const cam = () =>
    page.evaluate(() => (window as unknown as { transportsim: Hook }).transportsim.camera());
  // Below the getting-started guide.
  const cx = W / 2,
    cy = H * 0.62;

  // One finger with no tool pans.
  let before = await cam();
  await gesture(
    cdp,
    path(12, (t) => [{ x: cx, y: lerp(cy - 60, cy + 60, t) }]),
  );
  let after = await cam();
  check(
    Math.hypot(after.x - before.x, after.z - before.z) > 2 &&
      Math.abs(after.distance - before.distance) < 0.01,
    'one-finger drag pans',
  );

  // Pinch apart zooms in.
  before = await cam();
  await gesture(
    cdp,
    path(12, (t) => [
      { x: cx - lerp(30, 110, t), y: cy },
      { x: cx + lerp(30, 110, t), y: cy },
    ]),
  );
  after = await cam();
  check(
    after.distance < before.distance * 0.6,
    `pinch zooms in (${before.distance.toFixed(1)} → ${after.distance.toFixed(1)})`,
  );

  // Twisting two fingers rotates.
  before = await cam();
  await gesture(
    cdp,
    path(12, (t) => {
      const a = lerp(0, Math.PI / 3, t);
      return [
        { x: cx - Math.cos(a) * 90, y: cy - Math.sin(a) * 90 },
        { x: cx + Math.cos(a) * 90, y: cy + Math.sin(a) * 90 },
      ];
    }),
  );
  after = await cam();
  check(
    Math.abs(after.yaw - before.yaw) > 0.5 && Math.abs(after.pitch - before.pitch) < 0.01,
    `twist rotates (yaw ${before.yaw.toFixed(2)} → ${after.yaw.toFixed(2)})`,
  );

  // Two fingers dragged up together tilt.
  before = await cam();
  await gesture(
    cdp,
    path(14, (t) => [
      { x: cx - 70, y: lerp(cy + 120, cy - 40, t) },
      { x: cx + 70, y: lerp(cy + 120, cy - 40, t) },
    ]),
  );
  after = await cam();
  check(
    after.pitch < before.pitch - 0.2,
    `two-finger drag up tilts (pitch ${before.pitch.toFixed(2)} → ${after.pitch.toFixed(2)})`,
  );

  // Top-bar menu.
  await page.getByRole('button', { name: 'Menu' }).tap();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${outDir}/portrait-menu.png` });
  await noHorizontalOverflow(page, 'portrait menu');
  await page.getByRole('button', { name: /Find/ }).tap();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/portrait-window.png` });
  await noHorizontalOverflow(page, 'portrait window');
  await closeWindows();

  // The chat opens from the top bar and closes again.
  await page.getByRole('button', { name: /^Chat/ }).tap();
  await page.locator('.chat input').fill('Hello from a phone');
  await page.locator('.chat input').press('Enter');
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/portrait-chat.png` });
  await noHorizontalOverflow(page, 'portrait chat');
  await page.getByRole('button', { name: 'Hide chat' }).tap();
  check((await page.locator('.chat').count()) === 0, 'the chat closes');

  // Found a company, pick the rail tool.
  await page.getByRole('button', { name: /Start or join/ }).tap();
  await page.getByRole('button', { name: 'Found', exact: true }).tap();
  await page.locator('.money').waitFor();
  await closeWindows();
  await page.getByRole('button', { name: 'Railways tools' }).tap();
  await page.getByRole('button', { name: /^Station/ }).tap();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/portrait-station-tool.png` });
  await noHorizontalOverflow(page, 'portrait station tool');
  const railRow = await page
    .locator('.toolbar.submenu')
    .evaluate((el) => el.getBoundingClientRect().height);
  check(railRow < 56, `the rail tools fit in one row (${Math.round(railRow)}px tall)`);

  // With a tool, one finger builds and a second finger turns it into a camera gesture instead.
  await page.getByRole('button', { name: /^Build railway/ }).tap();
  const money = () => page.locator('.money').innerText();
  const m0 = await money();
  before = await cam();
  await gesture(cdp, [
    ...path(6, (t) => [{ x: cx - 80, y: lerp(cy, cy + 30, t) }]),
    ...path(10, (t) => [
      { x: cx - 80, y: cy + 30 },
      { x: lerp(cx + 40, cx + 120, t), y: cy + 30 },
    ]),
  ]);
  after = await cam();
  await page.waitForTimeout(500);
  check((await money()) === m0, 'a second finger cancels the track being dragged');
  check(Math.abs(after.distance - before.distance) > 0.5, 'and zooms instead');
  // On open ground, so the game has nothing to refuse.
  const ends = await page.evaluate(() => {
    const ts = (window as unknown as { transportsim: Hook }).transportsim;
    const c = ts.findClear(ts.spawn.x, ts.spawn.y, 8, 3);
    if (!c) return null;
    ts.view({ x: c.x + 4, y: c.y + 1, distance: 30 });
    return [ts.tileToScreen(c.x, c.y + 1), ts.tileToScreen(c.x + 7, c.y + 1)];
  });
  const m1 = await money();
  if (ends) {
    const [a, b] = ends as [{ x: number; y: number }, { x: number; y: number }];
    await gesture(
      cdp,
      path(8, (t) => [{ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) }]),
    );
  }
  await page.waitForTimeout(800);
  check((await money()) !== m1, 'one-finger drag with the rail tool builds track');
  await page.screenshot({ path: `${outDir}/portrait-built.png` });

  await page.getByRole('button', { name: /^Build railway/ }).tap();
  check(
    (await page.locator('.tool-btn.active:not(.menu-btn)').count()) === 0,
    'tapping the active tool puts it away',
  );

  // With no tool, a tap opens what is under the finger: look at the biggest town and tap its middle.
  await page.getByRole('button', { name: 'Menu' }).tap();
  await page.getByRole('button', { name: /Find/ }).tap();
  const first = page.locator('.window table.vlist tbody tr').first();
  const town = (await first.locator('td').first().innerText()).trim();
  await first.getByRole('button', { name: 'Locate' }).tap();
  await closeWindows();
  await page.waitForTimeout(500);
  await gesture(cdp, [[{ x: W / 2, y: H / 2 }]]);
  await page.waitForTimeout(300);
  check(
    (await page.locator('.window', { hasText: town }).count()) > 0,
    `tapping a town opens it (${town})`,
  );
  await closeWindows();

  await page.setViewportSize({ width: H, height: W });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${outDir}/landscape-game.png` });
  await noHorizontalOverflow(page, 'landscape HUD');
  const hudBottom = await page
    .locator('.hud-top')
    .evaluate((el) => el.getBoundingClientRect().bottom);
  check(hudBottom < 60, `landscape: the top bar is one row (${Math.round(hudBottom)}px tall)`);
  await page.getByRole('button', { name: 'Menu' }).tap();
  await page.getByRole('button', { name: /Graphs/ }).tap();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/landscape-window.png` });
  await noHorizontalOverflow(page, 'landscape window');
  const win = await page.locator('.window').evaluate((el) => el.getBoundingClientRect().width);
  check(
    win <= H * 0.55,
    `landscape: a window leaves most of the map in view (${Math.round(win)} of ${H}px)`,
  );
} finally {
  await browser.close();
  server.kill();
  if (process.platform === 'win32' && server.pid)
    spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { stdio: 'ignore' });
}
console.log(failures ? `${failures} check(s) failed` : 'all phone checks passed');
process.exit(failures ? 1 : 0);
