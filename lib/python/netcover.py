"""
netcover – inverse-isochrone network coverage ("pull-and-seed" incremental k-center)
for spatial networks built with networkx / osmnx.

Problem: given a spatial network G with edge lengths (m) and a radius r, find a
small set of center nodes S such that every node is within network distance r of
its nearest center. Equivalent to the Location Set Covering Problem (LSCP);
the dual is k-center.

Algorithms
----------
pull_and_seed   the proposed algorithm: network Lloyd iterations (each node ->
                nearest center; each center -> 1-center / 1-median of its
                cluster) until no center moves, then add a center at the node
                farthest from all centers; repeat until max distance <= r.
gonzalez        farthest-first traversal (Gonzalez 1985, 2-approx k-center).
greedy_lscp     greedy set cover on bounded Dijkstra coverage sets (Toregas 1971).
fixed_k         network Lloyd with a fixed k (k-medoids / p-center heuristic).
prune           drop redundant centers while coverage holds.

Every algorithm yields a list of `Step` records so the process can be animated.

Usage
-----
    import osmnx as ox, netcover as nc
    G = ox.graph_from_place("Tel Aviv-Yafo, Israel", network_type="walk")
    H = nc.prepare(G, segment_length=150)          # undirected, largest component, segmentized
    steps = nc.pull_and_seed(H, radius=500)
    centers = steps[-1].centers
    nc.steps_to_geodataframes(H, steps[-1])         # (centers_gdf, nodes_gdf)
"""
from __future__ import annotations

import heapq
import math
import random
from dataclasses import dataclass, field
from typing import Callable, Dict, Hashable, Iterable, List, Literal, Optional, Sequence, Tuple

import networkx as nx

Node = Hashable
Objective = Literal["minimax", "minisum"]

__all__ = [
    "Step", "prepare", "segmentize", "multi_source_dijkstra", "pull_and_seed", "gonzalez",
    "greedy_lscp", "fixed_k", "prune", "steps_to_geodataframes", "estimate_runtime_seconds",
]


@dataclass
class Step:
    kind: str                       # init | move | stuck | add | remove | final
    centers: List[Node]
    max_dist: float
    mean_dist: float
    covered: float                  # fraction of nodes with dist <= r
    farthest: Node
    note: str = ""
    moved: List[Tuple[Node, Node]] = field(default_factory=list)
    added: List[Node] = field(default_factory=list)
    removed: List[Node] = field(default_factory=list)
    label: Optional[Dict[Node, int]] = None   # node -> center index (kept only if keep_assignments=True)
    dist: Optional[Dict[Node, float]] = None


# --------------------------------------------------------------------------- graph prep

def prepare(G: nx.Graph, weight: str = "length", segment_length: float = 0.0,
            largest_component: bool = True) -> nx.Graph:
    """Turn an osmnx (Multi)DiGraph into a simple undirected weighted Graph.

    Parallel edges keep the shortest length. Optionally keeps only the largest
    connected component and splits long edges into <= segment_length pieces so
    that long streets contain demand nodes (like st_network_blend in sfnetworks).
    """
    H = nx.Graph()
    for n, d in G.nodes(data=True):
        H.add_node(n, x=d.get("x"), y=d.get("y"))
    for u, v, d in G.edges(data=True):
        if u == v:
            continue
        w = float(d.get(weight, 1.0))
        if H.has_edge(u, v):
            if w < H[u][v][weight]:
                H[u][v][weight] = w
                H[u][v]["geometry"] = d.get("geometry")
        else:
            H.add_edge(u, v, **{weight: w, "geometry": d.get("geometry")})
    if largest_component and H.number_of_nodes():
        cc = max(nx.connected_components(H), key=len)
        H = H.subgraph(cc).copy()
    if segment_length and segment_length > 0:
        H = segmentize(H, segment_length, weight=weight)
    H.graph["crs"] = G.graph.get("crs", "EPSG:4326")
    return H


