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
  // Players join without a company; the company window opens so they can found or join one.
  const companyWin = a.locator('.window', { hasText: 'Found a company' });
  await companyWin.waitFor({ timeout: 5000 });
  check(true, 'company window opens for a player without a company');
  await companyWin.getByRole('textbox', { name: 'Company name' }).fill('Alice Rail');
  await companyWin.getByRole('button', { name: 'Found', exact: true }).click();
  await a.locator('.money').waitFor({ timeout: 5000 });
  check((await a.locator('.hud-box').first().innerText()).includes('Alice Rail'), 'founded a company');
  await a.locator('.window button[aria-label="Close"]').click();
  await a.waitForTimeout(4000);
  await a.screenshot({ path: `${outDir}/02-game.png` });
  const chunks = Number((await a.locator('.statusbar').innerText()).match(/(\d+) chunks/)?.[1] ?? 0);
  check(chunks > 0, `terrain chunks rendered (${chunks})`);

  type Hook = {
    spawn: { x: number; y: number };
    view(v: object): void;
    tileToScreen(x: number, y: number): { x: number; y: number };
    command(cmd: object): Promise<{ ok: boolean; error?: string }>;
    findClear(x: number, y: number, w: number, h: number): { x: number; y: number } | null;
  };
  const hook = <T>(fn: (h: Hook, arg: never) => T, arg?: unknown) =>
    a.evaluate(([f, x]) => new Function('h', 'arg', `return (${f})(h, arg)`)((window as unknown as { transportsim: Hook }).transportsim, x), [fn.toString(), arg] as const) as Promise<T>;
  const spawn = await hook((h) => h.spawn);
  // Money for the building below, whatever the land costs to level.
  await hook((h) => h.command({ type: 'loan', action: 'borrow', amount: 500_000 }));
  // Raise terrain on clear land near the start
  const clearSpot = await hook((h, s: { x: number; y: number }) => h.findClear(s.x + 6, s.y + 6, 8, 8), spawn);
  if (clearSpot) await hook((h, s: { x: number; y: number }) => h.view({ x: s.x + 4, y: s.y + 4 }), clearSpot);
  await a.waitForTimeout(1500);
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
  await hook((h, s: { x: number; y: number }) => h.view({ x: s.x, y: s.y, yaw: 0.6, pitch: 0.75, distance: 30 }), spawn);
  await a.waitForTimeout(3000);
  await a.screenshot({ path: `${outDir}/02b-town.png` });
  // Find a spot near the spawn town that can be levelled (no houses or roads in the way).
  let sx = spawn.x;
  let sy = spawn.y;
  let level: { ok: boolean; error?: string } = { ok: false, error: 'no spot found' };
  for (const [dx, dy] of [[24, 0], [-24, 0], [0, 24], [0, -24], [30, 30], [-30, -30], [40, 0]] as const) {
    level = await hook(
      (h, s: { x: number; y: number }) =>
        h.command({ type: 'terraform', x0: s.x - 14, y0: s.y - 8, x1: s.x + 14, y1: s.y + 10, mode: 'level', level: 4 }),
      { x: spawn.x + dx, y: spawn.y + dy },
    );
    if (level.ok) {
      sx = spawn.x + dx;
      sy = spawn.y + dy;
      break;
    }
  }
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
  // Station over part of the straight line (2 platforms × 5), depot at its west end.
  const clickTile = async (x: number, y: number) => {
    const p = await hook((h, t: number[]) => h.tileToScreen(t[0]!, t[1]!), [x, y]);
    await a.mouse.move(p.x, p.y, { steps: 3 });
    await a.waitForTimeout(300);
    await a.mouse.down();
    await a.mouse.up();
    await a.waitForTimeout(800);
  };
  await a.keyboard.press('Digit6');
  const beforeStation = await a.locator('.money').innerText();
  await clickTile(sx - 2, sy - 4);
  await a.keyboard.press('Digit7');
  await clickTile(sx - 11, sy - 4);
  await a.waitForTimeout(1200);
  const afterStation = await a.locator('.money').innerText();
  check(beforeStation !== afterStation, `building a station and depot cost money (${beforeStation} → ${afterStation})`);
  check((await a.locator('.label.station').count()) >= 1, 'station label shown');
  if (beforeStation === afterStation) console.log('  toasts:', await a.locator('.toast').allInnerTexts());
  // Second station further east, then buy a train in the depot and give it orders — all via the UI.
  await a.keyboard.press('Digit6');
  await clickTile(sx + 5, sy - 4);
  // A one-way signal on the line between the depot and the first station.
  await a.keyboard.press('Digit9');
  const beforeSignal = await a.locator('.money').innerText();
  await clickTile(sx - 6, sy - 4);
  await a.waitForTimeout(800);
  check(beforeSignal !== (await a.locator('.money').innerText()), 'placed a signal');
  await a.keyboard.press('Escape');
  await clickTile(sx - 11, sy - 4);
  const depotWin = a.locator('.window', { hasText: 'Train depot' });
  await depotWin.waitFor({ timeout: 5000 });
  await depotWin.getByRole('button', { name: /^Buy for/ }).click();
  await depotWin.getByRole('button', { name: 'Open' }).first().click({ timeout: 5000 });
  const trainWin = a.locator('.window', { has: a.locator('ol.orders') });
  await trainWin.getByRole('button', { name: /Add stations/ }).click();
  await clickTile(sx - 2, sy - 4);
  await clickTile(sx + 7, sy - 4);
  await a.waitForTimeout(600);
  check((await trainWin.locator('ol.orders li').count()) === 2, 'train got two orders by clicking stations');
  await trainWin.getByRole('button', { name: 'Done adding' }).click();
  await trainWin.getByRole('button', { name: '+ Service' }).click();
  await a.waitForTimeout(500);
  check((await trainWin.innerText()).includes('Service at nearest depot'), 'added a depot service order');
  await trainWin.getByRole('button', { name: /Start/ }).click();
  await a.getByRole('button', { name: '4×' }).click();
  await a.waitForTimeout(6000);
  const status = await trainWin.locator('.kv b').first().innerText();
  check(/Heading|Loading at/.test(status), `train is running (${status})`);
  await trainWin.getByRole('button', { name: /Locate/ }).click();
  await hook((h) => h.view({ distance: 7, pitch: 0.55, yaw: 2.2 }));
  await a.waitForTimeout(800);
  await a.waitForTimeout(1500);
  await a.screenshot({ path: `${outDir}/03c-train.png` });
  await a.getByRole('button', { name: '📰 News' }).click();
  const newsWin = a.locator('.window', { hasText: 'News' }).last();
  await a.waitForTimeout(300);
  const newsText = await newsWin.innerText();
  check(newsText.includes('Alice founds Alice Rail'), 'news window lists the company founding');
  check(newsText.includes('first train arrives'), 'news reports the first train at a station');
  await newsWin.locator('button[aria-label="Close"]').click();
  // Books and a loan
  await a.keyboard.press('KeyF');
  const fin = a.locator('.window', { hasText: 'finances' });
  await fin.waitFor({ timeout: 5000 });
  check((await fin.innerText()).includes('Construction'), 'finances window shows the books');
  const money = (s: string) => Number(s.replace(/[^0-9-]/g, ''));
  const beforeLoan = money(await a.locator('.money').innerText());
  await fin.getByRole('button', { name: 'Borrow £10,000' }).click();
  await a.waitForTimeout(600);
  const afterLoan = money(await a.locator('.money').innerText());
  check(afterLoan - beforeLoan > 9000, `borrowed money (${beforeLoan} → ${afterLoan})`);
  await a.screenshot({ path: `${outDir}/03e-finances.png` });
  await fin.locator('button[aria-label="Close"]').click();
  await hook((h, s: { x: number; y: number }) => h.view({ x: s.x - 1, y: s.y - 4, yaw: 0.7, pitch: 0.75, distance: 18 }), { x: sx, y: sy });
  await a.waitForTimeout(2500);
  await a.screenshot({ path: `${outDir}/03b-track.png` });

  // On a fresh levelled area: dig a valley and bridge it, raise a hill and tunnel through it.
  const terra = (x0: number, y0: number, x1: number, y1: number, mode: string, lv?: number) =>
    hook((h, c: object) => h.command(c), { type: 'terraform', x0, y0, x1, y1, mode, level: lv });
  const bx = sx;
  let by = sy + 20;
  for (const oy of [20, -20, 32, -32]) {
    by = sy + oy;
    if ((await terra(bx - 14, by - 6, bx + 14, by + 6, 'level', 4)).ok) break;
  }
  check((await terra(bx - 3, by - 3, bx + 3, by + 3, 'level', 2)).ok, 'dug a valley');
  await terra(bx + 8, by - 3, bx + 12, by + 3, 'raise');
  await terra(bx + 8, by - 3, bx + 12, by + 3, 'raise');
  await hook((h, s: { x: number; y: number }) => h.view({ x: s.x + 4, y: s.y, yaw: 0.25, pitch: 0.95, distance: 30 }), { x: bx, y: by });
  await a.waitForTimeout(2000);
  // Close the train/depot windows so drags start on the map, not on a window.
  while ((await a.locator('.window').count()) > 0) await a.locator('.window button[aria-label="Close"]').first().click();
  await a.keyboard.press('KeyB');
  {
    const p0 = await hook((h, t: number[]) => h.tileToScreen(t[0]!, t[1]!), [bx - 5, by]);
    const p1 = await hook((h, t: number[]) => h.tileToScreen(t[0]!, t[1]!), [bx + 4, by]);
    await a.mouse.move(p0.x, p0.y);
    await a.mouse.down();
    await a.mouse.move(p1.x, p1.y, { steps: 10 });
    await a.waitForTimeout(500);
    await a.mouse.up();
    await a.waitForTimeout(1500);
  }
  await a.keyboard.press('KeyN');
  await clickTile(bx + 6, by);
  await a.keyboard.press('Escape');
  await a.waitForTimeout(1200);
  const tileData = (x: number, y: number) =>
    hook((h, t: number[]) => (h as unknown as { tile(x: number, y: number): { type: number; data: number } }).tile(t[0]!, t[1]!), [x, y]);
  const head = await tileData(bx - 5, by);
  const portal = await tileData(bx + 6, by);
  check(head.type === 2 && (head.data & 0x200) !== 0, 'built a bridge with the bridge tool');
  check(portal.type === 2 && (portal.data & 0x400) !== 0, 'built a tunnel with the tunnel tool');
  if (!(head.data & 0x200) || !(portal.data & 0x400)) console.log('  toasts:', await a.locator('.toast').allInnerTexts());
  await hook((h, s: { x: number; y: number }) => h.view({ x: s.x + 3, y: s.y, yaw: 0.55, pitch: 0.6, distance: 20 }), { x: bx, y: by });
  await a.waitForTimeout(2500);
  await a.screenshot({ path: `${outDir}/03d-structures.png` });

  // --- Feedback round: route joining, one-way signals, crossing, catchment, consist, export ---
  type TileInfo = { type: number; data: number; track: number; signals: number };
  const tileAt = (x: number, y: number) =>
    hook((h, t: number[]) => (h as unknown as { tile(x: number, y: number): TileInfo }).tile(t[0]!, t[1]!), [x, y]);
  await hook((h, s: { x: number; y: number }) => h.view({ x: s.x, y: s.y, yaw: 0.35, pitch: 1.05, distance: 34 }), { x: sx, y: sy });
  await a.waitForTimeout(1500);
  // Rail tools live in the rail menu, which opens when a rail tool is picked.
  await a.keyboard.press('Digit4');
  check(await a.getByRole('toolbar', { name: 'Rail tools' }).isVisible(), 'rail tools are in the rail menu');
  // A curve off the end of the east-west line joins it.
  await dragTiles(sx + 11, sy - 4, sx + 13, sy + 3);
  await a.waitForTimeout(800);
  const joint = await tileAt(sx + 11, sy - 4);
  check(joint.track !== 0, 'dragged route continues the existing line');
  await a.screenshot({ path: `${outDir}/04a-curve.png` });
  // One-way signal
  await a.keyboard.press('Digit9');
  await a.getByLabel('One-way').check();
  await clickTile(sx - 8, sy - 4);
  check(((await tileAt(sx - 8, sy - 4)).signals & 0x1000) !== 0, 'placed a one-way signal');
  await a.getByLabel('One-way').uncheck();
  await a.getByRole('button', { name: 'Path', exact: true }).click();
  await clickTile(sx - 9, sy - 4);
  check((await tileAt(sx - 9, sy - 4)).signals >> 13 === 4, 'placed a path signal');
  await a.getByRole('button', { name: 'Entry', exact: true }).click();
  await clickTile(sx + 3, sy - 4);
  check((await tileAt(sx + 3, sy - 4)).signals >> 13 === 1, 'placed an entry signal');
  await a.getByLabel('Show reservations').check();
  await a.keyboard.press('Escape');
  await a.keyboard.press('KeyP');
  await clickTile(sx - 4, sy - 4);
  check(((await tileAt(sx - 4, sy - 4)).data & 0x800) !== 0, 'built a waypoint');
  await a.keyboard.press('Digit9');
  await hook((h, s: { x: number; y: number }) => h.view({ x: s.x - 7, y: s.y - 4, yaw: 0.5, pitch: 0.6, distance: 9 }), { x: sx, y: sy });
  await a.waitForTimeout(2000);
  await a.screenshot({ path: `${outDir}/04a2-signals.png` });
  await hook((h, s: { x: number; y: number }) => h.view({ x: s.x, y: s.y, yaw: 0.35, pitch: 1.05, distance: 34 }), { x: sx, y: sy });
  await a.waitForTimeout(1000);
  await a.keyboard.press('Escape');
  // Level crossing over a town road
  const spot = await hook((h, s: { x: number; y: number }) => (h as unknown as { findCrossingSpot(x: number, y: number): { x: number; y: number; piece: number } | null }).findCrossingSpot(s.x, s.y), spawn);
  if (spot) {
    const r = await hook((h, c: object) => h.command(c), { type: 'buildTrack', pieces: [spot.x, spot.y, spot.piece] });
    check(r.ok, `built a level crossing${r.ok ? '' : `: ${r.error}`}`);
    await hook((h, s: { x: number; y: number }) => h.view({ x: s.x, y: s.y, yaw: 0.8, pitch: 0.65, distance: 6 }), spot);
    await a.waitForTimeout(2000);
    await a.screenshot({ path: `${outDir}/04b-crossing.png` });
  }
  // Roads: drag a road south of the line, a bus stop on it, a depot beside it, and a one-way piece.
  await hook((h, s: { x: number; y: number }) => h.view({ x: s.x, y: s.y + 6, yaw: 0.35, pitch: 1.05, distance: 26 }), { x: sx, y: sy });
  await a.waitForTimeout(1500);
  await a.keyboard.press('KeyG');
  await dragTiles(sx - 6, sy + 8, sx + 6, sy + 8);
  check((await tileAt(sx, sy + 8)).type === 3, 'built a road with the road tool');
  if ((await tileAt(sx, sy + 8)).type !== 3) console.log('  toasts:', await a.locator('.toast').allInnerTexts(), JSON.stringify(await tileAt(sx, sy + 8)));
  await a.keyboard.press('KeyH');
  await clickTile(sx - 2, sy + 8);
  check((await tileAt(sx - 2, sy + 8)).type === 8, 'built a bus stop');
  await a.keyboard.press('KeyJ');
  await clickTile(sx + 2, sy + 9);
  check((await tileAt(sx + 2, sy + 9)).type === 9, 'built a road depot');
  await a.keyboard.press('KeyK');
  await clickTile(sx + 4, sy + 8);
  check(((await tileAt(sx + 4, sy + 8)).data & 0x10) !== 0, 'made a road one-way');
  await a.keyboard.press('Escape');
  await hook((h, s: { x: number; y: number }) => h.view({ x: s.x, y: s.y + 6.5, yaw: 0.6, pitch: 0.7, distance: 9 }), { x: sx, y: sy });
  await a.waitForTimeout(2000);
  await a.screenshot({ path: `${outDir}/04b2-roads.png` });
  // A bus between two stops on that road.
  await hook((h, s: { x: number; y: number }) => h.view({ x: s.x, y: s.y + 6, yaw: 0.35, pitch: 1.05, distance: 26 }), { x: sx, y: sy });
  await a.waitForTimeout(1200);
  await a.keyboard.press('KeyH');
  await clickTile(sx - 5, sy + 8);
  await a.keyboard.press('Escape');
  await clickTile(sx + 2, sy + 9);
  const roadDepot = a.locator('.window', { hasText: 'Road depot' });
  await roadDepot.getByRole('button', { name: /^Buy for/ }).click();
  await roadDepot.getByRole('button', { name: 'Open' }).first().click({ timeout: 5000 });
  const busWin = a.locator('.window', { has: a.locator('ol.orders') }).last();
  await busWin.getByRole('button', { name: /Add stations/ }).click();
  await clickTile(sx - 2, sy + 8);
  await clickTile(sx - 5, sy + 8);
  await busWin.getByRole('button', { name: 'Done adding' }).click();
  check((await busWin.locator('ol.orders li').count()) === 2, 'bus got two stops');
  if ((await busWin.locator('ol.orders li').count()) !== 2) console.log('  toasts:', await a.locator('.toast').allInnerTexts(), JSON.stringify(await tileAt(sx - 5, sy + 8)), JSON.stringify(await tileAt(sx - 2, sy + 8)));
  await busWin.getByRole('button', { name: /Start/ }).click();
  await a.waitForTimeout(5000);
  const busStatus = await busWin.locator('.kv b').first().innerText();
  check(/Heading|Loading/.test(busStatus), `bus is running (${busStatus})`);
  await hook((h, s: { x: number; y: number }) => h.view({ x: s.x - 3, y: s.y + 8, yaw: 0.6, pitch: 0.7, distance: 8 }), { x: sx, y: sy });
  await a.waitForTimeout(1500);
  await a.screenshot({ path: `${outDir}/04b3-bus.png` });
  while ((await a.locator('.window').count()) > 0) await a.locator('.window button[aria-label="Close"]').first().click();

  // Catchment from the station window
  await hook((h, s: { x: number; y: number }) => h.view({ x: s.x, y: s.y - 4, yaw: 0.35, pitch: 1.0, distance: 30 }), { x: sx, y: sy });
  await a.waitForTimeout(1500);
  await clickTile(sx, sy - 3); // second platform: the running train never covers it
  const stationWin = a.locator('.window', { hasText: 'Catchment' });
  await stationWin.getByRole('button', { name: 'Show catchment area' }).click();
  await a.waitForTimeout(800);
  check((await stationWin.innerText()).includes('residents'), 'station window shows catchment residents');
  await stationWin.locator('details.rating summary').click();
  check((await stationWin.innerText()).includes('Last train called'), 'station window explains its rating');
  await a.screenshot({ path: `${outDir}/04c-catchment.png` });
  await stationWin.getByRole('button', { name: 'Hide catchment area' }).click();
  // Rearrange a parked train's vehicles
  while ((await a.locator('.window').count()) > 0) await a.locator('.window button[aria-label="Close"]').first().click();
  await hook((h) => h.command({ type: 'loan', action: 'borrow', amount: 200_000 }));
  await clickTile(sx - 11, sy - 4);
  const depot2 = a.locator('.window', { hasText: 'Train depot' });
  await depot2.getByRole('button', { name: /^Buy for/ }).click();
  await a.waitForTimeout(600);
  await depot2.getByRole('button', { name: 'Open' }).first().click();
  const parked = a.locator('.window', { hasText: 'Vehicles' }).last();
  const firstBefore = await parked.locator('ol.consist li').nth(0).innerText();
  await parked.locator('ol.consist li').nth(1).getByRole('button', { name: 'Move forward' }).click();
  await parked.getByRole('button', { name: 'Apply' }).click();
  await a.waitForTimeout(800);
  const firstAfter = await parked.locator('ol.consist li').nth(0).innerText();
  check(firstBefore !== firstAfter, `rearranged the train (${firstBefore.split('\n').join(' ')} → ${firstAfter.split('\n').join(' ')})`);
  await a.screenshot({ path: `${outDir}/04d-consist.png` });
  while ((await a.locator('.window').count()) > 0) await a.locator('.window button[aria-label="Close"]').first().click();
  // Export the game as a file
  const [download] = await Promise.all([a.waitForEvent('download', { timeout: 15_000 }), a.getByRole('button', { name: /Export/ }).click()]);
  check(download.suggestedFilename().endsWith('.tsave'), `exported ${download.suggestedFilename()}`);

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

  // Bob founds his own company and asks to use Alice's track; Alice accepts.
  const bobFound = b.locator('.window', { hasText: 'Found a company' });
  await bobFound.getByRole('textbox', { name: 'Company name' }).fill('Bob Lines');
  await bobFound.getByRole('button', { name: 'Found', exact: true }).click();
  await b.locator('.money').waitFor({ timeout: 5000 });
  const bobCo = b.locator('.window', { hasText: 'Track sharing' });
  await bobCo.getByRole('combobox', { name: 'Direction' }).selectOption('guest');
  await bobCo.getByRole('button', { name: 'Propose' }).click();
  await a.getByText('Bob Lines proposes using your track').waitFor({ timeout: 5000 });
  await a.locator('.company-btn').click();
  const aliceCo = a.locator('.window', { hasText: 'Track sharing' });
  await aliceCo.locator('.list-row', { hasText: 'Bob Lines may use our track' }).getByRole('button', { name: 'Accept' }).click();
  await a.waitForTimeout(600);
  check(/Bob Lines may use our track and stations[\s\S]*since/.test(await aliceCo.innerText()), 'track sharing agreement accepted');
  await a.screenshot({ path: `${outDir}/04g-sharing.png` });
  while ((await a.locator('.window').count()) > 0) await a.locator('.window button[aria-label="Close"]').first().click();

  // Bob asks to join Alice's company; Alice accepts him as a manager.
  await b.locator('.window', { hasText: 'Other companies' }).getByRole('button', { name: 'Ask to join' }).click();
  await a.getByText('Bob asks to join').waitFor({ timeout: 5000 });
  await a.locator('.company-btn').click();
  const members = a.locator('.window', { hasText: 'Asking to join' });
  await members.getByRole('combobox', { name: 'Role for Bob' }).selectOption('manager');
  await members.getByRole('button', { name: 'Accept' }).click();
  await b.getByText('You joined Alice Rail as manager').waitFor({ timeout: 5000 });
  check((await b.locator('.hud-box').first().innerText()).includes('Alice Rail'), 'guest joined the host company as a manager');
  await a.screenshot({ path: `${outDir}/04e-company.png` });
  while ((await a.locator('.window').count()) > 0) await a.locator('.window button[aria-label="Close"]').first().click();
  while ((await b.locator('.window').count()) > 0) await b.locator('.window button[aria-label="Close"]').first().click();

  // Chat round trip
  await b.getByPlaceholder(/Say something/).fill('Hello from Bob');
  await b.keyboard.press('Enter');
  await a.waitForTimeout(500);
  check((await a.locator('.chat-log').innerText()).includes('Hello from Bob'), 'chat reaches host');
  await b.getByRole('button', { name: 'All', exact: true }).click();
  await b.getByPlaceholder(/To your company/).fill('Company only');
  await b.keyboard.press('Enter');
  await a.waitForTimeout(500);
  check((await a.locator('.chat-log .company-line').innerText()).includes('Company only'), 'company chat reaches company members');
  await b.screenshot({ path: `${outDir}/04f-chat.png` });

  // A third player joins; the host renames the game and removes them.
  const ctxC = await browser.newContext({ viewport: { width: 1000, height: 700 } });
  const c = await ctxC.newPage();
  await c.goto(`http://localhost:${PORT}/`);
  await c.getByText('Connected').waitFor({ timeout: 10_000 });
  await c.getByPlaceholder('Player name').fill('Carl');
  await c.getByPlaceholder('Game code').fill(code);
  await c.getByRole('button', { name: 'Join by code' }).click();
  await c.getByRole('button', { name: /Start or join a company/ }).waitFor({ timeout: 30_000 });
  await a.getByRole('button', { name: 'Game and players' }).click();
  const gameWin = a.locator('.window', { hasText: 'Players' });
  await gameWin.locator('label.field', { hasText: 'Game name' }).locator('input').fill('Renamed railway');
  await gameWin.getByRole('button', { name: 'Save', exact: true }).click();
  await a.screenshot({ path: `${outDir}/04h-game.png` });
  a.once('dialog', (d) => void d.accept());
  await gameWin.locator('.list-row', { hasText: 'Carl' }).getByRole('button', { name: 'Remove' }).click();
  await c.getByText(/removed you/).waitFor({ timeout: 5000 });
  check(true, 'host removed a player');
  await b.getByRole('button', { name: 'Game and players' }).click();
  await b.waitForTimeout(300);
  check((await b.locator('.window', { hasText: 'Players' }).innerText()).includes('Renamed railway'), 'guest sees the renamed game');
  check(!(await b.locator('.window', { hasText: 'Players' }).innerText()).includes('Carl'), 'removed player is gone from the list');
  await ctxC.close();
  while ((await a.locator('.window').count()) > 0) await a.locator('.window button[aria-label="Close"]').first().click();

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
  // Running costs keep ticking, so allow a small drift between saving and reading the value.
  check(Math.abs(money(resumedMoney) - money(savedMoney)) < Math.max(500, money(savedMoney) * 0.01), `resumed game keeps company money (${savedMoney} → ${resumedMoney})`);
  await a2.screenshot({ path: `${outDir}/06-resumed.png` });

  // Airports need a later start year: a separate game from 1960. One airport is built with the
  // air tool, one by command; an aircraft bought in the hangar flies between them.
  const ctxD = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  const d = await ctxD.newPage();
  lastPage = d;
  d.on('pageerror', (e) => console.log(`[D pageerror] ${e.message}`));
  await d.goto(`http://localhost:${PORT}/`);
  await d.getByText('Connected').waitFor({ timeout: 10_000 });
  await d.getByPlaceholder('Player name').fill('Dana');
  await d.locator('label.field', { hasText: 'Seed' }).locator('input').fill('424242');
  await d.locator('label.field', { hasText: 'Sea level' }).locator('input').fill('0');
  await d.locator('label.field', { hasText: 'Start year' }).locator('input').fill('1960');
  await d.getByRole('button', { name: 'Create game' }).click();
  await d.getByText('Allow autosaves?').waitFor({ timeout: 30_000 });
  await d.getByRole('button', { name: 'Not now' }).click();
  const danaWin = d.locator('.window', { hasText: 'Found a company' });
  await danaWin.getByRole('textbox', { name: 'Company name' }).fill('Dana Air');
  await danaWin.getByRole('button', { name: 'Found', exact: true }).click();
  await d.locator('.money').waitFor({ timeout: 5000 });
  type DHook = { spawn: { x: number; y: number }; view(v: object): void; tileToScreen(x: number, y: number): { x: number; y: number }; command(cmd: object): Promise<{ ok: boolean; error?: string }>; tile(x: number, y: number): { type: number; data: number }; trains(): { id: number; mode?: string }[] };
  const dh = <T>(fn: (h: DHook, arg: never) => T, arg?: unknown) =>
    d.evaluate(([f, x]) => new Function('h', 'arg', `return (${f})(h, arg)`)((window as unknown as { transportsim: DHook }).transportsim, x), [fn.toString(), arg] as const) as Promise<T>;
  const dClick = async (x: number, y: number) => {
    const p = await dh((h, t: number[]) => h.tileToScreen(t[0]!, t[1]!), [x, y]);
    await d.mouse.move(p.x, p.y, { steps: 3 });
    await d.waitForTimeout(300);
    await d.mouse.down();
    await d.mouse.up();
    await d.waitForTimeout(800);
  };
  await dh((h) => h.command({ type: 'loan', action: 'borrow', amount: 600_000 }));
  const dSpawn = await dh((h) => h.spawn);
  const flatSpots: { x: number; y: number }[] = [];
  for (const [dx, dy] of [[14, 0], [-20, 0], [0, 14], [0, -16], [20, 20], [-24, -20], [30, 0], [-30, 10], [10, -30], [-10, 30]] as const) {
    const at = { x: dSpawn.x + dx, y: dSpawn.y + dy };
    const lv = await dh((h, t: { x: number; y: number }) => h.command({ type: 'terraform', x0: t.x - 1, y0: t.y - 1, x1: t.x + 6, y1: t.y + 4, mode: 'level', level: 4 }), at);
    if (lv.ok) flatSpots.push(at);
    if (flatSpots.length === 2) break;
  }
  check(flatSpots.length === 2, `levelled land for two airports (${flatSpots.length})`);
  const [ap1, ap2] = flatSpots;
  if (ap1 && ap2) {
    await dh((h, s: { x: number; y: number }) => h.view({ x: s.x + 2.5, y: s.y + 1.5, yaw: 0.35, pitch: 1.05, distance: 20 }), ap1);
    await d.waitForTimeout(2500);
    await d.getByRole('button', { name: 'Airports tools' }).click();
    await d.keyboard.press('KeyY');
    await dClick(ap1.x, ap1.y);
    check((await dh((h, t: number[]) => h.tile(t[0]!, t[1]!), [ap1.x + 2, ap1.y + 1])).type === 10, 'built an airport with the air tool');
    const built = await dh((h, t: { x: number; y: number }) => h.command({ type: 'buildAirport', x: t.x, y: t.y, kind: 'small' }), ap2);
    check(built.ok, `built a second airport by command${built.ok ? '' : `: ${built.error}`}`);
    await d.keyboard.press('Escape');
    await dClick(ap1.x, ap1.y + 2); // the hangar
    const hangarWin = d.locator('.window', { hasText: 'hangar' });
    await hangarWin.waitFor({ timeout: 5000 });
    await hangarWin.getByRole('button', { name: /^Buy for/ }).click();
    await hangarWin.getByRole('button', { name: 'Open' }).first().click({ timeout: 5000 });
    const planeWin = d.locator('.window', { has: d.locator('ol.orders') }).last();
    const home = (await dh((h, t: number[]) => h.tile(t[0]!, t[1]!), [ap1.x, ap1.y])).data;
    const away = (await dh((h, t: number[]) => h.tile(t[0]!, t[1]!), [ap2.x, ap2.y])).data;
    const planeId = await dh((h) => h.trains().filter((t) => t.mode === 'air').at(-1)?.id ?? -1);
    const r = await dh((h, o: number[]) => h.command({ type: 'setOrders', id: o[0], orders: [{ kind: 'station', station: o[1] }, { kind: 'station', station: o[2] }] }), [planeId, home, away]);
    check(r.ok, `gave the aircraft orders${r.ok ? '' : `: ${r.error}`}`);
    await d.waitForTimeout(800);
    await planeWin.getByRole('button', { name: /Start/ }).click();
    await d.waitForTimeout(6000);
    const planeStatus = await planeWin.locator('.kv b').first().innerText();
    check(/Heading|Loading/.test(planeStatus), `aircraft is flying (${planeStatus})`);
    while ((await d.locator('.window').count()) > 0) await d.locator('.window button[aria-label="Close"]').first().click();
    await dh((h, s: { x: number; y: number }) => h.view({ x: s.x + 2.5, y: s.y + 1.5, yaw: 0.6, pitch: 0.6, distance: 9 }), ap1);
    await d.waitForTimeout(1500);
    await d.screenshot({ path: `${outDir}/07-airport.png` });
  }
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
