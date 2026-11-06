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
async function api(p) {
  const base = new URL('.', document.baseURI).href;
  const get = async (f) => { const r = await fetch(base + f + '?t=' + Math.floor(Date.now() / 20000), {cache: 'no-store'}); if (!r.ok) throw new Error(f + ' → ' + r.status); return r.json(); };
  let m;
  if (p === '/api/runs') return get('api/runs.json');
  if ((m = p.match(/^\/api\/run\/([^/?]+)$/))) return get('api/run/' + m[1] + '.json');
  if (p === '/api/rules') return get('api/rules.json');
  if (p === '/api/server') return get('api/server.json');
  if ((m = p.match(/^\/api\/compare\?ids=(.*)$/))) { const ids = m[1].split(',').filter(Boolean); return {runs: await Promise.all(ids.map(i => get('api/card/' + i + '.json')))}; }
  throw new Error('unknown call ' + p);
}

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
function viewRuns() {
  const runs = [...state.runs].sort((a, b) => { const k = state.sort.k; const x = a[k], y = b[k]; return ((x ?? -1) > (y ?? -1) ? 1 : -1) * state.sort.d; });
  const chrono = [...state.runs].filter(r => r.wall_s).sort((a, b) => a.started - b.started).slice(-24);
  const live = state.runs.filter(r => r.status === 'running');
  const th = (k, t, n) => `<th class="s ${n ? 'num' : ''}" data-sort="${k}">${t}${state.sort.k === k ? (state.sort.d > 0 ? ' ▲' : ' ▼') : ''}</th>`;
  return `<h1>Runs</h1><p class="muted">Every run is recorded as it happens and kept. Click a row for the full picture; tick two or more to compare.</p>` +
    (live.length ? `<div class="card" style="margin-bottom:14px"><span class="live"></span><b>${live.length} run${live.length > 1 ? 's' : ''} in progress</b> — ${live.map(r => `<a href="#/run/${r.id}">${esc(r.id)}</a>`).join(', ')}</div>` : '') +
    (chrono.length > 1 ? `<div class="row"><div class="card grow"><h3>Total time per run</h3>${barChart(chrono.map(r => ({label: r.pr, value: r.wall_s, color: COL[r.light], tip: `${r.id}<br>${dur(r.wall_s)} · health ${r.score ?? '–'}`})), {yfmt: dur})}</div>` +
      `<div class="card grow"><h3>Mean LLM call time per run (s)</h3>${barChart(chrono.filter(r => r.llm_calls).map(r => ({label: r.pr, value: r.llm_mean_s, color: 'var(--accent)', tip: `${r.id}<br>${r.llm_mean_s}s mean over ${r.llm_calls} calls`})), {})}</div></div>` : '') +
    `<div class="card wrap" style="margin-top:14px;padding:0"><table><thead><tr><th></th>${th('id', 'Run')}${th('status', 'Status')}${th('score', 'Health', 1)}${th('wall_s', 'Time', 1)}${th('agents', 'Agents', 1)}${th('llm_calls', 'LLM calls', 1)}${th('llm_mean_s', 'Mean call', 1)}${th('tokens_in', 'Tokens in / out', 1)}${th('cache_pct', 'Cached', 1)}${th('peak_mem', 'Peak mem', 1)}<th>Biggest finding</th></tr></thead><tbody>` +
    (runs.length ? runs.map(r => `<tr class="click" data-open="${esc(r.id)}"><td><input type="checkbox" data-sel="${esc(r.id)}" ${state.sel.has(r.id) ? 'checked' : ''}></td><td><b>${esc(r.id)}</b><br><span class="muted small">${when(r.started)}${r.commits ? ' · ' + n0(r.commits) + ' commits' : ''}</span></td>` +
      `<td>${statusChip(r)}${r.legacy ? ' ' + chip('imported') : ''}${r.fake_llm ? ' ' + chip('fake llm') : ''}</td><td class="num">${light(r.light)}${r.score ?? '–'}</td><td class="num">${dur(r.wall_s)}</td>` +
      `<td class="num">${r.agents || '–'}${r.failed_agents ? ` <span style="color:var(--red)">(${r.failed_agents} failed)</span>` : ''}</td><td class="num">${n0(r.llm_calls)}</td><td class="num">${r.llm_calls ? r.llm_mean_s + 's' : '–'}</td><td class="num">${tok(r.tokens_in)} / ${tok(r.tokens_out)}</td><td class="num">${r.llm_calls ? r.cache_pct + '%' : '–'}</td><td class="num">${r.peak_mem != null ? n1(r.peak_mem) + ' GiB' : '–'}</td><td class="small">${esc(r.top || '')}</td></tr>`).join('')
      : '<tr><td colspan="12" class="muted">No runs yet. Start one (docker_narrative.py) and it appears here live.</td></tr>') + `</tbody></table></div>` +
    `<p><button id="cmp" ${state.sel.size < 2 ? 'disabled' : ''}>Compare ${state.sel.size} selected</button></p>`;
}
function tabs(id, cur) { return `<div class="tabs">${['overview', 'agents', 'llm', 'system', 'bottlenecks'].map(t => `<a href="#/run/${id}/${t}" class="${t === cur ? 'on' : ''}">${t[0].toUpperCase() + t.slice(1)}</a>`).join('')}</div>`; }
function head(r) {
  return `<p class="small"><a href="#/">← all runs</a></p><h1>${esc(r.id)} ${statusChip(r)} ${r.legacy ? chip('imported from an older run') : ''}${r.meta.fake_llm ? ' ' + chip('fake llm') : ''}</h1>` +
    `<p class="muted">${when(r.started)} · ${dur(r.wall_s)}${r.status === 'running' ? ' so far' : ''} · model ${esc(r.meta.model || '?')} / ${esc(r.meta.effort || '?')}${r.meta.commits ? ' · ' + n0(r.meta.commits) + ' commits' : ''}${r.meta.tier ? ' · ' + r.meta.tier + ' tier' : ''}${r.result ? ' · ' + esc(r.result) : ''}</p>`;
}
function tabOverview(r) {
  const s = r.score, k = r.kpis, comp = (n, v, why) => `<div class="comp"><span>${n}</span><div class="bar"><i style="width:${v ?? 0}%;background:${COL[lightOf(v)]}"></i></div><b>${v ?? '–'}</b></div>${why && why.length ? `<div class="small muted" style="margin:-2px 0 6px 98px">${esc(why.join(' · '))}</div>` : ''}`;
  const cp = r.critical_path;
  return `<div class="row"><div class="card grow"><h3>Health</h3><div class="score">${ring(s.overall, s.light)}<div style="flex:1">${comp('Outcome', s.outcome)}${comp('Agents', s.agents)}${comp('LLM', s.llm, s.llm_why)}${comp('System', s.system, s.system_why)}</div></div></div>` +
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
function tabAgents(r) {
  const rows = r.agents;
  return `<h2 style="margin-top:6px">Agent timeline</h2><div class="card">${gantt(rows, r.wall_s)}<div class="legend">${[...new Set(rows.map(a => a.group))].map(g => `<span><i style="background:${(rows.find(a => a.group === g) || {}).color}"></i>${g}</span>`).join('')}<span>outline: <b style="color:var(--amber)">amber</b>/<b style="color:var(--red)">red</b> = health</span></div></div>` +
    (r.concurrency.length > 1 ? `<h2>Agents running at once</h2><div class="card">${lineChart({series: [{name: 'agents running', color: '#5b9cf5', pts: r.concurrency, step: true, area: true}], h: 140, yfmt: n0})}</div>` : '') +
    `<h2>Per agent</h2><div class="card wrap" style="padding:0"><table><thead><tr><th>Agent</th><th>Group</th><th class="num">Start</th><th class="num">Time</th><th class="num">% of run</th><th class="num">Alone for</th><th class="num">Waited</th><th class="num">Attempts</th><th class="num">Fixes</th><th>Status</th><th>Health</th></tr></thead><tbody>` +
    rows.map(a => `<tr><td><b>${esc(a.name)}</b><br><span class="muted small">${esc(a.role)}</span></td><td>${esc(a.group)}</td><td class="num">${a.start != null ? dur(a.start) : '–'}</td><td class="num">${dur(a.seconds)}</td><td class="num">${(a.share * 100).toFixed(1)}%</td><td class="num">${a.solo_s ? dur(a.solo_s) : '–'}</td><td class="num">${a.queue_wait > 1 ? dur(a.queue_wait) : '–'}</td><td class="num">${a.attempts}</td><td class="num">${a.fixes}</td><td>${chip(a.status, a.status === 'SUCCESS' || a.status === 'RESUMED' ? 'green' : a.status === 'FAILED' ? 'red' : '')}</td><td>${light(a.light)}<span class="small muted">${esc(a.why.join('; '))}</span></td></tr>`).join('') + `</tbody></table></div>`;
}
function tabLLM(r) {
  const L = r.llm; if (!L.calls && !L.cache_hits) return '<p class="note">No LLM calls were recorded for this run' + (r.meta.fake_llm ? ' (it used the fake LLM).' : '.') + '</p>';
  const c = (v, a, b) => v > b ? 'red' : v > a ? 'amber' : '';
  return `<div class="tiles">` + tile('LLM calls', n0(L.calls), `${L.cache_hits} served from the response cache`) + tile('mean call time', L.mean_s + 's', `median ${L.p50_s}s`) +
    tile('p95 call time', L.p95_s + 's', `max ${L.max_s}s`, L.p50_s && L.p95_s / L.p50_s > 4 ? 'amber' : '') + tile('failed attempts', n0(L.failed), (L.fail_rate * 100).toFixed(1) + '% of calls', c(L.fail_rate, .03, .1)) +
    tile('input tokens', tok(L.tokens_in), `${n0(L.in_per_call)} per call`) + tile('cached share', L.cache_pct + '%', `${tok(L.tokens_cached)} tokens`, L.tokens_in && !r.meta.fake_llm && L.cache_pct < 30 ? 'amber' : '') +
    tile('output tokens', tok(L.tokens_out)) + tile('tokens per item', n0(L.tokens_per_item), `${n0(L.fresh_per_item)} not cached`) +
    tile('items per minute', n1(L.items_per_min), `${n0(L.items)} items`) + tile('worker utilisation', Math.round(L.utilisation * 100) + '%', `mean ${L.mean_workers} workers`) +
    tile('at the worker limit', Math.round(L.saturated_share * 100) + '% of busy time', 'high = add workers', L.saturated_share > .6 ? 'amber' : '') + `</div>` +
    `<div class="row"><div class="card grow"><h3>Call time over the run</h3>${scatter(L.points, r.wall_s)}</div><div class="card grow"><h3>Call time distribution</h3>${barChart(L.hist.map(b => ({label: b[0] + 's', value: b[1], tip: `${b[0]}s+: ${b[1]} calls`})), {h: 220})}</div></div>` +
    `<div class="row"><div class="card grow"><h3>Throughput (items per minute)</h3>${barChart(L.per_min.map(b => ({label: b.min + 'm', value: b.items, tip: `minute ${b.min}: ${b.items} items in ${b.calls} calls (mean ${b.mean_s}s)`})), {h: 190})}</div>` +
    `<div class="card grow"><h3>Calls in flight vs worker limit</h3>${lineChart({series: [{name: 'calls in flight', color: '#5b9cf5', pts: L.inflight, step: true, area: true}, {name: 'worker limit', color: '#d9a21b', pts: r.workers, step: true}], h: 190, yfmt: n0})}</div></div>` +
    `<h2>By stage</h2><div class="card wrap" style="padding:0"><table><thead><tr><th>Stage</th><th class="num">Calls</th><th class="num">Failed</th><th class="num">Items/call</th><th class="num">Mean</th><th class="num">p95</th><th class="num">Busy time</th><th class="num">Items/min</th><th class="num">Tokens in</th><th class="num">Cached</th><th class="num">Tokens/item</th></tr></thead><tbody>` +
    L.stages.map(s => `<tr><td><i class="light" style="background:${stageColor(s.stage)}"></i><b>${esc(s.stage)}</b></td><td class="num">${n0(s.calls)}</td><td class="num">${s.failed || '–'}</td><td class="num">${s.items_per_call}</td><td class="num">${s.mean_s}s</td><td class="num">${s.p95_s}s</td><td class="num">${dur(s.busy_s)}</td><td class="num">${s.items_per_min}</td><td class="num">${tok(s.tokens_in)}</td><td class="num">${s.cache_pct}%</td><td class="num">${n0(s.tokens_per_item)}</td></tr>`).join('') + `</tbody></table></div>`;
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
  const body = {overview: tabOverview, agents: tabAgents, llm: tabLLM, system: tabSystem, bottlenecks: tabBottlenecks}[tab] || tabOverview;
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
  document.querySelectorAll('nav a').forEach(a => a.classList.toggle('on', (h[0] === '' && a.id === 'nav-runs') || a.id === 'nav-' + h[0]));
  try {
    let html;
    if (h[0] === 'run' && h[1]) html = await viewRun(h[1], h[2] || 'overview');
    else if (h[0] === 'compare') html = await viewCompare((h[1] || '').split(',').filter(Boolean));
    else if (h[0] === 'rules') html = await viewRules();
    else { state.runs = (await api('/api/runs')).runs; html = viewRuns(); }
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
