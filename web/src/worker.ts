import { buildGraph, buildGraphFromWork, type BuildOptions, type Work } from './graph/osm';
import type { Graph } from './graph/graph';
import type { OverpassJson } from './graph/overpass';
import { run, assignment, type Params, type Step } from './algo/algorithms';

export type WorkerIn =
  | { type: 'build'; osm: OverpassJson; opts: BuildOptions }
  | { type: 'buildWork'; work: Work; opts: BuildOptions }
  | { type: 'graph'; graph: Graph }
  | { type: 'run'; params: Params }
  | { type: 'assign'; centers: Int32Array; id: number };

export type WorkerOut =
  | { type: 'log'; msg: string }
  | { type: 'built'; graph: Graph; stats: import('./graph/osm').BuildStats }
  | { type: 'progress'; step: number; k: number; maxDist: number; phase: string }
  | { type: 'done'; steps: Step[]; ms: number }
  | { type: 'assign'; id: number; label: Int32Array; dist: Float64Array }
  | { type: 'error'; msg: string };

let graph: Graph | null = null;
const post = (m: WorkerOut) => (self as unknown as Worker).postMessage(m);

self.onmessage = (ev: MessageEvent<WorkerIn>) => {
  const msg = ev.data;
  try {
    switch (msg.type) {
      case 'build': {
        const { graph: g, stats } = buildGraph(msg.osm, msg.opts, (s) => post({ type: 'log', msg: s }));
        graph = g;
        post({ type: 'built', graph: g, stats });
        break;
      }
      case 'buildWork': {
        const { graph: g, stats } = buildGraphFromWork(msg.work, msg.opts, (s) => post({ type: 'log', msg: s }));
        graph = g;
        post({ type: 'built', graph: g, stats });
        break;
      }
      case 'graph':
        graph = msg.graph;
        break;
      case 'run': {
        if (!graph) throw new Error('no graph');
        const t = performance.now();
        let last = 0;
        const steps = run(graph, msg.params, (info) => {
          const now = performance.now();
          if (now - last > 100 || info.step < 5) { last = now; post({ type: 'progress', ...info }); }
        });
        post({ type: 'done', steps, ms: performance.now() - t });
        break;
      }
      case 'assign': {
        if (!graph) throw new Error('no graph');
        const a = assignment(graph, msg.centers);
        post({ type: 'assign', id: msg.id, label: a.label, dist: a.dist });
        break;
      }
    }
  } catch (e) {
    post({ type: 'error', msg: e instanceof Error ? e.message : String(e) });
  }
};
