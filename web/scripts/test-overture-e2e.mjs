// Smoke test for the Overture-Maps-based network download (replaces the old Overpass path):
// opens the app with ?place=...&type=...&auto=1, waits for the graph to build, and prints stats.
// Usage: npx tsx scripts/test-overture-e2e.mjs [place] [type]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';

const place = process.argv[2] ?? 'Raanana, Israel';
const type = process.argv[3] ?? 'walk';
const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const baseUrl = process.env.E2E_URL;
const server = baseUrl ? null : spawn('npx', ['vite', 'preview', '--port', '4174', '--strictPort'], { cwd: root, shell: true, stdio: 'pipe' });
if (server) {
  await new Promise((res, rej) => {
    server.stdout.on('data', (d) => { if (String(d).includes('4174')) res(); });
    server.stderr.on('data', (d) => console.error(String(d)));
    server.on('exit', (c) => rej(new Error(`vite preview exited ${c}`)));
  });
}
const cleanup = () => { if (server) { try { spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { shell: true }); } catch { /* ignore */ } } };

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
page.on('console', (m) => console.log(`[console:${m.type()}]`, m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

try {
  const url = baseUrl ? `${baseUrl}?place=${encodeURIComponent(place)}&type=${type}` : `http://localhost:4174/?place=${encodeURIComponent(place)}&type=${type}`;
  console.log('open', url);
  await page.goto(url);
  await page.click('#download');
  await page.waitForFunction(() => window.__netcover?.graph, null, { timeout: 480000 });
  const stats = await page.evaluate(() => window.__netcover.stats);
  console.log('OK — graph built:', JSON.stringify(stats.final), 'total km', stats.totalKm.toFixed(1));
  if (stats.final.n < 10 || stats.final.m < 10) throw new Error('graph too small — Overture conversion likely broken');
} finally {
  await browser.close();
  cleanup();
}
