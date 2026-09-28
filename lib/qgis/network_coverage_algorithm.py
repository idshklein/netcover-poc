# -*- coding: utf-8 -*-
"""
QGIS Processing script: Network Coverage (inverse isochrone) – pull-and-seed / Gonzalez / greedy LSCP.

Install: Processing Toolbox ▸ Scripts ▸ "Add Script to Toolbox…" (or copy to
  %APPDATA%/QGIS/QGIS3/profiles/default/processing/scripts/).
Input: a projected LINESTRING layer (metres), e.g. OSM roads from QuickOSM.
Output: centers (points) + nodes (points with cluster/dist) + optional steps table for animation
        via the Temporal Controller (field "step").

Built with the basic QGIS/pyqgis toolset only (QgsSpatialIndex, geometry ops) plus pure-Python Dijkstra
(no networkx dependency). Topology: endpoints are snapped within `tolerance`; long edges are split every
`segment_length` metres so that long streets carry demand nodes.
"""
import heapq
import math
import random

from qgis.PyQt.QtCore import QCoreApplication, QVariant
from qgis.core import (
    QgsFeature, QgsFeatureSink, QgsField, QgsFields, QgsGeometry, QgsPointXY, QgsProcessing,
    QgsProcessingAlgorithm, QgsProcessingException, QgsProcessingParameterBoolean, QgsProcessingParameterEnum,
    QgsProcessingParameterFeatureSink, QgsProcessingParameterFeatureSource, QgsProcessingParameterNumber,
    QgsWkbTypes,
)


