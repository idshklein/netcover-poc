import maplibregl, { Map as MlMap, type GeoJSONSource } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Graph } from './graph/graph';
import type { Step } from './algo/algorithms';
import { clusterColor, distanceColor } from './palette';

export type ColorMode = 'cluster' | 'distance';

export class NetMap {
  map: MlMap;
  private graph: Graph | null = null;
  private ready: Promise<void>;
  onClick: ((lng: number, lat: number) => void) | null = null;

  constructor(container: string) {
    this.map = new maplibregl.Map({
      container,
      style: {
        version: 8,
        glyphs: 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf',
        sources: {
          osm: {
            type: 'raster',
            tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
            tileSize: 256,
            maxzoom: 19,
            attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
          },
        },
        // black & white basemap so the network colouring stands out
        layers: [{ id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-saturation': -1, 'raster-contrast': 0.1, 'raster-opacity': 0.9 } }],
      },
      center: [34.78, 32.08],
      zoom: 12,
      attributionControl: false,
    });
    this.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-left');
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');
    this.ready = new Promise((res) => this.map.on('load', () => { this.addLayers(); res(); }));
    this.map.on('click', (e) => this.onClick?.(e.lngLat.lng, e.lngLat.lat));
  }

  whenReady() { return this.ready; }

  private addLayers() {
    const m = this.map;
    const empty = { type: 'FeatureCollection', features: [] } as GeoJSON.FeatureCollection;
    m.addSource('edges', { type: 'geojson', data: empty });
    m.addSource('centers', { type: 'geojson', data: empty });
    m.addSource('moves', { type: 'geojson', data: empty });
    m.addSource('marks', { type: 'geojson', data: empty });
    m.addSource('manual', { type: 'geojson', data: empty });
    m.addSource('area', { type: 'geojson', data: empty });

    m.addLayer({ id: 'area', type: 'line', source: 'area', paint: { 'line-color': '#333', 'line-width': 1.5, 'line-dasharray': [3, 2] } });
    m.addLayer({
      id: 'edges', type: 'line', source: 'edges',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: {
        'line-color': ['coalesce', ['feature-state', 'c'], '#9a9a9a'],
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.6, 13, 1.6, 16, 3.5],
        'line-opacity': 0.9,
      },
    });
    m.addLayer({
      id: 'uncovered', type: 'line', source: 'edges',
      layout: { 'line-cap': 'round' },
      paint: {
        'line-color': '#c00',
        'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 13, 3, 16, 6],
        'line-opacity': ['case', ['==', ['coalesce', ['feature-state', 'u'], 0], 1], 0.35, 0],
      },
    });
    m.addLayer({
      id: 'moves', type: 'line', source: 'moves',
      paint: { 'line-color': '#111', 'line-width': 2, 'line-dasharray': [1, 1] },
    });
    m.addLayer({
      id: 'moves-from', type: 'circle', source: 'moves', filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 5, 'circle-color': 'rgba(0,0,0,0)', 'circle-stroke-color': '#111', 'circle-stroke-width': 1.5 },
    });
    m.addLayer({
      id: 'marks', type: 'circle', source: 'marks',
      paint: {
        'circle-radius': ['case', ['==', ['get', 'kind'], 'farthest'], 11, 9],
        'circle-color': 'rgba(0,0,0,0)',
        'circle-stroke-color': ['case', ['==', ['get', 'kind'], 'farthest'], '#d7191c', '#111'],
        'circle-stroke-width': 3,
      },
    });
    m.addLayer({
      id: 'centers', type: 'circle', source: 'centers',
      paint: { 'circle-radius': 6, 'circle-color': ['get', 'color'], 'circle-stroke-color': '#000', 'circle-stroke-width': 1.5 },
    });
    m.addLayer({
      id: 'centers-label', type: 'symbol', source: 'centers', minzoom: 13,
      layout: { 'text-field': ['to-string', ['get', 'idx']], 'text-size': 11, 'text-offset': [0, -1.2], 'text-font': ['Noto Sans Regular'] },
      paint: { 'text-halo-color': '#fff', 'text-halo-width': 1.2 },
    });
    m.addLayer({
      id: 'manual', type: 'circle', source: 'manual',
      paint: { 'circle-radius': 7, 'circle-color': '#ff9800', 'circle-stroke-color': '#000', 'circle-stroke-width': 1.5 },
    });
  }

