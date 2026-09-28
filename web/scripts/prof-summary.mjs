// Summarise a .cpuprofile by self time: node scripts/prof-summary.mjs file.cpuprofile
import fs from 'node:fs';
const p = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const self = new Map();
const byId = new Map(p.nodes.map((n) => [n.id, n]));
const dt = p.timeDeltas;
for (let i = 0; i < p.samples.length; i++) {
  const n = byId.get(p.samples[i]);
  const key = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`;
  self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0));
}
const total = [...self.values()].reduce((a, b) => a + b, 0);
[...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).forEach(([k, v]) => console.log((v / total * 100).toFixed(1).padStart(5) + '%', k));
