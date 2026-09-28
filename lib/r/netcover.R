# netcover.R — inverse-isochrone network coverage for sfnetworks / igraph
#
# Same algorithms as the web POC and the Python package:
#   nc_pull_and_seed()  proposed algorithm: pull centers to the 1-center (minimax) or
#                       1-median (minisum) of their network-Voronoi cell; when no center
#                       moves, add a center at the farthest node; repeat until max <= r
#   nc_gonzalez()       farthest-first traversal (Gonzalez 1985)
#   nc_greedy_lscp()    greedy set cover (Toregas 1971)
#   nc_prune()          drop redundant centers
#   nc_prepare()        undirected, largest component, segmentized sfnetwork (metres)
#   nc_plot_step()      ggplot of one step; nc_animate() writes PNG frames for a GIF
#
# Every algorithm returns a list of steps: list(kind, centers, max_dist, mean_dist, covered,
# farthest, note, moved, added, removed) so the process can be animated (cf. reference repo).

suppressPackageStartupMessages({
  library(sf); library(sfnetworks); library(igraph); library(tidygraph); library(dplyr)
})

# ----------------------------------------------------------------------------- preparation

#' @param lines sf LINESTRING layer (e.g. osmdata$osm_lines or an osmnx edges layer)
#' @param crs   projected CRS in metres (2039 = Israel TM Grid)
#' @param segment_length split edges so that nodes occur at least every `segment_length` m (0 = off)
nc_prepare <- function(lines, crs = 2039, segment_length = 150, simplify = TRUE) {
  l <- lines %>% st_transform(crs) %>% select() %>% st_cast("LINESTRING")
  net <- as_sfnetwork(l, directed = FALSE) %>%
    convert(to_spatial_subdivision, .clean = TRUE)                   # split at interior intersections
  if (simplify) net <- net %>% convert(to_spatial_smooth, .clean = TRUE)  # osmnx-like: merge degree-2 nodes
  if (segment_length > 0) {
    pts <- net %>% activate(edges) %>% st_as_sf() %>% st_geometry() %>%
      st_line_sample(density = 1 / segment_length) %>% st_cast("POINT")
    pts <- pts[!st_is_empty(pts)]
    net <- st_network_blend(net, pts, tolerance = 0.1)               # as in the reference implementation
  }
  net <- net %>% activate(nodes) %>%
    filter(group_components() == 1) %>%                              # largest component (tidygraph orders by size)
    activate(edges) %>% filter(!edge_is_multiple(), !edge_is_loop()) %>%
    mutate(weight = as.numeric(st_length(geometry))) %>%
    activate(nodes)
  net
}

# ----------------------------------------------------------------------------- core helpers

.nc_assign <- function(g, centers) {
  # k x n matrix of network distances; label = index of nearest center
  D <- igraph::distances(g, v = centers, to = igraph::V(g), weights = igraph::E(g)$weight)
  lab <- apply(D, 2, which.min)
  dist <- D[cbind(lab, seq_len(ncol(D)))]
  list(D = D, label = as.integer(lab), dist = as.numeric(dist))
}

.nc_one_center_lazy <- function(g, members, cur, cur_dist, max_iter = 12) {
  # exact 1-center (full-graph distances) with lazy lower bounds; each round = 2 single-source Dijkstras in C
  w <- igraph::E(g)$weight
  best <- cur; best_ecc <- max(cur_dist[members]); farthest <- members[which.max(cur_dist[members])]
  lb <- setNames(numeric(length(members)), members)
  for (it in seq_len(max_iter)) {
    df <- igraph::distances(g, v = farthest, to = members, weights = w)[1, ]
    lb <- pmax(lb, df)
    i <- which.min(lb)
    if (lb[i] >= best_ecc - 1e-9) break
    cand <- members[i]
    dc <- igraph::distances(g, v = cand, to = members, weights = w)[1, ]
    ecc <- max(dc); farthest <- members[which.max(dc)]
    if (ecc < best_ecc - 1e-9) { best <- cand; best_ecc <- ecc } else lb[i] <- max(lb[i], ecc)
  }
  best
}

.nc_one_median <- function(g, members, cur, cur_dist, exact_limit = 120) {
  w <- igraph::E(g)$weight
  if (length(members) <= exact_limit) {
    sub <- igraph::induced_subgraph(g, members)
    D <- igraph::distances(sub, weights = igraph::E(sub)$weight)
    s <- rowSums(ifelse(is.finite(D), D, 1e12))
    cur_sum <- sum(cur_dist[members])
    j <- which.min(s)
    return(if (s[j] < cur_sum - 1e-9) members[j] else cur)
  }
  # heuristic for big clusters: evaluate a random sample of candidates on the full graph
  cand <- unique(c(cur, sample(members, min(40, length(members)))))
  D <- igraph::distances(g, v = cand, to = members, weights = w)
  cand[which.min(rowSums(D))]
}

