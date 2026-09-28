import type { Graph } from '../graph/graph';
import { dijkstra, makeBuffer, MinHeap, type DijkstraResult } from './dijkstra';
import { makeContext, relocate, type Objective } from './center';

export type StepKind = 'init' | 'move' | 'stuck' | 'add' | 'remove' | 'final' | 'abort';

export interface Step {
  kind: StepKind;
  centers: Int32Array;
  maxDist: number;
  meanDist: number;
  /** fraction of nodes within radius r */
  covered: number;
  farthest: number;
  moved?: Array<[number, number]>;
  added?: number[];
  removed?: number[];
  note: string;
  elapsedMs: number;
}

export type InitMode = 'diameter' | 'single' | 'random' | 'manual';

export interface Params {
  algorithm: 'pullseed' | 'gonzalez' | 'lscp' | 'fixedk';
  radius: number;
  objective: Objective;
  init: InitMode;
  k: number;
  manualNodes: number[];
  exactLimit: number;
  candidateCap: number;
  postPull: boolean;
  postPrune: boolean;
  maxSteps: number;
  timeBudgetMs: number;
  seed: number;
}

export const DEFAULT_PARAMS: Params = {
  algorithm: 'pullseed',
  radius: 500,
  objective: 'minimax',
  init: 'diameter',
  k: 5,
  manualNodes: [],
  exactLimit: 120,
  candidateCap: 1500,
  postPull: false,
  postPrune: false,
  maxSteps: 3000,
  timeBudgetMs: 120000,
  seed: 42,
};

export type Progress = (info: { step: number; k: number; maxDist: number; phase: string }) => void;

class Runner {
  g: Graph;
  p: Params;
  steps: Step[] = [];
  heap: MinHeap;
  assign: DijkstraResult;
  t0 = performance.now();
  progress: Progress;
  rng: () => number;

  constructor(g: Graph, p: Params, progress: Progress) {
    this.g = g; this.p = p; this.progress = progress;
    this.heap = new MinHeap(g.n);
    this.assign = { dist: new Float64Array(g.n), label: new Int32Array(g.n), pred: new Int32Array(g.n) };
    this.rng = mulberry32(p.seed);
  }

  elapsed() { return performance.now() - this.t0; }
  outOfBudget() { return this.elapsed() > this.p.timeBudgetMs || this.steps.length >= this.p.maxSteps; }

  assignedFor: Int32Array | null = null;

  assignTo(centers: ArrayLike<number>) {
    if (centers === this.assignedFor) return;
    dijkstra(this.g, centers, { heap: this.heap, out: this.assign });
    this.assignedFor = centers instanceof Int32Array ? centers : null;
  }

  /** Multi-source Dijkstra from centers, then record a step with stats. */
  record(kind: StepKind, centers: Int32Array, note: string, extra: Partial<Step> = {}): Step {
    this.assignTo(centers);
    const { dist } = this.assign;
    let max = 0, sum = 0, far = -1, cov = 0;
    for (let i = 0; i < dist.length; i++) {
      const d = dist[i];
      if (d > max) { max = d; far = i; }
      sum += d;
      if (d <= this.p.radius) cov++;
    }
    const step: Step = {
      kind, centers, maxDist: max, meanDist: sum / dist.length, covered: cov / dist.length,
      farthest: far, note, elapsedMs: this.elapsed(), ...extra,
    };
    this.steps.push(step);
    this.progress({ step: this.steps.length, k: centers.length, maxDist: max, phase: kind });
    return step;
  }

  farthestFrom(sources: ArrayLike<number>): { node: number; dist: number } {
    this.assignTo(sources);
    const d = this.assign.dist;
    let best = -1, bd = -1;
    for (let i = 0; i < d.length; i++) if (d[i] !== Infinity && d[i] > bd) { bd = d[i]; best = i; }
    return { node: best, dist: bd };
  }

