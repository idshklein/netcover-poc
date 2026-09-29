import { NetMap, type ColorMode } from './map';
import type { Graph } from './graph/graph';
import type { BuildOptions, BuildStats } from './graph/osm';
import { geocodePlace, buildQuery, fetchOverpass, bboxAreaKm2, type NetworkType, type Area, type OverpassJson } from './graph/overpass';
import { loadCityManifest, loadCityOsm } from './graph/citycache';
import { DEFAULT_PARAMS, type Params, type Step } from './algo/algorithms';
import type { WorkerIn, WorkerOut } from './worker';
import { cacheGet, cacheSet, cacheClear } from './cache';
import { clusterColor } from './palette';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const val = (id: string) => ($(id) as HTMLInputElement | HTMLSelectElement).value;
const num = (id: string) => Number(val(id));
const chk = (id: string) => ($(id) as HTMLInputElement).checked;

const netMap = new NetMap('map');

// ---------------- worker ----------------
let worker: Worker;
let graph: Graph | null = null;
let stats: BuildStats | null = null;
let steps: Step[] = [];
let current = 0;
let manualNodes: number[] = [];
let assignReq = 0;
const assignCache = new Map<number, { label: Int32Array; dist: Float64Array }>();
let pendingStep = -1;

function newWorker() {
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<WorkerOut>) => handle(ev.data);
  worker.onerror = (e) => { setStatus('runStatus', `שגיאת worker: ${e.message}`); setBusy(false); };
}
const send = (m: WorkerIn) => worker.postMessage(m);
newWorker();

function handle(m: WorkerOut) {
  switch (m.type) {
    case 'log': setStatus('netStatus', m.msg); break;
    case 'built': onBuilt(m.graph, m.stats); break;
    case 'progress':
      setStatus('runStatus', m.phase.startsWith('חישוב') ? m.phase : `צעד ${m.step} · k=${m.k} · מרחק מקס' ${fmt(m.maxDist)} מ' · ${m.phase}`);
      break;
    case 'done': onDone(m.steps, m.ms); break;
    case 'assign': onAssign(m.id, m.label, m.dist); break;
    case 'error': setStatus('runStatus', `שגיאה: ${m.msg}`); setBusy(false); break;
  }
}

// ---------------- network download ----------------
$('download').onclick = () => download().catch((e) => { setStatus('netStatus', `שגיאה: ${e.message}`); setBusy(false); });
$('clearCache').onclick = async () => { await cacheClear(); setStatus('netStatus', 'המטמון נוקה'); };
$('areaMode').onchange = () => {
  const mode = val('areaMode');
  $('place').parentElement!.classList.toggle('hidden', mode !== 'place');
  $('citySelect').parentElement!.classList.toggle('hidden', mode !== 'city');
  $('cityHint').classList.toggle('hidden', mode !== 'city');
  const netType = $('netType') as HTMLSelectElement;
  if (mode === 'city') { netType.value = 'walk'; netType.disabled = true; } else { netType.disabled = false; }
};
loadCityManifest().then((m) => {
  if (!m.length) return; // manifest missing (e.g. dev before running scripts/build-city-cache.ts)
  const known = new Set(m.map((c) => c.slug));
  for (const opt of Array.from(($('citySelect') as HTMLSelectElement).options)) opt.disabled = !known.has(opt.value);
});