def segmentize(H: nx.Graph, max_len: float, weight: str = "length") -> nx.Graph:
    """Split every edge longer than max_len into equal pieces, inserting synthetic nodes."""
    try:
        from shapely.geometry import LineString
    except ImportError:  # geometry optional
        LineString = None  # type: ignore
    out = nx.Graph()
    out.graph.update(H.graph)
    out.add_nodes_from(H.nodes(data=True))
    nid = 0
    for u, v, d in H.edges(data=True):
        L = float(d[weight])
        parts = max(1, math.ceil(L / max_len))
        if parts == 1:
            out.add_edge(u, v, **d)
            continue
        geom = d.get("geometry")
        if geom is None and LineString is not None:
            geom = LineString([(H.nodes[u]["x"], H.nodes[u]["y"]), (H.nodes[v]["x"], H.nodes[v]["y"])])
        prev = u
        for i in range(1, parts + 1):
            if i == parts:
                nxt = v
            else:
                nid += 1
                nxt = f"seg_{u}_{v}_{nid}"
                if geom is not None:
                    p = geom.interpolate(i / parts, normalized=True)
                    out.add_node(nxt, x=p.x, y=p.y)
                else:
                    t = i / parts
                    out.add_node(nxt, x=H.nodes[u]["x"] + (H.nodes[v]["x"] - H.nodes[u]["x"]) * t,
                                 y=H.nodes[u]["y"] + (H.nodes[v]["y"] - H.nodes[u]["y"]) * t)
            attrs = {weight: L / parts}
            if geom is not None:
                a, b = (i - 1) / parts, i / parts
                try:
                    from shapely.ops import substring
                    attrs["geometry"] = substring(geom, a, b, normalized=True)
                except Exception:
                    pass
            out.add_edge(prev, nxt, **attrs)
            prev = nxt
    return out


# --------------------------------------------------------------------------- shortest paths

def multi_source_dijkstra(H: nx.Graph, sources: Sequence[Node], weight: str = "length",
                          cutoff: float = math.inf, allowed: Optional[set] = None
                          ) -> Tuple[Dict[Node, float], Dict[Node, int], Dict[Node, Node]]:
    """Multi-source Dijkstra returning (dist, label=index of nearest source, pred).

    `allowed` restricts the search to a node subset (cluster-restricted searches);
    `cutoff` stops relaxing beyond a distance.
    """
    dist: Dict[Node, float] = {}
    label: Dict[Node, int] = {}
    pred: Dict[Node, Node] = {}
    heap: List[Tuple[float, int, Node]] = []
    for i, s in enumerate(sources):
        if allowed is not None and s not in allowed:
            continue
        if s in dist:
            continue
        dist[s] = 0.0
        label[s] = i
        heap.append((0.0, i, s))
    heapq.heapify(heap)
    done: set = set()
    adj = H.adj
    while heap:
        d, _, u = heapq.heappop(heap)
        if u in done or d > dist.get(u, math.inf):
            continue
        done.add(u)
        lu = label[u]
        for v, ed in adj[u].items():
            if allowed is not None and v not in allowed:
                continue
            nd = d + ed[weight]
            if nd <= cutoff and nd < dist.get(v, math.inf):
                dist[v] = nd
                label[v] = lu
                pred[v] = u
                heapq.heappush(heap, (nd, lu, v))
    return dist, label, pred


# --------------------------------------------------------------------------- cluster centers

