// Quick sanity/perf check on a synthetic grid: npx tsx scripts/test-grid.ts
import { buildCSR, type EdgeInput } from '../src/graph/graph';
import { run, DEFAULT_PARAMS } from '../src/algo/algorithms';
import { counters } from '../src/algo/dijkstra';
import { buildGraph } from '../src/graph/osm';

const N = Number(process.argv[2] ?? 80);
const spacing = 0.0009; // ~100 m
const lon = new Float64Array(N * N), lat = new Float64Array(N * N);
const edges: EdgeInput[] = [];
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const id = i * N + j;
  lon[id] = 34.75 + j * spacing; lat[id] = 32.05 + i * spacing;
}
const len = 100;
for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
  const id = i * N + j;
  if (j + 1 < N && Math.random() > 0.15) edges.push({ u: id, v: id + 1, geom: [lon[id], lat[id], lon[id + 1], lat[id + 1]], len });
  if (i + 1 < N && Math.random() > 0.15) edges.push({ u: id, v: id + N, geom: [lon[id], lat[id], lon[id + N], lat[id + N]], len });
}
// use osm builder to test simplify/largest component on the same data
const osm = {
  elements: [
    ...Array.from({ length: N * N }, (_, id) => ({ type: 'node' as const, id: id + 1, lon: lon[id], lat: lat[id] })),
    ...edges.map((e, i) => ({ type: 'way' as const, id: i + 1, nodes: [e.u + 1, e.v + 1] })),
  ],
};
const t0 = performance.now();
const { graph, stats } = buildGraph(osm, { simplify: true, consolidateTolerance: 0, segmentLength: 60, largestComponent: true }, (s) => console.log(' ', s));
console.log('build ms', Math.round(performance.now() - t0), stats);
void buildCSR;

const only = process.argv[3];
for (const algorithm of ['pullseed', 'gonzalez', 'lscp', 'fixedk'] as const) {
  if (only && algorithm !== only) continue;
  const t = performance.now();
  const steps = run(graph, { ...DEFAULT_PARAMS, algorithm, radius: 500, k: 20, exactLimit: Number(process.env.EXACT ?? 120), postPrune: algorithm === 'gonzalez' }, () => {});
  const last = steps[steps.length - 1];
  const kinds = steps.reduce((m, s) => (m[s.kind] = (m[s.kind] ?? 0) + 1, m), {} as Record<string, number>);
  console.log(algorithm, 'ms', Math.round(performance.now() - t), 'steps', steps.length, kinds, 'k', last.centers.length, 'max', Math.round(last.maxDist), 'mean', Math.round(last.meanDist), 'dijkstra calls', counters.calls, 'visited', counters.visited);
  counters.calls = 0; counters.visited = 0;
}
