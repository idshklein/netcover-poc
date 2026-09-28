"""Demo: Tel Aviv walk network with osmnx -> pull-and-seed -> animated GIF of the steps.

    pip install osmnx matplotlib
    python demo_osmnx.py "Tel Aviv-Yafo, Israel" walk 500
"""
import sys
import time

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import osmnx as ox

import netcover as nc

place = sys.argv[1] if len(sys.argv) > 1 else "Tel Aviv-Yafo, Israel"
net_type = sys.argv[2] if len(sys.argv) > 2 else "drive"
radius = float(sys.argv[3]) if len(sys.argv) > 3 else 500

G = ox.graph_from_place(place, network_type=net_type)          # osmnx downloads + simplifies
G = ox.project_graph(G)                                         # metres (UTM / local CRS)
H = nc.prepare(G, segment_length=150)                           # undirected, largest component, segmentized
print(f"nodes={H.number_of_nodes()} edges={H.number_of_edges()} "
      f"est. runtime ~{nc.estimate_runtime_seconds(H, radius):.0f}s (pure python)")
if nc.estimate_runtime_seconds(H, radius) > 300:
    print("WARNING: this may take several minutes; increase segment_length / radius or use a smaller area")

t = time.time()
steps = nc.pull_and_seed(H, radius, progress=lambda s: print(f"\r{s.kind:6s} k={len(s.centers):4d} max={s.max_dist:7.0f}", end=""))
print(f"\n{len(steps)} steps, {len(steps[-1].centers)} centers, {time.time() - t:.1f}s")

# compare with other methods
for name, fn in [("gonzalez", nc.gonzalez), ("greedy_lscp", nc.greedy_lscp)]:
    t = time.time()
    s = fn(H, radius)
    print(f"{name:12s} k={len(s[-1].centers):4d} max={s[-1].max_dist:.0f} {time.time() - t:.1f}s")

# plot a few frames
centers_gdf, nodes_gdf = nc.steps_to_geodataframes(H, steps[-1])
fig, ax = plt.subplots(figsize=(8, 10))
nodes_gdf.plot(ax=ax, column="cluster", cmap="tab20", markersize=2, categorical=False, legend=False)
centers_gdf.plot(ax=ax, color="black", markersize=25)
ax.set_title(f"{place} – {net_type} – r={radius:.0f} m – {len(steps[-1].centers)} centers")
ax.set_axis_off()
fig.savefig("netcover_final.png", dpi=150, bbox_inches="tight")
print("saved netcover_final.png")
