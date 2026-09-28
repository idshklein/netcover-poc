/** Overpass filters replicated from osmnx `_overpass._get_osm_filter` (osmnx 2.x). */
const ACCESS = '["access"!~"private"]';

export const NETWORK_TYPES = {
  drive:
    `["highway"]["area"!~"yes"]${ACCESS}` +
    `["highway"!~"abandoned|bridleway|bus_guideway|busway|construction|corridor|cycleway|elevator|escalator|footway|ladder|path|pedestrian|planned|platform|proposed|raceway|razed|service|steps|track"]` +
    `["motor_vehicle"!~"no"]["motorcar"!~"no"]` +
    `["service"!~"alley|driveway|emergency_access|parking|parking_aisle|private"]`,
  drive_service:
    `["highway"]["area"!~"yes"]${ACCESS}` +
    `["highway"!~"abandoned|bridleway|bus_guideway|busway|construction|corridor|cycleway|elevator|escalator|footway|ladder|path|pedestrian|planned|platform|proposed|raceway|razed|steps|track"]` +
    `["motor_vehicle"!~"no"]["motorcar"!~"no"]` +
    `["service"!~"emergency_access|parking|parking_aisle|private"]`,
  walk:
    `["highway"]["area"!~"yes"]${ACCESS}` +
    `["highway"!~"abandoned|bus_guideway|busway|construction|cycleway|motor|planned|platform|proposed|raceway|razed"]` +
    `["foot"!~"no"]["service"!~"private"]` +
    `["sidewalk"!~"separate"]["sidewalk:both"!~"separate"]["sidewalk:left"!~"separate"]["sidewalk:right"!~"separate"]`,
  bike:
    `["highway"]["area"!~"yes"]${ACCESS}` +
    `["highway"!~"abandoned|bus_guideway|busway|construction|corridor|elevator|escalator|footway|ladder|motor|planned|platform|proposed|raceway|razed|steps"]` +
    `["bicycle"!~"no"]["service"!~"private"]`,
  all:
    `["highway"]["area"!~"yes"]${ACCESS}` +
    `["highway"!~"abandoned|construction|planned|platform|proposed|raceway|razed"]` +
    `["service"!~"private"]`,
  all_public:
    `["highway"]["area"!~"yes"]${ACCESS}` +
    `["highway"!~"abandoned|construction|planned|platform|proposed|raceway|razed"]` +
    `["service"!~"private"]`,
  all_private:
    `["highway"]["area"!~"yes"]` +
    `["highway"!~"abandoned|construction|planned|platform|proposed|raceway|razed"]`,
} as const;

export type NetworkType = keyof typeof NETWORK_TYPES;

export const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];

export interface OsmNode { type: 'node'; id: number; lat: number; lon: number }
export interface OsmWay { type: 'way'; id: number; nodes: number[]; tags?: Record<string, string> }
export interface OverpassJson { elements: Array<OsmNode | OsmWay> }

export type Area =
  | { kind: 'bbox'; south: number; west: number; north: number; east: number }
  | { kind: 'polygon'; rings: number[][][] /* [ring][pt][lon,lat] */; bbox: [number, number, number, number] };

export interface Geocoded {
  displayName: string;
  area: Area;
  bbox: [number, number, number, number]; // west, south, east, north
}

/** Nominatim geocode with polygon (like osmnx.geocode_to_gdf). */
export async function geocodePlace(query: string): Promise<Geocoded> {
  const url = new URL('https://nominatim.openstreetmap.org/search');
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('polygon_geojson', '1');
  url.searchParams.set('limit', '1');
  url.searchParams.set('accept-language', 'he,en');
  const headers: Record<string, string> = { Accept: 'application/json' };
  // browsers set their own UA/Referer; Node needs an identifying UA per Nominatim's usage policy
  if (typeof window === 'undefined') headers['User-Agent'] = 'netcover-poc/0.1 (https://github.com/idshklein)';
  const res = await fetch(url.toString(), { headers });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const arr = (await res.json()) as Array<{
    display_name: string;
    boundingbox: [string, string, string, string]; // south, north, west, east
    geojson?: { type: string; coordinates: unknown };
  }>;
  if (!arr.length) throw new Error(`לא נמצא מקום בשם "${query}"`);
  const r = arr[0];
  const south = +r.boundingbox[0], north = +r.boundingbox[1], west = +r.boundingbox[2], east = +r.boundingbox[3];
  const bbox: [number, number, number, number] = [west, south, east, north];
  let area: Area = { kind: 'bbox', south, west, north, east };
  if (r.geojson && (r.geojson.type === 'Polygon' || r.geojson.type === 'MultiPolygon')) {
    const polys = r.geojson.type === 'Polygon'
      ? [r.geojson.coordinates as number[][][]]
      : (r.geojson.coordinates as number[][][][]);
    // outer rings only, simplified so the Overpass query stays small
    const rings = polys.map((p) => simplifyRing(p[0], 0.0005));
    area = { kind: 'polygon', rings, bbox };
  }
  return { displayName: r.display_name, area, bbox };
}

/** Douglas–Peucker on a lon/lat ring (degrees tolerance). */
export function simplifyRing(ring: number[][], tol: number): number[][] {
  if (ring.length <= 4) return ring;
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, ring.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const d = segDist(ring[i], ring[a], ring[b]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol && idx >= 0) { keep[idx] = 1; stack.push([a, idx], [idx, b]); }
  }
  return ring.filter((_, i) => keep[i] === 1);
}

function segDist(p: number[], a: number[], b: number[]): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  let t = l2 === 0 ? 0 : ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  const x = a[0] + t * dx - p[0], y = a[1] + t * dy - p[1];
  return Math.hypot(x, y);
}

export function buildQuery(area: Area, type: NetworkType, timeout = 180): string {
  const filter = NETWORK_TYPES[type];
  let sel: string;
  if (area.kind === 'bbox') {
    sel = `way${filter}(${area.south},${area.west},${area.north},${area.east});`;
  } else {
    sel = area.rings
      .map((ring) => `way${filter}(poly:"${ring.map((c) => `${c[1].toFixed(6)} ${c[0].toFixed(6)}`).join(' ')}");`)
      .join('');
  }
  return `[out:json][timeout:${timeout}];(${sel});out body;>;out skel qt;`;
}

export async function fetchOverpass(query: string, onStatus?: (s: string) => void): Promise<OverpassJson> {
  let lastErr: unknown;
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
  if (typeof window === 'undefined') headers['User-Agent'] = 'netcover-poc/0.1 (https://github.com/idshklein)';
  for (const ep of OVERPASS_ENDPOINTS) {
    try {
      onStatus?.(`שולח שאילתה ל-${new URL(ep).host} …`);
      const res = await fetch(ep, { method: 'POST', body: 'data=' + encodeURIComponent(query), headers });
      if (!res.ok) throw new Error(`Overpass ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()) as OverpassJson;
    } catch (e) {
      lastErr = e;
      onStatus?.(`${new URL(ep).host}: ${e instanceof Error ? e.message : e}`);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Approximate area in km² of a lon/lat bbox. */
export function bboxAreaKm2(b: [number, number, number, number]): number {
  const [w, s, e, n] = b;
  const midLat = ((s + n) / 2) * Math.PI / 180;
  const dx = (e - w) * 111.32 * Math.cos(midLat);
  const dy = (n - s) * 110.57;
  return Math.abs(dx * dy);
}
