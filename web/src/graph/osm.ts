import { buildCSR, type EdgeInput, type Graph } from './graph';
import { haversine, polylineLength, splitPolyline } from './geo';
import type { OverpassJson, OsmNode, OsmWay } from './overpass';

export interface BuildOptions {
  /** merge interstitial (degree-2) nodes into single edges, like osmnx.simplify_graph */
  simplify: boolean;
  /** merge nodes closer than this many meters (0 = off), like osmnx.consolidate_intersections */
  consolidateTolerance: number;
  /** split edges so no edge is longer than this (0 = off), like sfnetworks::st_network_blend of sampled points */
  segmentLength: number;
  /** keep only the largest connected component */
  largestComponent: boolean;
}

export interface BuildStats {
  raw: { n: number; m: number };
  simplified: { n: number; m: number };
  consolidated: { n: number; m: number };
  component: { n: number; m: number; components: number };
  final: { n: number; m: number };
  totalKm: number;
}

interface Work {
  lon: number[];
  lat: number[];
  osmId: number[];
  edges: EdgeInput[];
}

export function buildGraph(osm: OverpassJson, opts: BuildOptions, log: (s: string) => void = () => {}): { graph: Graph; stats: BuildStats } {
  log('פענוח תגובת Overpass…');
  let w = parse(osm);
  const stats: BuildStats = {
    raw: { n: w.lon.length, m: w.edges.length },
    simplified: { n: 0, m: 0 }, consolidated: { n: 0, m: 0 }, component: { n: 0, m: 0, components: 0 }, final: { n: 0, m: 0 }, totalKm: 0,
  };
  if (opts.simplify) { log('פישוט טופולוגי (מיזוג צמתי-ביניים)…'); w = simplify(w); }
  stats.simplified = { n: usedNodes(w), m: w.edges.length };
  if (opts.consolidateTolerance > 0) { log(`איחוד צמתים במרחק ≤ ${opts.consolidateTolerance} מ'…`); w = consolidate(w, opts.consolidateTolerance); }
  stats.consolidated = { n: usedNodes(w), m: w.edges.length };
  const comps = countComponents(w);
  if (opts.largestComponent) { log('שמירת הרכיב הקשיר הגדול…'); w = largestComponent(w); }
  stats.component = { n: usedNodes(w), m: w.edges.length, components: comps };
  if (opts.segmentLength > 0) { log(`חלוקת קשתות למקטעים של ≤ ${opts.segmentLength} מ'…`); w = segmentize(w, opts.segmentLength); }
  w = compact(w);
  stats.final = { n: w.lon.length, m: w.edges.length };
  stats.totalKm = w.edges.reduce((s, e) => s + e.len, 0) / 1000;
  const graph = buildCSR(w.lon.length, Float64Array.from(w.lon), Float64Array.from(w.lat), w.edges, Float64Array.from(w.osmId));
  return { graph, stats };
}

function usedNodes(w: Work): number {
  const seen = new Uint8Array(w.lon.length);
  let c = 0;
  for (const e of w.edges) { if (!seen[e.u]) { seen[e.u] = 1; c++; } if (!seen[e.v]) { seen[e.v] = 1; c++; } }
  return c;
}

function parse(osm: OverpassJson): Work {
  const nodeIdx = new Map<number, number>();
  const lon: number[] = [], lat: number[] = [], osmId: number[] = [];
  const ways: OsmWay[] = [];
  for (const el of osm.elements) {
    if (el.type === 'node') {
      const nd = el as OsmNode;
      nodeIdx.set(nd.id, lon.length);
      lon.push(nd.lon); lat.push(nd.lat); osmId.push(nd.id);
    } else if (el.type === 'way') ways.push(el as OsmWay);
  }
  const edges: EdgeInput[] = [];
  for (const way of ways) {
    for (let i = 1; i < way.nodes.length; i++) {
      const u = nodeIdx.get(way.nodes[i - 1]), v = nodeIdx.get(way.nodes[i]);
      if (u === undefined || v === undefined || u === v) continue;
      const len = haversine(lon[u], lat[u], lon[v], lat[v]);
      edges.push({ u, v, geom: [lon[u], lat[u], lon[v], lat[v]], len });
    }
  }
  return { lon, lat, osmId, edges };
}

