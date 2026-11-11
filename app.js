import { generateStore, SIZES } from './src/generate.js';
import { analyze, lostSales, naiveLost, bootstrap } from './src/estimate.js';
import { quantile } from './src/stats.js';
import { MAIN_STORE, STORE_LABEL, BOOT_B } from './src/config.js';

const $ = (id) => document.getElementById(id);
const usd = (v) => '$' + Math.round(v).toLocaleString('en-US');
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dstr = (iso, add = 0) => { const d = new Date(Date.parse(iso + 'T12:00:00Z') + add * 86400000); return MON[d.getUTCMonth()] + ' ' + d.getUTCDate(); };
const CAUSE_LABEL = { 1: 'In backroom', 2: 'Misplaced', 3: 'Out of stock' };
const CAUSE_COLOR = { 1: '#ff6b00', 2: '#000000', 3: '#bbbbbb' };

let store, fit, rows, naive, salesRev, boot = null, state = { cause: 'all', sel: null, sla: 30 };

function init() {
  store = generateStore(MAIN_STORE);
  fit = analyze(store);
  rows = lostSales(store, fit.E, fit.prof.theta, fit.prof.lams, { slaMin: state.sla });
  naive = naiveLost(store);
  salesRev = 0;
  for (const st of store.styles) for (const z of st.sizes) for (let t = 0; t < store.T; t++) salesRev += z.sales[t] * st.price;
  $('storeName').textContent = `${STORE_LABEL.store} · ${STORE_LABEL.mall}`;
  $('rangeLbl').textContent = `${dstr(store.start)} – ${dstr(store.start, store.days - 1)}, 2026 · 15-min reads`;
  const nSku = rows.length;
  $('lede').textContent = `A size only sells while it is on its home fixture. RADAR knows to the minute when that is true, so this page estimates real demand with availability as exposure, learns how many shoppers take the next size instead, and prices what the floor gaps cost across ${nSku} SKUs in ${store.styles.length} styles.`;
  render();
  wire();
  setTimeout(runBootstrap, 30);
}

const total = (f) => rows.reduce((a, r) => a + f(r), 0);

function render() {
  renderKpis();
  renderWeeks();
  renderSla();
  renderTable();
  renderDetail();
  renderProfile();
  renderValidation();
}

function renderKpis() {
  const rev = total((r) => r.lost * r.price), units = total((r) => r.lost);
  const back = total((r) => r.byCause[1] * r.price);
  const th = fit.prof.theta, ci = fit.prof.ci;
  const over = naive.revenue / rev - 1;
  const intv = boot ? `90% interval ${usd(quantile(boot.map((b) => b.revPred), 0.05))} – ${usd(quantile(boot.map((b) => b.revPred), 0.95))}` : '<span class="pending">computing interval…</span>';
  $('kpis').innerHTML = `
  <div class="kpi"><div class="eyebrow">Lost revenue · ${store.days / 7} wks</div><div class="v or">${usd(rev)}</div><div class="s">${intv}</div></div>
  <div class="kpi"><div class="eyebrow">Demand lost</div><div class="v">${(rev / (rev + salesRev) * 100).toFixed(1)}%</div><div class="s">${Math.round(units)} units vs ${usd(salesRev)} sold</div></div>
  <div class="kpi"><div class="eyebrow">Sitting in backroom</div><div class="v">${Math.round(back / rev * 100)}%</div><div class="s">${usd(back)} lost while stock was in the store</div></div>
  <div class="kpi"><div class="eyebrow">Shoppers who take next size</div><div class="v">${Math.round(th * 100)}%</div><div class="s">95% CI ${Math.round(ci[0] * 100)}–${Math.round(ci[1] * 100)}% · profile likelihood</div></div>
  <div class="kpi"><div class="eyebrow">Naive out-of-stock estimate</div><div class="v">${usd(naive.revenue)}</div><div class="s">overstates by ${Math.round(over * 100)}% (ignores size switching)</div></div>`;
}

function weekly() {
  const W = store.days / 7, perWeek = store.slotsPerDay * 7;
  const out = Array.from({ length: W }, () => [0, 0, 0, 0]);
  for (const r of rows) {
    const z = r.style.sizes[r.i];
    for (let t = 0; t < store.T; t++) if (r.lostSlot[t] > 0) out[Math.floor(t / perWeek)][z.cause[t]] += r.lostSlot[t] * r.price;
  }
  return out;
}

