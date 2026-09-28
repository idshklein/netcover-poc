# Demo: Tel Aviv network from OSM (osmdata) -> sfnetworks -> pull-and-seed -> frames/GIF
# Rscript demo_tlv.R [radius] [segment_length]
source("netcover.R")
library(osmdata)
args <- commandArgs(trailingOnly = TRUE)
radius <- if (length(args) >= 1) as.numeric(args[1]) else 500
seglen <- if (length(args) >= 2) as.numeric(args[2]) else 150

# city polygon (relation 1382494 = Tel Aviv-Yafo, as in the reference repo)
tlv <- opq_osm_id(type = "relation", id = "1382494") %>% opq_string() %>% osmdata_sf()
poly <- tlv$osm_multipolygons %>% st_transform(4326)

# osmnx "drive" filter, expressed with osmdata (highway=* minus non-drivable classes)
excluded <- c("abandoned", "bridleway", "bus_guideway", "busway", "construction", "corridor", "cycleway", "elevator",
              "escalator", "footway", "ladder", "path", "pedestrian", "planned", "platform", "proposed", "raceway",
              "razed", "service", "steps", "track")
q <- opq(bbox = st_bbox(poly), timeout = 180) %>% add_osm_feature(key = "highway")
osm <- osmdata_sf(q)
lines <- osm$osm_lines %>%
  filter(!highway %in% excluded, is.na(area) | area != "yes", is.na(access) | access != "private") %>%
  st_intersection(st_geometry(poly))

net <- nc_prepare(lines, crs = 2039, segment_length = seglen)
n <- igraph::vcount(as.igraph(net)); cat("nodes", n, "\n")
if (n > 30000) message("large network: the R implementation may take many minutes; increase segment_length or radius")

steps <- nc_pull_and_seed(net, radius)
cat(sprintf("\n%d steps, %d centers\n", length(steps), length(steps[[length(steps)]]$centers)))
g <- nc_gonzalez(net, radius, verbose = FALSE);  cat("gonzalez k =", length(g[[length(g)]]$centers), "\n")
l <- nc_greedy_lscp(net, radius, verbose = FALSE); cat("greedy lscp k =", length(l[[length(l)]]$centers), "\n")

frames <- nc_animate(net, steps, dir = "frames", radius = radius, every = max(1, length(steps) %/% 150))
if (requireNamespace("gifski", quietly = TRUE)) gifski::gifski(frames, "tlv_pull_and_seed.gif", width = 1600, height = 1600, delay = 0.15)
res <- nc_step_sf(net, steps[[length(steps)]])
st_write(res$centers, "tlv_centers.gpkg", delete_dsn = TRUE, quiet = TRUE)
st_write(res$edges, "tlv_edges.gpkg", delete_dsn = TRUE, quiet = TRUE)