async function download() {
  setBusy(true);
  showWarn('netWarn', null);
  $('netStats').classList.add('hidden');
  const type = val('netType') as NetworkType;
  let area: Area;
  let bbox: [number, number, number, number];
  let osm: OverpassJson | undefined;
  if (val('areaMode') === 'city') {
    const slug = val('citySelect');
    setStatus('netStatus', 'טוען קובץ שמור…');
    const manifest = await loadCityManifest();
    const entry = manifest.find((c) => c.slug === slug);
    if (!entry) throw new Error(`אין קובץ שמור עבור "${slug}" — הריצו scripts/build-city-cache.ts`);
    bbox = entry.bbox;
    area = { kind: 'bbox', west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3] };
    netMap.setArea(null);
    netMap.map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 30, duration: 500 });
    osm = await loadCityOsm(slug);
    setStatus('netStatus', `נטען מקובץ שמור: ${osm.elements.length.toLocaleString()} אלמנטים (${entry.name})`);
  } else if (val('areaMode') === 'place') {
    setStatus('netStatus', 'מחפש את המקום ב-Nominatim…');
    const geo = await geocodePlace(val('place'));
    area = geo.area; bbox = geo.bbox;
    setStatus('netStatus', `נמצא: ${geo.displayName}`);
    netMap.setArea(area.kind === 'polygon'
      ? { type: 'FeatureCollection', features: area.rings.map((r) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: [...r, r[0]] } })) }
      : null);
    netMap.map.fitBounds([[bbox[0], bbox[1]], [bbox[2], bbox[3]]], { padding: 30, duration: 500 });
  } else {
    bbox = netMap.viewBbox();
    area = { kind: 'bbox', west: bbox[0], south: bbox[1], east: bbox[2], north: bbox[3] };
    netMap.setArea(null);
  }
  const km2 = bboxAreaKm2(bbox);
  if (km2 > 150) showWarn('netWarn', `שטח התיבה ~${Math.round(km2)} קמ"ר – הורדה ועיבוד עלולים להימשך זמן רב (ורשת ה-walk גדולה במיוחד). מומלץ שטח < 100 קמ"ר, או drive/bike.`);
  if (!osm) {
    const query = buildQuery(area, type);
    osm = await cacheGet<OverpassJson>(query);
    if (osm) setStatus('netStatus', 'נטען מהמטמון המקומי');
    else {
      const t = performance.now();
      osm = await fetchOverpass(query, (s) => setStatus('netStatus', s));
      setStatus('netStatus', `הורדו ${osm.elements.length.toLocaleString()} אלמנטים ב-${((performance.now() - t) / 1000).toFixed(1)} ש'`);
      await cacheSet(query, osm);
    }
  }
  const opts: BuildOptions = {
    simplify: chk('simplify'),
    consolidateTolerance: num('consolidate'),
    segmentLength: num('segment'),
    largestComponent: chk('largest'),
  };
  send({ type: 'build', osm, opts });
}

function onBuilt(g: Graph, s: BuildStats) {
  graph = g; stats = s;
  steps = []; assignCache.clear(); manualNodes = []; netMap.setManual([]);
  $('timeline').classList.add('hidden');
  netMap.setGraph(g);
  const rows: Array<[string, string]> = [
    ['גולמי (צמתים / קשתות)', `${s.raw.n.toLocaleString()} / ${s.raw.m.toLocaleString()}`],
    ['אחרי פישוט', `${s.simplified.n.toLocaleString()} / ${s.simplified.m.toLocaleString()}`],
    ['אחרי איחוד צמתים', `${s.consolidated.n.toLocaleString()} / ${s.consolidated.m.toLocaleString()}`],
    ['רכיבים קשירים', `${s.component.components.toLocaleString()}`],
    ['סופי (צמתים / קשתות)', `${s.final.n.toLocaleString()} / ${s.final.m.toLocaleString()}`],
    ['אורך כולל', `${s.totalKm.toFixed(1)} ק"מ`],
  ];
  const tbl = $('netStats');
  tbl.innerHTML = rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('');
  tbl.classList.remove('hidden');
  setStatus('netStatus', 'הרשת מוכנה');
  ($('run') as HTMLButtonElement).disabled = false;
  setBusy(false);
  estimateRuntime();
}