def _one_center_lazy(H: nx.Graph, members: List[Node], cur: Node, cur_dist: Dict[Node, float],
                     weight: str, max_iter: int = 12) -> Node:
    """Exact 1-center of `members` (full-graph distances) with lazy lower bounds.

    lb(v) = max_{e in E} d(e, v) <= ecc(v) for a growing set of extreme members E;
    stop when min lb >= incumbent eccentricity. Each round costs 2 bounded Dijkstras.
    """
    best, best_ecc = cur, 0.0
    farthest = None
    for m in members:
        d = cur_dist.get(m, math.inf)
        if d > best_ecc:
            best_ecc, farthest = d, m
    lb = {m: 0.0 for m in members}
    for _ in range(max_iter):
        if farthest is None:
            break
        df, _, _ = multi_source_dijkstra(H, [farthest], weight, cutoff=best_ecc)
        min_lb, cand = math.inf, None
        for m in members:
            b = df.get(m, best_ecc + 1.0)
            if b > lb[m]:
                lb[m] = b
            if lb[m] < min_lb:
                min_lb, cand = lb[m], m
        if min_lb >= best_ecc - 1e-9 or cand is None:
            break
        dc, _, _ = multi_source_dijkstra(H, [cand], weight, cutoff=best_ecc)
        ecc, far = 0.0, None
        for m in members:
            d = dc.get(m)
            if d is None:
                ecc, far = math.inf, m
                break
            if d > ecc:
                ecc, far = d, m
        farthest = far
        if ecc == math.inf:
            lb[cand] = best_ecc + 1.0
            continue
        if ecc < best_ecc - 1e-9:
            best, best_ecc = cand, ecc
        else:
            lb[cand] = max(lb[cand], ecc)
    return best


def _one_median_exact(H: nx.Graph, members: List[Node], cur: Node, cur_dist: Dict[Node, float], weight: str) -> Node:
    allowed = set(members)
    best, best_sum = cur, sum(cur_dist.get(m, 0.0) for m in members)
    for s in members:
        if s == cur:
            continue
        d, _, _ = multi_source_dijkstra(H, [s], weight, allowed=allowed)
        tot = sum(d.get(m, 1e12) for m in members)
        if tot < best_sum - 1e-9:
            best, best_sum = s, tot
    return best


def _one_median_centroid_walk(H: nx.Graph, members: List[Node], cur: Node, cur_dist: Dict[Node, float],
                              pred: Dict[Node, Node], label: Dict[Node, int], c: int, weight: str) -> Node:
    """Heuristic 1-median: walk from the center into the shortest-path-tree subtree holding > half the members."""
    allowed = set(members)
    size = len(members)
    sub = {m: 1 for m in members}
    for m in sorted(members, key=lambda v: -cur_dist.get(v, 0.0)):
        p = pred.get(m)
        if p is not None and label.get(p) == c:
            sub[p] = sub.get(p, 0) + sub[m]
    m = cur
    while True:
        heavy, hs = None, size / 2
        for w in H.adj[m]:
            if label.get(w) == c and pred.get(w) == m and sub.get(w, 0) > hs:
                heavy, hs = w, sub[w]
        if heavy is None:
            break
        m = heavy
    if m == cur:
        return cur
    d, _, _ = multi_source_dijkstra(H, [m], weight, allowed=allowed)
    if sum(d.get(x, 1e12) for x in members) < sum(cur_dist.get(x, 0.0) for x in members):
        return m
    return cur


# --------------------------------------------------------------------------- runner

