'use strict';
/* Pipeline Health dashboard. No dependencies: charts are plain SVG. Reads /api/*, refreshes itself while a run is live. */
const $ = (s, r = document) => r.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const COL = {green: 'var(--green)', amber: 'var(--amber)', red: 'var(--red)', grey: 'var(--grey)'};
const PALETTE = ['#5b9cf5', '#2f8f6b', '#c58a1a', '#cc5a71', '#8a5cc2', '#2b8fb5', '#d1783c', '#7aa83b', '#b25dab', '#4aa3a0'];
const state = {runs: [], run: null, sel: new Set(), sort: {k: 'started', d: -1}, last: ''};
let uid = 0;
const wires = [];                       // hover wiring, run only when the freshly built HTML is actually applied

// ---------------------------------------------------------------- formatting
const n0 = v => v == null ? '–' : Math.round(v).toLocaleString();
const n1 = v => v == null ? '–' : (Math.round(v * 10) / 10).toLocaleString();
const tok = v => v == null ? '–' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'k' : String(Math.round(v));
const dur = s => {
  if (s == null) return '–'; s = Math.round(s);
  if (s < 60) return s + 's'; if (s < 3600) return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(s / 3600) + 'h ' + String(Math.floor(s % 3600 / 60)).padStart(2, '0') + 'm';
};
const when = t => t ? new Date(t * 1000).toLocaleString([], {month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'}) : '–';
const light = (l, t = '') => `<span class="light ${l || 'grey'}" title="${esc(t)}"></span>`;
const chip = (txt, cls = '') => `<span class="chip ${cls}">${esc(txt)}</span>`;
const statusChip = r => ({running: chip('running', 'run'), finished: chip('finished', 'green'), needs_review: chip('needs review', 'amber'),
  crashed: chip('crashed', 'red'), failed: chip('failed', 'red')}[r.status] || chip(r.status));
const STATIC = !!document.querySelector('meta[name="static-site"]');   // the published copy reads files, not a server
function staticPath(p) {
  const u = new URL(p, location.href), src = u.searchParams.get('src') || 'all'; let m;
  if (u.pathname === '/api/sources') return 'data/sources.json';
  if (u.pathname === '/api/overview') return 'data/overview-' + src + '.json';
  if (u.pathname === '/api/runs') return 'data/runs-' + src + '.json';
  if ((m = u.pathname.match(/^\/api\/run\/(.+)$/))) return 'data/run/' + m[1] + '.json';
  if (u.pathname === '/api/rules') return 'data/rules.json';
  if (u.pathname === '/api/server') return 'data/server.json';
  return p;
}
async function api(p) {
  if (STATIC) {
    const m = p.match(/^\/api\/compare\?ids=(.*)$/);
    if (m) return {runs: await Promise.all(m[1].split(',').filter(Boolean).map(i => api('data/card/' + i + '.json')))};
    if (p.startsWith('/api/')) p = staticPath(p);
    p += (p.includes('?') ? '&' : '?') + 't=' + Math.floor(Date.now() / 20000);
  }
  const r = await fetch(p, {cache: 'no-store'}); if (!r.ok) throw new Error(p + ' → ' + r.status); return r.json();
}
const money = v => v == null ? '–' : v >= 100 ? '$' + Math.round(v).toLocaleString() : v >= 1 ? '$' + v.toFixed(2) : v >= 0.01 ? '$' + v.toFixed(3) : v > 0 ? '$' + v.toFixed(4) : '$0';
const pct = v => v == null ? '–' : (Math.round(v * 10) / 10) + '%';
/* horizontal bars made of divs: rows [{label, value, text, color, tip}] */
function hbars(rows, o = {}) {
  if (!rows.length) return '<p class="muted small">nothing recorded yet</p>';
  const mx = Math.max(...rows.map(r => r.value), 1e-9);
  return `<div class="hbs">${rows.map(r => `<div class="hb" data-tip="${esc(r.tip || '')}"><span class="hl" title="${esc(r.label)}">${esc(r.label)}</span><div class="hbar"><i style="width:${Math.max(1, r.value / mx * 100)}%;background:${r.color || 'var(--accent)'}"></i></div><span class="hv">${r.text ?? n1(r.value)}</span></div>`).join('')}</div>`;
}
const SRC_NAME = {api: 'API repo', cli: 'CLI repo'};
const SRC_HELP = {api: 'Runs that call the OpenAI API directly', cli: 'Runs that call the model through the Codex command line'};

// ---------------------------------------------------------------- tooltip
const tip = $('#tip');
document.addEventListener('mousemove', e => {
  const t = e.target.closest && e.target.closest('[data-tip]');
  if (!t) { tip.hidden = true; return; }
  tip.innerHTML = t.getAttribute('data-tip'); tip.hidden = false;
  tip.style.left = Math.min(e.clientX + 14, innerWidth - tip.offsetWidth - 8) + 'px';
  tip.style.top = Math.min(e.clientY + 14, innerHeight - tip.offsetHeight - 8) + 'px';
});

// ---------------------------------------------------------------- SVG charts
function scale(d0, d1, r0, r1) { const k = (r1 - r0) / ((d1 - d0) || 1); return v => r0 + (v - d0) * k; }
function ticks(lo, hi, n = 5) {
  const span = hi - lo || 1, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map(m => m * mag).find(s => s >= step0) || step0;
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(6)); return out;
}
function frame(W, H, m, x, y, xt, yt, xf, yf, xlabel) {
  let s = '';
  yt.forEach(v => { s += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${yf(v)}</text>`; });
  xt.forEach(v => { s += `<text x="${x(v)}" y="${H - m.b + 15}" text-anchor="middle">${xf(v)}</text>`; });
  s += `<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>`;
  if (xlabel) s += `<text x="${W - m.r}" y="${H - 2}" text-anchor="end">${esc(xlabel)}</text>`;
  return s;
}
/* spec: {series:[{name,color,pts:[[x,y]],area,step}], h, yfmt, xfmt, ymax, ymin, refs:[{y,label,color}], xlabel} */
function lineChart(spec) {
  const W = 920, H = spec.h || 210, m = {l: 52, r: 14, t: 10, b: 26};
  const all = spec.series.flatMap(s => s.pts); if (!all.length) return '<p class="muted small">no data</p>';
  const xmax = Math.max(...all.map(p => p[0]), spec.xmax || 0), xmin = 0;
  let ymax = spec.ymax ?? Math.max(...all.map(p => p[1] ?? 0), ...(spec.refs || []).map(r => r.y), 0.0001) * 1.08;
  const ymin = spec.ymin ?? 0;
  const x = scale(xmin, xmax, m.l, W - m.r), y = scale(ymin, ymax, H - m.b, m.t);
  const xf = spec.xfmt || dur, yf = spec.yfmt || (v => n1(v));
  let g = frame(W, H, m, x, y, ticks(xmin, xmax, 6), ticks(ymin, ymax, 4), xf, yf, spec.xlabel);
  (spec.refs || []).forEach(r => { g += `<line x1="${m.l}" x2="${W - m.r}" y1="${y(r.y)}" y2="${y(r.y)}" stroke="${r.color || COL.red}" stroke-dasharray="5 4"/><text x="${W - m.r - 2}" y="${y(r.y) - 4}" text-anchor="end" style="fill:${r.color || COL.red}">${esc(r.label)}</text>`; });
  spec.series.forEach(s => {
    const p = s.pts.filter(q => q[1] != null); if (!p.length) return;
    let d = ''; p.forEach((q, i) => { d += (i ? (s.step ? `H${x(q[0])}V${y(q[1])}` : `L${x(q[0])},${y(q[1])}`) : `M${x(q[0])},${y(q[1])}`); });
    if (s.area) g += `<path d="${d}L${x(p[p.length - 1][0])},${y(ymin)}L${x(p[0][0])},${y(ymin)}Z" fill="${s.color}" opacity=".16"/>`;
    g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.7"/>`;
  });
  const id = 'c' + (++uid);
  wires.push(() => wireHover(id, spec, x, y, m, W, H, xf, yf));
  const legend = spec.series.length > 1 || spec.legend ? `<div class="legend">${spec.series.map(s => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>` : '';
  return `<svg id="${id}" viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px">${g}<g id="${id}h"></g><rect id="${id}r" x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/></svg>${legend}`;
}
function wireHover(id, spec, x, y, m, W, H, xf, yf) {
  const r = document.getElementById(id + 'r'), h = document.getElementById(id + 'h'); if (!r) return;
  r.addEventListener('mousemove', e => {
    const b = r.getBoundingClientRect(), px = (e.clientX - b.left) / b.width * (W - m.l - m.r) + m.l;
    let best = null; spec.series.forEach(s => s.pts.forEach(q => { if (q[1] != null) { const dx = Math.abs(x(q[0]) - px); if (!best || dx < best.dx) best = {dx, x: q[0]}; } }));
    if (!best) return;
    const rows = spec.series.map(s => { const q = s.pts.reduce((a, c) => c[1] != null && Math.abs(c[0] - best.x) < Math.abs((a ? a[0] : 1e18) - best.x) ? c : a, null); return q ? `<span style="color:${s.color}">●</span> ${esc(s.name)}: <b>${yf(q[1])}</b>` : ''; });
    h.innerHTML = `<line x1="${x(best.x)}" x2="${x(best.x)}" y1="${m.t}" y2="${H - m.b}" stroke="var(--muted)" stroke-dasharray="3 3"/>`;
    r.setAttribute('data-tip', `<div class="muted">${xf(best.x)}</div>` + rows.join('<br>'));
  });
  r.addEventListener('mouseleave', () => { h.innerHTML = ''; r.removeAttribute('data-tip'); tip.hidden = true; });
}
/* bars: [{label,value,color,tip}] */
function barChart(bars, o = {}) {
  const W = 920, H = o.h || 190, m = {l: 52, r: 14, t: 10, b: 38};
  if (!bars.length) return '<p class="muted small">no data</p>';
  const ymax = (o.ymax ?? Math.max(...bars.map(b => b.value), 0.0001)) * 1.08, y = scale(0, ymax, H - m.b, m.t);
  const bw = (W - m.l - m.r) / bars.length, yf = o.yfmt || n1;
  let g = ticks(0, ymax, 4).map(v => `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${y(v)}" y2="${y(v)}"/><text x="${m.l - 6}" y="${y(v) + 4}" text-anchor="end">${yf(v)}</text>`).join('');
  g += `<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>`;
  bars.forEach((b, i) => {
    const x0 = m.l + i * bw + bw * .12, w = bw * .76;
    g += `<rect x="${x0}" y="${y(b.value)}" width="${w}" height="${Math.max(0, y(0) - y(b.value))}" rx="2" fill="${b.color || 'var(--accent)'}" data-tip="${esc(b.tip || b.label + ': ' + yf(b.value))}"/>`;
    if (bars.length <= 24) g += `<text x="${x0 + w / 2}" y="${H - m.b + 13}" text-anchor="middle" ${bars.length > 10 ? `transform="rotate(35 ${x0 + w / 2} ${H - m.b + 13})" text-anchor="start"` : ''}>${esc((b.label || '').slice(0, 14))}</text>`;
  });
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px">${g}</svg>`;
}
function gantt(agents, total) {
  const rows = agents.filter(a => a.start != null); if (!rows.length) return '<p class="muted small">no timeline (an imported run has durations only)</p>';
  const L = 168, W = 1180, rh = 25, H = rows.length * rh + 30, x = scale(0, total || 1, L, W - 12);
  let g = ticks(0, total, 8).map(v => `<line class="grid" x1="${x(v)}" x2="${x(v)}" y1="2" y2="${H - 22}"/><text x="${x(v)}" y="${H - 8}" text-anchor="middle">${dur(v)}</text>`).join('');
  rows.forEach((a, i) => {
    const y0 = i * rh + 4, e = a.end ?? total, w = Math.max(2, x(e) - x(a.start)), stroke = a.light === 'red' ? COL.red : a.light === 'amber' ? COL.amber : 'none';
    const t = `<b>${esc(a.name)}</b> — ${esc(a.role)}<br>${dur(a.seconds)} (${(a.share * 100).toFixed(1)}% of the run)<br>${a.status} · ${a.attempts} attempt(s) · ${a.fixes} fix(es)` +
      (a.queue_wait > 1 ? `<br>waited ${dur(a.queue_wait)} to be admitted` : '') + (a.solo_s > 1 ? `<br>alone for ${dur(a.solo_s)}` : '') + (a.why.length ? `<br><i>${esc(a.why.join('; '))}</i>` : '');
    g += `<text x="${L - 8}" y="${y0 + 14}" text-anchor="end">${esc(a.name)}</text>` +
      `<rect x="${x(a.start)}" y="${y0}" width="${w}" height="${rh - 8}" rx="3" fill="${a.color}" opacity="${a.status === 'RUNNING' ? .55 : .9}" stroke="${stroke}" stroke-width="2" data-tip="${esc(t)}"/>` +
      (w > 46 ? `<text x="${x(a.start) + 6}" y="${y0 + 14}" style="fill:#fff;font-weight:600">${dur(a.seconds)}</text>` : '');
  });
  return `<div class="wrap"><svg viewBox="0 0 ${W} ${H}" width="100%" style="min-width:760px;max-width:${W}px">${g}</svg></div>`;
}
const stageColor = (() => { const m = {}; return s => m[s] || (m[s] = PALETTE[Object.keys(m).length % PALETTE.length]); })();
function scatter(points, total) {
  const W = 920, H = 220, m = {l: 52, r: 14, t: 10, b: 26}; if (!points.length) return '<p class="muted small">no data</p>';
  const ymax = Math.max(...points.map(p => p[1]), 1) * 1.08, x = scale(0, total || 1, m.l, W - m.r), y = scale(0, ymax, H - m.b, m.t);
  let g = frame(W, H, m, x, y, ticks(0, total, 6), ticks(0, ymax, 4), dur, v => v + 's', 'time into the run');
  points.forEach(p => { g += `<circle cx="${x(p[0])}" cy="${y(p[1])}" r="${p[3] ? 2.6 : 4}" fill="${p[3] ? stageColor(p[2]) : COL.red}" opacity=".75" data-tip="${esc(p[2])} · ${p[1]}s${p[3] ? '' : ' · FAILED'}"/>`; });
  const st = [...new Set(points.map(p => p[2]))];
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" style="max-width:${W}px">${g}</svg><div class="legend">${st.map(s => `<span><i style="background:${stageColor(s)}"></i>${esc(s)}</span>`).join('')}<span><i style="background:var(--red)"></i>failed attempt</span></div>`;
}
const ring = (v, l) => { const c = 2 * Math.PI * 44; return `<div class="ring"><svg width="104" height="104"><circle cx="52" cy="52" r="44" fill="none" stroke="var(--panel2)" stroke-width="9"/><circle cx="52" cy="52" r="44" fill="none" stroke="${COL[l]}" stroke-width="9" stroke-linecap="round" stroke-dasharray="${(v ?? 0) / 100 * c} ${c}"/></svg><div class="n">${v ?? '–'}</div></div>`; };
const tile = (l, v, d = '', c = '') => `<div class="tile ${c}"><div class="v">${v}</div><div class="l">${l}</div>${d ? `<div class="d">${d}</div>` : ''}</div>`;
const lightOf = v => v == null ? 'grey' : v >= 80 ? 'green' : v >= 55 ? 'amber' : 'red';

// ---------------------------------------------------------------- views
function srcCard(x, cur) {
  const live = x.running ? `<span class="live"></span>${x.running} running` : '';
  const l = x.health == null ? 'grey' : lightOf(x.health);
  return `<a class="src ${cur === x.id ? 'on' : ''}" href="#/src/${x.id}"><div class="src-h"><b>${esc(SRC_NAME[x.id] || x.label)}</b><span class="small">${live}</span></div>` +
    `<div class="muted small">${esc(SRC_HELP[x.id] || '')}</div>` +
    `<div class="src-k"><div><div class="v">${x.runs}</div><div class="l">runs</div></div><div><div class="v">${x.pass_rate == null ? '–' : Math.round(x.pass_rate) + '%'}</div><div class="l">passed</div></div>` +
    `<div><div class="v">${light(l)}${x.health ?? '–'}</div><div class="l">health</div></div><div><div class="v">${money(x.cost)}</div><div class="l">model cost</div></div></div>` +
    `<div class="muted small">last run ${x.last_started ? when(x.last_started) : 'none yet'}</div></a>`;
}
function viewHome(ov, runs, src) {
  const T = ov.totals, srcs = ['api', 'cli'].map(k => ov.sources[k] || {id: k, label: SRC_NAME[k], runs: 0, running: 0, pass_rate: null, health: null, cost: 0, last_started: null});
  const trend = ov.runs.filter(r => r.status !== 'running').slice(-30);
  const bar = (f, fmt, col) => trend.map(r => ({label: r.pr, value: f(r) ?? 0, color: col ? col(r) : COL[r.light], tip: `${r.id}<br>${fmt(f(r))} · health ${r.score ?? '–'}`}));
  const ag = ov.agents.filter(a => a.seconds > 0).slice(0, 12);
  const live = runs.filter(r => r.status === 'running');
  const th = (k, t, n) => `<th class="s ${n ? 'num' : ''}" data-sort="${k}">${t}${state.sort.k === k ? (state.sort.d > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  const sorted = [...runs].sort((a, b) => { const k = state.sort.k, x = a[k], y = b[k]; return ((x ?? -1) > (y ?? -1) ? 1 : -1) * state.sort.d; });
  return `<h1>Overall health <span class="muted" style="font-size:15px;font-weight:500">· ${src ? esc(SRC_NAME[src] || src) : 'all runs'}</span></h1>` +
    `<p class="muted">Every run is added here as it happens, so these totals keep growing. Green = healthy, amber = look at it, red = needs attention.</p>` +
    `<div class="srcs">${srcs.map(x => srcCard(x, src)).join('')}</div>` +
    (live.length ? `<div class="card" style="margin:14px 0"><span class="live"></span><b>${live.length} run${live.length > 1 ? 's' : ''} in progress</b> — ${live.map(r => `<a href="#/run/${r.id}">${esc(r.id)}</a>`).join(', ')}</div>` : '') +
    `<h2>Totals so far</h2><div class="tiles">` +
    tile('runs', T.runs, `${T.passed} passed · ${T.needs_review} need review · ${T.crashed} failed`) +
    tile('success rate', T.pass_rate == null ? '–' : Math.round(T.pass_rate) + '%', 'runs that passed the final check', T.pass_rate == null ? '' : T.pass_rate >= 80 ? 'green' : T.pass_rate >= 50 ? 'amber' : 'red') +
    tile('average health', T.health ?? '–', 'score out of 100', T.health == null ? '' : lightOf(T.health)) +
    tile('time spent', dur(T.wall_s), `${dur(T.mean_wall_s)} per run`) +
    tile('model calls', n0(T.calls), `${n0(T.failed_calls)} failed`, T.calls && T.failed_calls / T.calls > .1 ? 'red' : T.calls && T.failed_calls / T.calls > .03 ? 'amber' : '') +
    tile('model cost', money(T.cost), `${money(T.cost_per_run)} per run · ${esc(ov.prices ? 'gpt-6-luna prices' : '')}`) +
    tile('saved by the cache', money(T.cache_saved), `${pct(T.cache_pct)} of input was reused`) +
    tile('words read / written', `${tok(T.tokens_in)} / ${tok(T.tokens_out)}`, 'tokens in / out') + `</div>` +
    `<h2>Run by run</h2><div class="row">` +
    `<div class="card grow"><h3>Health of each run</h3>${barChart(bar(r => r.score, v => 'health ' + (v ?? '–')), {ymax: 100})}</div>` +
    `<div class="card grow"><h3>Model cost of each run</h3>${barChart(bar(r => r.cost, money, r => 'var(--accent)'), {yfmt: money})}</div></div>` +
    `<div class="row" style="margin-top:14px"><div class="card grow"><h3>Time each run took</h3>${barChart(bar(r => r.wall_s, dur), {yfmt: dur})}</div>` +
    `<div class="card grow"><h3>Failed model calls in each run</h3>${barChart(bar(r => r.failed_calls, n0, r => r.failed_calls ? 'var(--red)' : 'var(--green)'), {yfmt: n0})}</div></div>` +
    `<h2>Where the model time and money go <span class="muted small">— all runs added up, per agent</span></h2><div class="row">` +
    `<div class="card grow"><h3>Cost per agent</h3>${hbars(ov.model.map((a, i) => ({label: a.label, value: a.cost, text: money(a.cost), color: PALETTE[i % PALETTE.length], tip: `${a.label}<br>${n0(a.calls)} calls · ${money(a.cost)}<br>without cache it would be ${money(a.cost_if_no_cache)}`})))}</div>` +
    `<div class="card grow"><h3>Model calls per agent</h3>${hbars(ov.model.map((a, i) => ({label: a.label, value: a.calls, text: n0(a.calls), color: PALETTE[i % PALETTE.length], tip: `${n0(a.failed)} failed · ${a.mean_s}s per call`})))}</div>` +
    `<div class="card grow"><h3>Input reused from the cache</h3>${hbars(ov.model.map(a => ({label: a.label, value: a.cache_pct, text: pct(a.cache_pct), color: a.cache_pct >= 50 ? 'var(--green)' : a.cache_pct >= 20 ? 'var(--amber)' : 'var(--red)', tip: `${tok(a.tokens_cached)} of ${tok(a.tokens_in)} input tokens`})))}</div></div>` +
    `<div class="row" style="margin-top:14px"><div class="card grow"><h3>Work shared between workers <span class="muted small" style="text-transform:none">(a worker is one parallel slot)</span></h3>${hbars(ov.workers.map(w => ({label: 'worker ' + w.worker, value: w.calls, text: n0(w.calls) + ' calls', tip: `${dur(w.busy_s)} busy · ${money(w.cost)} · ${n0(w.failed)} failed`})))}</div>` +
    `<div class="card grow"><h3>Average time each agent takes</h3>${hbars(ag.map((a, i) => ({label: a.name, value: a.mean_s, text: dur(a.mean_s), color: a.failed ? 'var(--red)' : undefined, tip: `${a.name}: ${dur(a.mean_s)} on average over ${a.runs} runs · longest ${dur(a.max_s)} · failed ${a.failed}×`})))}</div></div>` +
    (ov.problems.length ? `<h2>What keeps going wrong</h2><div class="card">${ov.problems.map(p => `<div class="prow"><span>${esc(p.title)}</span><span class="chip amber">${p.runs} run${p.runs > 1 ? 's' : ''}</span></div>`).join('')}</div>` : '') +
    `<h2>All runs</h2><p class="muted small">Click a run for the full picture; tick two or more to compare.</p>` +
    `<div class="card wrap" style="padding:0"><table><thead><tr><th></th>${th('id', 'Run')}${th('source', 'Where')}${th('status', 'Result')}${th('score', 'Health', 1)}${th('wall_s', 'Time', 1)}${th('llm_calls', 'Model calls', 1)}${th('cost', 'Cost', 1)}${th('cache_pct', 'Cached', 1)}<th>Biggest finding</th></tr></thead><tbody>` +
    (sorted.length ? sorted.map(r => `<tr class="click" data-open="${esc(r.id)}"><td><input type="checkbox" data-sel="${esc(r.id)}" ${state.sel.has(r.id) ? 'checked' : ''}></td><td><b>${esc(r.id)}</b><br><span class="muted small">${when(r.started)}${r.commits ? ' · ' + n0(r.commits) + ' commits' : ''}</span></td>` +
      `<td>${chip(SRC_NAME[r.source] || r.source || '')}${r.fake_llm ? ' ' + chip('test model') : ''}${r.mercor ? ' ' + chip(r.mercor === 'finished' ? 'graded' : 'grading', r.mercor === 'finished' ? 'green' : 'run') : ''}</td><td>${statusChip(r)}</td><td class="num">${light(r.light)}${r.score ?? '–'}</td><td class="num">${dur(r.wall_s)}</td>` +
      `<td class="num">${n0(r.llm_calls)}${r.llm_failed ? ` <span style="color:var(--red)">(${r.llm_failed} failed)</span>` : ''}</td><td class="num">${money(r.cost)}</td><td class="num">${r.llm_calls ? pct(r.cache_pct) : '–'}</td><td class="small">${esc(r.top || '')}</td></tr>`).join('')
      : '<tr><td colspan="10" class="muted">No runs yet. Start one and it appears here live.</td></tr>') + `</tbody></table></div>` +
    `<p><button id="cmp" ${state.sel.size < 2 ? 'disabled' : ''}>Compare ${state.sel.size} selected</button></p>`;
}
const TAB_NAME = {overview: 'Summary', mercor: 'Mercor grader', agents: 'Agents', llm: 'Model calls', system: 'Machine', bottlenecks: 'Findings'};
function tabs(id, cur) { return `<div class="tabs">${Object.keys(TAB_NAME).map(t => `<a href="#/run/${id}/${t}" class="${t === cur ? 'on' : ''}">${TAB_NAME[t]}</a>`).join('')}</div>`; }
document.addEventListener('click', e => { const b = e.target.closest && e.target.closest('[data-dl]'); if (b && state.run) mgDownload(state.run, b.dataset.dl); });
function head(r) {
  return `<p class="small"><a href="#/">← back to overall health</a></p><h1>${esc(r.id)} ${statusChip(r)} ${r.legacy ? chip('imported from an older run') : ''}${r.source ? ' ' + chip(SRC_NAME[r.source] || r.source) : ''}${r.meta.fake_llm ? ' ' + chip('test model') : ''}${r.mercor ? ' ' + chip(r.mercor.status === 'finished' ? 'graded' : 'grading', r.mercor.status === 'finished' ? 'green' : 'run') : ''}</h1>` +
    `<p class="muted">${when(r.started)} · ${dur(r.wall_s)}${r.status === 'running' ? ' so far' : ''} · model ${esc(r.meta.model || '?')} / ${esc(r.meta.effort || '?')}${(r.repo_stats?.before?.commits ?? r.meta.commits) ? ' · ' + n0(r.repo_stats?.before?.commits ?? r.meta.commits) + ' commits' : ''}${r.meta.tier ? ' · ' + r.meta.tier + ' tier' : ''}${r.result ? ' · ' + esc(r.result) : ''}</p>`;
}
function repoPanel(r) {
  const S = r.repo_stats, B = S && S.before, A = S && S.after, G = r.mercor && r.mercor.after;
  const title = '<h2 style="margin-top:6px">Repository before and after</h2>';
  if (!B) return title + '<p class="note">Repository counts were not recorded for this run.</p>';
  const rows = [['commits', 'Commits', 'whole history, all branches'], ['loc', 'Lines of code', 'text lines in the files of the latest commit'],
    ['contributors', 'Contributors', 'different authors in the history'], ['prs', 'Pull requests', 'merged pull requests'], ['issues', 'Issues', 'issues']];
  const num = v => v == null ? '–' : n0(v);
  const gv = k => { const v = k === 'loc' ? G.loc_code : G[k]; return v == null ? '<span class="muted">–</span>' : n0(v) + (k === 'loc' ? ' <span class="muted small">code lines</span>' : ''); };
  const diff = (b, a) => {
    if (b == null || a == null) return '<span class="muted">–</span>';
    const d = a - b; if (!d) return '<span class="muted">no change</span>';
    return (d > 0 ? '+' : '−') + n0(Math.abs(d)) + (b ? ` <span class="muted small">(${d > 0 ? '+' : '−'}${Math.abs(d / b * 100).toFixed(1)}%)</span>` : '');
  };
  return title + `<div class="card wrap" style="padding:0"><table><thead><tr><th></th><th class="num">Original repository <span class="muted small">(before)</span></th>` +
    `<th class="num">Anonymised repository <span class="muted small">(after)</span></th><th class="num">Difference</th>${G ? '<th class="num">Measured by the grader <span class="muted small">(after)</span></th>' : ''}</tr></thead><tbody>` +
    rows.map(([k, label, hint]) => `<tr><td><b>${label}</b><br><span class="muted small">${hint}</span></td><td class="num">${num(B[k])}</td>` +
      `<td class="num">${A ? num(A[k]) : '<span class="muted">not recorded</span>'}</td><td class="num">${A ? diff(B[k], A[k]) : '<span class="muted">–</span>'}</td>${G ? `<td class="num">${gv(k)}</td>` : ''}</tr>`).join('') +
    `</tbody></table></div><p class="small muted">Counts only: no names or file contents. “After” is the repository this run delivered, with its anonymised pull requests and issues. ` +
    `Small differences are expected, because the anonymisation rewrites names, authors and some text.${G ? ' The grader column is what the Mercor analysis tool counted on the delivered repository (lines are code lines only, so they are lower than the text lines above).' : ''}${A ? '' : ' This run has no “after” figures: the delivered repository is overwritten by the next run of the same repository, so only the latest run of each repository keeps them.'}</p>`;
}
function recognitionPanel(r) {
  const J = r.meta && r.meta.traceability; if (!J) return '';
  const V = {recognised: ['A stranger could name the source project', 'red'], partly: ['Partly recognised', 'amber'],
    not_recognised: ['Not recognised', 'green'], unusable: ['No usable answer', 'amber']}[J.verdict] || [J.verdict, 'amber'];
  const say = {recognised: 'A model that saw only the delivered repository named the project it comes from. The evidence it relied on is counted below; the next run replaces the phrases it can.',
    partly: 'A model that saw only the delivered repository named the project with low confidence, or only as one of several guesses.',
    not_recognised: 'A model that saw only the delivered repository could not name the project it comes from.',
    unusable: 'The judge did not return an answer that could be used. This does not affect the result of the run.'}[J.verdict] || '';
  const kinds = Object.entries(J.evidence_by_kind || {}).map(([k, n]) => chip(`${k} · ${n}`)).join(' ');
  return `<div class="card" style="margin-top:14px"><h3>Blind recognition <span class="muted small">(a model judging the delivered repository)</span></h3>` +
    `<p>${chip(V[0], V[1])}${J.confidence != null ? ` <span class="muted">confidence ${Math.round(J.confidence * 100)}%</span>` : ''}</p><p class="small">${say}</p>` +
    (J.evidence_total ? `<p class="small"><b>${n0(J.evidence_total)}</b> piece(s) of evidence: ${kinds}${J.fixable_phrases ? ` · <b>${n0(J.fixable_phrases)}</b> phrase(s) can be replaced automatically` : ''}</p>` : '') +
    `<p class="small muted">Advisory only: it never fails a run. What the model guessed, and the exact text it relied on, name the real project and are kept private.</p></div>`;
}
function tabOverview(r) {
  const s = r.score, k = r.kpis, comp = (n, v, why) => `<div class="comp"><span>${n}</span><div class="bar"><i style="width:${v ?? 0}%;background:${COL[lightOf(v)]}"></i></div><b>${v ?? '–'}</b></div>${why && why.length ? `<div class="small muted" style="margin:-2px 0 6px 98px">${esc(why.join(' · '))}</div>` : ''}`;
  const cp = r.critical_path;
  return repoPanel(r) + recognitionPanel(r) + `<div class="row" style="margin-top:14px"><div class="card grow"><h3>Health</h3><div class="score">${ring(s.overall, s.light)}<div style="flex:1">${comp('Outcome', s.outcome)}${comp('Agents', s.agents)}${comp('LLM', s.llm, s.llm_why)}${comp('System', s.system, s.system_why)}</div></div></div>` +
    `<div class="card grow"><h3>What to look at first</h3>${r.bottlenecks.slice(0, 3).map(insight).join('') || '<p class="muted">No findings.</p>'}<p class="small"><a href="#/run/${r.id}/bottlenecks">all findings →</a></p></div></div>` +
    `<h2>At a glance</h2><div class="tiles">` +
    tile('total time', dur(k.wall_s), r.status === 'running' ? 'still running' : '') +
    tile('agents', `${k.agents}`, `${k.failed_agents} failed · ${k.skipped_agents} skipped`, k.failed_agents ? 'red' : '') +
    tile('Fixer interventions', k.fixes, 'env/config fixes applied', k.fixes ? 'amber' : '') +
    tile('parallel efficiency', k.parallel_efficiency != null ? k.parallel_efficiency + '×' : '–', 'agent-seconds ÷ wall') +
    tile('time with 1 agent only', k.solo_share != null ? Math.round(k.solo_share * 100) + '%' : '–', 'serial share', k.solo_share > .4 ? 'amber' : '') +
    tile('LLM calls', n0(k.llm_calls), k.llm_calls ? `mean ${k.llm_mean_s}s` : '') +
    tile('tokens in / out', `${tok(k.tokens_in)} / ${tok(k.tokens_out)}`, k.llm_calls ? `${k.cache_pct}% cached` : '') +
    tile('peak memory', k.peak_mem != null ? n1(k.peak_mem) + ' GiB' : '–', r.meta.pool_gib ? `of ${n1(r.meta.pool_gib)} GiB pool` : '') +
    tile('avg CPU', k.avg_cpu != null ? n1(k.avg_cpu) + ' cores' : '–', r.meta.cpus ? `of ${r.meta.cpus}` : '') + `</div>` +
    (cp.length ? `<h2>Critical path <span class="muted small">— the chain that decided the finish time</span></h2><div class="card"><div class="crit">${cp.map((p, i) => `${i ? `<span class="a">→${p.wait > 1 ? ' (' + dur(p.wait) + ' wait) ' : ''}</span>` : ''}<span class="n"><b>${esc(p.name)}</b> ${dur(p.seconds)}</span>`).join('')}</div></div>` : '') +
    `<h2>Timeline</h2><div class="card">${gantt(r.agents, r.wall_s)}</div>`;
}

// ---------------------------------------------------------------- Mercor grader (repo-quality-score + repo_analysis_tool, run on the delivered repository)
const MG_GROUPS = [
  ['The repository', [['repo_name', 'Name'], ['license_type', 'License'], ['is_git', 'Git history found'], ['git_history_intact', 'History looks continuous']]],
  ['History', [['commits', 'Commits'], ['meaningful_commit_count', 'Meaningful commits'], ['contributors', 'Contributors'], ['branch_count', 'Branches'],
    ['first_commit_date', 'First commit'], ['last_commit_date', 'Last commit'], ['development_span_months', 'Active span (months)'], ['commits_per_month', 'Commits per month']]],
  ['Code size', [['loc_code', 'Lines of code'], ['loc_comment', 'Comment lines'], ['loc_blank', 'Blank lines'], ['loc_files', 'Source files'], ['tokens_llm', 'LLM tokens'], ['duplication_weighted_percent', 'Duplication (%)']]],
  ['Languages and frameworks', [['languages', 'Languages'], ['framework_backend', 'Back-end frameworks'], ['framework_frontend', 'Front-end frameworks'], ['databases_used', 'Databases'], ['third_party_apis', 'Third-party APIs']]],
  ['Quality signals from the tool', [['repo_rating_score', 'Tool rating (0–10)'], ['repo_rating_label', 'Tool rating label'], ['code_complexity', 'Code complexity'], ['documentation_quality', 'Documentation'],
    ['setup_guidelines', 'Setup guide'], ['security_findings', 'Secrets scan'], ['ai_detection_percent', 'AI-detection (%)']]],
  ['Pull requests (GitHub)', [['total_pr_count', 'Total'], ['open_pr_count', 'Open'], ['closed_pr_count', 'Closed'], ['merged_pr_count', 'Merged'], ['github_pr_analysis_available', 'Available']]]];
const MG_NUMERIC = new Set(['commits', 'meaningful_commit_count', 'contributors', 'branch_count', 'loc_code', 'loc_comment', 'loc_blank', 'loc_files', 'tokens_llm', 'total_pr_count', 'open_pr_count', 'closed_pr_count', 'merged_pr_count']);
function mgDownload(run, name) {
  const f = (run.mercor && run.mercor.files || {})[name]; if (f == null) return;
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob(['﻿' + f], {type: 'text/csv'})); a.download = name; document.body.appendChild(a); a.click(); a.remove();
}
function mgCommand(r) {
  const repo = String(r.pr || '').replace(/^API-/, ''), src = r.source === 'api' ? 'api' : 'cli';
  return `powershell -ExecutionPolicy Bypass -File .\\_dev\\run_mercor.ps1 -PR ${repo} -Source ${src}`;
}
function tabMercor(r) {
  const M = r.mercor;
  if (!M) return `<h2 style="margin-top:6px">Mercor grader</h2><p class="note">The grader has not been run on this repository yet. It scores the repository this run delivered, with the quality-score agent and the analysis tool, and shows the result here.</p>` +
    `<p class="small muted">Run it from the folder that holds <span class="mono">_dev</span>:</p><div class="card"><span class="mono small" style="word-break:break-all">${esc(mgCommand(r))}</span></div>`;
  const steps = M.steps || [], wall = M.wall_s || 1, st = M.status;
  const stChip = st === 'finished' ? chip('finished', 'green') : st === 'running' ? chip('running', 'run') : chip(st || 'unknown', 'amber');
  const stepSec = n => (steps.find(s => s.name === n) || {}).seconds;
  const A = M.agent, T = M.tool, Q = M.quality, S = M.summary || {}, files = M.files || {};
  const rows = steps.map((s, i) => {
    const off = M.started && s.started ? Math.max(0, s.started - M.started) : 0, w = s.seconds != null ? s.seconds : (M.started ? (Date.now() / 1000 - (s.started || M.started)) : 0);
    return `<tr><td><b>${esc(s.label)}</b><br><span class="muted small">${s.kind === 'agent' ? 'AI agent (Codex)' : s.kind === 'setup' ? 'setup' : 'program'}</span></td>` +
      `<td style="width:46%"><div class="bar" style="height:14px"><i style="margin-left:${(off / wall * 100).toFixed(1)}%;width:${Math.max(1.5, w / wall * 100).toFixed(1)}%;background:${PALETTE[i % PALETTE.length]}"></i></div></td>` +
      `<td class="num">${s.seconds != null ? dur(s.seconds) : 'running…'}</td><td>${s.status === 'running' ? chip('running', 'run') : s.exit === 0 || s.exit == null ? chip('done', 'green') : chip('exit ' + s.exit, 'red')}</td></tr>`;
  }).join('');
  const grp = ([title, keys]) => {
    const items = keys.filter(([k]) => S[k] !== undefined && S[k] !== '');
    return items.length ? `<div class="card"><h3>${esc(title)}</h3><table style="table-layout:auto;width:100%"><tbody>${items.map(([k, l]) => `<tr><td class="muted small">${esc(l)}</td><td class="num" style="white-space:normal;overflow-wrap:anywhere;text-align:right">${MG_NUMERIC.has(k) && !isNaN(+S[k]) ? n0(+S[k]) : esc(S[k])}</td></tr>`).join('')}</tbody></table></div>` : '';
  };
  const names = Object.keys(files);
  return `<h2 style="margin-top:6px">Mercor grader ${stChip}</h2><p class="muted">The quality-score agent and the analysis tool, run on <span class="mono">${esc(M.tree || 'the delivered repository')}</span> — the repository this run delivered, after anonymisation.</p>` +
    `<div class="tiles">` + tile('time to complete', dur(M.wall_s), st === 'running' ? 'still running' : `${when(M.started)} → ${when(M.ended)}`) +
    tile('quality-score agent', dur(stepSec('quality_score')), A ? `${esc(A.model || '?')} · ${esc(A.effort || '?')}` : 'not run') +
    tile('analysis tool', dur(stepSec('analysis_tool')), T && T.seconds != null ? `tool reports ${T.seconds}s of work` : 'not run') +
    tile('agent tokens', A && A.tokens != null ? tok(A.tokens) : '–', A ? `${n0(A.commands)} commands${A.failed ? ' · ' + A.failed + ' failed' : ''}` : '') + `</div>` +
    `<h2>Steps</h2><div class="card wrap" style="padding:0"><table><thead><tr><th>Step</th><th>Timeline</th><th class="num">Took</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table></div>` +
    (A ? `<div class="row" style="margin-top:14px"><div class="card grow"><h3>What the scoring agent did</h3>${hbars((A.by_kind || []).map((k, i) => ({label: k.kind, value: k.count, text: k.count + (k.count > 1 ? ' commands' : ' command'), color: PALETTE[i % PALETTE.length], tip: `${k.count} commands, ${k.seconds}s of command time`})))}` +
      `<p class="small muted">Commands the agent ran inside the container. Most of its time is the model thinking, not running commands.</p></div>` +
      `<div class="card grow"><h3>Quality score</h3>${Q && Q.completed ? `<p>${chip('scoring complete', 'green')}</p>` : `<p>${chip('not complete', 'amber')}</p>`}` +
      `<p class="small">The score is written only to a sealed file${Q && Q.sealed_file ? ` (<span class="mono">${esc(Q.sealed_file)}</span>, ${n0(Q.sealed_size_kb)} KB)` : ''}. The quality-score method keeps scores out of any place a person can read, so this dashboard does not read or show them.</p></div></div>` : '') +
    (T ? `<h2>Analysis tool stages</h2><div class="card"><div class="crit">${(T.stages || []).map(x => `<span class="n"><b>${esc(x.stage)}</b> ${x.done ? '✓' : x.active ? '…' : '–'}<br><span class="muted small">${esc(x.what)}</span></span>`).join('')}</div></div>` : '') +
    (Object.keys(S).length ? `<h2>The delivered repository, as the grader measured it</h2><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px">${MG_GROUPS.map(grp).join('')}</div>` : '<p class="note">The analysis tool has not produced its tables yet.</p>') +
    (names.length ? `<h2>Reports</h2><div class="card wrap" style="padding:0"><table><thead><tr><th>File</th><th>What it holds</th><th></th></tr></thead><tbody>${names.map(n => `<tr><td><b>${esc(n)}</b></td><td class="muted small">${n === 'summary_all.csv' ? 'All 40 measurements of the repository, one row' : 'The short executive view: licence, security status, architecture labels'}</td><td class="num"><button data-dl="${esc(n)}">Download</button></td></tr>`).join('')}</tbody></table></div>` +
      `<p class="small muted">Downloads open in Excel. The tool's deep report and the console logs stay on the machine that ran the grader: they list files of the repository.</p>` : '');
}
function tabAgents(r) {
  const rows = r.agents;
  return `<h2 style="margin-top:6px">Agent timeline</h2><div class="card">${gantt(rows, r.wall_s)}<div class="legend">${[...new Set(rows.map(a => a.group))].map(g => `<span><i style="background:${(rows.find(a => a.group === g) || {}).color}"></i>${g}</span>`).join('')}<span>outline: <b style="color:var(--amber)">amber</b>/<b style="color:var(--red)">red</b> = health</span></div></div>` +
    (r.concurrency.length > 1 ? `<h2>Agents running at once</h2><div class="card">${lineChart({series: [{name: 'agents running', color: '#5b9cf5', pts: r.concurrency, step: true, area: true}], h: 140, yfmt: n0})}</div>` : '') +
    `<h2>Per agent</h2><div class="card wrap" style="padding:0"><table><thead><tr><th>Agent</th><th>Group</th><th class="num">Start</th><th class="num">Time</th><th class="num">% of run</th><th class="num">Alone for</th><th class="num">Waited</th><th class="num">Attempts</th><th class="num">Fixes</th><th>Status</th><th>Health</th></tr></thead><tbody>` +
    rows.map(a => `<tr><td><b>${esc(a.name)}</b><br><span class="muted small">${esc(a.role)}</span></td><td>${esc(a.group)}</td><td class="num">${a.start != null ? dur(a.start) : '–'}</td><td class="num">${dur(a.seconds)}</td><td class="num">${(a.share * 100).toFixed(1)}%</td><td class="num">${a.solo_s ? dur(a.solo_s) : '–'}</td><td class="num">${a.queue_wait > 1 ? dur(a.queue_wait) : '–'}</td><td class="num">${a.attempts}</td><td class="num">${a.fixes}</td><td>${chip(a.status, a.status === 'SUCCESS' || a.status === 'RESUMED' ? 'green' : a.status === 'FAILED' ? 'red' : '')}</td><td>${light(a.light)}<span class="small muted">${esc(a.why.join('; '))}</span></td></tr>`).join('') + `</tbody></table></div>`;
}
function tabLLM(r) {
  const L = r.llm; if (!L.calls && !L.cache_hits) return '<p class="note">No model calls were recorded for this run' + (r.meta.fake_llm ? ' (it used the test model).' : '.') + '</p>';
  const c = (v, a, b) => v > b ? 'red' : v > a ? 'amber' : '';
  const A = L.api || {}, haveW = (L.by_worker || []).length > 0, P = L.prices || {};
  const agentRows = (L.by_agent || []), workerRows = (L.by_worker || []);
  return `<h2 style="margin-top:6px">This run in numbers</h2><div class="tiles">` +
    tile('model calls', n0(L.calls), `${n0(L.cache_hits)} answered from saved answers (free)`) + tile('cost of this run', money(L.cost), `${money(L.cost_per_call)} per call · gpt-6-luna prices`) +
    tile('saved by the cache', money(L.cache_saved), `without it: ${money(L.cost_if_no_cache)}`) + tile('input reused from cache', pct(L.cache_pct), `${tok(L.tokens_cached)} of ${tok(L.tokens_in)} read`, L.tokens_in && !r.meta.fake_llm && L.cache_pct < 30 ? 'amber' : '') +
    tile('words read (input)', tok(L.tokens_in), `${n0(L.in_per_call)} per call`) + tile('words written (output)', tok(L.tokens_out), 'includes the model thinking') +
    tile('average call time', L.mean_s + 's', `typical ${L.p50_s}s · slowest 5%: ${L.p95_s}s`, L.p50_s && L.p95_s / L.p50_s > 4 ? 'amber' : '') + tile('failed calls', n0(L.failed), pct(L.fail_rate * 100) + ' of calls', c(L.fail_rate, .03, .1)) +
    (A.requests ? tile('rate-limited by the API (429)', n0(A.rate_limited), A.rate_limited ? 'too many at once: lower the workers' : 'none', A.rate_limited ? (A.rate_limited > 5 ? 'red' : 'amber') : '') +
      tile('API errors / timeouts', `${n0(A.server_errors)} / ${n0(A.timeouts + A.network)}`, `key problems: ${n0(A.auth_errors)} · rejected: ${n0(A.other_4xx)}`, (A.server_errors + A.timeouts + A.network + A.auth_errors) ? 'amber' : '') : '') + `</div>` +
    `<div class="row" style="margin-top:14px"><div class="card grow"><h3>Cost as the run goes on</h3>${lineChart({series: [{name: 'cost so far', color: '#2f8f6b', pts: L.cost_series || [], area: true}], h: 190, yfmt: money})}</div>` +
    `<div class="card grow"><h3>Model calls running at the same time</h3>${lineChart({series: [{name: 'calls running', color: '#5b9cf5', pts: L.inflight, step: true, area: true}, {name: 'allowed at once', color: '#d9a21b', pts: r.workers, step: true}], h: 190, yfmt: n0})}</div></div>` +
    `<h2>By agent <span class="muted small">— which agent uses the model, and what it costs</span></h2>` +
    `<div class="card wrap" style="padding:0"><table><thead><tr><th>Agent</th><th class="num">Calls</th><th class="num">Failed</th><th class="num">Time spent</th><th class="num">Per call</th><th class="num">Words read</th><th class="num">Reused from cache</th><th class="num">Words written</th><th class="num">Cost</th><th class="num">Without cache</th><th class="num">Workers used</th></tr></thead><tbody>` +
    (agentRows.map(a => `<tr><td><b>${esc(a.label)}</b></td><td class="num">${n0(a.calls)}</td><td class="num" style="color:${a.failed ? 'var(--red)' : 'inherit'}">${n0(a.failed)}</td><td class="num">${dur(a.busy_s)}</td><td class="num">${a.mean_s}s</td><td class="num">${tok(a.tokens_in)}</td><td class="num">${pct(a.cache_pct)}</td><td class="num">${tok(a.tokens_out)}</td><td class="num"><b>${money(a.cost)}</b></td><td class="num muted">${money(a.cost_if_no_cache)}</td><td class="num">${haveW ? a.workers : '–'}</td></tr>`).join('') || '<tr><td colspan="11" class="muted">none</td></tr>') + `</tbody></table></div>` +
    `<div class="row" style="margin-top:14px"><div class="card grow"><h3>Cost per agent</h3>${hbars(agentRows.map((a, i) => ({label: a.label, value: a.cost, text: money(a.cost), color: PALETTE[i % PALETTE.length], tip: `${a.label}: ${n0(a.calls)} calls`})))}</div>` +
    `<div class="card grow"><h3>Time spent calling the model, per agent</h3>${hbars(agentRows.map((a, i) => ({label: a.label, value: a.busy_s, text: dur(a.busy_s), color: PALETTE[i % PALETTE.length], tip: `${a.mean_s}s per call`})))}</div>` +
    `<div class="card grow"><h3>Input reused from the cache, per agent</h3>${hbars(agentRows.map(a => ({label: a.label, value: a.cache_pct, text: pct(a.cache_pct), color: a.cache_pct >= 50 ? 'var(--green)' : a.cache_pct >= 20 ? 'var(--amber)' : 'var(--red)', tip: `${tok(a.tokens_cached)} of ${tok(a.tokens_in)}`})))}</div></div>` +
    `<h2>By worker <span class="muted small">— a worker is one parallel slot that makes calls; the number only tells slots apart</span></h2>` +
    (haveW ? `<div class="card wrap" style="padding:0"><table><thead><tr><th>Worker</th><th class="num">Calls</th><th class="num">Failed</th><th class="num">Busy for</th><th class="num">Share of all call time</th><th class="num">Per call</th><th class="num">Reused from cache</th><th class="num">Cost</th><th>Worked on</th></tr></thead><tbody>` +
      workerRows.map(w => `<tr><td><b>worker ${w.worker}</b></td><td class="num">${n0(w.calls)}</td><td class="num" style="color:${w.failed ? 'var(--red)' : 'inherit'}">${n0(w.failed)}</td><td class="num">${dur(w.busy_s)}</td><td class="num">${Math.round(w.share * 100)}%</td><td class="num">${w.mean_s}s</td><td class="num">${pct(w.cache_pct)}</td><td class="num">${money(w.cost)}</td><td class="small">${esc(w.agents.join(', '))}</td></tr>`).join('') + `</tbody></table></div>` +
      `<div class="row" style="margin-top:14px"><div class="card grow"><h3>Calls per worker</h3>${hbars(workerRows.map(w => ({label: 'worker ' + w.worker, value: w.calls, text: n0(w.calls), tip: `${dur(w.busy_s)} busy`})))}</div>` +
      `<div class="card grow"><h3>Busy time per worker</h3>${hbars(workerRows.map(w => ({label: 'worker ' + w.worker, value: w.busy_s, text: dur(w.busy_s), tip: `${Math.round(w.share * 100)}% of all call time`})))}</div></div>`
      : '<p class="note">Worker numbers were not recorded for this run (it was made before this view existed).</p>') +
    `<h2>How long calls take</h2><div class="row"><div class="card grow"><h3>Each call, over the run</h3>${scatter(L.points, r.wall_s)}</div><div class="card grow"><h3>How long calls take (count by seconds)</h3>${barChart(L.hist.map(b => ({label: b[0] + 's', value: b[1], tip: `${b[0]}s+: ${b[1]} calls`})), {h: 190})}</div></div>` +
    `<h2>Speed</h2><div class="row"><div class="card grow"><h3>Texts processed per minute</h3>${barChart(L.per_min.map(b => ({label: b.min + 'm', value: b.items, tip: `minute ${b.min}: ${b.items} texts in ${b.calls} calls (mean ${b.mean_s}s)`})), {h: 190})}</div></div>` +
    `<p class="small muted">${esc((P.input != null ? `Prices used (per million words): input $${P.input}, cached input $${P.cached_input}, output $${P.output}. ` : ''))}Change them in <span class="mono">dashboard/pricing.json</span>; costs are estimates from the token counts.</p>`;
}
function tabSystem(r) {
  const S = r.system, pool = r.meta.pool_gib; if (!S.series.length) return '<p class="note">No system samples were recorded for this run' + (r.legacy ? ' (an imported run only has LLM data).' : '.') + '</p>';
  const ser = i => S.series.map(p => [p[0], p[i]]);
  return `<div class="tiles">` + tile('peak memory', n1(S.peak_mem) + ' GiB', pool ? Math.round(S.peak_mem / pool * 100) + '% of ' + n1(pool) + ' GiB' : '', pool && S.peak_mem / pool > .92 ? 'red' : pool && S.peak_mem / pool > .8 ? 'amber' : '') +
    tile('above 80% of the pool', dur(S.above_amber_s), `above 92%: ${dur(S.above_red_s)}`, S.above_red_s > 0 ? 'red' : S.above_amber_s > 0 ? 'amber' : '') + tile('avg CPU', n1(S.avg_cpu) + ' cores', `peak ${n1(S.peak_cpu)} of ${r.meta.cpus || '?'}`) + tile('min disk free', S.min_disk != null ? n1(S.min_disk) + ' GiB' : '–', '', S.min_disk != null && S.min_disk < 10 ? 'amber' : '') + `</div>` +
    `<div class="row"><div class="card grow"><h3>Memory (GiB)</h3>${lineChart({series: [{name: 'in use', color: '#cc5a71', pts: ser(2), area: true}, {name: 'reserved by running agents', color: '#8a5cc2', pts: ser(5)}], refs: pool ? [{y: pool, label: 'pool ' + n1(pool) + ' GiB'}, {y: pool * .8, label: '80%', color: COL.amber}] : [], ymax: pool ? pool * 1.1 : undefined, yfmt: v => n1(v)})}</div>` +
    `<div class="card grow"><h3>CPU (cores busy)</h3>${lineChart({series: [{name: 'cores', color: '#2f8f6b', pts: ser(1), area: true}], refs: r.meta.cpus ? [{y: r.meta.cpus, label: r.meta.cpus + ' cpus', color: COL.grey}] : [], yfmt: v => n1(v)})}</div></div>` +
    `<div class="row"><div class="card grow"><h3>LLM workers: allowed vs busy</h3>${lineChart({series: [{name: 'allowed (Governor)', color: '#d9a21b', pts: ser(3), step: true}, {name: 'busy', color: '#5b9cf5', pts: ser(4), step: true, area: true}], yfmt: n0})}</div>` +
    `<div class="card grow"><h3>Agents running</h3>${lineChart({series: [{name: 'agents', color: '#5b9cf5', pts: ser(6), step: true, area: true}], yfmt: n0})}</div></div>`;
}
function insight(i) { return `<div class="ins ${i.severity}"><div class="t"><span class="sev ${i.severity}">${i.severity}</span>${esc(i.title)}</div><div class="e">${esc(i.evidence)}</div>${i.advice ? `<div class="a">→ ${esc(i.advice)}</div>` : ''}</div>`; }
function tabBottlenecks(r) {
  return `<p class="muted">Ranked by how much they cost this run. Each finding names the evidence and the lever.</p>${r.bottlenecks.map(insight).join('') || '<p class="note">Nothing stands out.</p>'}` +
    (r.critical_path.length ? `<h2>Critical path</h2><div class="card"><table><thead><tr><th>Agent</th><th class="num">Waited before start</th><th class="num">Took</th><th class="num">Share of run</th></tr></thead><tbody>${r.critical_path.map(p => `<tr><td><b>${esc(p.name)}</b></td><td class="num">${p.wait > 1 ? dur(p.wait) : '–'}</td><td class="num">${dur(p.seconds)}</td><td class="num">${(p.seconds / r.wall_s * 100).toFixed(1)}%</td></tr>`).join('')}</tbody></table></div>` : '');
}
async function viewRun(id, tab) {
  const r = state.run = await api('/api/run/' + id);
  const body = {overview: tabOverview, mercor: tabMercor, agents: tabAgents, llm: tabLLM, system: tabSystem, bottlenecks: tabBottlenecks}[tab] || tabOverview;
  return head(r) + tabs(id, tab || 'overview') + body(r);
}
async function viewCompare(ids) {
  ids = ids.length ? ids : [...state.sel];
  if (ids.length < 2) return `<h1>Compare</h1><p class="note">Tick two or more runs on the Runs page, then press Compare.</p>`;
  const rs = (await api('/api/compare?ids=' + ids.join(','))).runs, base = rs[0];
  const row = (l, f, fmt, good = -1) => `<tr><td>${l}</td>${rs.map((r, i) => { const v = f(r), b = f(base); const dlt = i && b && v != null ? (v - b) / b * 100 : null; return `<td class="num">${fmt(v)}${dlt != null && Math.abs(dlt) >= 1 ? ` <span class="small" style="color:${(dlt * good) > 0 ? 'var(--green)' : 'var(--red)'}">${dlt > 0 ? '+' : ''}${dlt.toFixed(0)}%</span>` : ''}</td>`; }).join('')}</tr>`;
  const names = [...new Set(rs.flatMap(r => Object.keys(r.agent_seconds)))];
  return `<h1>Compare</h1><p class="muted">Changes are against the first column. Green = better.</p><div class="card wrap" style="padding:0"><table><thead><tr><th></th>${rs.map(r => `<th class="num"><a href="#/run/${r.id}">${esc(r.id)}</a><br><span class="muted small">${when(r.started)}</span></th>`).join('')}</tr></thead><tbody>` +
    row('Health', r => r.score, n0, 1) + row('Total time', r => r.wall_s, dur) + row('Agents failed', r => r.failed_agents, n0) + row('Fixer interventions', r => r.fixes, n0) + row('LLM calls', r => r.llm_calls, n0) + row('Mean call time', r => r.llm_calls ? r.llm_mean_s : null, v => v == null ? '–' : v + 's') +
    row('Tokens in', r => r.tokens_in, tok) + row('Tokens out', r => r.tokens_out, tok) + row('Cached share', r => r.llm_calls ? r.cache_pct : null, v => v == null ? '–' : v + '%', 1) + row('Peak memory', r => r.peak_mem, v => v == null ? '–' : n1(v) + ' GiB') + `</tbody></table></div>` +
    `<h2>Time per agent</h2><div class="card wrap" style="padding:0"><table><thead><tr><th>Agent</th>${rs.map(r => `<th class="num">${esc(r.id)}</th>`).join('')}</tr></thead><tbody>${names.map(n => `<tr><td><b>${esc(n)}</b></td>${rs.map((r, i) => { const v = r.agent_seconds[n]; const b = base.agent_seconds[n]; const dlt = i && b && v != null ? (v - b) / b * 100 : null; return `<td class="num">${v != null ? dur(v) : '–'}${dlt != null && Math.abs(dlt) >= 10 ? ` <span class="small" style="color:${dlt < 0 ? 'var(--green)' : 'var(--red)'}">${dlt > 0 ? '+' : ''}${dlt.toFixed(0)}%</span>` : ''}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
}
async function viewRules() {
  const j = await api('/api/rules');
  return `<h1>How the lights are decided</h1><p class="muted">Every colour comes from a named rule. Health = 35% outcome (LH2 verdict) + 30% agents + 20% LLM + 15% system; a part with no data is left out.</p>` +
    `<div class="card"><h3>Thresholds</h3><table><tbody>${Object.entries(j.rules).map(([k, v]) => `<tr><td class="mono">${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</tbody></table></div>` +
    `<h2>What to do about a slow agent</h2><div class="card"><table><tbody>${Object.entries(j.advice).map(([k, v]) => `<tr><td class="mono"><b>${esc(k)}</b></td><td style="white-space:normal">${esc(v)}</td></tr>`).join('')}</tbody></table></div>`;
}

// ---------------------------------------------------------------- router
async function render(force) {
  uid = 0; wires.length = 0;          // deterministic chart ids: an unchanged page builds identical HTML and is not redrawn
  const h = location.hash.replace(/^#\/?/, '').split('/'), app = $('#app');
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', ((h[0] === '' || h[0] === 'src') && a.id === 'nav-runs') || a.id === 'nav-' + h[0]));
  try {
    let html;
    if (h[0] === 'run' && h[1]) html = await viewRun(h[1], h[2] || 'overview');
    else if (h[0] === 'compare') html = await viewCompare((h[1] || '').split(',').filter(Boolean));
    else if (h[0] === 'rules') html = await viewRules();
    else {
      const src = h[0] === 'src' ? h[1] : '', q = src ? '?src=' + src : '';
      const [ov, rr] = await Promise.all([api('/api/overview' + q), api('/api/runs' + q)]);
      state.runs = rr.runs; html = viewHome(ov, rr.runs, src);
    }
    if (!force && html === state.last) return;
    const y = scrollY; state.last = html; app.innerHTML = html; scrollTo(0, y); wires.forEach(f => f());
    app.querySelectorAll('[data-open]').forEach(tr => tr.addEventListener('click', e => { if (e.target.tagName !== 'INPUT') location.hash = '#/run/' + tr.dataset.open; }));
    app.querySelectorAll('[data-sel]').forEach(cb => cb.addEventListener('change', () => { cb.checked ? state.sel.add(cb.dataset.sel) : state.sel.delete(cb.dataset.sel); const b = $('#cmp'); if (b) { b.disabled = state.sel.size < 2; b.textContent = `Compare ${state.sel.size} selected`; } }));
    app.querySelectorAll('[data-sort]').forEach(t => t.addEventListener('click', () => { const k = t.dataset.sort; state.sort = {k, d: state.sort.k === k ? -state.sort.d : -1}; render(true); }));
    const b = $('#cmp'); if (b) b.addEventListener('click', () => { location.hash = '#/compare/' + [...state.sel].join(','); });
  } catch (e) { app.innerHTML = `<p class="note">Could not load: ${esc(e.message)}</p>`; }
}
async function pulse() {
  try { const s = await api('/api/server'); $('#srvdot').className = 'dot ok'; $('#srvinfo').textContent = `${s.runs} runs · up ${dur(s.uptime_s)}`; } catch (e) { $('#srvdot').className = 'dot'; $('#srvinfo').textContent = 'server not reachable'; }
}
$('#theme').addEventListener('click', () => { const r = document.documentElement, t = r.dataset.theme === 'light' ? 'dark' : 'light'; r.dataset.theme = t; try { localStorage.setItem('theme', t); } catch (e) {} });
try { const t = localStorage.getItem('theme'); if (t) document.documentElement.dataset.theme = t; } catch (e) {}
addEventListener('hashchange', () => render(true));
render(true); pulse(); setInterval(() => { render(false); pulse(); }, 4000);