  initialCenters(): { centers: number[]; note: string } {
    const { p, g } = this;
    if (p.init === 'manual' && p.manualNodes.length) {
      return { centers: [...new Set(p.manualNodes)], note: `אתחול ידני: ${p.manualNodes.length} מוקדים שנבחרו על המפה` };
    }
    if (p.init === 'random') {
      const k = Math.max(1, Math.min(p.k, g.n));
      const set = new Set<number>();
      while (set.size < k) set.add(Math.floor(this.rng() * g.n));
      return { centers: [...set], note: `אתחול אקראי: ${k} מוקדים` };
    }
    // 2-sweep approximation of the diameter endpoints
    const a0 = this.farthestFrom([0]).node;
    const b = this.farthestFrom([a0]);
    const a = this.farthestFrom([b.node]);
    if (p.init === 'single') {
      // pseudo-center: node minimising max(d(a,·), d(b,·))
      const da = this.assign.dist.slice(); // distances from b.node
      this.assignTo([a.node]);
      const db = this.assign.dist;
      let best = 0, bv = Infinity;
      for (let i = 0; i < g.n; i++) { const v = Math.max(da[i], db[i]); if (v < bv) { bv = v; best = i; } }
      return { centers: [best], note: `אתחול במרכז הגרף המקורב (2-sweep). קוטר משוער ${fmt(a.dist)} מ'` };
    }
    return { centers: [a.node, b.node], note: `אתחול בשני קצות הקוטר המשוער (${fmt(a.dist)} מ'), כמו ביישום הייחוס` };
  }

  /** Labels from the previous pull, used to skip clusters whose membership did not change. */
  prevLabel: Int32Array | null = null;

  /** One Lloyd-style pull: relocate each center inside its cluster. Returns new centers and moved pairs. */
  pullOnce(centers: Int32Array): { next: Int32Array; moved: Array<[number, number]> } {
    this.assignTo(centers);
    const k = centers.length;
    const label = this.assign.label;
    const dirty = new Uint8Array(k);
    if (this.prevLabel) {
      const prev = this.prevLabel;
      for (let i = 0; i < label.length; i++) {
        if (prev[i] !== label[i]) { if (prev[i] >= 0 && prev[i] < k) dirty[prev[i]] = 1; dirty[label[i]] = 1; }
      }
    } else dirty.fill(1);
    const ctx = makeContext(this.g, this.assign, k, this.p.exactLimit);
    const next = new Int32Array(k);
    const moved: Array<[number, number]> = [];
    for (let c = 0; c < k; c++) {
      next[c] = dirty[c] ? relocate(ctx, c, centers[c], this.p.objective) : centers[c];
      if (next[c] !== centers[c]) moved.push([centers[c], next[c]]);
    }
    this.prevLabel = label.slice();
    return { next, moved };
  }

  // ---------------- algorithms ----------------

  pullSeed() {
    const init = this.initialCenters();
    let centers: Int32Array = Int32Array.from(init.centers);
    let step = this.record('init', centers, init.note);
    while (step.maxDist > this.p.radius) {
      if (this.outOfBudget()) return this.abort(centers);
      const { next, moved } = this.pullOnce(centers);
      if (moved.length === 0) {
        this.record('stuck', centers, `אף מוקד לא זז – התכנסות מקומית. המרחק המקסימלי ${fmt(step.maxDist)} מ' > ${this.p.radius} מ'`);
        const far = step.farthest;
        centers = append(centers, far);
        step = this.record('add', centers, `הוספת מוקד #${centers.length} בצומת הרחוק ביותר (${fmt(step.maxDist)} מ' מהמוקד הקרוב)`, { added: [far] });
      } else {
        centers = next;
        step = this.record('move', centers, `${moved.length} מוקדים נמשכו למרכז (${this.p.objective === 'minimax' ? '1-center' : '1-median'}) של האשכול שלהם`, { moved });
      }
    }
    return this.post(centers);
  }