.nc_record <- function(state, kind, centers, note = "", moved = NULL, added = NULL, removed = NULL) {
  a <- .nc_assign(state$g, centers)
  far <- which.max(a$dist)
  step <- list(kind = kind, centers = centers, max_dist = a$dist[far], mean_dist = mean(a$dist),
               covered = mean(a$dist <= state$r), farthest = far, note = note,
               moved = moved, added = added, removed = removed, label = a$label, dist = a$dist)
  state$steps[[length(state$steps) + 1]] <- step
  if (state$verbose) cat(sprintf("\r%-6s k=%4d max=%8.0f", kind, length(centers), step$max_dist))
  state$last <- step
  state
}

.nc_pull_once <- function(state, centers, objective) {
  last <- state$last
  k <- length(centers)
  dirty <- if (is.null(state$prev_label)) rep(TRUE, k) else {
    d <- rep(FALSE, k); ch <- which(state$prev_label != last$label)
    d[unique(c(state$prev_label[ch], last$label[ch]))] <- TRUE; d
  }
  nxt <- centers; moved <- list()
  for (c in seq_len(k)) {
    members <- which(last$label == c)
    if (!dirty[c] || length(members) <= 1) next
    new <- if (objective == "minimax") .nc_one_center_lazy(state$g, members, centers[c], last$dist)
           else .nc_one_median(state$g, members, centers[c], last$dist)
    if (new != centers[c]) { nxt[c] <- new; moved[[length(moved) + 1]] <- c(centers[c], new) }
  }
  state$prev_label <- last$label
  list(state = state, next_centers = nxt, moved = moved)
}

.nc_state <- function(net, radius, verbose) {
  g <- as.igraph(net)
  if (is.null(igraph::E(g)$weight)) igraph::E(g)$weight <- as.numeric(st_length(st_as_sf(activate(net, "edges"))))
  list(g = g, r = radius, steps = list(), prev_label = NULL, last = NULL, verbose = verbose)
}

.nc_diameter_endpoints <- function(g) {
  w <- igraph::E(g)$weight
  a0 <- which.max(igraph::distances(g, v = 1, weights = w)[1, ])
  b  <- which.max(igraph::distances(g, v = a0, weights = w)[1, ])
  da <- igraph::distances(g, v = b, weights = w)[1, ]
  a  <- which.max(da)
  c(a, b, da[a])
}

.nc_post <- function(state, centers, post_pull, post_prune, objective) {
  if (post_pull) repeat {
    p <- .nc_pull_once(state, centers, objective); state <- p$state
    if (length(p$moved) == 0) break
    centers <- p$next_centers
    state <- .nc_record(state, "move", centers, sprintf("post-pull: %d centers moved", length(p$moved)), moved = p$moved)
  }
  if (post_prune && length(centers) > 1) {
    sizes <- tabulate(state$last$label, nbins = length(centers))
    alive <- rep(TRUE, length(centers))
    for (i in order(sizes)) {
      alive[i] <- FALSE
      trial <- centers[alive]
      d <- .nc_assign(state$g, trial)$dist
      if (max(d) <= state$r) state <- .nc_record(state, "remove", trial, "prune: redundant center", removed = centers[i])
      else alive[i] <- TRUE
    }
    centers <- centers[alive]
  }
  state <- .nc_record(state, "final", centers, sprintf("done: %d centers", length(centers)))
  if (state$verbose) cat("\n")
  state$steps
}

# ----------------------------------------------------------------------------- algorithms

#' Proposed algorithm. `init`: "diameter" (2 centers at the diameter endpoints, like the reference),
#' "single", "random" (k), or a vector of node indices.
nc_pull_and_seed <- function(net, radius, objective = c("minimax", "minisum"), init = "diameter", k = 2,
                             post_pull = FALSE, post_prune = FALSE, max_steps = 5000, verbose = TRUE) {
  objective <- match.arg(objective)
  st <- .nc_state(net, radius, verbose)
  if (is.numeric(init)) { centers <- unique(init); note <- "manual init" }
  else if (init == "random") { centers <- sample(igraph::vcount(st$g), k); note <- sprintf("random init k=%d", k) }
  else {
    de <- .nc_diameter_endpoints(st$g)
    if (init == "single") {
      w <- igraph::E(st$g)$weight
      D <- igraph::distances(st$g, v = de[1:2], weights = w)
      centers <- which.min(apply(D, 2, max)); note <- "init at approximate graph center"
    } else { centers <- de[1:2]; note <- sprintf("init at diameter endpoints (%.0f m)", de[3]) }
  }
  st <- .nc_record(st, "init", centers, note)
  while (st$last$max_dist > radius && length(st$steps) < max_steps) {
    p <- .nc_pull_once(st, centers, objective); st <- p$state
    if (length(p$moved) == 0) {
      st <- .nc_record(st, "stuck", centers, sprintf("no center moved; max %.0f > r", st$last$max_dist))
      far <- st$last$farthest
      centers <- c(centers, far)
      st <- .nc_record(st, "add", centers, sprintf("add center #%d at farthest node", length(centers)), added = far)
    } else {
      centers <- p$next_centers
      st <- .nc_record(st, "move", centers, sprintf("%d centers pulled", length(p$moved)), moved = p$moved)
    }
  }
  .nc_post(st, centers, post_pull, post_prune, objective)
}

