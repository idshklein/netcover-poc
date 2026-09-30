/**
 * Overture Maps transportation segments queried directly from the public S3 bucket via
 * DuckDB-WASM (runs entirely in the browser, no server component). Replaces Overpass as the
 * live network-download source for "place" and "current map view" modes.
 *
 * Unlike OSM ways, Overture segments already carry routable topology: each segment references
 * shared `connectors` (intersection ids) at fractional positions ("at", 0..1) along its geometry —
 * including *interior* connectors where another segment joins mid-line. We split each segment's
 * polyline at every connector position so no edge crosses an intersection.
 */
import type { EdgeInput } from './graph';
import { polylineLength, sliceAtDistances } from './geo';
import type { Work } from './osm';
import type { NetworkType } from './overpass';

const RELEASE = '2026-08-19.0';
const BUCKET = `s3://overturemaps-us-west-2/release/${RELEASE}/theme=transportation/type=segment/*`;

/** Overture `class` values to exclude per network type (approximation of the osmnx/Overpass filters). */
const CLASS_EXCLUDE: Record<NetworkType, string[]> = {
  walk: ['motorway', 'motorway_link', 'trunk', 'trunk_link', 'raceway'],
  drive: ['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'track', 'bridleway', 'raceway'],
  drive_service: ['footway', 'path', 'pedestrian', 'steps', 'cycleway', 'track', 'bridleway', 'raceway'],
  bike: ['footway', 'steps', 'motorway', 'motorway_link', 'raceway'],
  all: ['raceway'],
  all_public: ['raceway'],
  all_private: ['raceway'],
};

export interface OvertureRow {
  id: string;
  roadClass: string | null;
  connectorIds: string[];
  connectorAts: number[];
  /** flat [lon,lat,lon,lat,...] */
  coords: number[];
}

/** Parses a WKT `LINESTRING (lon lat, lon lat, ...)` into a flat [lon,lat,...] array. */
export function parseLineStringWkt(wkt: string): number[] {
  const m = /LINESTRING\s*\(([^)]*)\)/i.exec(wkt);
  if (!m) throw new Error(`unexpected geometry WKT: ${wkt.slice(0, 40)}`);
  const coords: number[] = [];
  for (const pair of m[1].split(',')) {
    const [lon, lat] = pair.trim().split(/\s+/).map(Number);
    coords.push(lon, lat);
  }
  return coords;
}

export function buildOvertureQuery(bbox: [number, number, number, number], type: NetworkType, limit?: number): string {
  const [west, south, east, north] = bbox;
  const exclude = CLASS_EXCLUDE[type];
  const classFilter = exclude.length ? ` AND (class IS NULL OR class NOT IN (${exclude.map((c) => `'${c}'`).join(', ')}))` : '';
  return `
    SELECT
      id,
      class AS road_class,
      list_transform(connectors, x -> x.connector_id) AS connector_ids,
      list_transform(connectors, x -> x.at) AS connector_ats,
      ST_AsText(geometry) AS wkt
    FROM read_parquet('${BUCKET}', filename=true, hive_partitioning=1)
    WHERE subtype = 'road'
      AND bbox.xmin <= ${east} AND bbox.xmax >= ${west}
      AND bbox.ymin <= ${north} AND bbox.ymax >= ${south}${classFilter}
    ${limit ? `LIMIT ${limit}` : ''}
  `.trim();
}

/** Converts Overture segments (with resolved connector topology) into the generic `Work` graph input. */
export function overtureRowsToWork(rows: OvertureRow[]): Work {
  const lon: number[] = [], lat: number[] = [], osmId: number[] = [];
  const nodeIdx = new Map<string, number>();
  const nodeOf = (id: string, plon: number, plat: number): number => {
    let i = nodeIdx.get(id);
    if (i === undefined) { i = lon.length; nodeIdx.set(id, i); lon.push(plon); lat.push(plat); osmId.push(0); }
    return i;
  };
  const edges: EdgeInput[] = [];
  for (const row of rows) {
    const { coords, connectorIds, connectorAts } = row;
    if (connectorIds.length < 2 || coords.length < 4) continue;
    // sort connectors by position along the line (they're usually already sorted, but don't assume)
    const order = connectorIds.map((_, i) => i).sort((a, b) => connectorAts[a] - connectorAts[b]);
    const total = polylineLength(coords);
    const cuts: number[] = [];
    for (let k = 1; k < order.length - 1; k++) cuts.push(connectorAts[order[k]] * total);
    const pieces = cuts.length ? sliceAtDistances(coords, cuts) : [coords.slice()];
    for (let k = 0; k < pieces.length; k++) {
      const geom = pieces[k];
      const idA = connectorIds[order[k]], idB = connectorIds[order[k + 1]];
      const u = nodeOf(idA, geom[0], geom[1]);
      const v = nodeOf(idB, geom[geom.length - 2], geom[geom.length - 1]);
      if (u === v) continue;
      const len = polylineLength(geom);
      if (len <= 0) continue;
      edges.push({ u, v, geom, len });
    }
  }
  return { lon, lat, osmId, edges };
}

let dbPromise: Promise<import('@duckdb/duckdb-wasm').AsyncDuckDB> | null = null;

async function getDb() {
  dbPromise ??= (async () => {
    const duckdb = await import('@duckdb/duckdb-wasm');
    const bundles = duckdb.getJsDelivrBundles();
    const bundle = await duckdb.selectBundle(bundles);
    const workerUrl = URL.createObjectURL(new Blob([`importScripts("${bundle.mainWorker}");`], { type: 'text/javascript' }));
    const worker = new Worker(workerUrl);
    const logger = new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING);
    const db = new duckdb.AsyncDuckDB(logger, worker);
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
    URL.revokeObjectURL(workerUrl);
    const conn = await db.connect();
    await conn.query(`INSTALL httpfs; LOAD httpfs; SET s3_region='us-west-2';`);
    await conn.close();
    return db;
  })();
  return dbPromise;
}

/** Runs the Overture bbox query in-browser and returns parsed rows ready for `overtureRowsToWork`. */
export async function fetchOverture(bbox: [number, number, number, number], type: NetworkType, onStatus?: (s: string) => void): Promise<OvertureRow[]> {
  onStatus?.('מאתחל DuckDB-WASM…');
  const db = await getDb();
  const conn = await db.connect();
  try {
    onStatus?.(`שולח שאילתת Overture (S3, ${type})…`);
    const query = buildOvertureQuery(bbox, type);
    const result = await conn.query(query);
    const rows: OvertureRow[] = [];
    for (const rec of result.toArray()) {
      const o = rec.toJSON() as { id: string; road_class: string | null; connector_ids: string[]; connector_ats: number[]; wkt: string };
      rows.push({ id: o.id, roadClass: o.road_class, connectorIds: Array.from(o.connector_ids ?? []), connectorAts: Array.from(o.connector_ats ?? []).map(Number), coords: parseLineStringWkt(o.wkt) });
    }
    return rows;
  } finally {
    await conn.close();
  }
}