  gonzalez() {
    const init = this.initialCenters();
    let centers: Int32Array = Int32Array.from(init.centers.slice(0, 1));
    let step = this.record('init', centers, 'Gonzalez (1985) farthest-first traversal – מוקד ראשון');
    while (step.maxDist > this.p.radius) {
      if (this.outOfBudget()) return this.abort(centers);
      const far = step.farthest;
      centers = append(centers, far);
      step = this.record('add', centers, `הוספת המוקד הרחוק ביותר (${fmt(step.maxDist)} מ')`, { added: [far] });
    }
    return this.post(centers);
  }

  lscp() {
    const { g, p } = this;
    const n = g.n;
    // candidate sites
    let cand: Int32Array;
    if (n <= p.candidateCap) cand = Int32Array.from({ length: n }, (_, i) => i);
    else {
      const set = new Set<number>();
      while (set.size < p.candidateCap) set.add(Math.floor(this.rng() * n));
      cand = Int32Array.from(set);
    }
    // coverage sets via bounded Dijkstra
    const cover: Int32Array[] = new Array(cand.length);
    const buf: DijkstraResult = makeBuffer(n);
    const order = new Int32Array(n);
    for (let i = 0; i < cand.length; i++) {
      const r = dijkstra(g, [cand[i]], { heap: this.heap, out: buf, cutoff: p.radius, order });
      cover[i] = order.slice(0, r.visitedCount);
      if ((i & 63) === 0) this.progress({ step: 0, k: 0, maxDist: 0, phase: `חישוב קבוצות כיסוי ${i}/${cand.length}` });
    }
    const covered = new Uint8Array(n);
    let uncovered = n;
    // lazy greedy with a max-heap (negated keys)
    const heap = new MinHeap(cand.length);
    for (let i = 0; i < cand.length; i++) heap.push(i, -cover[i].length);
    let centers: Int32Array = new Int32Array(0);
    let step: Step | null = null;
    const gain = (i: number) => { let s = 0; for (const v of cover[i]) if (!covered[v]) s++; return s; };
    while (uncovered > 0) {
      if (this.outOfBudget()) return this.abort(centers);
      let pick = -1, pickGain = 0;
      while (heap.size > 0) {
        const i = heap.pop();
        const gI = gain(i);
        if (gI === 0) continue;
        if (heap.size === 0 || gI >= -heap.topKey()) { pick = i; pickGain = gI; break; }
        heap.push(i, -gI);
      }
      if (pick < 0) {
        // no candidate covers remaining nodes → fallback to farthest uncovered node
        if (!step) { step = this.record('init', centers, 'אין מועמדים – אתחול ריק'); }
        let far = step.farthest;
        if (far < 0 || covered[far]) { far = covered.indexOf(0); }
        centers = append(centers, far);
        const r = dijkstra(g, [far], { heap: this.heap, out: buf, cutoff: p.radius, order });
        for (let j = 0; j < r.visitedCount; j++) { const v = order[j]; if (!covered[v]) { covered[v] = 1; uncovered--; } }
        step = this.record('add', centers, `אין מועמד שמכסה צמתים חסרים – הוספת הצומת הרחוק ביותר כמוקד`, { added: [far] });
        continue;
      }
      for (const v of cover[pick]) if (!covered[v]) { covered[v] = 1; uncovered--; }
      centers = append(centers, cand[pick]);
      step = this.record(centers.length === 1 ? 'init' : 'add', centers,
        `Greedy set cover: המועמד שמכסה הכי הרבה צמתים לא מכוסים (+${pickGain}); נותרו ${uncovered}`, { added: [cand[pick]] });
    }
    return this.post(centers);
  }

