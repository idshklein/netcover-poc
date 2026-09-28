import type { Graph } from '../graph/graph';
import { dijkstra, makeBuffer, MinHeap, type DijkstraResult } from './dijkstra';

export type Objective = 'minimax' | 'minisum';

export interface Clusters {
  k: number;
  offsets: Int32Array;
  nodes: Int32Array;
}

/** Group nodes by label (counting sort). */
export function groupClusters(label: Int32Array, k: number): Clusters {
  const n = label.length;
  const counts = new Int32Array(k + 1);
  for (let i = 0; i < n; i++) if (label[i] >= 0) counts[label[i] + 1]++;
  for (let c = 0; c < k; c++) counts[c + 1] += counts[c];
  const fill = counts.slice(0, k);
  const nodes = new Int32Array(counts[k]);
  for (let i = 0; i < n; i++) if (label[i] >= 0) nodes[fill[label[i]]++] = i;
  return { k, offsets: counts, nodes };
}

export interface CenterContext {
  g: Graph;
  heap: MinHeap;
  buf: DijkstraResult;
  /** Assignment of every node to its current nearest center (from multi-source Dijkstra). */
  assign: DijkstraResult;
  clusters: Clusters;
  exactLimit: number;
  maxIter: number;
}

export function makeContext(g: Graph, assign: DijkstraResult, k: number, exactLimit = 120, maxIter = 12): CenterContext {
  return {
    g,
    heap: new MinHeap(g.n),
    buf: makeBuffer(g.n),
    assign,
    clusters: groupClusters(assign.label, k),
    exactLimit,
    maxIter,
  };
}

const EPS = 1e-6;

/** Best node of cluster `c` (currently centred at `cur`) under the objective. Returns node id. */
export function relocate(ctx: CenterContext, c: number, cur: number, objective: Objective): number {
  const { clusters } = ctx;
  const start = clusters.offsets[c], end = clusters.offsets[c + 1];
  const size = end - start;
  if (size <= 1) return cur;
  if (size <= ctx.exactLimit) return exactCenter(ctx, c, cur, objective);
  return objective === 'minimax' ? lazyOneCenter(ctx, c, cur) : centroidWalkMedian(ctx, c, cur);
}

function exactCenter(ctx: CenterContext, c: number, cur: number, objective: Objective): number {
  const { g, clusters, assign, heap, buf } = ctx;
  const start = clusters.offsets[c], end = clusters.offsets[c + 1];
  const members = clusters.nodes.subarray(start, end);
  let best = cur, bestVal = evalFromDist(assign.dist, members, objective);
  for (let i = 0; i < members.length; i++) {
    const s = members[i];
    if (s === cur) continue;
    dijkstra(g, [s], { mask: assign.label, maskValue: c, heap, out: buf });
    const val = evalFromDist(buf.dist, members, objective);
    if (val < bestVal - EPS) { bestVal = val; best = s; }
  }
  return best;
}

function evalFromDist(dist: Float64Array, members: Int32Array, objective: Objective): number {
  let acc = 0;
  if (objective === 'minimax') {
    for (let i = 0; i < members.length; i++) { const d = dist[members[i]]; if (d > acc) acc = d; }
  } else {
    for (let i = 0; i < members.length; i++) acc += dist[members[i]];
  }
  return acc;
}

/**
 * Exact-terminating 1-center with lazy lower bounds:
 * keep a set of "extreme" members E; lb(v) = max_{e in E} d(e,v) <= ecc(v).
 * Stop when min lb >= best ecc found. Distances are in the full graph (as in the
 * reference implementation), searches are cut off at the incumbent eccentricity.
 */