function renderWeeks() {
  const data = weekly();
  const el = $('weekChart'), Wd = el.clientWidth || 700, H = 250, m = { l: 58, r: 10, t: 10, b: 30 };
  const mx = Math.max(...data.map((w) => w[1] + w[2] + w[3])) * 1.12;
  const step = mx > 4000 ? 1000 : 500;
  const y = (v) => m.t + (1 - v / mx) * (H - m.t - m.b);
  const bw = (Wd - m.l - m.r) / data.length;
  let svg = `<svg width="${Wd}" height="${H}">`;
  for (let v = 0; v <= mx; v += step) svg += `<line x1="${m.l}" x2="${Wd - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="#ececec"/><text x="${m.l - 8}" y="${y(v) + 4}" text-anchor="end" font-size="11" fill="#858585">$${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k</text>`;
  data.forEach((w, k) => {
    let base = 0;
    const x0 = m.l + k * bw + bw * 0.22, ww = bw * 0.56;
    for (const c of [1, 2, 3]) {
      const h = y(base) - y(base + w[c]);
      svg += `<rect x="${x0}" y="${y(base + w[c])}" width="${ww}" height="${Math.max(0, h)}" fill="${CAUSE_COLOR[c]}" data-k="${k}"/>`;
      base += w[c];
    }
    svg += `<text x="${x0 + ww / 2}" y="${y(base) - 6}" text-anchor="middle" font-size="11" fill="#2b2b2b">${usd(base)}</text>`;
    svg += `<text x="${x0 + ww / 2}" y="${H - 10}" text-anchor="middle" font-size="11" fill="#858585">Wk of ${dstr(store.start, k * 7)}</text>`;
  });
  svg += '</svg>';
  el.innerHTML = svg;
  $('weekLegend').innerHTML = [1, 2, 3].map((c) => `<span><i style="background:${CAUSE_COLOR[c]}"></i>${CAUSE_LABEL[c]}</span>`).join('');
  el.querySelectorAll('rect').forEach((r) => {
    r.addEventListener('mousemove', (e) => { const w = data[+r.dataset.k]; showTip(e, `Week of ${dstr(store.start, +r.dataset.k * 7)}<br>In backroom ${usd(w[1])}<br>Misplaced ${usd(w[2])}<br>Out of stock ${usd(w[3])}`); });
    r.addEventListener('mouseleave', hideTip);
  });
}

function renderSla() {
  const backRev = total((r) => r.byCause[1] * r.price);
  const rec = total((r) => r.recovered * r.price);
  const perYear = rec * 365 / store.days;
  $('slaVal').textContent = state.sla + ' min';
  $('slaOut').innerHTML = `<div><div class="l">Recovered, ${store.days / 7} weeks</div><div class="v">${usd(rec)}</div></div><div><div class="l">Per store per year</div><div class="v">${usd(perYear)}</div></div>`;
  let spells = [], cur = 0;
  for (const r of rows) { const z = r.style.sizes[r.i]; cur = 0; for (let t = 0; t < store.T; t++) { if (z.cause[t] === 1) cur++; else if (cur) { spells.push(cur * 15); cur = 0; } } if (cur) spells.push(cur * 15); }
  const med = quantile(spells, 0.5), p90 = quantile(spells, 0.9);
  $('slaNote').innerHTML = `Today a size sits off its fixture with backroom stock for a median of <b>${Math.round(med)} min</b> (90th percentile ${Math.round(p90)} min) across ${spells.length} gaps. A ${state.sla}-minute response would recover ${Math.round(rec / Math.max(1, backRev) * 100)}% of the ${usd(backRev)} lost to backroom gaps. First-order estimate: it holds demand fixed and ignores knock-on stock changes.`;
}

function filteredRows() {
  const key = state.cause === 'all' ? (r) => r.lost * r.price : (r) => r.byCause[+state.cause] * r.price;
  return rows.map((r) => ({ r, v: key(r) })).filter((x) => x.v > 0.5).sort((a, b) => b.v - a.v).slice(0, 12);
}