class _Runner:
    def __init__(self, H: nx.Graph, radius: float, weight: str, objective: Objective,
                 exact_limit: int, keep_assignments: bool, progress: Optional[Callable[[Step], None]], seed: int):
        self.H, self.r, self.w, self.obj = H, radius, weight, objective
        self.exact_limit, self.keep, self.progress = exact_limit, keep_assignments, progress
        self.steps: List[Step] = []
        self.nodes = list(H.nodes)
        self.rng = random.Random(seed)
        self.prev_label: Optional[Dict[Node, int]] = None
        self._assigned_for: Optional[Tuple[Node, ...]] = None
        self.dist: Dict[Node, float] = {}
        self.label: Dict[Node, int] = {}
        self.pred: Dict[Node, Node] = {}

    def assign(self, centers: Sequence[Node]):
        key = tuple(centers)
        if key == self._assigned_for:
            return
        self.dist, self.label, self.pred = multi_source_dijkstra(self.H, centers, self.w)
        self._assigned_for = key

    def record(self, kind: str, centers: Sequence[Node], note: str = "", **extra) -> Step:
        self.assign(centers)
        n = len(self.nodes)
        mx, far, tot, cov = 0.0, None, 0.0, 0
        for v in self.nodes:
            d = self.dist.get(v, math.inf)
            if d > mx:
                mx, far = d, v
            tot += d
            if d <= self.r:
                cov += 1
        st = Step(kind, list(centers), mx, tot / n, cov / n, far, note, **extra)
        if self.keep:
            st.label, st.dist = dict(self.label), dict(self.dist)
        self.steps.append(st)
        if self.progress:
            self.progress(st)
        return st

    def farthest(self, centers: Sequence[Node]) -> Tuple[Node, float]:
        self.assign(centers)
        v = max(self.nodes, key=lambda x: self.dist.get(x, -1))
        return v, self.dist.get(v, math.inf)

    def diameter_endpoints(self) -> Tuple[Node, Node, float]:
        a0, _ = self.farthest([self.nodes[0]])
        b, _ = self.farthest([a0])
        a, d = self.farthest([b])
        return a, b, d

    def pull_once(self, centers: List[Node]) -> Tuple[List[Node], List[Tuple[Node, Node]]]:
        self.assign(centers)
        k = len(centers)
        dirty = [True] * k if self.prev_label is None else [False] * k
        if self.prev_label is not None:
            for v in self.nodes:
                a, b = self.prev_label.get(v, -1), self.label.get(v, -1)
                if a != b:
                    if 0 <= a < k:
                        dirty[a] = True
                    if b >= 0:
                        dirty[b] = True
        members: List[List[Node]] = [[] for _ in range(k)]
        for v in self.nodes:
            c = self.label.get(v, -1)
            if c >= 0:
                members[c].append(v)
        nxt, moved = list(centers), []
        for c in range(k):
            if not dirty[c] or len(members[c]) <= 1:
                continue
            cur = centers[c]
            if self.obj == "minimax":
                new = _one_center_lazy(self.H, members[c], cur, self.dist, self.w)
            elif len(members[c]) <= self.exact_limit:
                new = _one_median_exact(self.H, members[c], cur, self.dist, self.w)
            else:
                new = _one_median_centroid_walk(self.H, members[c], cur, self.dist, self.pred, self.label, c, self.w)
            if new != cur:
                nxt[c] = new
                moved.append((cur, new))
        self.prev_label = dict(self.label)
        return nxt, moved

    def post(self, centers: List[Node], post_pull: bool, post_prune: bool) -> List[Step]:
        if post_pull:
            while True:
                nxt, moved = self.pull_once(centers)
                if not moved:
                    break
                centers = nxt
                self.record("move", centers, f"post-pull: {len(moved)} centers moved", moved=moved)
        if post_prune and len(centers) > 1:
            centers = self._prune(centers)
        self.record("final", centers, f"done: {len(centers)} centers")
        return self.steps

    def _prune(self, centers: List[Node]) -> List[Node]:
        self.prev_label = None
        self.assign(centers)
        sizes = [0] * len(centers)
        for v in self.nodes:
            sizes[self.label[v]] += 1
        alive = [True] * len(centers)
        for idx in sorted(range(len(centers)), key=lambda i: sizes[i]):
            alive[idx] = False
            trial = [c for c, a in zip(centers, alive) if a]
            if not trial:
                alive[idx] = True
                continue
            _, d = self.farthest(trial)
            if d <= self.r:
                self.record("remove", trial, f"prune: center redundant (max {d:.0f} <= r)", removed=[centers[idx]])
            else:
                alive[idx] = True
        return [c for c, a in zip(centers, alive) if a]


def _init(run: _Runner, init: str, k: int, manual: Optional[Sequence[Node]]) -> Tuple[List[Node], str]:
    if init == "manual" and manual:
        return list(dict.fromkeys(manual)), f"manual init: {len(manual)} centers"
    if init == "random":
        return run.rng.sample(run.nodes, min(k, len(run.nodes))), f"random init: k={k}"
    a, b, d = run.diameter_endpoints()
    if init == "single":
        da = dict(run.dist)  # from b
        run.assign([a])
        db = run.dist
        c = min(run.nodes, key=lambda v: max(da.get(v, math.inf), db.get(v, math.inf)))
        return [c], f"init at approximate graph center (2-sweep, diameter ~{d:.0f} m)"
    return [a, b], f"init at approximate diameter endpoints ({d:.0f} m), as in the reference implementation"


