// Pure, network-free unit test for the Overture -> Work graph conversion (connector splitting,
// shared-node dedup, WKT parsing). Run: npx tsx scripts/test-overture.ts
import assert from 'node:assert';
import { parseLineStringWkt, overtureRowsToWork, buildOvertureQuery, type OvertureRow } from '../src/graph/overture';

// --- WKT parsing ---
{
    const coords = parseLineStringWkt('LINESTRING (34.1 32.1, 34.2 32.1, 34.3 32.2)');
    assert.deepStrictEqual(coords, [34.1, 32.1, 34.2, 32.1, 34.3, 32.2]);
    console.log('OK parseLineStringWkt');
}

// --- query builder: bbox + class-exclude filter present, no SQL injection from bbox numbers ---
{
    const q = buildOvertureQuery([34.7, 32.0, 34.8, 32.1], 'walk');
    assert.ok(q.includes("subtype = 'road'"));
    assert.ok(q.includes('bbox.xmin <= 34.8'));
    assert.ok(q.includes("NOT IN ('motorway'"));
    console.log('OK buildOvertureQuery');
}

// --- graph conversion: two segments sharing one connector should produce one shared node ---
{
    // A --(seg1)--> B --(seg2)--> C, B is the shared connector.
    const rows: OvertureRow[] = [
        {
            id: 'seg1', roadClass: 'residential',
            connectorIds: ['A', 'B'], connectorAts: [0, 1],
            coords: [34.0, 32.0, 34.01, 32.0],
        },
        {
            id: 'seg2', roadClass: 'residential',
            connectorIds: ['B', 'C'], connectorAts: [0, 1],
            coords: [34.01, 32.0, 34.02, 32.0],
        },
    ];
    const w = overtureRowsToWork(rows);
    assert.strictEqual(w.lon.length, 3, `expected 3 shared nodes (A,B,C), got ${w.lon.length}`);
    assert.strictEqual(w.edges.length, 2, `expected 2 edges, got ${w.edges.length}`);
    console.log('OK overtureRowsToWork: shared connector dedup ->', w.lon.length, 'nodes,', w.edges.length, 'edges');
}

// --- graph conversion: a segment with an *interior* connector must be split into two edges ---
{
    const rows: OvertureRow[] = [
        {
            id: 'seg-with-midpoint', roadClass: 'residential',
            connectorIds: ['X', 'MID', 'Y'], connectorAts: [0, 0.5, 1],
            coords: [34.0, 32.0, 34.02, 32.0], // straight line, MID falls exactly at the midpoint
        },
    ];
    const w = overtureRowsToWork(rows);
    assert.strictEqual(w.lon.length, 3, `expected 3 nodes (X, MID, Y), got ${w.lon.length}`);
    assert.strictEqual(w.edges.length, 2, `expected 2 sub-edges split at the interior connector, got ${w.edges.length}`);
    const total = w.edges.reduce((s, e) => s + e.len, 0);
    const wholeLen = w.edges[0].len + w.edges[1].len;
    assert.ok(Math.abs(total - wholeLen) < 1e-6);
    console.log('OK overtureRowsToWork: interior connector splits the segment ->', w.edges.map((e) => Math.round(e.len)), 'm');
}

console.log('\nall overture unit tests passed');