function renderTable() {
  const list = filteredRows();
  if (state.sel === null && list.length) state.sel = list[0].r.sku;
  $('skuTable').innerHTML = `<table><thead><tr><th>Style</th><th>Size</th><th class="r">Hrs off fixture</th><th class="r">Cause mix</th><th class="r">Lost units</th><th class="r">Lost $</th></tr></thead><tbody>${list.map(({ r, v }) => {
    const tot = r.byCause[1] + r.byCause[2] + r.byCause[3] || 1;
    return `<tr data-sku="${r.sku}" class="${r.sku === state.sel ? 'sel' : ''}"><td>${r.style.name}<div class="sub">${r.style.color} · ${r.style.id}</div></td><td><span class="size">${r.size}</span></td><td class="r mono-num">${(r.unavailSlots / 4).toFixed(1)}</td><td class="r"><div class="cbar">${[1, 2, 3].map((c) => `<i class="c${c}" style="width:${(r.byCause[c] / tot * 100).toFixed(1)}%"></i>`).join('')}</div></td><td class="r mono-num">${(state.cause === 'all' ? r.lost : r.byCause[+state.cause]).toFixed(1)}</td><td class="r"><b>${usd(v)}</b></td></tr>`;
  }).join('')}</tbody></table>`;
  $('skuTable').querySelectorAll('tbody tr').forEach((tr) => tr.addEventListener('click', () => { state.sel = tr.dataset.sku; renderTable(); renderDetail(); }));
}

function renderDetail() {
  const r = rows.find((x) => x.sku === state.sel);
  if (!r) { $('detail').innerHTML = ''; return; }
  const st = r.style, z = st.sizes[r.i];
  const lam = fit.prof.lams[r.j][r.i];
  let Esum = 0, sold = 0, absorbed = 0;
  for (let t = 0; t < store.T; t++) {
    Esum += fit.E[t]; sold += z.sales[t];
    if (!z.avail[t]) { const anyAdj = [r.i - 1, r.i + 1].some((k) => k >= 0 && k < 5 && st.sizes[k].avail[t]); if (anyAdj) absorbed += lam * fit.E[t] * fit.prof.theta; }
  }
  const demandWk = lam * Esum / (store.days / 7);
  $('detail').innerHTML = `<div class="ph-head"><div><div class="eyebrow">${st.id} · ${st.cat.toUpperCase()}</div><h2>${st.name}, ${st.color} · size ${r.size}</h2></div><div class="mono-num">${usd(st.price)}</div></div>
  <div class="det-grid"><div><div class="l">Est. demand / wk</div><div class="v">${demandWk.toFixed(1)}</div></div><div><div class="l">Sold, ${store.days / 7} wks</div><div class="v">${sold}</div></div><div><div class="l">Lost · switched size</div><div class="v">${r.lost.toFixed(1)} · ${absorbed.toFixed(1)}</div></div></div>
  <div class="eyebrow">Size run on the fixture, ${dstr(store.start)} – ${dstr(store.start, store.days - 1)}</div>
  <div class="strip" id="strip">${SIZES.map((s, i) => `<div class="strip-row ${i === r.i ? 'focus' : ''}"><span class="lb">${s}</span><canvas data-i="${i}" width="${store.days * 11}" height="1"></canvas></div>`).join('')}</div>
  <div class="legend" style="margin-top:8px"><span><i style="background:#e9e9e9"></i>On fixture</span>${[1, 2, 3].map((c) => `<span><i style="background:${CAUSE_COLOR[c]}"></i>${CAUSE_LABEL[c]}</span>`).join('')}</div>
  <p class="muted" style="margin-top:10px">Demand for ${r.size} is estimated from the hours it was on its fixture; while it was missing, ${Math.round(fit.prof.theta * 100)}% of those shoppers are expected to take ${[r.i - 1, r.i + 1].filter((k) => k >= 0 && k < 5).map((k) => SIZES[k]).join(' or ')} when it is there.</p>`;
  const S = store.slotsPerDay;
  $('detail').querySelectorAll('canvas').forEach((cv) => {
    const i = +cv.dataset.i, zz = st.sizes[i], ctx = cv.getContext('2d');
    const W = store.days * 11; // 11 hourly cells per day (4 slots each -> majority cause)
    const img = ctx.createImageData(W, 1);
    for (let d = 0; d < store.days; d++) for (let h = 0; h < 11; h++) {
      const cnt = [0, 0, 0, 0];
      for (let q = 0; q < 4; q++) cnt[zz.cause[d * S + h * 4 + q]]++;
      let c = 0; if (cnt[0] < 2) c = cnt[1] >= cnt[2] && cnt[1] >= cnt[3] ? 1 : cnt[2] >= cnt[3] ? 2 : 3;
      const col = c === 0 ? [233, 233, 233] : c === 1 ? [255, 107, 0] : c === 2 ? [0, 0, 0] : [187, 187, 187];
      const o = (d * 11 + h) * 4; img.data.set([...col, 255], o);
    }
    ctx.putImageData(img, 0, 0);
  });
}