nc_gonzalez <- function(net, radius, post_pull = FALSE, post_prune = FALSE, verbose = TRUE) {
  st <- .nc_state(net, radius, verbose)
  centers <- .nc_diameter_endpoints(st$g)[1]
  st <- .nc_record(st, "init", centers, "Gonzalez farthest-first")
  while (st$last$max_dist > radius) {
    far <- st$last$farthest; centers <- c(centers, far)
    st <- .nc_record(st, "add", centers, "add farthest node", added = far)
  }
  .nc_post(st, centers, post_pull, post_prune, "minimax")
}

nc_greedy_lscp <- function(net, radius, candidate_cap = 1500, post_pull = FALSE, post_prune = FALSE, verbose = TRUE) {
  st <- .nc_state(net, radius, verbose)
  n <- igraph::vcount(st$g); w <- igraph::E(st$g)$weight
  cand <- if (n <= candidate_cap) seq_len(n) else sample(n, candidate_cap)
  D <- igraph::distances(st$g, v = cand, weights = w)          # candidates x nodes
  cov <- D <= radius
  covered <- rep(FALSE, n); centers <- integer(0)
  while (!all(covered)) {
    gain <- rowSums(cov[, !covered, drop = FALSE])
    i <- which.max(gain)
    if (gain[i] == 0) {                                          # fallback: farthest uncovered
      far <- if (length(centers)) st$last$farthest else which(!covered)[1]
      centers <- c(centers, far)
      covered <- covered | (igraph::distances(st$g, v = far, weights = w)[1, ] <= radius)
      st <- .nc_record(st, "add", centers, "fallback: farthest uncovered node", added = far); next
    }
    covered <- covered | cov[i, ]; centers <- c(centers, cand[i])
    st <- .nc_record(st, if (length(centers) == 1) "init" else "add", centers,
                     sprintf("greedy set cover: +%d, %d left", gain[i], sum(!covered)), added = cand[i])
  }
  .nc_post(st, centers, post_pull, post_prune, "minimax")
}

nc_prune <- function(net, centers, radius) {
  st <- .nc_state(net, radius, FALSE)
  st <- .nc_record(st, "init", centers)
  tail(.nc_post(st, centers, FALSE, TRUE, "minimax"), 1)[[1]]$centers
}

# ----------------------------------------------------------------------------- output

nc_step_sf <- function(net, step) {
  nodes <- net %>% activate(nodes) %>% st_as_sf() %>%
    mutate(cluster = factor(step$label), dist = step$dist, covered = dist <= max(step$dist[step$centers]) )
  edges <- net %>% activate(edges) %>% st_as_sf() %>%
    mutate(cluster = factor(step$label[ifelse(step$dist[from] <= step$dist[to], from, to)]),
           dist = pmax(step$dist[from], step$dist[to]))
  centers <- nodes[step$centers, ] %>% mutate(idx = seq_along(step$centers))
  list(nodes = nodes, edges = edges, centers = centers)
}

nc_plot_step <- function(net, step, i = NULL, radius = NULL) {
  requireNamespace("ggplot2")
  s <- nc_step_sf(net, step)
  p <- ggplot2::ggplot() +
    ggplot2::geom_sf(data = s$edges, ggplot2::aes(color = cluster), linewidth = 0.4, show.legend = FALSE) +
    ggplot2::geom_sf(data = s$centers, color = "black", size = 2.5)
  if (!is.null(step$added)) p <- p + ggplot2::geom_sf(data = s$nodes[step$added, ], shape = 21, size = 6, color = "black", stroke = 1.2)
  if (step$kind %in% c("stuck", "add")) p <- p + ggplot2::geom_sf(data = s$nodes[step$farthest, ], shape = 21, size = 7, color = "red", stroke = 1.5)
  p + ggplot2::ggtitle(sprintf("%s%s · k=%d · max=%.0f m%s", if (is.null(i)) "" else paste0(i, ": "), step$kind,
                               length(step$centers), step$max_dist, if (is.null(radius)) "" else sprintf(" · r=%.0f", radius))) +
    ggplot2::theme_void()
}

#' Write one PNG per step (then e.g. gifski::gifski(list.files(dir, full.names = TRUE), "steps.gif"))
nc_animate <- function(net, steps, dir = "frames", radius = NULL, every = 1, width = 1600, height = 1600) {
  dir.create(dir, showWarnings = FALSE)
  idx <- seq(1, length(steps), by = every)
  if (tail(idx, 1) != length(steps)) idx <- c(idx, length(steps))
  for (i in idx) ggplot2::ggsave(file.path(dir, sprintf("%05d.png", i)), nc_plot_step(net, steps[[i]], i, radius),
                                 width = width / 300, height = height / 300, dpi = 300, bg = "white")
  invisible(list.files(dir, full.names = TRUE))
}
