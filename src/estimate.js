// Lost-sales estimation from RFID availability + POS sales.
// Demand is censored: a size only sells while it is on its home fixture. RADAR knows exactly
// when that is true, so the demand rate is estimated with availability as exposure, and the
// share of shoppers who take an adjacent size (theta) is identified from the extra sales of
// neighbouring sizes while a size is missing. Fitted per style on availability-pattern
// sufficient statistics (at most 32 patterns per style), so the whole store fits in milliseconds.
import { makeRng } from './rng.js';

const NS = 5;
const adj = (i) => [i - 1, i + 1].filter((j) => j >= 0 && j < NS);

// ---- 1. traffic index: day x hour-of-day multiplicative model on total store sales (IPF) ----
export function estimateTraffic(store) {
  const { T, slotsPerDay: S, days } = store;
  const y = new Float64Array(T);
  for (const st of store.styles) for (const z of st.sizes) for (let t = 0; t < T; t++) y[t] += z.sales[t];
  const H = S / 4; // hours
  const dayF = new Float64Array(days).fill(1), hourF = new Float64Array(H).fill(1);
  const hourOf = (t) => Math.floor((t % S) / 4);
  for (let it = 0; it < 30; it++) {
    for (let d = 0; d < days; d++) { let num = 0, den = 0; for (let k = 0; k < S; k++) { num += y[d * S + k]; den += hourF[hourOf(k)]; } dayF[d] = num / Math.max(1e-9, den); }
    const num = new Float64Array(H), den = new Float64Array(H);
    for (let t = 0; t < T; t++) { num[hourOf(t)] += y[t]; den[hourOf(t)] += dayF[Math.floor(t / S)]; }
    for (let h = 0; h < H; h++) hourF[h] = num[h] / Math.max(1e-9, den[h]);
  }
  const E = new Float64Array(T);
  let m = 0;
  for (let t = 0; t < T; t++) { E[t] = dayF[Math.floor(t / S)] * hourF[hourOf(t)]; m += E[t]; }
  m /= T;
  for (let t = 0; t < T; t++) E[t] /= m;
  return E;
}

// ---- 2. sufficient statistics per style and day ----
export function styleStats(store, E) {
  const { T, slotsPerDay: S, days } = store;
  return store.styles.map((st) => {
    const Es = Array.from({ length: days }, () => new Float64Array(32));
    const Ys = Array.from({ length: days }, () => new Float64Array(32 * NS));
    for (let t = 0; t < T; t++) {
      let p = 0;
      for (let i = 0; i < NS; i++) if (st.sizes[i].avail[t]) p |= 1 << i;
      const d = Math.floor(t / S);
      Es[d][p] += E[t];
      for (let i = 0; i < NS; i++) Ys[d][p * NS + i] += st.sizes[i].sales[t];
    }
    return { Es, Ys };
  });
}

function sumDays(stats, dayIdx) {
  const E = new Float64Array(32), Y = new Float64Array(32 * NS);
  for (const d of dayIdx) { const a = stats.Es[d], b = stats.Ys[d]; for (let p = 0; p < 32; p++) E[p] += a[p]; for (let q = 0; q < 32 * NS; q++) Y[q] += b[q]; }
  return { E, Y };
}

// B[k][i][p]: contribution of size-k demand to size-i sales under availability pattern p
function contrib(k, i, p, theta) {
  if (!(p >> i & 1)) return 0;
  if (k === i) return 1;
  if (p >> k & 1) return 0;
  if (Math.abs(k - i) !== 1) return 0;
  const nAv = adj(k).filter((j) => p >> j & 1).length;
  return nAv ? theta / nAv : 0;
}

// ---- 3. EM for size demand rates given theta ----
export function fitStyle(E, Y, theta, init = null, iters = 60) {
  const lam = init ? Float64Array.from(init) : new Float64Array(NS).fill(0.02);
  const pats = [];
  for (let p = 0; p < 32; p++) if (E[p] > 0) pats.push(p);
  const den = new Float64Array(NS);
  for (const p of pats) for (let k = 0; k < NS; k++) for (let i = 0; i < NS; i++) den[k] += E[p] * contrib(k, i, p, theta);
  let ll = 0;
  for (let it = 0; it < iters; it++) {
    const num = new Float64Array(NS);
    ll = 0;
    for (const p of pats) for (let i = 0; i < NS; i++) {
      if (!(p >> i & 1)) continue;
      let mu = 0;
      for (let k = 0; k < NS; k++) mu += lam[k] * contrib(k, i, p, theta);
      mu *= E[p];
      const yv = Y[p * NS + i];
      if (mu > 0) { ll += yv * Math.log(mu) - mu; const r = yv / mu; for (let k = 0; k < NS; k++) num[k] += r * lam[k] * contrib(k, i, p, theta) * E[p]; }
    }
    for (let k = 0; k < NS; k++) if (den[k] > 0) lam[k] = num[k] / den[k];
  }
  return { lam, ll };
}

