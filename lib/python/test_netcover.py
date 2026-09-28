"""Synthetic-grid test of netcover (no network access needed): python test_netcover.py"""
import random
import time

import networkx as nx

import netcover as nc


def grid(n=40, spacing=100.0, drop=0.15, seed=1):
    rng = random.Random(seed)
    G = nx.Graph()
    for i in range(n):
        for j in range(n):
            G.add_node((i, j), x=j * spacing, y=i * spacing)
    for i in range(n):
        for j in range(n):
            if j + 1 < n and rng.random() > drop:
                G.add_edge((i, j), (i, j + 1), length=spacing)
            if i + 1 < n and rng.random() > drop:
                G.add_edge((i, j), (i + 1, j), length=spacing)
    return G


G = grid()
H = nc.prepare(G, segment_length=60)
print("nodes", H.number_of_nodes(), "edges", H.number_of_edges())
for name, fn in [("pull_and_seed", nc.pull_and_seed), ("gonzalez", nc.gonzalez), ("greedy_lscp", nc.greedy_lscp)]:
    t = time.time()
    steps = fn(H, radius=500)
    last = steps[-1]
    kinds = {}
    for s in steps:
        kinds[s.kind] = kinds.get(s.kind, 0) + 1
    assert last.max_dist <= 500, name
    print(f"{name:14s} {time.time() - t:5.1f}s steps={len(steps):4d} {kinds} k={len(last.centers)} max={last.max_dist:.0f} mean={last.mean_dist:.0f}")
steps = nc.fixed_k(H, k=15, radius=500)
print(f"fixed_k        steps={len(steps)} k={len(steps[-1].centers)} max={steps[-1].max_dist:.0f}")
pruned = nc.prune(H, nc.gonzalez(H, 500)[-1].centers, 500)
print("gonzalez pruned k =", len(pruned))