  setArea(geojson: GeoJSON.FeatureCollection | null) {
    (this.map.getSource('area') as GeoJSONSource).setData(geojson ?? { type: 'FeatureCollection', features: [] });
  }

  setGraph(g: Graph) {
    this.graph = g;
    const features: GeoJSON.Feature[] = new Array(g.m);
    for (let e = 0; e < g.m; e++) {
      const geom = g.egeom[e];
      const coords: number[][] = [];
      for (let i = 0; i < geom.length; i += 2) coords.push([geom[i], geom[i + 1]]);
      features[e] = { type: 'Feature', id: e, geometry: { type: 'LineString', coordinates: coords }, properties: {} };
    }
    (this.map.getSource('edges') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
    this.map.removeFeatureState({ source: 'edges' });
    this.clearStep();
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (let i = 0; i < g.n; i++) { w = Math.min(w, g.lon[i]); e = Math.max(e, g.lon[i]); s = Math.min(s, g.lat[i]); n = Math.max(n, g.lat[i]); }
    if (g.n) this.map.fitBounds([[w, s], [e, n]], { padding: 40, duration: 600 });
  }

  clearStep() {
    for (const s of ['centers', 'moves', 'marks']) (this.map.getSource(s) as GeoJSONSource).setData({ type: 'FeatureCollection', features: [] });
  }

  setManual(nodes: number[]) {
    const g = this.graph;
    const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: g ? nodes.map((v) => pt(g, v, {})) : [] };
    (this.map.getSource('manual') as GeoJSONSource).setData(fc);
  }

  /** Colour edges & draw centers for a step, given the node assignment. */
  renderStep(step: Step, label: Int32Array, dist: Float64Array, mode: ColorMode, radius: number, showMoves: boolean) {
    const g = this.graph;
    if (!g) return;
    const m = this.map;
    const colors = mode === 'cluster' ? Array.from(step.centers, (_, i) => clusterColor(i)) : null;
    for (let e = 0; e < g.m; e++) {
      const u = g.eu[e], v = g.ev[e];
      const du = dist[u], dv = dist[v];
      // colour by the endpoint nearer to its center (edge belongs mostly to that cell)
      const rep = du <= dv ? u : v;
      const c = colors ? colors[label[rep]] ?? '#bbb' : distanceColor(Math.max(du, dv), radius);
      m.setFeatureState({ source: 'edges', id: e }, { c, u: Math.min(du, dv) > radius ? 1 : 0 });
    }
    const centers: GeoJSON.Feature[] = Array.from(step.centers, (v, i) => pt(g, v, { idx: i, color: clusterColor(i) }));
    (m.getSource('centers') as GeoJSONSource).setData({ type: 'FeatureCollection', features: centers });

    const moves: GeoJSON.Feature[] = [];
    if (showMoves && step.moved) {
      for (const [from, to] of step.moved) {
        moves.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[g.lon[from], g.lat[from]], [g.lon[to], g.lat[to]]] }, properties: {} });
        moves.push(pt(g, from, {}));
      }
    }
    (m.getSource('moves') as GeoJSONSource).setData({ type: 'FeatureCollection', features: moves });

    const marks: GeoJSON.Feature[] = [];
    if (step.kind === 'stuck' || step.kind === 'add' || step.kind === 'abort') marks.push(pt(g, step.farthest, { kind: 'farthest' }));
    for (const a of step.added ?? []) marks.push(pt(g, a, { kind: 'added' }));
    for (const r of step.removed ?? []) marks.push(pt(g, r, { kind: 'removed' }));
    (m.getSource('marks') as GeoJSONSource).setData({ type: 'FeatureCollection', features: marks });
  }

  nearestNode(lng: number, lat: number): number {
    const g = this.graph;
    if (!g) return -1;
    let best = -1, bd = Infinity;
    const cl = Math.cos(lat * Math.PI / 180);
    for (let i = 0; i < g.n; i++) {
      const dx = (g.lon[i] - lng) * cl, dy = g.lat[i] - lat;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  viewBbox(): [number, number, number, number] {
    const b = this.map.getBounds();
    return [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];
  }
}

function pt(g: Graph, v: number, props: Record<string, unknown>): GeoJSON.Feature {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [g.lon[v], g.lat[v]] }, properties: props };
}