export function profileTheta(statsList, dayIdx, { grid = null } = {}) {
  const sums = statsList.map((s) => sumDays(s, dayIdx));
  const thetas = grid || Array.from({ length: 46 }, (_, i) => i * 0.02);
  let warm = sums.map(() => null);
  const prof = thetas.map((th) => {
    let ll = 0;
    const fits = sums.map((s, j) => { const f = fitStyle(s.E, s.Y, th, warm[j], warm[j] ? 25 : 60); ll += f.ll; return f; });
    warm = fits.map((f) => f.lam);
    return { theta: th, ll, lams: fits.map((f) => Array.from(f.lam)) };
  });
  let best = prof[0];
  for (const p of prof) if (p.ll > best.ll) best = p;
  // profile-likelihood 95% interval (chi-square 1 df: 1.92 log-lik units)
  const inSet = prof.filter((p) => p.ll >= best.ll - 1.92).map((p) => p.theta);
  return { theta: best.theta, lams: best.lams, ll: best.ll, ci: [Math.min(...inSet), Math.max(...inSet)], profile: prof.map((p) => ({ theta: p.theta, ll: p.ll - best.ll })) };
}

// ---- 4. lost units by SKU and cause ----
export function lostSales(store, E, theta, lams, { slaMin = null } = {}) {
  const { T } = store;
  const rows = [];
  for (let j = 0; j < store.styles.length; j++) {
    const st = store.styles[j];
    for (let i = 0; i < NS; i++) {
      const z = st.sizes[i];
      const byCause = [0, 0, 0, 0];
      let unavailSlots = 0, recovered = 0, spell = 0;
      const lostSlot = new Float32Array(T);
      for (let t = 0; t < T; t++) {
        if (z.avail[t]) { spell = 0; continue; }
        unavailSlots++;
        const anyAdj = adj(i).some((k) => st.sizes[k].avail[t]);
        const l = lams[j][i] * E[t] * (1 - (anyAdj ? theta : 0));
        byCause[z.cause[t]] += l;
        lostSlot[t] = l;
        if (z.cause[t] === 1) { spell++; if (slaMin !== null && spell * 15 > slaMin) recovered += l; } else spell = 0;
      }
      const total = byCause[1] + byCause[2] + byCause[3];
      rows.push({ j, i, sku: z.sku, style: st, size: z.size, price: st.price, unavailSlots, lost: total, byCause, recovered, lostSlot });
    }
  }
  return rows;
}

// What a typical report does: unavailable time x the SKU's average sales rate while available, no substitution.
export function naiveLost(store) {
  let units = 0, revenue = 0;
  for (const st of store.styles) for (const z of st.sizes) {
    let av = 0, s = 0, un = 0;
    for (let t = 0; t < store.T; t++) { if (z.avail[t]) { av++; s += z.sales[t]; } else un++; }
    const u = av ? s / av * un : 0;
    units += u; revenue += u * st.price;
  }
  return { units, revenue };
}

export function analyze(store) {
  const E = estimateTraffic(store);
  const stats = styleStats(store, E);
  const all = Array.from({ length: store.days }, (_, d) => d);
  const prof = profileTheta(stats, all);
  return { E, stats, prof };
}

// ---- 5. day-block bootstrap for totals (theta re-profiled on a coarse grid each time) ----
export function bootstrap(store, E, stats, { B = 60, seed = 3, grid = null } = {}) {
  const rng = makeRng(seed);
  const g = grid || Array.from({ length: 16 }, (_, i) => 0.05 + i * 0.04);
  const out = [];
  for (let b = 0; b < B; b++) {
    const idx = Array.from({ length: store.days }, () => Math.floor(rng.uniform() * store.days));
    const pr = profileTheta(stats, idx, { grid: g });
    // refine around the coarse optimum
    const fine = profileTheta(stats, idx, { grid: [-0.03, -0.015, 0, 0.015, 0.03].map((d) => Math.min(0.95, Math.max(0, pr.theta + d))) });
    // rates fitted on resampled days are per-slot rates; apply to the observed availability timeline
    const rows = lostSales(store, E, fine.theta, fine.lams);
    let units = 0, rev = 0, v = 0, cause = [0, 0, 0, 0];
    for (const r of rows) { units += r.lost; rev += r.lost * r.price; v += r.lost * r.price * r.price; for (let c = 1; c < 4; c++) cause[c] += r.byCause[c] * r.price; }
    // lost shoppers are themselves random (Poisson): add realization noise so the interval
    // covers the lost revenue that actually happened, not just its expectation
    const unitsPred = units + rng.normal(0, Math.sqrt(units)), revPred = rev + rng.normal(0, Math.sqrt(v));
    out.push({ theta: fine.theta, units, rev, cause, unitsPred, revPred });
  }
  return out;
}

export function trueLost(store) {
  let units = 0, revenue = 0;
  for (const st of store.styles) for (const z of st.sizes) { let u = 0; for (let t = 0; t < store.T; t++) u += z.trueLost[t]; units += u; revenue += u * st.price; }
  return { units, revenue };
}
