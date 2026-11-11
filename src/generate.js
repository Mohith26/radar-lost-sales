// Seeded synthetic apparel store with item-level, 15-minute RFID availability.
// Each SKU has home-fixture floor units, misplaced floor units (wrong table / fitting room)
// and backroom units. Shoppers who find their size missing sometimes take an adjacent size.
// Everything a real RADAR store would observe is kept (availability state, cause, POS sales);
// the true demand and true lost units are kept separately for validation only.
import { makeRng } from './rng.js';

export const SIZES = ['XS', 'S', 'M', 'L', 'XL'];
export const CAUSES = ['backroom', 'misplaced', 'oos']; // why the size was not on its home fixture
export const SLOT_MIN = 15;
const CATS = [
  ['Denim', ['Slim Jean', 'Mom Jean', 'Straight Jean', 'Wide-Leg Jean', 'Baggy Jean', 'Skinny Jean', 'Denim Short'], [45, 65]],
  ['Tops', ['Crew Tee', 'Boxy Tee', 'Ribbed Tank', 'Baby Tee', 'Polo', 'Henley', 'Waffle Long Sleeve', 'Graphic Tee'], [15, 30]],
  ['Fleece', ['Pullover Hoodie', 'Zip Hoodie', 'Crew Sweatshirt', 'Fleece Jogger', 'Sweatpant'], [35, 55]],
  ['Bottoms', ['Cargo Pant', 'Chino', 'Linen Pant', 'Pull-On Short', 'Flare Legging'], [30, 50]],
  ['Outerwear', ['Puffer Jacket', 'Sherpa Jacket', 'Shacket', 'Bomber'], [60, 90]],
  ['Knit', ['Cable Sweater', 'Cardigan', 'Quarter Zip', 'Sweater Vest'], [40, 60]],
];
const COLORS = ['Black', 'Heather Grey', 'Washed Navy', 'Olive', 'Cream', 'Light Wash', 'Medium Wash', 'Dark Wash', 'Sage', 'Rust'];
const BASE_CURVE = [0.10, 0.22, 0.30, 0.24, 0.14];

export function openSlots() { return (21 - 10) * 60 / SLOT_MIN; } // 10:00-21:00

