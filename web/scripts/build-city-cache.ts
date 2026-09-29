// Pre-fetches Overpass "walk" network JSON for a fixed list of Israeli cities (via Nominatim
// polygon geocoding), gzips each response, and writes web/public/cities/<slug>.json.gz plus
// an index.json manifest consumed by the "city" area mode in the UI.
// Usage: npx tsx scripts/build-city-cache.ts [slug ...]   (default: all cities)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { geocodePlace, buildQuery, fetchOverpass } from '../src/graph/overpass';

const CITIES = [
    { slug: 'jerusalem', name: 'ירושלים', query: 'Jerusalem, Israel' },
    { slug: 'tel-aviv-yafo', name: 'תל אביב-יפו', query: 'Tel Aviv-Yafo, Israel' },
    { slug: 'haifa', name: 'חיפה', query: 'Haifa, Israel' },
    { slug: 'beer-sheva', name: 'באר שבע', query: 'Beer Sheva, Israel' },
    { slug: 'ashdod', name: 'אשדוד', query: 'Ashdod, Israel' },
    { slug: 'ashkelon', name: 'אשקלון', query: 'Ashkelon, Israel' },
    { slug: 'rishon-lezion', name: 'ראשון לציון', query: 'Rishon LeZion, Israel' },
    { slug: 'petah-tikva', name: 'פתח תקווה', query: 'Petah Tikva, Israel' },
    { slug: 'raanana', name: "רעננה", query: "Ra'anana, Israel" },
] as const;

const OUT_DIR = new URL('../public/cities/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface ManifestEntry {
    slug: string; name: string; displayName: string;
    bbox: [number, number, number, number];
    rawBytes: number; gzBytes: number; elements: number;
}

const manifestPath = path.join(OUT_DIR, 'index.json');
const manifest: ManifestEntry[] = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : [];

const wanted = process.argv.slice(2);
const targets = wanted.length ? CITIES.filter((c) => wanted.includes(c.slug)) : CITIES;

const failed: string[] = [];
for (const c of targets) {
    console.log('===', c.name, '/', c.query);
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const geo = await geocodePlace(c.query);
            console.log('  geocoded:', geo.displayName, geo.area.kind);
            const query = buildQuery(geo.area, 'walk', 300);
            console.log('  query length', query.length);
            const t = performance.now();
            const osm = await fetchOverpass(query, (s) => console.log('  ', s));
            console.log('  elements', osm.elements.length, 'in', Math.round(performance.now() - t), 'ms');
            const raw = Buffer.from(JSON.stringify(osm));
            const gz = zlib.gzipSync(raw, { level: 9 });
            fs.writeFileSync(path.join(OUT_DIR, `${c.slug}.json.gz`), gz);
            console.log('  raw', (raw.length / 1024 / 1024).toFixed(2), 'MB -> gz', (gz.length / 1024 / 1024).toFixed(2), 'MB');
            const entry: ManifestEntry = { slug: c.slug, name: c.name, displayName: geo.displayName, bbox: geo.bbox, rawBytes: raw.length, gzBytes: gz.length, elements: osm.elements.length };
            const i = manifest.findIndex((m) => m.slug === c.slug);
            if (i >= 0) manifest[i] = entry; else manifest.push(entry);
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
            break;
        } catch (e) {
            console.log('  attempt', attempt, 'failed:', e instanceof Error ? e.message.slice(0, 120) : e);
            if (attempt === 3) failed.push(c.slug);
            else await sleep(20000 * attempt); // back off before retrying
        }
    }
    await sleep(8000); // be nice to the Overpass endpoint between cities
}

console.log('\ndone.', manifest.length, 'cities in manifest.', failed.length ? `FAILED: ${failed.join(', ')}` : '');
for (const m of manifest) console.log(' ', m.slug.padEnd(16), (m.rawBytes / 1024 / 1024).toFixed(2).padStart(7), 'MB raw ->', (m.gzBytes / 1024 / 1024).toFixed(2).padStart(6), 'MB gz');