function renderProfile() {
  const p = fit.prof.profile, el = $('profile'), W = el.clientWidth || 600, H = 190, m = { l: 46, r: 10, t: 10, b: 28 };
  const lo = -12;
  const x = (v) => m.l + v / 0.9 * (W - m.l - m.r), y = (v) => m.t + (1 - (Math.max(lo, v) - lo) / (0 - lo)) * (H - m.t - m.b);
  const ci = fit.prof.ci;
  let svg = `<svg width="${W}" height="${H}"><rect x="${x(ci[0])}" y="${m.t}" width="${x(ci[1]) - x(ci[0])}" height="${H - m.t - m.b}" fill="#fff0e5"/>`;
  for (let v = 0; v >= lo; v -= 4) svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}" stroke="#ececec"/><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end" font-size="10.5" fill="#858585">${v}</text>`;
  for (let v = 0; v <= 0.9001; v += 0.1) svg += `<text x="${x(v)}" y="${H - 8}" text-anchor="middle" font-size="10.5" fill="#858585">${Math.round(v * 100)}%</text>`;
  svg += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(-1.92)}" y2="${y(-1.92)}" stroke="#ff6b00" stroke-dasharray="4 4"/>`;
  svg += `<path d="M${p.map((q) => `${x(q.theta).toFixed(1)},${y(q.ll).toFixed(1)}`).join('L')}" fill="none" stroke="#000" stroke-width="2"/>`;
  svg += `<circle cx="${x(fit.prof.theta)}" cy="${y(0)}" r="4" fill="#ff6b00"/></svg>`;
  el.innerHTML = svg;
  $('profileNote').textContent = `Profile log-likelihood (relative to the best fit) for the share of shoppers who take an adjacent size when theirs is missing. It is identified by the extra sales of neighbouring sizes while a size is off its fixture. Best fit ${Math.round(fit.prof.theta * 100)}%; the shaded band is the 95% interval (within 1.92 of the maximum).`;
}

async function renderValidation() {
  let v;
  try { v = await (await fetch('data/validation.json')).json(); } catch (e) { $('valid').innerHTML = '<p class="muted">validation.json not found</p>'; return; }
  $('valid').innerHTML = `<div class="vgrid">
  <div><div class="l">Average error, lost revenue</div><div class="v">${Math.round(v.estimate.mape * 100)}%</div><div class="s">vs ${Math.round(v.naive.mape * 100)}% for the out-of-stock-hours estimate</div></div>
  <div><div class="l">Average bias</div><div class="v">${v.estimate.bias >= 0 ? '+' : '−'}${Math.abs(v.estimate.bias * 100).toFixed(1)}%</div><div class="s">naive: ${v.naive.bias >= 0 ? '+' : '−'}${Math.round(Math.abs(v.naive.bias) * 100)}%</div></div>
  <div><div class="l">90% intervals containing the truth</div><div class="v">${Math.round(v.coverage90 * 100)}%</div><div class="s">${v.stores} stores, ${v.bootstrap} day-block bootstrap draws each</div></div>
  <div><div class="l">Switch-size intervals containing the truth</div><div class="v">${Math.round(v.thetaCoverage95 * 100)}%</div><div class="s">true share varied 20–50% across stores</div></div></div>
  <p class="muted" style="margin-top:10px">Simulated stores where every lost shopper is known. The interval runs slightly under its 90% target because the estimator reads availability at 15-minute resolution and misses sizes that sell out mid-interval.</p>`;
}

function runBootstrap() {
  boot = bootstrap(store, fit.E, fit.stats, { B: BOOT_B, seed: 3 });
  renderKpis();
}

function showTip(e, html) { const t = $('tip'); t.innerHTML = html; t.hidden = false; t.style.left = e.clientX + 12 + 'px'; t.style.top = e.clientY - 10 + 'px'; }
function hideTip() { $('tip').hidden = true; }

function wire() {
  $('sla').addEventListener('input', (e) => {
    state.sla = +e.target.value;
    rows = lostSales(store, fit.E, fit.prof.theta, fit.prof.lams, { slaMin: state.sla });
    renderSla();
  });
  $('causeSeg').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
    $('causeSeg').querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    state.cause = b.dataset.c; state.sel = null; renderTable(); renderDetail();
  }));
  window.addEventListener('resize', () => { renderWeeks(); renderProfile(); });
}

init();
