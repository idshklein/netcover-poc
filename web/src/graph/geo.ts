export const EARTH_R = 6371008.8;

export function haversine(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_R * Math.asin(Math.sqrt(a));
}

/** Length of a flat [lon,lat,lon,lat,...] polyline in meters. */
export function polylineLength(coords: ArrayLike<number>): number {
  let s = 0;
  for (let i = 2; i < coords.length; i += 2) {
    s += haversine(coords[i - 2], coords[i - 1], coords[i], coords[i + 1]);
  }
  return s;
}

/** Point at a given distance (m) along the polyline; returns [lon,lat]. */
export function pointAlong(coords: ArrayLike<number>, d: number): [number, number] {
  let acc = 0;
  for (let i = 2; i < coords.length; i += 2) {
    const seg = haversine(coords[i - 2], coords[i - 1], coords[i], coords[i + 1]);
    if (acc + seg >= d || i + 2 >= coords.length) {
      const t = seg === 0 ? 0 : Math.min(1, Math.max(0, (d - acc) / seg));
      return [
        coords[i - 2] + (coords[i] - coords[i - 2]) * t,
        coords[i - 1] + (coords[i + 1] - coords[i - 1]) * t,
      ];
    }
    acc += seg;
  }
  return [coords[0], coords[1]];
}

/** Split a polyline into `parts` equal-length pieces. Returns array of flat coordinate arrays. */
export function splitPolyline(coords: ArrayLike<number>, parts: number): number[][] {
  const total = polylineLength(coords);
  const out: number[][] = [];
  let cur: number[] = [coords[0], coords[1]];
  let acc = 0;
  let nextCut = total / parts;
  let cutIdx = 1;
  for (let i = 2; i < coords.length; i += 2) {
    const ax = coords[i - 2], ay = coords[i - 1], bx = coords[i], by = coords[i + 1];
    const seg = haversine(ax, ay, bx, by);
    while (cutIdx < parts && acc + seg >= nextCut && seg > 0) {
      const t = (nextCut - acc) / seg;
      const px = ax + (bx - ax) * t, py = ay + (by - ay) * t;
      cur.push(px, py);
      out.push(cur);
      cur = [px, py];
      cutIdx++;
      nextCut = (total * cutIdx) / parts;
    }
    cur.push(bx, by);
    acc += seg;
  }
  out.push(cur);
  while (out.length < parts) out.push([cur[cur.length - 2], cur[cur.length - 1], cur[cur.length - 2], cur[cur.length - 1]]);
  return out;
}
