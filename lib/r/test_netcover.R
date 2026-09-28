# Synthetic-grid test of netcover.R (no downloads): Rscript test_netcover.R
source("netcover.R")
set.seed(1)
n <- 30; sp <- 100
pts <- expand.grid(x = 0:(n - 1) * sp, y = 0:(n - 1) * sp)
seg <- function(x1, y1, x2, y2) st_linestring(rbind(c(x1, y1), c(x2, y2)))
lines <- list()
for (i in 0:(n - 1)) for (j in 0:(n - 1)) {
  if (j < n - 1 && runif(1) > 0.15) lines[[length(lines) + 1]] <- seg(j * sp, i * sp, (j + 1) * sp, i * sp)
  if (i < n - 1 && runif(1) > 0.15) lines[[length(lines) + 1]] <- seg(j * sp, i * sp, j * sp, (i + 1) * sp)
}
l <- st_sf(geometry = st_sfc(lines, crs = 2039))
net <- nc_prepare(l, crs = 2039, segment_length = 60, simplify = TRUE)
cat("nodes", igraph::vcount(as.igraph(net)), "edges", igraph::ecount(as.igraph(net)), "\n")

t <- Sys.time(); s1 <- nc_pull_and_seed(net, 500, verbose = FALSE)
cat(sprintf("pull_and_seed %.1fs steps=%d k=%d max=%.0f\n", as.numeric(Sys.time() - t, units = "secs"), length(s1), length(s1[[length(s1)]]$centers), s1[[length(s1)]]$max_dist))
t <- Sys.time(); s2 <- nc_gonzalez(net, 500, verbose = FALSE)
cat(sprintf("gonzalez      %.1fs steps=%d k=%d max=%.0f\n", as.numeric(Sys.time() - t, units = "secs"), length(s2), length(s2[[length(s2)]]$centers), s2[[length(s2)]]$max_dist))
t <- Sys.time(); s3 <- nc_greedy_lscp(net, 500, verbose = FALSE)
cat(sprintf("greedy_lscp   %.1fs steps=%d k=%d max=%.0f\n", as.numeric(Sys.time() - t, units = "secs"), length(s3), length(s3[[length(s3)]]$centers), s3[[length(s3)]]$max_dist))
stopifnot(s1[[length(s1)]]$max_dist <= 500, s2[[length(s2)]]$max_dist <= 500, s3[[length(s3)]]$max_dist <= 500)
if (requireNamespace("ggplot2", quietly = TRUE)) {
  ggplot2::ggsave("test_final.png", nc_plot_step(net, s1[[length(s1)]], length(s1), 500), width = 6, height = 6, dpi = 120, bg = "white")
  cat("saved test_final.png\n")
}
