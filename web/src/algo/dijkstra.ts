import type { Graph } from '../graph/graph';

/** Indexed binary min-heap over node ids keyed by Float64 priorities. */
export class MinHeap {
  private heap: Int32Array;
  private pos: Int32Array;
  private key: Float64Array;
  size = 0;
  constructor(n: number) {
    this.heap = new Int32Array(n);
    this.pos = new Int32Array(n).fill(-1);
    this.key = new Float64Array(n);
  }
  clear() {
    for (let i = 0; i < this.size; i++) this.pos[this.heap[i]] = -1;
    this.size = 0;
  }
  has(v: number) { return this.pos[v] >= 0; }
  topKey(): number { return this.key[this.heap[0]]; }
  /** Insert or decrease key. */
  push(v: number, k: number) {
    let i = this.pos[v];
    if (i < 0) {
      i = this.size++;
      this.heap[i] = v;
      this.pos[v] = i;
      this.key[v] = k;
    } else {
      if (k >= this.key[v]) return;
      this.key[v] = k;
    }
    this.up(i);
  }
  pop(): number {
    const top = this.heap[0];
    this.pos[top] = -1;
    this.size--;
    if (this.size > 0) {
      const last = this.heap[this.size];
      this.heap[0] = last;
      this.pos[last] = 0;
      this.down(0);
    }
    return top;
  }
  private up(i: number) {
    const h = this.heap, p = this.pos, k = this.key;
    const v = h[i], kv = k[v];
    while (i > 0) {
      const par = (i - 1) >> 1;
      const pv = h[par];
      if (k[pv] <= kv) break;
      h[i] = pv; p[pv] = i;
      i = par;
    }
    h[i] = v; p[v] = i;
  }
  private down(i: number) {
    const h = this.heap, p = this.pos, k = this.key, n = this.size;
    const v = h[i], kv = k[v];
    for (;;) {
      let c = 2 * i + 1;
      if (c >= n) break;
      if (c + 1 < n && k[h[c + 1]] < k[h[c]]) c++;
      if (k[h[c]] >= kv) break;
      h[i] = h[c]; p[h[c]] = i;
      i = c;
    }
    h[i] = v; p[v] = i;
  }
}

export interface DijkstraResult {
  dist: Float64Array;
  /** index into sources array (or -1) */
  label: Int32Array;
  /** predecessor node (-1 for sources) */
  pred: Int32Array;
  /** nodes touched by the last run (enables O(touched) reset instead of O(n) fill) */
  touched?: Int32Array;
  touchedCount?: number;
}

export function makeBuffer(n: number): DijkstraResult {
  return { dist: new Float64Array(n).fill(Infinity), label: new Int32Array(n).fill(-1), pred: new Int32Array(n).fill(-1), touched: new Int32Array(n), touchedCount: 0 };
}

export interface DijkstraOptions {
  /** Only traverse nodes whose mask value equals `maskValue` (used for cluster-restricted searches). */
  mask?: Int32Array;
  maskValue?: number;
  /** Stop relaxing beyond this distance. */
  cutoff?: number;
  /** Reusable buffers */
  out?: DijkstraResult;
  heap?: MinHeap;
  /** Record visiting order into this array; returns count in `visitedCount`. */
  order?: Int32Array;
}

export const counters = { calls: 0, visited: 0 };

/** Multi-source Dijkstra on an undirected CSR graph. */
export function dijkstra(g: Graph, sources: ArrayLike<number>, opts: DijkstraOptions = {}): DijkstraResult & { visitedCount: number } {
  const n = g.n;
  const res = opts.out ?? { dist: new Float64Array(n), label: new Int32Array(n), pred: new Int32Array(n) };
  const { dist, label, pred, touched } = res;
  if (touched && res.touchedCount !== undefined) {
    for (let i = 0; i < res.touchedCount; i++) { const v = touched[i]; dist[v] = Infinity; label[v] = -1; pred[v] = -1; }
  } else {
    dist.fill(Infinity);
    label.fill(-1);
    pred.fill(-1);
  }
  let nt = 0;
  const heap = opts.heap ?? new MinHeap(n);
  heap.clear();
  const mask = opts.mask, mv = opts.maskValue ?? 0;
  const cutoff = opts.cutoff ?? Infinity;
  for (let s = 0; s < sources.length; s++) {
    const v = sources[s];
    if (mask && mask[v] !== mv) continue;
    if (dist[v] === 0) continue;
    dist[v] = 0;
    label[v] = s;
    if (touched) touched[nt++] = v;
    heap.push(v, 0);
  }
  const { offsets, adjNode, adjW } = g;
  let visited = 0;
  while (heap.size > 0) {
    const u = heap.pop();
    const du = dist[u];
    if (opts.order) opts.order[visited] = u;
    visited++;
    for (let i = offsets[u]; i < offsets[u + 1]; i++) {
      const v = adjNode[i];
      if (mask && mask[v] !== mv) continue;
      const nd = du + adjW[i];
      if (nd < dist[v] && nd <= cutoff) {
        if (touched && dist[v] === Infinity) touched[nt++] = v;
        dist[v] = nd;
        label[v] = label[u];
        pred[v] = u;
        heap.push(v, nd);
      }
    }
  }
  if (touched) res.touchedCount = nt;
  counters.calls++; counters.visited += visited;
  return { ...res, visitedCount: visited };
}

export function argmaxFinite(dist: Float64Array, mask?: Int32Array, mv = 0): number {
  let best = -1, bd = -1;
  for (let i = 0; i < dist.length; i++) {
    if (mask && mask[i] !== mv) continue;
    const d = dist[i];
    if (d !== Infinity && d > bd) { bd = d; best = i; }
  }
  return best;
}