# --------------------------------------------------------------------------- public algorithms

def pull_and_seed(H: nx.Graph, radius: float, weight: str = "length", objective: Objective = "minimax",
                  init: str = "diameter", k: int = 2, manual: Optional[Sequence[Node]] = None,
                  exact_limit: int = 120, post_pull: bool = False, post_prune: bool = False,
                  max_steps: int = 5000, keep_assignments: bool = False,
                  progress: Optional[Callable[[Step], None]] = None, seed: int = 42) -> List[Step]:
    """The proposed algorithm: pull centers to cluster centers; when stuck, seed a center at the farthest node."""
    run = _Runner(H, radius, weight, objective, exact_limit, keep_assignments, progress, seed)
    centers, note = _init(run, init, k, manual)
    st = run.record("init", centers, note)
    while st.max_dist > radius and len(run.steps) < max_steps:
        nxt, moved = run.pull_once(centers)
        if not moved:
            run.record("stuck", centers, f"no center moved (local convergence); max {st.max_dist:.0f} m > r")
            far = st.farthest
            centers = centers + [far]
            st = run.record("add", centers, f"add center #{len(centers)} at farthest node ({st.max_dist:.0f} m)", added=[far])
        else:
            centers = nxt
            st = run.record("move", centers, f"{len(moved)} centers pulled to cluster {'1-center' if objective == 'minimax' else '1-median'}", moved=moved)
    return run.post(centers, post_pull, post_prune)


def gonzalez(H: nx.Graph, radius: float, weight: str = "length", start: Optional[Node] = None,
             post_pull: bool = False, post_prune: bool = False, keep_assignments: bool = False,
             progress: Optional[Callable[[Step], None]] = None, objective: Objective = "minimax") -> List[Step]:
    """Farthest-first traversal (Gonzalez 1985) until max distance <= radius."""
    run = _Runner(H, radius, weight, objective, 120, keep_assignments, progress, 0)
    if start is None:
        start, _, _ = run.diameter_endpoints()
    centers = [start]
    st = run.record("init", centers, "Gonzalez farthest-first: first center")
    while st.max_dist > radius:
        far = st.farthest
        centers = centers + [far]
        st = run.record("add", centers, f"add farthest node ({st.max_dist:.0f} m)", added=[far])
    return run.post(centers, post_pull, post_prune)


def greedy_lscp(H: nx.Graph, radius: float, weight: str = "length", candidates: Optional[Iterable[Node]] = None,
                candidate_cap: int = 1500, post_pull: bool = False, post_prune: bool = False,
                keep_assignments: bool = False, progress: Optional[Callable[[Step], None]] = None,
                objective: Objective = "minimax", seed: int = 42) -> List[Step]:
    """Greedy set cover for the Location Set Covering Problem (Toregas et al. 1971)."""
    run = _Runner(H, radius, weight, objective, 120, keep_assignments, progress, seed)
    nodes = run.nodes
    if candidates is None:
        cand = nodes if len(nodes) <= candidate_cap else run.rng.sample(nodes, candidate_cap)
    else:
        cand = list(candidates)
    cover = [set(multi_source_dijkstra(H, [c], weight, cutoff=radius)[0]) for c in cand]
    covered: set = set()
    centers: List[Node] = []
    heap = [(-len(s), i) for i, s in enumerate(cover)]
    heapq.heapify(heap)
    st: Optional[Step] = None
    while len(covered) < len(nodes):
        pick = None
        while heap:
            negg, i = heapq.heappop(heap)
            g = len(cover[i] - covered)
            if g == 0:
                continue
            if not heap or g >= -heap[0][0]:
                pick = i
                break
            heapq.heappush(heap, (-g, i))
        if pick is None:  # fall back: farthest uncovered node
            if st is None:
                st = run.record("init", centers, "no candidates")
            far = st.farthest
            centers = centers + [far]
            covered |= set(multi_source_dijkstra(H, [far], weight, cutoff=radius)[0])
            st = run.record("add", centers, "no candidate covers remaining nodes; add farthest node", added=[far])
            continue
        gain = len(cover[pick] - covered)
        covered |= cover[pick]
        centers = centers + [cand[pick]]
        st = run.record("init" if len(centers) == 1 else "add", centers,
                        f"greedy set cover: +{gain} newly covered, {len(nodes) - len(covered)} left", added=[cand[pick]])
    return run.post(centers, post_pull, post_prune)