// ---------------- runtime estimate ----------------
function estimateRuntime() {
  if (!graph || !stats) return;
  const r = num('radius');
  const algo = val('algorithm');
  const nm = graph.n + graph.m;
  // rough: k ≈ covered area / (2 r²); pull&seed ≈ 4 steps per center, each ≈ 5 Dijkstra-equivalents
  const km2 = stats.totalKm * 1000 * 60 / 1e6; // proxy for area: total length × 60 m corridor
  const kEst = Math.max(1, km2 * 1e6 / (2 * r * r));
  const perDij = nm * 1.5e-7;
  let sec = 0;
  if (algo === 'pullseed') sec = 4 * kEst * 5 * perDij;
  else if (algo === 'gonzalez') sec = kEst * perDij;
  else if (algo === 'lscp') sec = num('candidateCap') * perDij * 0.2 + kEst * perDij;
  else sec = 30 * 5 * perDij;
  const msgs: string[] = [];
  if (graph.n > 60000) msgs.push(`הרשת גדולה (${graph.n.toLocaleString()} צמתים).`);
  if (sec > 60) msgs.push(`הערכת זמן ריצה ~${Math.round(sec)} ש' (סדר גודל). אפשר להגדיל את r או את אורך המקטע, לצמצם שטח, לבחור drive, או להגדיל את תקציב הזמן.`);
  else if (sec > 15) msgs.push(`הערכת זמן ריצה ~${Math.round(sec)} ש'.`);
  showWarn('runWarn', msgs.length ? msgs.join(' ') : null);
}
for (const id of ['radius', 'algorithm', 'candidateCap', 'segment']) $(id).addEventListener('change', estimateRuntime);

// ---------------- run ----------------
$('algorithm').onchange = () => { syncAlgoUI(); estimateRuntime(); };
$('init').onchange = syncAlgoUI;
function syncAlgoUI() {
  const algo = val('algorithm');
  const init = val('init');
  $('manualHint').classList.toggle('hidden', init !== 'manual');
  ($('k') as HTMLInputElement).disabled = !(init === 'random' || algo === 'fixedk');
  ($('init') as HTMLSelectElement).disabled = algo === 'lscp';
  ($('objective') as HTMLSelectElement).disabled = !(algo === 'pullseed' || algo === 'fixedk' || chk('postPull'));
}
$('postPull').onchange = syncAlgoUI;
syncAlgoUI();

netMap.onClick = (lng, lat) => {
  if (val('init') !== 'manual' || !graph) return;
  const v = netMap.nearestNode(lng, lat);
  if (v >= 0 && !manualNodes.includes(v)) { manualNodes.push(v); netMap.setManual(manualNodes); $('manualCount').textContent = String(manualNodes.length); }
};
$('manualClear').onclick = () => { manualNodes = []; netMap.setManual([]); $('manualCount').textContent = '0'; };

$('run').onclick = () => {
  if (!graph) return;
  const params: Params = {
    ...DEFAULT_PARAMS,
    algorithm: val('algorithm') as Params['algorithm'],
    radius: num('radius'),
    objective: val('objective') as Params['objective'],
    init: val('init') as Params['init'],
    k: num('k'),
    manualNodes: [...manualNodes],
    exactLimit: num('exactLimit'),
    candidateCap: num('candidateCap'),
    postPull: chk('postPull'),
    postPrune: chk('postPrune'),
    timeBudgetMs: num('budget') * 1000,
    seed: num('seed'),
  };
  if (params.init === 'manual' && manualNodes.length === 0) { setStatus('runStatus', 'בחרו לפחות מוקד אחד על המפה'); return; }
  setBusy(true);
  ($('cancel') as HTMLButtonElement).disabled = false;
  steps = []; assignCache.clear();
  stopPlay();
  setStatus('runStatus', 'מריץ…');
  send({ type: 'run', params });
};

$('cancel').onclick = () => {
  worker.terminate();
  newWorker();
  if (graph) send({ type: 'graph', graph });
  setBusy(false);
  setStatus('runStatus', 'ההרצה בוטלה');
};

function onDone(s: Step[], ms: number) {
  steps = s;
  setBusy(false);
  const last = s[s.length - 1];
  const nAdds = s.filter((x) => x.kind === 'add').length, nMoves = s.filter((x) => x.kind === 'move').length, nStuck = s.filter((x) => x.kind === 'stuck').length;
  setStatus('runStatus', `הסתיים ב-${(ms / 1000).toFixed(1)} ש' · ${s.length} צעדים (${nMoves} משיכות, ${nStuck} היתקעויות, ${nAdds} הוספות) · ${last.centers.length} מוקדים · מרחק מקס' ${fmt(last.maxDist)} מ'`);
  const slider = $('slider') as HTMLInputElement;
  slider.max = String(s.length - 1);
  $('timeline').classList.remove('hidden');
  $('legend').classList.remove('hidden');
  drawChart();
  goTo(s.length - 1);
}