class NetworkCoverageAlgorithm(QgsProcessingAlgorithm):
    INPUT, RADIUS, METHOD, OBJECTIVE, SEGMENT, TOLERANCE, PRUNE = 'INPUT', 'RADIUS', 'METHOD', 'OBJECTIVE', 'SEGMENT', 'TOLERANCE', 'PRUNE'
    CENTERS, NODES, STEPS = 'CENTERS', 'NODES', 'STEPS'
    METHODS = ['Pull-and-seed (incremental k-center)', 'Gonzalez farthest-first', 'Greedy set cover (LSCP)']

    def tr(self, s):
        return QCoreApplication.translate('NetworkCoverage', s)

    def createInstance(self):
        return NetworkCoverageAlgorithm()

    def name(self):
        return 'networkcoverage'

    def displayName(self):
        return self.tr('Network coverage (inverse isochrone)')

    def group(self):
        return self.tr('Network analysis')

    def groupId(self):
        return 'networkanalysis'

    def shortHelpString(self):
        return self.tr('Finds a small set of center nodes so that every network node is within RADIUS (network metres) '
                       'of its nearest center. Pull-and-seed: centers are pulled to the 1-center/1-median of their '
                       'network-Voronoi cell; when nothing moves, a center is added at the farthest node. '
                       'Input must be a projected line layer in metres. Large networks (>30k nodes) can take minutes.')

    def initAlgorithm(self, config=None):
        self.addParameter(QgsProcessingParameterFeatureSource(self.INPUT, self.tr('Network lines (projected, metres)'), [QgsProcessing.TypeVectorLine]))
        self.addParameter(QgsProcessingParameterNumber(self.RADIUS, self.tr('Coverage radius r (m)'), QgsProcessingParameterNumber.Double, 500.0, minValue=1))
        self.addParameter(QgsProcessingParameterEnum(self.METHOD, self.tr('Method'), self.METHODS, defaultValue=0))
        self.addParameter(QgsProcessingParameterEnum(self.OBJECTIVE, self.tr('Pull objective'), ['minimax (1-center)', 'minisum (1-median)'], defaultValue=0))
        self.addParameter(QgsProcessingParameterNumber(self.SEGMENT, self.tr('Max edge segment length (m, 0=off)'), QgsProcessingParameterNumber.Double, 150.0, minValue=0))
        self.addParameter(QgsProcessingParameterNumber(self.TOLERANCE, self.tr('Node snapping tolerance (m)'), QgsProcessingParameterNumber.Double, 0.5, minValue=0))
        self.addParameter(QgsProcessingParameterBoolean(self.PRUNE, self.tr('Prune redundant centers'), False))
        self.addParameter(QgsProcessingParameterFeatureSink(self.CENTERS, self.tr('Centers')))
        self.addParameter(QgsProcessingParameterFeatureSink(self.NODES, self.tr('Nodes (cluster, dist)')))
        self.addParameter(QgsProcessingParameterFeatureSink(self.STEPS, self.tr('Steps (centers per step, for Temporal Controller)'), optional=True, createByDefault=False))

    # ------------------------------------------------------------------ graph building
    def _build_graph(self, source, tol, seglen, feedback):
        key_of = {}
        xs, ys, adj = [], [], []

        def node(x, y):
            k = (round(x / tol), round(y / tol)) if tol > 0 else (x, y)
            i = key_of.get(k)
            if i is None:
                i = len(xs); key_of[k] = i; xs.append(x); ys.append(y); adj.append([])
            return i

        def add_edge(u, v, w):
            if u != v and w > 0:
                adj[u].append((v, w)); adj[v].append((u, w))

        total = source.featureCount() or 1
        for n, f in enumerate(source.getFeatures()):
            if feedback.isCanceled():
                break
            if n % 500 == 0:
                feedback.setProgress(int(20 * n / total))
            g = f.geometry()
            if g.isEmpty():
                continue
            parts = g.asMultiPolyline() if g.isMultipart() else [g.asPolyline()]
            for pl in parts:
                if len(pl) < 2:
                    continue
                # cumulative length along the polyline
                cum = [0.0]
                for a, b in zip(pl[:-1], pl[1:]):
                    cum.append(cum[-1] + math.hypot(b.x() - a.x(), b.y() - a.y()))
                L = cum[-1]
                if L == 0:
                    continue
                nparts = max(1, math.ceil(L / seglen)) if seglen > 0 else 1
                prev = node(pl[0].x(), pl[0].y())
                for p in range(1, nparts + 1):
                    if p == nparts:
                        cur = node(pl[-1].x(), pl[-1].y())
                    else:
                        d = L * p / nparts
                        j = 1
                        while cum[j] < d:
                            j += 1
                        t = (d - cum[j - 1]) / (cum[j] - cum[j - 1]) if cum[j] > cum[j - 1] else 0
                        x = pl[j - 1].x() + (pl[j].x() - pl[j - 1].x()) * t
                        y = pl[j - 1].y() + (pl[j].y() - pl[j - 1].y()) * t
                        cur = node(x, y)
                    add_edge(prev, cur, L / nparts)
                    prev = cur
        # largest connected component
        n = len(xs)
        comp = [-1] * n
        best, best_size = -1, 0
        for s in range(n):
            if comp[s] >= 0:
                continue
            stack, comp[s], size = [s], s, 0
            while stack:
                u = stack.pop(); size += 1
                for v, _ in adj[u]:
                    if comp[v] < 0:
                        comp[v] = s; stack.append(v)
            if size > best_size:
                best, best_size = s, size
        keep = [i for i in range(n) if comp[i] == best]
        remap = {old: new for new, old in enumerate(keep)}
        adj2 = [[(remap[v], w) for v, w in adj[old]] for old in keep]
        return [xs[i] for i in keep], [ys[i] for i in keep], adj2

    # ------------------------------------------------------------------ algorithms (pure python)
    @staticmethod
    def _dijkstra(adj, sources, cutoff=math.inf):
        dist, label, pred = {}, {}, {}
        heap = []
        for i, s in enumerate(sources):
            if s not in dist:
                dist[s] = 0.0; label[s] = i; heap.append((0.0, s))
        heapq.heapify(heap)
        while heap:
            d, u = heapq.heappop(heap)
            if d > dist[u]:
                continue
            for v, w in adj[u]:
                nd = d + w
                if nd <= cutoff and nd < dist.get(v, math.inf):
                    dist[v] = nd; label[v] = label[u]; pred[v] = u; heapq.heappush(heap, (nd, v))
        return dist, label, pred

    def _one_center(self, adj, members, cur, cur_dist):
        best, best_ecc, far = cur, 0.0, None
        for m in members:
            if cur_dist[m] > best_ecc:
                best_ecc, far = cur_dist[m], m
        lb = {m: 0.0 for m in members}
        for _ in range(12):
            if far is None:
                break
            df, _, _ = self._dijkstra(adj, [far], best_ecc)
            cand, min_lb = None, math.inf
            for m in members:
                lb[m] = max(lb[m], df.get(m, best_ecc + 1))
                if lb[m] < min_lb:
                    min_lb, cand = lb[m], m
            if min_lb >= best_ecc - 1e-9:
                break
            dc, _, _ = self._dijkstra(adj, [cand], best_ecc)
            ecc, far = 0.0, None
            for m in members:
                d = dc.get(m)
                if d is None:
                    ecc = math.inf; far = m; break
                if d > ecc:
                    ecc, far = d, m
            if ecc == math.inf:
                lb[cand] = best_ecc + 1
            elif ecc < best_ecc - 1e-9:
                best, best_ecc = cand, ecc
            else:
                lb[cand] = max(lb[cand], ecc)
        return best

    def _one_median(self, adj, members, cur, cur_dist):
        mset = set(members)
        best, best_sum = cur, sum(cur_dist[m] for m in members)
        cands = members if len(members) <= 120 else random.sample(members, 40)
        for s in cands:
            if s == cur:
                continue
            d, _, _ = self._dijkstra_restricted(adj, s, mset)
            tot = sum(d.get(m, 1e12) for m in members)
            if tot < best_sum:
                best, best_sum = s, tot
        return best

    @staticmethod
    def _dijkstra_restricted(adj, s, allowed):
        dist = {s: 0.0}; heap = [(0.0, s)]
        while heap:
            d, u = heapq.heappop(heap)
            if d > dist[u]:
                continue
            for v, w in adj[u]:
                if v in allowed and d + w < dist.get(v, math.inf):
                    dist[v] = d + w; heapq.heappush(heap, (d + w, v))
        return dist, None, None

    def _run(self, adj, n, radius, method, objective, prune, feedback):
        nodes = range(n)
        steps = []

        def record(kind, centers, note=''):
            dist, label, pred = self._dijkstra(adj, centers)
            far = max(nodes, key=lambda v: dist.get(v, -1))
            steps.append(dict(kind=kind, centers=list(centers), max=dist[far], far=far, note=note, dist=dist, label=label, pred=pred))
            feedback.pushInfo(f'{kind:6s} k={len(centers):4d} max={dist[far]:8.0f}  {note}')
            return steps[-1]

        def farthest_from(src):
            d, _, _ = self._dijkstra(adj, src)
            v = max(nodes, key=lambda x: d.get(x, -1))
            return v, d[v]

        a0, _ = farthest_from([0]); b, _ = farthest_from([a0]); a, diam = farthest_from([b])
        prev_label = None

        def pull(centers, st):
            nonlocal prev_label
            k = len(centers)
            dirty = [True] * k if prev_label is None else [False] * k
            if prev_label is not None:
                for v in nodes:
                    if prev_label.get(v) != st['label'].get(v):
                        for c in (prev_label.get(v, -1), st['label'].get(v, -1)):
                            if 0 <= c < k:
                                dirty[c] = True
            members = [[] for _ in range(k)]
            for v in nodes:
                members[st['label'][v]].append(v)
            nxt, moved = list(centers), 0
            for c in range(k):
                if not dirty[c] or len(members[c]) <= 1:
                    continue
                new = self._one_center(adj, members[c], centers[c], st['dist']) if objective == 0 else self._one_median(adj, members[c], centers[c], st['dist'])
                if new != centers[c]:
                    nxt[c] = new; moved += 1
            prev_label = st['label']
            return nxt, moved

        if method == 0:
            centers = [a, b]
            st = record('init', centers, f'diameter endpoints ({diam:.0f} m)')
            while st['max'] > radius and not feedback.isCanceled():
                nxt, moved = pull(centers, st)
                if moved == 0:
                    record('stuck', centers, 'no center moved')
                    centers = centers + [st['far']]
                    st = record('add', centers, f'farthest node ({st["max"]:.0f} m)')
                else:
                    centers = nxt
                    st = record('move', centers, f'{moved} centers pulled')
                feedback.setProgress(20 + int(70 * min(1.0, radius / max(st['max'], 1e-9))))
        elif method == 1:
            centers = [a]
            st = record('init', centers, 'Gonzalez')
            while st['max'] > radius and not feedback.isCanceled():
                centers = centers + [st['far']]
                st = record('add', centers)
                feedback.setProgress(20 + int(70 * min(1.0, radius / max(st['max'], 1e-9))))
        else:
            cand = list(nodes) if n <= 1500 else random.sample(list(nodes), 1500)
            cover = [set(self._dijkstra(adj, [c], radius)[0]) for c in cand]
            covered, centers = set(), []
            st = None
            while len(covered) < n and not feedback.isCanceled():
                gains = [len(s - covered) for s in cover]
                i = max(range(len(cand)), key=lambda j: gains[j])
                if gains[i] == 0:
                    far = st['far'] if st else next(v for v in nodes if v not in covered)
                    centers.append(far); covered |= set(self._dijkstra(adj, [far], radius)[0])
                    st = record('add', centers, 'fallback farthest'); continue
                covered |= cover[i]; centers.append(cand[i])
                st = record('init' if len(centers) == 1 else 'add', centers, f'+{gains[i]} covered')
                feedback.setProgress(20 + int(70 * len(covered) / n))
        if prune and len(centers) > 1:
            alive = [True] * len(centers)
            for i in range(len(centers)):
                alive[i] = False
                trial = [c for c, al in zip(centers, alive) if al]
                if trial:
                    _, d = farthest_from(trial)
                    if d <= radius:
                        record('remove', trial, 'pruned redundant center'); continue
                alive[i] = True
            centers = [c for c, al in zip(centers, alive) if al]
        record('final', centers, f'{len(centers)} centers')
        return steps

    # ------------------------------------------------------------------ processing entry point
    def processAlgorithm(self, parameters, context, feedback):
        source = self.parameterAsSource(parameters, self.INPUT, context)
        if source is None:
            raise QgsProcessingException(self.invalidSourceError(parameters, self.INPUT))
        if source.sourceCrs().isGeographic():
            raise QgsProcessingException('Input layer must be in a projected CRS (metres), e.g. EPSG:2039.')
        radius = self.parameterAsDouble(parameters, self.RADIUS, context)
        method = self.parameterAsEnum(parameters, self.METHOD, context)
        objective = self.parameterAsEnum(parameters, self.OBJECTIVE, context)
        seglen = self.parameterAsDouble(parameters, self.SEGMENT, context)
        tol = self.parameterAsDouble(parameters, self.TOLERANCE, context)
        prune = self.parameterAsBool(parameters, self.PRUNE, context)

        xs, ys, adj = self._build_graph(source, tol, seglen, feedback)
        n = len(xs)
        m = sum(len(a) for a in adj) // 2
        feedback.pushInfo(f'graph: {n} nodes, {m} edges (largest component)')
        if n > 30000:
            feedback.pushWarning('Large network: pure-Python run may take many minutes. Consider a larger segment length / radius or a smaller area.')
        if n == 0:
            raise QgsProcessingException('Empty network')

        steps = self._run(adj, n, radius, method, objective, prune, feedback)
        final = steps[-1]
        crs = source.sourceCrs()

        cf = QgsFields(); cf.append(QgsField('idx', QVariant.Int)); cf.append(QgsField('node', QVariant.Int))
        centers_sink, centers_id = self.parameterAsSink(parameters, self.CENTERS, context, cf, QgsWkbTypes.Point, crs)
        for i, c in enumerate(final['centers']):
            f = QgsFeature(cf); f.setGeometry(QgsGeometry.fromPointXY(QgsPointXY(xs[c], ys[c]))); f.setAttributes([i, c]); centers_sink.addFeature(f, QgsFeatureSink.FastInsert)

        nf = QgsFields(); nf.append(QgsField('node', QVariant.Int)); nf.append(QgsField('cluster', QVariant.Int)); nf.append(QgsField('dist', QVariant.Double)); nf.append(QgsField('covered', QVariant.Bool))
        nodes_sink, nodes_id = self.parameterAsSink(parameters, self.NODES, context, nf, QgsWkbTypes.Point, crs)
        for v in range(n):
            f = QgsFeature(nf); f.setGeometry(QgsGeometry.fromPointXY(QgsPointXY(xs[v], ys[v])))
            d = final['dist'].get(v, float('inf')); f.setAttributes([v, final['label'].get(v, -1), d, d <= radius]); nodes_sink.addFeature(f, QgsFeatureSink.FastInsert)

        out = {self.CENTERS: centers_id, self.NODES: nodes_id}
        if parameters.get(self.STEPS):
            sf = QgsFields(); sf.append(QgsField('step', QVariant.Int)); sf.append(QgsField('kind', QVariant.String)); sf.append(QgsField('idx', QVariant.Int)); sf.append(QgsField('k', QVariant.Int)); sf.append(QgsField('max_dist', QVariant.Double)); sf.append(QgsField('is_farthest', QVariant.Bool))
            steps_sink, steps_id = self.parameterAsSink(parameters, self.STEPS, context, sf, QgsWkbTypes.Point, crs)
            if steps_sink is not None:
                for si, st in enumerate(steps):
                    for i, c in enumerate(st['centers']):
                        f = QgsFeature(sf); f.setGeometry(QgsGeometry.fromPointXY(QgsPointXY(xs[c], ys[c]))); f.setAttributes([si, st['kind'], i, len(st['centers']), st['max'], False]); steps_sink.addFeature(f, QgsFeatureSink.FastInsert)
                    if st['kind'] in ('stuck', 'add'):
                        f = QgsFeature(sf); f.setGeometry(QgsGeometry.fromPointXY(QgsPointXY(xs[st['far']], ys[st['far']]))); f.setAttributes([si, st['kind'], -1, len(st['centers']), st['max'], True]); steps_sink.addFeature(f, QgsFeatureSink.FastInsert)
                out[self.STEPS] = steps_id
        feedback.pushInfo(f'done: {len(final["centers"])} centers, {len(steps)} steps, max distance {final["max"]:.0f} m')
        return out