def fixed_k(H: nx.Graph, k: int, radius: float, weight: str = "length", objective: Objective = "minimax",
            init: str = "diameter", manual: Optional[Sequence[Node]] = None, exact_limit: int = 120,
            post_prune: bool = False, keep_assignments: bool = False,
            progress: Optional[Callable[[Step], None]] = None, seed: int = 42) -> List[Step]:
    """Network Lloyd / k-medoids with fixed k: pull until convergence, report whether r is met."""
    run = _Runner(H, radius, weight, objective, exact_limit, keep_assignments, progress, seed)
    centers, note = _init(run, init, k, manual)
    while len(centers) < k and init in ("diameter", "single"):
        far, _ = run.farthest(centers)
        centers.append(far)
    st = run.record("init", centers, f"{note}; k={len(centers)}")
    while True:
        nxt, moved = run.pull_once(centers)
        if not moved:
            run.record("final" if st.max_dist <= radius else "stuck", centers,
                       f"converged with k={len(centers)}: max {st.max_dist:.0f} m {'<=' if st.max_dist <= radius else '>'} r")
            break
        centers = nxt
        st = run.record("move", centers, f"{len(moved)} centers pulled", moved=moved)
    return run.post(centers, False, post_prune)


def prune(H: nx.Graph, centers: Sequence[Node], radius: float, weight: str = "length") -> List[Node]:
    """Remove redundant centers (smallest clusters first) while every node stays within radius."""
    run = _Runner(H, radius, weight, "minimax", 120, False, None, 0)
    return run._prune(list(centers))


# --------------------------------------------------------------------------- helpers

def estimate_runtime_seconds(H: nx.Graph, radius: float, algorithm: str = "pull_and_seed") -> float:
    """Order-of-magnitude runtime guess (pure Python is ~10-20x slower than the TS worker)."""
    n, m = H.number_of_nodes(), H.number_of_edges()
    total_len = sum(d.get("length", 0.0) for _, _, d in H.edges(data=True))
    k_est = max(1.0, total_len * 60 / (2 * radius * radius))
    per_dij = (n + m) * 2.5e-6
    if algorithm == "pull_and_seed":
        return 4 * k_est * 5 * per_dij
    if algorithm == "gonzalez":
        return k_est * per_dij
    return 1500 * per_dij * 0.2 + k_est * per_dij


def steps_to_geodataframes(H: nx.Graph, step: Step, weight: str = "length"):
    """(centers_gdf, nodes_gdf) for a step; nodes carry cluster label and distance."""
    import geopandas as gpd
    from shapely.geometry import Point
    crs = H.graph.get("crs", "EPSG:4326")
    if step.label is None or step.dist is None:
        dist, label, _ = multi_source_dijkstra(H, step.centers, weight)
    else:
        dist, label = step.dist, step.label
    centers = gpd.GeoDataFrame(
        {"idx": range(len(step.centers)), "node": [str(c) for c in step.centers]},
        geometry=[Point(H.nodes[c]["x"], H.nodes[c]["y"]) for c in step.centers], crs=crs)
    nodes = gpd.GeoDataFrame(
        {"node": [str(v) for v in H.nodes], "cluster": [label.get(v, -1) for v in H.nodes],
         "dist": [dist.get(v, float("inf")) for v in H.nodes]},
        geometry=[Point(d["x"], d["y"]) for _, d in H.nodes(data=True)], crs=crs)
    return centers, nodes