// ---------------- timeline ----------------
let playTimer: number | null = null;
$('slider').oninput = () => goTo(Number(val('slider')));
$('first').onclick = () => goTo(0);
$('last').onclick = () => goTo(steps.length - 1);
$('prev').onclick = () => goTo(current - 1);
$('next').onclick = () => goTo(current + 1);
$('play').onclick = () => (playTimer ? stopPlay() : startPlay());
$('speed').oninput = () => { if (playTimer) { stopPlay(); startPlay(); } };
$('colorMode').onchange = () => rerender();
$('showMoves').onchange = () => rerender();
document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  if (e.key === 'ArrowLeft') goTo(current + 1); // RTL: left = forward
  else if (e.key === 'ArrowRight') goTo(current - 1);
  else if (e.key === ' ') { e.preventDefault(); (playTimer ? stopPlay() : startPlay()); }
});

function startPlay() {
  if (!steps.length) return;
  if (current >= steps.length - 1) goTo(0);
  $('play').textContent = '⏸';
  const tick = () => {
    if (current >= steps.length - 1) { stopPlay(); return; }
    if (pendingStep < 0) goTo(current + 1);
    playTimer = window.setTimeout(tick, 1000 / num('speed'));
  };
  playTimer = window.setTimeout(tick, 1000 / num('speed'));
}
function stopPlay() {
  if (playTimer) { clearTimeout(playTimer); playTimer = null; }
  $('play').textContent = '▶';
}

function goTo(i: number) {
  if (!steps.length) return;
  i = Math.max(0, Math.min(steps.length - 1, i));
  current = i;
  ($('slider') as HTMLInputElement).value = String(i);
  const st = steps[i];
  $('stepLabel').textContent = `צעד ${i}/${steps.length - 1} · ${kindName(st.kind)}`;
  $('stepNote').textContent = st.note;
  $('stepStats').innerHTML =
    `<span>מוקדים <b>${st.centers.length}</b></span>` +
    `<span>מרחק מקס' <b>${fmt(st.maxDist)}</b> מ'</span>` +
    `<span>מרחק ממוצע <b>${fmt(st.meanDist)}</b> מ'</span>` +
    `<span>צמתים מכוסים (≤ r) <b>${(st.covered * 100).toFixed(1)}%</b></span>` +
    `<span>זמן <b>${(st.elapsedMs / 1000).toFixed(1)}</b> ש'</span>`;
  updateChartCursor();
  const cached = assignCache.get(i);
  if (cached) { pendingStep = -1; render(st, cached.label, cached.dist); }
  else { pendingStep = i; assignReq++; send({ type: 'assign', centers: st.centers, id: assignReq * 100000 + i }); }
}

function onAssign(id: number, label: Int32Array, dist: Float64Array) {
  const i = id % 100000;
  if (assignCache.size > 60) assignCache.delete(assignCache.keys().next().value!);
  assignCache.set(i, { label, dist });
  if (i === current) { pendingStep = -1; render(steps[i], label, dist); }
}

function render(st: Step, label: Int32Array, dist: Float64Array) {
  netMap.renderStep(st, label, dist, val('colorMode') as ColorMode, num('radius'), chk('showMoves'));
  updateLegend(st);
}
function rerender() { if (steps.length) goTo(current); }

function kindName(k: Step['kind']) {
  return { init: 'אתחול', move: 'משיכת מוקדים', stuck: 'היתקעות', add: 'הוספת מוקד', remove: 'הסרת מוקד', final: 'סיום', abort: 'עצירה' }[k];
}

