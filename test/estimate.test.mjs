import test from 'node:test';
import assert from 'node:assert/strict';
import { generateStore } from '../src/generate.js';
import { analyze, lostSales, naiveLost, trueLost, fitStyle, estimateTraffic, bootstrap } from '../src/estimate.js';
import { quantile } from '../src/stats.js';
import { MAIN_STORE } from '../src/config.js';

test('generator is deterministic and causes are consistent with availability', () => {
  const a = generateStore(MAIN_STORE), b = generateStore(MAIN_STORE);
  assert.deepEqual(Array.from(a.styles[3].sizes[2].sales), Array.from(b.styles[3].sizes[2].sales));
  for (const st of a.styles) for (const z of st.sizes) for (let t = 0; t < a.T; t++) assert.equal(z.avail[t] === 1, z.cause[t] === 0);
});

test('traffic index recovers the hour-of-day shape', () => {
  const s = generateStore({ seed: 21 });
  const E = estimateTraffic(s);
  const S = s.slotsPerDay;
  const hourMean = (h) => { let a = 0, n = 0; for (let t = 0; t < s.T; t++) if (Math.floor((t % S) / 4) === h) { a += E[t]; n++; } return a / n; };
  assert.ok(hourMean(6) / hourMean(0) > 1.8 && hourMean(6) / hourMean(0) < 2.8);
});

test('EM recovers size rates with no substitution and full availability', () => {
  const E = new Float64Array(32), Y = new Float64Array(160);
  E[31] = 1000; const truth = [0.01, 0.03, 0.05, 0.04, 0.02];
  truth.forEach((l, i) => { Y[31 * 5 + i] = l * 1000; });
  const f = fitStyle(E, Y, 0.3);
  f.lam.forEach((l, i) => assert.ok(Math.abs(l - truth[i]) < 1e-6));
});

test('substitution share is identified from neighbour sales while a size is missing', () => {
  // M (index 2) missing for half the exposure; S and L absorb theta * lamM split evenly
  const E = new Float64Array(32), Y = new Float64Array(160);
  const lam = [0.01, 0.03, 0.05, 0.04, 0.02], theta = 0.4;
  E[31] = 2000; E[31 & ~4] = 2000;
  lam.forEach((l, i) => { Y[31 * 5 + i] = l * 2000; });
  const p = 31 & ~4;
  lam.forEach((l, i) => { if (i !== 2) Y[p * 5 + i] = l * 2000 + (i === 1 || i === 3 ? theta * lam[2] / 2 * 2000 : 0); });
  let best = null;
  for (let th = 0; th <= 0.8001; th += 0.02) { const f = fitStyle(E, Y, th, null, 200); if (!best || f.ll > best.ll) best = { th, ll: f.ll }; }
  assert.ok(Math.abs(best.th - theta) < 0.021, 'theta ' + best.th);
});

test('store estimate beats the naive out-of-stock-hours estimate and brackets the truth', () => {
  const s = generateStore(MAIN_STORE);
  const a = analyze(s);
  const est = lostSales(s, a.E, a.prof.theta, a.prof.lams).reduce((acc, r) => acc + r.lost * r.price, 0);
  const truth = trueLost(s).revenue, naive = naiveLost(s).revenue;
  assert.ok(Math.abs(est - truth) < Math.abs(naive - truth));
  assert.ok(a.prof.ci[0] <= 0.35 && a.prof.ci[1] >= 0.35);
  const bs = bootstrap(s, a.E, a.stats, { B: 30, seed: 3 }).map((b) => b.revPred);
  assert.ok(truth >= quantile(bs, 0.02) && truth <= quantile(bs, 0.98));
});

test('faster replenishment recovers more and never more than the backroom losses', () => {
  const s = generateStore(MAIN_STORE);
  const a = analyze(s);
  const rec = (m) => lostSales(s, a.E, a.prof.theta, a.prof.lams, { slaMin: m }).reduce((acc, r) => acc + r.recovered, 0);
  const back = lostSales(s, a.E, a.prof.theta, a.prof.lams).reduce((acc, r) => acc + r.byCause[1], 0);
  assert.ok(rec(15) >= rec(60) && rec(60) >= rec(240));
  assert.ok(rec(15) <= back + 1e-9);
});
