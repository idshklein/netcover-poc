// End-to-end data path in Node: geocode → Overpass → build graph → run algorithm.
// npx tsx scripts/test-osm.ts "Tel Aviv-Yafo" drive 500
import fs from 'node:fs';
import { geocodePlace, buildQuery, fetchOverpass, type NetworkType, type OverpassJson } from '../src/graph/overpass';
import { buildGraph } from '../src/graph/osm';
import { run, DEFAULT_PARAMS } from '../src/algo/algorithms';

const place = process.argv[2] ?? 'Tel Aviv-Yafo';
const type = (process.argv[3] ?? 'drive') as NetworkType;
const radius = Number(process.argv[4] ?? 500);
const cacheFile = new URL(`./.cache_${place.replace(/\W+/g, '_')}_${type}.json`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

let osm: OverpassJson;
if (fs.existsSync(cacheFile)) osm = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
else {
  const geo = await geocodePlace(place);
  console.log('geocoded:', geo.displayName, geo.area.kind, geo.area.kind === 'polygon' ? geo.area.rings.map((r) => r.length) : '');
  const q = buildQuery(geo.area, type);
  console.log('query length', q.length);
  const t = performance.now();
  osm = await fetchOverpass(q, (s) => console.log(' ', s));
  console.log('elements', osm.elements.length, 'in', Math.round(performance.now() - t), 'ms');
  fs.writeFileSync(cacheFile, JSON.stringify(osm));
}
const t0 = performance.now();
const { graph, stats } = buildGraph(osm, { simplify: true, consolidateTolerance: 0, segmentLength: 150, largestComponent: true }, (s) => console.log(' ', s));
console.log('build ms', Math.round(performance.now() - t0), stats);
for (const algorithm of ['pullseed', 'gonzalez', 'lscp'] as const) {
  const t = performance.now();
  let lastLog = 0;
  const steps = run(graph, { ...DEFAULT_PARAMS, algorithm, radius, timeBudgetMs: 600000 }, (i) => {
    if (performance.now() - lastLog > 5000) { lastLog = performance.now(); console.log('   ', algorithm, 'step', i.step, 'k', i.k, 'max', Math.round(i.maxDist)); }
  });
  const last = steps[steps.length - 1];
  console.log(algorithm, 'ms', Math.round(performance.now() - t), 'steps', steps.length, 'k', last.centers.length, 'max', Math.round(last.maxDist), 'mean', Math.round(last.meanDist), last.kind);
}