export function generateStore(opts = {}) {
  const { seed = 412, days = 42, start = '2026-09-28', theta = 0.35, replenMedianMin = 150, recoverMedianMin = 80 } = opts;
  const rng = makeRng(seed);
  const S = openSlots();
  const T = days * S;
  // traffic: hour-of-day and day-of-week profile with noise
  const hourShape = [0.55, 0.7, 0.85, 1.05, 1.15, 1.2, 1.25, 1.2, 1.1, 0.95, 0.75];
  const dowShape = [0.85, 0.8, 0.85, 0.95, 1.15, 1.45, 1.3]; // Mon..Sun
  const traffic = new Float64Array(T);
  const startDow = (new Date(start + 'T12:00:00Z').getUTCDay() + 6) % 7;
  for (let d = 0; d < days; d++) {
    const dayNoise = Math.exp(rng.normal(0, 0.08));
    for (let k = 0; k < S; k++) traffic[d * S + k] = dowShape[(startDow + d) % 7] * hourShape[Math.floor(k * SLOT_MIN / 60)] * dayNoise;
  }
  const styles = [];
  let sid = 0;
  for (const [cat, names, [lo, hi]] of CATS) {
    for (const name of names) {
      const color = COLORS[Math.floor(rng.uniform() * COLORS.length)];
      const price = Math.round(lo + rng.uniform() * (hi - lo)) - 0.05;
      const rate = Math.exp(rng.normal(Math.log(0.12), 0.45)); // style units per 15-min slot at traffic 1
      let curve = BASE_CURVE.map((c) => c * Math.exp(rng.normal(0, 0.18)));
      const cs = curve.reduce((a, b) => a + b, 0);
      curve = curve.map((c) => c / cs);
      styles.push({ id: 'ST' + String(1040 + sid++), cat, name, color, price, rate, curve });
    }
  }
  const nS = SIZES.length;
  const out = styles.map((st) => ({
    ...st,
    sizes: SIZES.map((sz, i) => ({
      size: sz, sku: st.id + '-' + sz,
      avail: new Uint8Array(T), cause: new Uint8Array(T), // cause: 0 available, 1 backroom, 2 misplaced, 3 oos
      sales: new Uint16Array(T), trueDemand: new Float64Array(T), trueLost: new Uint16Array(T),
    })),
  }));
  for (const st of out) {
    // per-size inventory state
    const home = [], mis = [], back = [], cap = [];
    const misTimers = SIZES.map(() => []), repl = SIZES.map(() => null);
    for (let i = 0; i < nS; i++) {
      cap[i] = Math.max(2, Math.round(3 + st.rate * st.curve[i] * 120));
      home[i] = cap[i]; mis[i] = 0; back[i] = Math.round(cap[i] * (1 + rng.uniform() * 2));
    }
    const deliveryEvery = 3 + Math.floor(rng.uniform() * 3);
    for (let t = 0; t < T; t++) {
      const day = Math.floor(t / S), slot = t % S;
      if (slot === 0 && day > 0 && day % deliveryEvery === 0) for (let i = 0; i < nS; i++) back[i] += Math.round(cap[i] * (0.6 + rng.uniform() * 1.2) * (rng.uniform() < 0.85 ? 1 : 0));
      // misplaced items recovered, replenishments landing
      for (let i = 0; i < nS; i++) {
        misTimers[i] = misTimers[i].filter((due) => { if (due <= t) { mis[i]--; home[i]++; return false; } return true; });
        if (repl[i] !== null && repl[i] <= t) { const q = Math.min(back[i], cap[i] - home[i] - mis[i]); if (q > 0) { home[i] += q; back[i] -= q; } repl[i] = null; }
        if (home[i] + mis[i] <= 1 && back[i] > 0 && repl[i] === null) repl[i] = t + Math.max(1, Math.round(Math.exp(rng.normal(Math.log(replenMedianMin / SLOT_MIN), 0.7))));
        // a shopper or try-on moves a unit off its home fixture
        if (home[i] > 0 && rng.uniform() < 0.035 * traffic[t]) {
          home[i]--; mis[i]++;
          misTimers[i].push(t + Math.max(1, Math.round(Math.exp(rng.normal(Math.log(recoverMedianMin / SLOT_MIN), 0.8)))));
        }
      }
      // record availability at the start of the slot
      const availNow = home.map((h) => h > 0);
      for (let i = 0; i < nS; i++) {
        const z = st.sizes[i];
        z.avail[t] = availNow[i] ? 1 : 0;
        z.cause[t] = availNow[i] ? 0 : mis[i] > 0 ? 2 : back[i] > 0 ? 1 : 3;
      }
      // demand
      for (let i = 0; i < nS; i++) {
        const lam = st.rate * st.curve[i] * traffic[t];
        st.sizes[i].trueDemand[t] = lam;
        let n = poisson(rng, lam);
        while (n-- > 0) {
          if (home[i] > 0) { home[i]--; st.sizes[i].sales[t]++; continue; }
          const nb = [i - 1, i + 1].filter((j) => j >= 0 && j < nS && home[j] > 0);
          if (nb.length && rng.uniform() < theta) { const j = nb[Math.floor(rng.uniform() * nb.length)]; home[j]--; st.sizes[j].sales[t]++; }
          else st.sizes[i].trueLost[t]++;
        }
      }
    }
  }
  return { seed, days, start, slotsPerDay: S, T, traffic, styles: out, truth: { theta } };
}

function poisson(rng, lam) {
  if (lam <= 0) return 0;
  const L = Math.exp(-lam); let k = 0, p = 1;
  do { k++; p *= rng.uniform(); } while (p > L);
  return k - 1;
}