function lazyOneCenter(ctx: CenterContext, c: number, cur: number): number {
  const { g, clusters, assign, heap, buf, maxIter } = ctx;
  const start = clusters.offsets[c], end = clusters.offsets[c + 1];
  const members = clusters.nodes.subarray(start, end);
  const lb = new Float64Array(members.length); // lower bound on ecc, indexed like members

  let best = cur;
  let bestEcc = 0, farthest = -1;
  for (let i = 0; i < members.length; i++) {
    const d = assign.dist[members[i]];
    if (d > bestEcc) { bestEcc = d; farthest = members[i]; }
  }
  let cand = cur;
  for (let it = 0; it < maxIter && farthest >= 0; it++) {
    // add the farthest member from the candidate to the extreme set
    dijkstra(g, [farthest], { heap, out: buf, cutoff: bestEcc });
    let minLb = Infinity, minIdx = -1;
    for (let i = 0; i < members.length; i++) {
      const d = buf.dist[members[i]];
      const b = d === Infinity ? bestEcc + 1 : d;
      if (b > lb[i]) lb[i] = b;
      if (lb[i] < minLb) { minLb = lb[i]; minIdx = i; }
    }
    if (minLb >= bestEcc - EPS) break; // incumbent is optimal
    cand = members[minIdx];
    // evaluate candidate eccentricity in the full graph, bounded by the incumbent
    dijkstra(g, [cand], { heap, out: buf, cutoff: bestEcc });
    let ecc = 0; farthest = -1;
    for (let i = 0; i < members.length; i++) {
      const d = buf.dist[members[i]];
      if (d === Infinity) { ecc = Infinity; farthest = members[i]; break; }
      if (d > ecc) { ecc = d; farthest = members[i]; }
    }
    if (ecc === Infinity) {
      // candidate is worse than the incumbent: the unreached member becomes the next
      // extreme point, which lifts lb(cand) above bestEcc on the next round
      lb[minIdx] = bestEcc + 1;
      continue;
    }
    if (ecc < bestEcc - EPS) { bestEcc = ecc; best = cand; }
    else lb[minIdx] = Math.max(lb[minIdx], ecc); // tie: keep incumbent
  }
  return best;
}

/**
 * 1-median heuristic: walk from the current center along the shortest-path tree
 * toward the subtree that contains more than half of the members (tree centroid),
 * then verify with a restricted Dijkstra. Repeats a few times.
 */
function centroidWalkMedian(ctx: CenterContext, c: number, cur: number): number {
  const { g, clusters, assign, heap, buf } = ctx;
  const start = clusters.offsets[c], end = clusters.offsets[c + 1];
  const members = clusters.nodes.subarray(start, end);
  const size = members.length;
  let bestSum = 0;
  for (let i = 0; i < size; i++) bestSum += assign.dist[members[i]];
  let best = cur;
  let tree: DijkstraResult = assign;
  const sub = new Map<number, number>();
  const order = Array.from(members);
  for (let it = 0; it < 4; it++) {
    // subtree sizes: process members by decreasing distance
    order.sort((a, b) => tree.dist[b] - tree.dist[a]);
    sub.clear();
    for (const v of order) sub.set(v, (sub.get(v) ?? 0) + 1);
    for (const v of order) {
      const p = tree.pred[v];
      if (p >= 0 && assign.label[p] === c) sub.set(p, (sub.get(p) ?? 0) + sub.get(v)!);
    }
    // walk from the root into the heavy child while it holds > half
    let m = best;
    for (;;) {
      let heavy = -1, hs = size / 2;
      for (let i = g.offsets[m]; i < g.offsets[m + 1]; i++) {
        const w = g.adjNode[i];
        if (assign.label[w] !== c || tree.pred[w] !== m) continue;
        const s = sub.get(w) ?? 0;
        if (s > hs) { hs = s; heavy = w; }
      }
      if (heavy < 0) break;
      m = heavy;
    }
    if (m === best) break;
    dijkstra(g, [m], { heap, out: buf, mask: assign.label, maskValue: c });
    let sum = 0;
    for (let i = 0; i < size; i++) { const d = buf.dist[members[i]]; sum += d === Infinity ? 1e12 : d; }
    if (sum < bestSum - EPS) {
      bestSum = sum; best = m;
      tree = { dist: buf.dist.slice(), label: buf.label, pred: buf.pred.slice() };
    } else break;
  }
  return best;
}