  fixedK() {
    const init = this.initialCenters();
    let centers: Int32Array = Int32Array.from(init.centers);
    if (this.p.init === 'diameter' || this.p.init === 'single') {
      // fill up to k with farthest-first
      while (centers.length < this.p.k) {
        const f = this.farthestFrom(centers);
        centers = append(centers, f.node);
      }
    }
    let step = this.record('init', centers, `${init.note}; k=${centers.length}`);
    for (;;) {
      if (this.outOfBudget()) return this.abort(centers);
      const { next, moved } = this.pullOnce(centers);
      if (moved.length === 0) {
        step = this.record(step.maxDist <= this.p.radius ? 'final' : 'stuck', centers,
          `התכנסות עם k=${centers.length}: מרחק מקסימלי ${fmt(step.maxDist)} מ' ${step.maxDist <= this.p.radius ? '≤' : '>'} ${this.p.radius} מ'`);
        break;
      }
      centers = next;
      step = this.record('move', centers, `${moved.length} מוקדים נמשכו למרכז האשכול`, { moved });
    }
    return this.postPrune(centers);
  }

  // ---------------- post-processing ----------------

  post(centers: Int32Array) {
    if (this.p.postPull) {
      for (;;) {
        if (this.outOfBudget()) return this.abort(centers);
        const { next, moved } = this.pullOnce(centers);
        if (moved.length === 0) break;
        centers = next;
        this.record('move', centers, `שיפור לאחר-מעשה: ${moved.length} מוקדים נמשכו למרכז האשכול`, { moved });
      }
    }
    return this.postPrune(centers);
  }

  postPrune(centers: Int32Array) {
    this.prevLabel = null;
    if (this.p.postPrune && centers.length > 1) {
      // try removing centers, smallest cluster first
      this.assignTo(centers);
      const sizes = new Int32Array(centers.length);
      for (let i = 0; i < this.g.n; i++) sizes[this.assign.label[i]]++;
      const orderIdx = Array.from(centers.keys()).sort((a, b) => sizes[a] - sizes[b]);
      const alive = new Uint8Array(centers.length).fill(1);
      for (const idx of orderIdx) {
        if (this.outOfBudget()) return this.abort(centers.filter((_, i) => alive[i] === 1));
        if (alive[idx] === 0) continue;
        alive[idx] = 0;
        const trial = centers.filter((_, i) => alive[i] === 1);
        if (trial.length === 0) { alive[idx] = 1; continue; }
        const f = this.farthestFrom(trial);
        if (f.dist <= this.p.radius) {
          this.record('remove', trial, `גיזום: המוקד מיותר – ללא המוקד המרחק המקסימלי ${fmt(f.dist)} מ' ≤ ${this.p.radius} מ'`, { removed: [centers[idx]] });
        } else alive[idx] = 1;
      }
      centers = centers.filter((_, i) => alive[i] === 1);
    }
    this.record('final', centers, `סיום: ${centers.length} מוקדים`);
    return this.steps;
  }

  abort(centers: Int32Array) {
    this.record('abort', centers, `הרצה נעצרה: חריגה מתקציב הזמן (${Math.round(this.p.timeBudgetMs / 1000)} ש') או ממספר הצעדים (${this.p.maxSteps})`);
    return this.steps;
  }
}

function append(a: Int32Array, v: number): Int32Array {
  const out = new Int32Array(a.length + 1);
  out.set(a);
  out[a.length] = v;
  return out;
}

function fmt(x: number) { return Math.round(x).toLocaleString('en-US'); }

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function run(g: Graph, p: Params, progress: Progress): Step[] {
  const r = new Runner(g, p, progress);
  switch (p.algorithm) {
    case 'pullseed': return r.pullSeed();
    case 'gonzalez': return r.gonzalez();
    case 'lscp': return r.lscp();
    case 'fixedk': return r.fixedK();
  }
}

/** Recompute the assignment for a step (used by the UI to colour the network). */
export function assignment(g: Graph, centers: Int32Array): DijkstraResult {
  return dijkstra(g, centers);
}
