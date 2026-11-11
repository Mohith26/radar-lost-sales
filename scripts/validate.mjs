// Validation: 30 synthetic stores with known lost sales. For each, fit, bootstrap a 90% interval
// for lost revenue, and compare against the hidden truth and the naive estimate.
import fs from 'node:fs';
import { generateStore } from '../src/generate.js';
import { analyze, lostSales, naiveLost, trueLost, bootstrap } from '../src/estimate.js';
import { quantile } from '../src/stats.js';
const K = +(process.argv[2] || 30), B = +(process.argv[3] || 60);
const rows = [];
for (let k = 0; k < K; k++) {
  const theta = 0.2 + 0.3 * ((k * 7) % 10) / 9; // vary the true substitution share 0.20-0.50
  const s = generateStore({ seed: 5000 + k, theta });
  const a = analyze(s);
  const est = lostSales(s, a.E, a.prof.theta, a.prof.lams).reduce((acc, r) => acc + r.lost * r.price, 0);
  const bs = bootstrap(s, a.E, a.stats, { B, seed: k + 1 }).map((b) => b.revPred);
  const lo = quantile(bs, 0.05), hi = quantile(bs, 0.95);
  const truth = trueLost(s).revenue, naive = naiveLost(s).revenue;
  rows.push({ seed: 5000 + k, thetaTrue: theta, thetaHat: a.prof.theta, thetaCI: a.prof.ci, est, lo, hi, truth, naive });
  if (k % 10 === 9) console.error('store', k + 1);
}
const cover = rows.filter((r) => r.truth >= r.lo && r.truth <= r.hi).length / K;
const thetaCover = rows.filter((r) => r.thetaTrue >= r.thetaCI[0] - 1e-9 && r.thetaTrue <= r.thetaCI[1] + 1e-9).length / K;
const mape = (f) => rows.reduce((s, r) => s + Math.abs(f(r) - r.truth) / r.truth, 0) / K;
const bias = (f) => rows.reduce((s, r) => s + (f(r) - r.truth) / r.truth, 0) / K;
const out = { generated: `node scripts/validate.mjs ${K} ${B}`, stores: K, bootstrap: B, coverage90: cover, thetaCoverage95: thetaCover,
  estimate: { mape: mape((r) => r.est), bias: bias((r) => r.est) }, naive: { mape: mape((r) => r.naive), bias: bias((r) => r.naive) }, rows };
fs.writeFileSync(new URL('../data/validation.json', import.meta.url), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ coverage90: cover, thetaCoverage95: thetaCover, estimate: out.estimate, naive: out.naive }));
