/** Distinct-ish colour for cluster index (golden-angle hue walk with 3 lightness bands). */
export function clusterColor(i: number): string {
  if (i < 0) return '#bbbbbb';
  const h = (i * 137.508) % 360;
  const band = i % 3;
  const s = 70 - band * 10;
  const l = 42 + band * 9;
  return `hsl(${h.toFixed(1)},${s}%,${l}%)`;
}

/** Green (0) → yellow (r) → red (≥1.5r) for distance colouring. */
export function distanceColor(d: number, r: number): string {
  if (!isFinite(d)) return '#000';
  const t = Math.min(d / (1.5 * r), 1);
  // 0 → #1a9850, 0.667 (=r) → #ffffbf, 1 → #d73027
  const stops: Array<[number, [number, number, number]]> = [
    [0, [26, 152, 80]],
    [2 / 3, [255, 255, 191]],
    [1, [215, 48, 39]],
  ];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i];
      const u = (t - t0) / (t1 - t0);
      const c = c0.map((a, k) => Math.round(a + (c1[k] - a) * u));
      return `rgb(${c[0]},${c[1]},${c[2]})`;
    }
  }
  return '#d73027';
}