/** Adjacency lists (edge indices) for a Work graph. */
function incidence(w: Work): Int32Array[] {
  const inc: Int32Array[] = new Array(w.lon.length);
  const deg = new Int32Array(w.lon.length);
  for (const e of w.edges) { deg[e.u]++; deg[e.v]++; }
  for (let i = 0; i < inc.length; i++) inc[i] = new Int32Array(deg[i]);
  deg.fill(0);
  w.edges.forEach((e, i) => { inc[e.u][deg[e.u]++] = i; inc[e.v][deg[e.v]++] = i; });
  return inc;
}

/** osmnx-style simplification: merge chains through degree-2 nodes into single edges. */
function simplify(w: Work): Work {
  const n = w.lon.length;
  const inc = incidence(w);
  const isEndpoint = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const d = inc[i].length;
    if (d !== 2) { isEndpoint[i] = 1; continue; }
    const e0 = w.edges[inc[i][0]], e1 = w.edges[inc[i][1]];
    if (e0.u === e0.v || e1.u === e1.v) isEndpoint[i] = 1; // self-loop
    else if (inc[i][0] === inc[i][1]) isEndpoint[i] = 1;
  }
  const used = new Uint8Array(w.edges.length);
  const out: EdgeInput[] = [];
  const walk = (start: number, firstEdge: number) => {
    const geom: number[] = [w.lon[start], w.lat[start]];
    let len = 0;
    let cur = start, e = firstEdge;
    for (;;) {
      used[e] = 1;
      const ed = w.edges[e];
      const next = ed.u === cur ? ed.v : ed.u;
      appendGeom(geom, ed, cur === ed.u);
      len += ed.len;
      cur = next;
      if (isEndpoint[cur] || cur === start) break;
      const nx = inc[cur][0] === e ? inc[cur][1] : inc[cur][0];
      if (used[nx]) break;
      e = nx;
    }
    out.push({ u: start, v: cur, geom, len });
  };
  for (let i = 0; i < n; i++) {
    if (!isEndpoint[i]) continue;
    for (const e of inc[i]) if (!used[e]) walk(i, e);
  }
  // pure cycles without endpoints
  for (let e = 0; e < w.edges.length; e++) {
    if (!used[e]) { const s = w.edges[e].u; isEndpoint[s] = 1; walk(s, e); }
  }
  return { lon: w.lon, lat: w.lat, osmId: w.osmId, edges: out };
}

function appendGeom(geom: number[], e: EdgeInput, forward: boolean) {
  const g = e.geom;
  if (forward) for (let i = 2; i < g.length; i++) geom.push(g[i]);
  else for (let i = g.length - 4; i >= 0; i -= 2) geom.push(g[i], g[i + 1]);
}