function updateLegend(st: Step) {
  const mode = val('colorMode');
  const r = num('radius');
  let html = '';
  if (mode === 'cluster') {
    html += `<div class="item"><b>${st.centers.length} אשכולות</b> (צבע לפי מוקד)</div>`;
    html += `<div class="item">${Array.from({ length: Math.min(st.centers.length, 24) }, (_, i) => `<span class="sw" style="background:${clusterColor(i)}"></span>`).join('')}${st.centers.length > 24 ? '…' : ''}</div>`;
  } else {
    html += `<div class="item"><span class="sw" style="background:rgb(26,152,80)"></span>0 מ' &nbsp; <span class="sw" style="background:rgb(255,255,191)"></span>${r} מ' (r) &nbsp; <span class="sw" style="background:rgb(215,48,39)"></span>≥ ${Math.round(1.5 * r)} מ'</div>`;
  }
  html += `<div class="item"><span class="sw" style="background:rgba(204,0,0,0.35)"></span>קשת לא מכוסה (> r)</div>`;
  html += `<div class="item"><span class="sw" style="border:3px solid #d7191c;background:none"></span>הצומת הרחוק ביותר &nbsp; <span class="sw" style="border:3px solid #111;background:none"></span>מוקד שנוסף/הוסר &nbsp; <span class="sw" style="border:1.5px dashed #111;background:none"></span>תזוזה</div>`;
  $('legend').innerHTML = html;
}

// ---------------- chart ----------------
function drawChart() {
  const svg = $('chart');
  const W = 600, H = 90, padL = 36, padR = 30, padT = 6, padB = 14;
  const n = steps.length;
  const r = num('radius');
  const maxD = Math.max(r * 1.1, ...steps.map((s) => s.maxDist));
  const maxK = Math.max(1, ...steps.map((s) => s.centers.length));
  const x = (i: number) => padL + (n > 1 ? (i / (n - 1)) * (W - padL - padR) : 0);
  const yD = (d: number) => padT + (1 - d / maxD) * (H - padT - padB);
  const yK = (k: number) => padT + (1 - k / maxK) * (H - padT - padB);
  const dPath = steps.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yD(s.maxDist).toFixed(1)}`).join(' ');
  const kPath = steps.map((s, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${yK(s.centers.length).toFixed(1)}`).join(' ');
  const adds = steps.map((s, i) => (s.kind === 'add' ? `<circle cx="${x(i).toFixed(1)}" cy="${yK(s.centers.length).toFixed(1)}" r="2" fill="#0b5cad"/>` : '')).join('');
  svg.innerHTML =
    `<line x1="${padL}" x2="${W - padR}" y1="${yD(r)}" y2="${yD(r)}" stroke="#d73027" stroke-dasharray="4 3"/>` +
    `<path d="${dPath}" fill="none" stroke="#d73027" stroke-width="1.5"/>` +
    `<path d="${kPath}" fill="none" stroke="#0b5cad" stroke-width="1.5"/>${adds}` +
    `<text x="2" y="${padT + 8}" font-size="9" fill="#d73027">${fmt(maxD)}</text>` +
    `<text x="2" y="${yD(r) - 2}" font-size="9" fill="#d73027">r=${r}</text>` +
    `<text x="${W - padR + 3}" y="${padT + 8}" font-size="9" fill="#0b5cad">k=${maxK}</text>` +
    `<text x="${padL}" y="${H - 3}" font-size="9" fill="#666">0</text><text x="${W - padR - 20}" y="${H - 3}" font-size="9" fill="#666">${n - 1}</text>` +
    `<line id="cursor" x1="${padL}" x2="${padL}" y1="${padT}" y2="${H - padB}" stroke="#333" stroke-width="1"/>`;
  svg.onclick = (e) => {
    const rect = svg.getBoundingClientRect();
    const px = ((e.clientX - rect.left) / rect.width) * W;
    goTo(Math.round(((px - padL) / (W - padL - padR)) * (n - 1)));
  };
}
function updateChartCursor() {
  const c = document.getElementById('cursor');
  if (!c) return;
  const W = 600, padL = 36, padR = 30, n = steps.length;
  const xx = padL + (n > 1 ? (current / (n - 1)) * (W - padL - padR) : 0);
  c.setAttribute('x1', String(xx)); c.setAttribute('x2', String(xx));
}

