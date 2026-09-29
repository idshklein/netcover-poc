/** Loads pre-fetched, gzip-compressed Overpass "walk" networks bundled under public/cities/. */
import type { OverpassJson } from './overpass';

export interface CityManifestEntry {
  slug: string;
  name: string;
  displayName: string;
  bbox: [number, number, number, number]; // west, south, east, north
  rawBytes: number;
  gzBytes: number;
  elements: number;
}

let manifestPromise: Promise<CityManifestEntry[]> | null = null;

export function loadCityManifest(): Promise<CityManifestEntry[]> {
  manifestPromise ??= fetch(`${import.meta.env.BASE_URL}cities/index.json`)
    .then((r) => (r.ok ? (r.json() as Promise<CityManifestEntry[]>) : []))
    .catch(() => []);
  return manifestPromise;
}

/** Fetches and gunzips (via the browser's native DecompressionStream) a cached city's OSM data. */
export async function loadCityOsm(slug: string): Promise<OverpassJson> {
  const res = await fetch(`${import.meta.env.BASE_URL}cities/${slug}.json.gz`);
  if (!res.ok || !res.body) throw new Error(`שגיאה בטעינת קובץ העיר (${res.status})`);
  const stream = res.body.pipeThrough(new DecompressionStream('gzip'));
  return JSON.parse(await new Response(stream).text()) as OverpassJson;
}