/** Merge nodes within `tol` meters (grid hashing + union-find), moving them to the cluster centroid. */
function consolidate(w: Work, tol: number): Work {
  const n = w.lon.length;
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const union = (a: number, b: number) => { a = find(a); b = find(b); if (a !== b) parent[a] = b; };
  const midLat = w.lat.reduce((s, v) => s + v, 0) / n;
  const dLat = tol / 110570, dLon = tol / (111320 * Math.cos(midLat * Math.PI / 180));
  const cells = new Map<string, number[]>();
  const key = (i: number, dx = 0, dy = 0) => `${Math.floor(w.lon[i] / dLon) + dx},${Math.floor(w.lat[i] / dLat) + dy}`;
  for (let i = 0; i < n; i++) { const k = key(i); (cells.get(k) ?? cells.set(k, []).get(k)!).push(i); }
  for (let i = 0; i < n; i++) {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const bucket = cells.get(key(i, dx, dy));
      if (!bucket) continue;
      for (const j of bucket) if (j > i && haversine(w.lon[i], w.lat[i], w.lon[j], w.lat[j]) <= tol) union(i, j);
    }
  }
  const root = new Int32Array(n);
  const cnt = new Map<number, number>();
  for (let i = 0; i < n; i++) { root[i] = find(i); cnt.set(root[i], (cnt.get(root[i]) ?? 0) + 1); }
  const lon = w.lon.slice(), lat = w.lat.slice();
  const sx = new Float64Array(n), sy = new Float64Array(n);
  for (let i = 0; i < n; i++) { sx[root[i]] += w.lon[i]; sy[root[i]] += w.lat[i]; }
  for (const [r, c] of cnt) { lon[r] = sx[r] / c; lat[r] = sy[r] / c; }
  const edges: EdgeInput[] = [];
  for (const e of w.edges) {
    const u = root[e.u], v = root[e.v];
    const geom = e.geom.slice();
    geom[0] = lon[u]; geom[1] = lat[u]; geom[geom.length - 2] = lon[v]; geom[geom.length - 1] = lat[v];
    const len = polylineLength(geom);
    if (u === v && len < 2 * tol) continue;
    edges.push({ u, v, geom, len });
  }
  return { lon, lat, osmId: w.osmId, edges };
}

function componentsOf(w: Work): { comp: Int32Array; count: number; sizes: number[] } {
  const n = w.lon.length;
  const inc = incidence(w);
  const comp = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (comp[s] >= 0 || inc[s].length === 0) continue;
    const c = sizes.length; sizes.push(0);
    stack.push(s); comp[s] = c;
    while (stack.length) {
      const u = stack.pop()!; sizes[c]++;
      for (const e of inc[u]) { const ed = w.edges[e]; const v = ed.u === u ? ed.v : ed.u; if (comp[v] < 0) { comp[v] = c; stack.push(v); } }
    }
  }
  return { comp, count: sizes.length, sizes };
}

function countComponents(w: Work): number { return componentsOf(w).count; }

function largestComponent(w: Work): Work {
  const { comp, sizes } = componentsOf(w);
  let best = 0;
  sizes.forEach((s, i) => { if (s > sizes[best]) best = i; });
  return { ...w, edges: w.edges.filter((e) => comp[e.u] === best) };
}

function segmentize(w: Work, maxLen: number): Work {
  const lon = w.lon.slice(), lat = w.lat.slice(), osmId = w.osmId.slice();
  const edges: EdgeInput[] = [];
  for (const e of w.edges) {
    const parts = Math.ceil(e.len / maxLen);
    if (parts <= 1) { edges.push(e); continue; }
    const pieces = splitPolyline(e.geom, parts);
    let prev = e.u;
    for (let i = 0; i < pieces.length; i++) {
      const g = pieces[i];
      let nxt: number;
      if (i === pieces.length - 1) nxt = e.v;
      else { nxt = lon.length; lon.push(g[g.length - 2]); lat.push(g[g.length - 1]); osmId.push(0); }
      edges.push({ u: prev, v: nxt, geom: g, len: polylineLength(g) });
      prev = nxt;
    }
  }
  return { lon, lat, osmId, edges };
}

/** Drop unreferenced nodes and renumber. */
function compact(w: Work): Work {
  const used = new Int32Array(w.lon.length).fill(-1);
  let k = 0;
  for (const e of w.edges) { if (used[e.u] < 0) used[e.u] = k++; if (used[e.v] < 0) used[e.v] = k++; }
  const lon = new Array<number>(k), lat = new Array<number>(k), osmId = new Array<number>(k);
  for (let i = 0; i < used.length; i++) if (used[i] >= 0) { lon[used[i]] = w.lon[i]; lat[used[i]] = w.lat[i]; osmId[used[i]] = w.osmId[i]; }
  return { lon, lat, osmId, edges: w.edges.map((e) => ({ ...e, u: used[e.u], v: used[e.v] })) };
}