// ---------------- export ----------------
$('exportGeo').onclick = () => {
  if (!graph || !steps.length) return;
  const st = steps[current];
  const a = assignCache.get(current);
  if (!a) return;
  const g = graph;
  const features: GeoJSON.Feature[] = [];
  st.centers.forEach((v, i) => features.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [g.lon[v], g.lat[v]] }, properties: { kind: 'center', idx: i, node: v, osm_id: g.osmId[v] || null } }));
  for (let e = 0; e < g.m; e++) {
    const geom = g.egeom[e];
    const coords: number[][] = [];
    for (let i = 0; i < geom.length; i += 2) coords.push([geom[i], geom[i + 1]]);
    const u = g.eu[e], v = g.ev[e];
    features.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: coords }, properties: { kind: 'edge', u, v, length_m: Math.round(g.elen[e] * 10) / 10, cluster: a.label[a.dist[u] <= a.dist[v] ? u : v], dist_u: Math.round(a.dist[u]), dist_v: Math.round(a.dist[v]), covered: Math.min(a.dist[u], a.dist[v]) <= num('radius') } });
  }
  saveFile(`netcover_step${current}.geojson`, JSON.stringify({ type: 'FeatureCollection', features }));
};
$('exportSteps').onclick = () => {
  if (!graph || !steps.length) return;
  const g = graph;
  const out = steps.map((s, i) => ({ step: i, kind: s.kind, note: s.note, maxDist: s.maxDist, meanDist: s.meanDist, covered: s.covered, elapsedMs: s.elapsedMs,
    centers: Array.from(s.centers, (v) => ({ node: v, lon: g.lon[v], lat: g.lat[v], osm_id: g.osmId[v] || null })), moved: s.moved, added: s.added, removed: s.removed }));
  saveFile('netcover_steps.json', JSON.stringify(out));
};
function saveFile(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------- helpers ----------------
function setStatus(id: string, s: string) { $(id).textContent = s; }
function showWarn(id: string, s: string | null) { const el = $(id); el.textContent = s ?? ''; el.classList.toggle('hidden', !s); }
function setBusy(b: boolean) {
  ($('download') as HTMLButtonElement).disabled = b;
  ($('run') as HTMLButtonElement).disabled = b || !graph;
  ($('cancel') as HTMLButtonElement).disabled = !b;
}
function fmt(x: number) { return Math.round(x).toLocaleString('en-US'); }

// ---------------- URL parameters (shareable demos): ?place=…&type=walk&r=500&algo=pullseed&segment=150&auto=1 ----------------
(function applyUrlParams() {
  const q = new URLSearchParams(location.search);
  const setIf = (id: string, key: string) => { const v = q.get(key); if (v !== null) ($(id) as HTMLInputElement).value = v; };
  setIf('place', 'place'); setIf('netType', 'type'); setIf('radius', 'r'); setIf('algorithm', 'algo'); setIf('segment', 'segment');
  setIf('objective', 'objective'); setIf('init', 'init'); setIf('k', 'k'); setIf('consolidate', 'consolidate');
  if (q.get('prune') === '1') ($('postPrune') as HTMLInputElement).checked = true;
  if (q.get('pull') === '1') ($('postPull') as HTMLInputElement).checked = true;
  syncAlgoUI();
  if (q.get('auto') === '1') {
    netMap.whenReady().then(async () => {
      await download().catch((e) => setStatus('netStatus', `שגיאה: ${e.message}`));
      const wait = () => new Promise<void>((res) => { const t = setInterval(() => { if (graph && !($('run') as HTMLButtonElement).disabled) { clearInterval(t); res(); } }, 200); });
      await wait();
      $('run').click();
    });
  }
})();
// expose state for e2e tests / console exploration
Object.defineProperty(window, '__netcover', { get: () => ({ graph, stats, steps, current }) });
