/**
 * Compact undirected weighted spatial graph in CSR form.
 * Edge lengths are meters (haversine along geometry).
 */
export interface Graph {
  n: number;
  lon: Float64Array;
  lat: Float64Array;
  /** CSR: neighbors of node i are adjNode[offsets[i] .. offsets[i+1]) */
  offsets: Int32Array;
  adjNode: Int32Array;
  adjEdge: Int32Array;
  adjW: Float64Array;
  m: number;
  eu: Int32Array;
  ev: Int32Array;
  elen: Float64Array;
  /** flat [lon,lat,...] geometry per edge, oriented u->v */
  egeom: Float64Array[];
  /** original OSM node ids (0 for synthetic nodes) */
  osmId: Float64Array;
}

export interface EdgeInput {
  u: number;
  v: number;
  geom: number[];
  len: number;
}

export function buildCSR(
  n: number,
  lon: Float64Array,
  lat: Float64Array,
  edges: EdgeInput[],
  osmId?: Float64Array,
): Graph {
  const m = edges.length;
  const deg = new Int32Array(n);
  for (const e of edges) {
    deg[e.u]++;
    deg[e.v]++;
  }
  const offsets = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) offsets[i + 1] = offsets[i] + deg[i];
  const fill = offsets.slice(0, n);
  const adjNode = new Int32Array(offsets[n]);
  const adjEdge = new Int32Array(offsets[n]);
  const adjW = new Float64Array(offsets[n]);
  const eu = new Int32Array(m), ev = new Int32Array(m), elen = new Float64Array(m);
  const egeom: Float64Array[] = new Array(m);
  edges.forEach((e, i) => {
    eu[i] = e.u; ev[i] = e.v; elen[i] = e.len; egeom[i] = Float64Array.from(e.geom);
    adjNode[fill[e.u]] = e.v; adjEdge[fill[e.u]] = i; adjW[fill[e.u]++] = e.len;
    adjNode[fill[e.v]] = e.u; adjEdge[fill[e.v]] = i; adjW[fill[e.v]++] = e.len;
  });
  return { n, lon, lat, offsets, adjNode, adjEdge, adjW, m, eu, ev, elen, egeom, osmId: osmId ?? new Float64Array(n) };
}

/** Serializable form for postMessage (no methods, typed arrays transfer cheaply). */
export type GraphMessage = Graph;

export function degree(g: Graph, i: number): number {
  return g.offsets[i + 1] - g.offsets[i];
}
