// Prints the numbers shown on the page (same code path as app.js).
import { generateStore } from '../src/generate.js';
import { analyze, lostSales, naiveLost, trueLost, bootstrap } from '../src/estimate.js';
import { quantile } from '../src/stats.js';
import { MAIN_STORE, BOOT_B } from '../src/config.js';
const s = generateStore(MAIN_STORE);
const a = analyze(s);
const rows = lostSales(s, a.E, a.prof.theta, a.prof.lams, { slaMin: 30 });
const sum = (f) => rows.reduce((acc, r) => acc + f(r), 0);
const rev = sum((r) => r.lost * r.price), units = sum((r) => r.lost);
const cause = [1, 2, 3].map((c) => sum((r) => r.byCause[c] * r.price));
let salesRev = 0; for (const st of s.styles) for (const z of st.sizes) for (let t = 0; t < s.T; t++) salesRev += z.sales[t] * st.price;
const bs = bootstrap(s, a.E, a.stats, { B: BOOT_B, seed: 3 });
console.log(JSON.stringify({ theta: a.prof.theta, thetaCI: a.prof.ci, units: +units.toFixed(1), rev: Math.round(rev), revInt: [Math.round(quantile(bs.map((b) => b.revPred), 0.05)), Math.round(quantile(bs.map((b) => b.revPred), 0.95))], cause: cause.map(Math.round), recovered30: Math.round(sum((r) => r.recovered * r.price)), salesRev: Math.round(salesRev), lostShare: +(rev / (rev + salesRev)).toFixed(4), naive: Math.round(naiveLost(s).revenue), overstatement: +(naiveLost(s).revenue / rev - 1).toFixed(3) }));
console.log('hidden truth (never shown):', JSON.stringify(trueLost(s)));
