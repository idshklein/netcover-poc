// Browser e2e smoke test using the locally installed Edge: node scripts/e2e.mjs [place] [type] [r]
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

const place = process.argv[2] ?? 'Tel Aviv-Yafo';
const type = process.argv[3] ?? 'walk';
const r = process.argv[4] ?? '500';
const algo = process.argv[5] ?? 'pullseed';
const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const outDir = path.join(root, 'scripts', 'shots');
fs.mkdirSync(outDir, { recursive: true });

const server = spawn('npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { cwd: root, shell: true, stdio: 'pipe' });
await new Promise((res, rej) => {
  server.stdout.on('data', (d) => { if (String(d).includes('4173')) res(); });
  server.stderr.on('data', (d) => { console.error(String(d)); });
  server.on('exit', (c) => rej(new Error(`vite preview exited ${c}`)));
});
const cleanup = () => { try { spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { shell: true }); } catch { /* ignore */ } };

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(`${m.type()}: ${m.text()}`); });
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));

const url = `http://localhost:4173/?place=${encodeURIComponent(place)}&type=${type}&r=${r}&algo=${algo}&auto=1`;
console.log('open', url);
await page.goto(url);
await page.waitForFunction(() => window.__netcover?.graph, null, { timeout: 600000 });
console.log('graph built:', await page.evaluate(() => JSON.stringify(window.__netcover.stats.final)));
await page.screenshot({ path: path.join(outDir, '1-network.png') });
await page.waitForFunction(() => window.__netcover?.steps?.length > 0, null, { timeout: 900000 });
await page.waitForTimeout(2500);
console.log('run status:', await page.textContent('#runStatus'));
await page.screenshot({ path: path.join(outDir, '2-final.png') });
// walk a few steps
const n = await page.evaluate(() => window.__netcover.steps.length);
for (const [i, frac] of [[3, 0.02], [4, 0.15], [5, 0.5]]) {
  await page.evaluate((idx) => { const s = document.getElementById('slider'); s.value = String(idx); s.dispatchEvent(new Event('input')); }, Math.floor(n * frac));
  await page.waitForTimeout(1500);
  console.log('step', Math.floor(n * frac), await page.textContent('#stepLabel'), '|', await page.textContent('#stepNote'));
  await page.screenshot({ path: path.join(outDir, `${i}-step.png`) });
}
// zoom in on a detail with distance colouring
await page.evaluate(() => { const s = document.getElementById('colorMode'); s.value = 'distance'; s.dispatchEvent(new Event('change')); });
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(outDir, '6-distance.png') });
console.log('console issues:', errors.length ? errors.slice(0, 10) : 'none');
await browser.close();
cleanup();
setTimeout(() => process.exit(0), 500);
