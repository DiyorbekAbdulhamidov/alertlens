/* AlertLens front-end (vanilla JS). Talks only to this site's /api. */
const API = '/api';
const TYPES = ['bank', 'card', 'cash', 'intl'];
const TYPE_LABEL = {bank: 'Bank transfer', card: 'Card', cash: 'Cash', intl: 'International'};
const TYPE_COLOR = ['#2563eb', '#0f9d8a', '#d98e04', '#9b2c9b'];
const ACTION = {P1: 'Priority review today', P2: 'Standard review', P3: 'Low priority — after P1/P2'};
const $ = (s, el = document) => el.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const fmtDate = t => new Date(t * 1000).toISOString().slice(0, 10);
const pct = (x, d = 0) => (x * 100).toFixed(d) + '%';
let QUEUE = [], METRICS = null, CUR = null, ORDER = 'risk', CHARTS = [], MEMO_LANG = 'en', PREV_TAB = 'queue';

async function getJSON(url, opt) {
  const r = await fetch(url, opt);
  const j = await r.json();
  if (!r.ok || j.error) throw new Error(j.error || r.statusText);
  return j;
}

/* ---------------- tabs ---------------- */
function show(tab) {
  document.querySelectorAll('.tab').forEach(s => s.classList.toggle('active', s.id === 'tab-' + tab));
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  if (tab !== 'detail') PREV_TAB = tab;
  window.scrollTo(0, 0);
  if (tab === 'model') renderModel();
  if (tab === 'roi') renderROI();
  if (tab === 'audit') renderAudit();
}
document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => { show(b.dataset.tab); history.replaceState(null, '', '#' + b.dataset.tab); });
$('#back').onclick = () => show(PREV_TAB);

/* ---------------- audit log (browser-side, hash-chained by the API) ---------------- */
function auditLog() { try { return JSON.parse(localStorage.getItem('alertlens_audit') || '[]'); } catch (e) { return []; } }
function saveAudit(a) { try { localStorage.setItem('alertlens_audit', JSON.stringify(a)); } catch (e) {} }
function decisionOf(id) { const a = auditLog().filter(x => x.alert_id === id); return a.length ? a[a.length - 1] : null; }

/* ---------------- queue ---------------- */
async function loadQueue() {
  $('#queue').innerHTML = '<div class="spinner">Scoring the queue…</div>';
  const [q, m] = await Promise.all([getJSON(API + '/queue'), getJSON(API + '/metrics')]);
  QUEUE = q.alerts; METRICS = m;
  renderKPIs(); renderQueue();
}
function renderKPIs() {
  const p1 = QUEUE.filter(a => a.band === 'P1').length;
  const cap20 = METRICS.capture_at_share['20'];
  const pos = METRICS.mean_queue_position_of_escalations.alertlens;
  $('#kpis').innerHTML = `
    <div class="kpi"><div class="v">${QUEUE.length}</div><div class="l">alerts waiting (demo, synthetic)</div></div>
    <div class="kpi"><div class="v">${p1}</div><div class="l">P1 — review today</div></div>
    <div class="kpi"><div class="v">${pct(cap20)}</div><div class="l">of real escalations sit in the top 20% of the queue (FIFO: 20%) · held-out test</div></div>
    <div class="kpi"><div class="v">−${pct((0.5 - pos) / 0.5)}</div><div class="l">average wait of a true escalation vs. FIFO · held-out test</div></div>`;
}
function typChip(p) {
  if (p >= 0.7) return `<span class="chip S" title="P(high-risk typology)">S-like ${p.toFixed(2)}</span>`;
  if (p <= 0.3) return `<span class="chip N" title="P(high-risk typology)">N-like ${p.toFixed(2)}</span>`;
  return `<span class="chip U" title="P(high-risk typology)">unclear ${p.toFixed(2)}</span>`;
}
function renderQueue() {
  const items = [...QUEUE];
  if (ORDER === 'fifo') items.sort((a, b) => a.alert_t - b.alert_t || a.id.localeCompare(b.id));
  const maxp = Math.max(...QUEUE.map(a => a.probability));
  $('#queue-note').textContent = ORDER === 'fifo'
    ? 'Arrival order: high-risk alerts are scattered through the queue.'
    : 'Risk order: officers start from the top. Bands use thresholds fixed on the held-out test set.';
  let html = `<div class="qhead"><div>#</div><div>Alert</div><div>Risk score</div><div>Band</div><div>Typology</div><div>Main reasons</div><div></div></div>`;
  items.forEach((a, i) => {
    const d = decisionOf(a.id);
    html += `<div class="qrow" data-id="${a.id}">
      <div class="rank">${i + 1}</div>
      <div class="id">${a.id}<div class="small muted">${fmtDate(a.alert_t)} · ${a.n_tx} tx</div></div>
      <div class="scorec"><span>${a.probability.toFixed(3)}</span><div class="bar"><i style="width:${(100 * a.probability / maxp).toFixed(1)}%"></i></div></div>
      <div class="bandc"><span class="chip ${a.band}">${a.band}</span></div>
      <div class="typc">${typChip(a.typology_p)}</div>
      <div class="why">${a.top_reasons.map(esc).join(' · ') || '—'}${a.n_burst ? ` · burst ${a.n_burst} tx` : ''}</div>
      <div class="st" title="${d ? esc(d.decision) : 'open'}">${d ? (d.decision === 'escalate' ? '⬆️' : d.decision === 'dismiss' ? '✅' : '❔') : ''}</div>
    </div>`;
  });
  $('#queue').innerHTML = html;
  document.querySelectorAll('.qrow').forEach(r => r.onclick = () => openAlert(r.dataset.id));
}
document.querySelectorAll('#order-seg button').forEach(b => b.onclick = () => {
  ORDER = b.dataset.order;
  document.querySelectorAll('#order-seg button').forEach(x => x.classList.toggle('active', x === b));
  renderQueue();
});

/* ---------------- detail ---------------- */
async function openAlert(id) {
  show('detail');
  $('#detail').innerHTML = '<div class="spinner">Scoring…</div>';
  try { renderDetail(await getJSON(`${API}/alert?id=${encodeURIComponent(id)}`)); }
  catch (e) { $('#detail').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
function reasonRows(r) {
  const cs = r.reasons.concepts;
  const mx = Math.max(0.25, ...cs.map(c => Math.abs(c.logodds)));
  return cs.map(c => {
    const w = 50 * Math.abs(c.logodds) / mx;
    const left = c.direction === 'up' ? 50 : 50 - w;
    return `<div class="reason">
      <div><div class="lab">${esc(c.label.en)}</div></div>
      <div><div class="dbar"><span class="mid"></span><i style="left:${left}%;width:${w}%;background:${c.direction === 'up' ? 'var(--up)' : 'var(--down)'}"></i></div></div>
      <div class="odds ${c.direction}">×${c.odds_x.toFixed(2)}</div>
      <div class="ev" style="grid-column:1/-1">${esc(c.evidence.en)}</div>
    </div>`;
  }).join('');
}
function renderDetail(r, prev) {
  CUR = r;
  CHARTS.forEach(c => c.destroy()); CHARTS = [];
  const tx = r.transactions;
  const d = decisionOf(r.id);
  const delta = prev ? r.probability - prev.probability : null;
  $('#detail').innerHTML = `
  <div class="card">
    <div class="dhead">
      <div><div class="small muted">Alert</div><h2 style="margin:0">${esc(r.id)}</h2>
        <div class="small muted">alert date ${fmtDate(tx.alert_t)} · ${tx.t.length} transactions in 180 days · scored in ${r.latency_ms} ms · ${esc(r.model_version)}</div></div>
      <div style="text-align:right">
        <div class="small muted">Escalation risk</div><div class="big">${r.probability.toFixed(3)}</div>
        ${delta !== null ? `<div class="delta ${delta >= 0 ? 'up' : 'down'}">${delta >= 0 ? '+' : ''}${delta.toFixed(3)} vs. before edit</div>` : ''}
      </div>
      <div><span class="chip ${r.band}" style="font-size:16px">${r.band}</span>
        <div class="small" style="margin-top:6px"><b>${ACTION[r.band] || ''}</b></div>
        <div class="small muted">In this band ${pct(r.band_escalation_rate)} of held-out alerts were escalated · ranks above ${pct(1 - r.top_share)} of them</div></div>
      <div>${typChip(r.typology_p)}<div class="small muted" style="margin-top:6px">hidden client typology (label-free)</div></div>
    </div>
  </div>
  <div class="grid2">
    <div class="card"><h3>Why this score</h3>
      <div class="small muted" style="margin-bottom:6px">Contributions are the model's own path attributions (they add up exactly to the score). Red raises risk, green lowers it; ×odds is the multiplicative effect.</div>
      ${reasonRows(r)}
      <details style="margin-top:8px"><summary class="small">Feature-level audit trail</summary>
        <table><tr><th>feature</th><th>value</th><th>peer median</th><th>log-odds</th></tr>
        ${r.reasons.features.map(f => `<tr><td><code>${esc(f.feature)}</code></td><td>${f.value ?? '—'}</td><td>${f.peer_median == null ? '—' : (+f.peer_median).toFixed(3)}</td><td>${f.logodds.toFixed(3)}</td></tr>`).join('')}
        </table><div class="small muted">Base log-odds ${r.reasons.base_logodds}.</div></details>
    </div>
    <div class="card"><h3>Transactions</h3>
      <div class="chartbox"><canvas id="c-hist"></canvas></div>
      <div class="small muted" style="margin:6px 0">Last 200 seconds before the alert (the pre-alert burst):</div>
      <div class="chartbox" style="height:170px"><canvas id="c-burst"></canvas></div>
    </div>
  </div>
  <div class="grid2">
    <div class="card"><h3>Case memo draft</h3>
      <div class="seg" id="memo-seg"><button data-l="en">EN</button><button data-l="uz">UZ</button><button data-l="ru">RU</button></div>
      <textarea id="memo" class="memo" style="margin-top:8px"></textarea>
      <div class="row"><button class="ghost" id="memo-copy">Copy</button><span class="small muted">Generated from the reasons above, no LLM — deterministic and reproducible for audit. The officer edits and signs it.</span></div>
    </div>
    <div class="card"><h3>Officer decision</h3>
      ${d ? `<div class="small">Last decision: <b>${esc(d.decision)}</b> by ${esc(d.officer)} — receipt <code>${d.hash.slice(0, 16)}…</code></div>` : '<div class="small muted">No decision yet.</div>'}
      <label>Officer <input type="text" id="off" value="${esc(localStorage.getItem('alertlens_officer') || 'officer.demo')}"></label>
      <label>Comment <input type="text" id="cmt" placeholder="reason for the decision"></label>
      <div class="row"><button class="esc" data-dec="escalate">Escalate</button><button class="dis" data-dec="dismiss">Dismiss</button><button class="ghost" data-dec="request_info">Request more info</button></div>
      <div id="rcpt" style="margin-top:8px"></div>
      <h3 style="margin-top:16px">What-if (re-score live)</h3>
      <div class="row">
        <button class="ghost" data-w="noburst">Remove pre-alert burst</button>
        <button class="ghost" data-w="burst">Add 40-tx burst</button>
        <button class="ghost" data-w="smark">Add 3 high-risk micro transfers</button>
        <button class="ghost" data-w="nmark">Add 3 low-risk micro transfers</button>
        <button class="ghost" data-w="up">Amounts +0.5</button>
        <button class="ghost" data-w="down">Amounts −0.5</button>
        <button class="ghost" data-w="csv">Download CSV</button>
      </div>
      <div id="w-err" class="err"></div>
    </div>
  </div>`;
  setMemo(MEMO_LANG);
  document.querySelectorAll('#memo-seg button').forEach(b => b.onclick = () => setMemo(b.dataset.l));
  $('#memo-copy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText($('#memo').value); };
  document.querySelectorAll('[data-dec]').forEach(b => b.onclick = () => decide(b.dataset.dec));
  document.querySelectorAll('[data-w]').forEach(b => b.onclick = () => whatIf(b.dataset.w));
  drawCharts(tx);
}
function setMemo(l) {
  MEMO_LANG = l;
  $('#memo').value = CUR.memo[l];
  document.querySelectorAll('#memo-seg button').forEach(b => b.classList.toggle('active', b.dataset.l === l));
}
function drawCharts(tx) {
  if (!window.Chart) return;
  const hist = [[], [], [], []], burst = [[], [], [], []];
  for (let i = 0; i < tx.t.length; i++) {
    const age = tx.alert_t - tx.t[i];
    const pt = {x: age <= 200 ? -age : -age / 86400, y: tx.amt[i], dir: tx.is_in[i]};
    (age <= 200 && age >= 0 ? burst : hist)[tx.typ[i]].push(pt);
  }
  const mk = (data, xl) => ({
    type: 'scatter',
    data: {datasets: TYPES.map((t, k) => ({label: TYPE_LABEL[t], data: data[k], backgroundColor: TYPE_COLOR[k] + 'aa',
      pointStyle: data[k].map(p => p.dir ? 'circle' : 'triangle'), pointRadius: 3}))},
    options: {responsive: true, maintainAspectRatio: false, animation: false,
      plugins: {legend: {labels: {boxWidth: 10, font: {size: 11}}}, tooltip: {callbacks: {label: c => `${c.dataset.label} ${c.raw.dir ? 'in' : 'out'} · amount ${c.raw.y.toFixed(2)}`}}},
      scales: {x: {title: {display: true, text: xl}}, y: {title: {display: true, text: 'amount index'}}}}
  });
  CHARTS.push(new Chart($('#c-hist'), mk(hist, 'days before alert (● in, ▲ out)')));
  CHARTS.push(new Chart($('#c-burst'), mk(burst, 'seconds before alert')));
}
async function decide(dec) {
  const officer = $('#off').value.trim() || 'officer.demo';
  try { localStorage.setItem('alertlens_officer', officer); } catch (e) {}
  const log = auditLog();
  const body = {alert_id: CUR.id, decision: dec, officer, comment: $('#cmt').value.trim() || null,
    probability: Math.round(CUR.probability * 1e6) / 1e6, prev_hash: log.length ? log[log.length - 1].hash : null};
  try {
    const rec = await getJSON(API + '/receipt', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    log.push(rec); saveAudit(log);
    $('#rcpt').innerHTML = `<div class="small">Recorded. Tamper-evident receipt (SHA-256, chained to the previous entry):</div><div class="receipt">${rec.hash}</div>`;
    renderQueue();
  } catch (e) { $('#rcpt').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
function txRows(tx) {
  return tx.t.map((t, i) => ({time: t, direction: tx.is_in[i] ? 'in' : 'out', type: TYPES[tx.typ[i]], amount_index: tx.amt[i]}));
}
function rnd(a, b) { return a + Math.random() * (b - a); }
async function whatIf(kind) {
  const tx = CUR.transactions, A = tx.alert_t;
  let rows = txRows(tx);
  if (kind === 'csv') return downloadCSV(rows, A, CUR.id);
  if (kind === 'noburst') rows = rows.filter(r => A - r.time > 200);
  if (kind === 'burst') for (let i = 0; i < 40; i++) {
    const u = Math.random(), type = u < 0.45 ? 'bank' : u < 0.92 ? 'card' : u < 0.99 ? 'cash' : 'intl';
    rows.push({time: A - Math.floor(rnd(0, 180)), direction: Math.random() < 0.75 ? 'in' : 'out', type, amount_index: +rnd(-0.8, 1.2).toFixed(3)});
  }
  if (kind === 'smark') for (let i = 0; i < 3; i++) rows.push({time: A - Math.floor(rnd(2, 170) * 86400), direction: 'out', type: 'bank', amount_index: +rnd(-2.809, -2.772).toFixed(4)});
  if (kind === 'nmark') for (let i = 0; i < 3; i++) rows.push({time: A - Math.floor(rnd(2, 170) * 86400), direction: 'in', type: 'bank', amount_index: +rnd(-2.916, -2.899).toFixed(4)});
  if (kind === 'up' || kind === 'down') rows = rows.map(r => ({...r, amount_index: +(r.amount_index + (kind === 'up' ? 0.5 : -0.5)).toFixed(4)}));
  try {
    const prev = CUR;
    const r = await getJSON(API + '/score', {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({alert_time: A, transactions: rows})});
    r.id = prev.id.replace(/ \(edited\)$/, '') + ' (edited)';
    renderDetail(r, prev);
  } catch (e) { $('#w-err').textContent = e.message; }
}
function downloadCSV(rows, A, name) {
  const iso = t => new Date(t * 1000).toISOString().slice(0, 19);
  const s = `#alert_time=${iso(A)}\ntime,direction,type,amount_index\n` + rows.map(r => `${iso(r.time)},${r.direction},${r.type},${r.amount_index}`).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([s], {type: 'text/csv'}));
  a.download = (name || 'alert').replace(/[^\w-]+/g, '_') + '.csv';
  a.click();
}

/* ---------------- try it ---------------- */
['burst', 'n', 'shift'].forEach(k => { const i = $('#g-' + k); i.oninput = () => $('#g-' + k + '-v').textContent = k === 'shift' ? (+i.value).toFixed(1) : i.value; });
$('#g-go').onclick = async () => {
  show('detail'); PREV_TAB = 'try';
  $('#detail').innerHTML = '<div class="spinner">Generating and scoring…</div>';
  const q = new URLSearchParams({typology: $('#g-typ').value, burst: $('#g-burst').value, n: $('#g-n').value, shift: $('#g-shift').value, seed: $('#g-seed').value});
  try { renderDetail(await getJSON(`${API}/generate?${q}`)); } catch (e) { $('#detail').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
};
$('#u-file').onchange = e => { const f = e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => $('#u-text').value = rd.result; rd.readAsText(f); };
$('#u-template').onclick = e => {
  e.preventDefault();
  const A = Math.floor(Date.UTC(2026, 4, 10) / 1000), rows = [];
  for (let i = 0; i < 60; i++) rows.push({time: A - Math.floor(rnd(1, 170) * 86400), direction: Math.random() < 0.7 ? 'in' : 'out', type: Math.random() < 0.5 ? 'card' : 'bank', amount_index: +rnd(-1.2, 1.2).toFixed(3)});
  rows.sort((a, b) => a.time - b.time);
  downloadCSV(rows, A, 'alertlens_template');
};
$('#u-go').onclick = async () => {
  $('#u-err').textContent = '';
  const text = $('#u-text').value.trim();
  if (!text) { $('#u-err').textContent = 'Paste CSV or choose a file first.'; return; }
  const lines = text.split(/\r?\n/).filter(l => l.trim());
  let alert_time = null;
  const body = lines.filter(l => { const m = l.match(/^#\s*alert_time\s*=\s*(.+)$/i); if (m) { alert_time = m[1].trim(); return false; } return true; });
  const hdr = body[0].split(',').map(s => s.trim().toLowerCase());
  const need = ['time', 'direction', 'type', 'amount_index'];
  if (!need.every(n => hdr.includes(n))) { $('#u-err').textContent = 'Header must contain: ' + need.join(','); return; }
  const rows = body.slice(1).map(l => { const v = l.split(','); const o = {}; hdr.forEach((h, i) => o[h] = (v[i] || '').trim()); return o; });
  show('detail'); PREV_TAB = 'try';
  $('#detail').innerHTML = '<div class="spinner">Scoring…</div>';
  try { renderDetail(await getJSON(API + '/score', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({alert_time, transactions: rows})})); }
  catch (e) { show('try'); $('#u-err').textContent = e.message; }
};

/* ---------------- model card ---------------- */
async function renderModel() {
  if (!METRICS) METRICS = await getJSON(API + '/metrics');
  const m = METRICS;
  let live = null;
  try { const t0 = performance.now(); const r = await getJSON(API + '/alert?id=AL-2026-0001'); live = {server: r.latency_ms, round: Math.round(performance.now() - t0)}; } catch (e) {}
  const cpuHours = (m.speed.ms_per_alert_cpu_single_core * 1e6 / 3.6e6).toFixed(1);
  $('#model').innerHTML = `
  <h2>Model card</h2>
  <p class="muted">Every number on this page is measured on a <b>held-out test set</b>: ${m.test_set.n_alerts.toLocaleString()} real alerts (${m.test_set.n_escalated} escalated, base rate ${pct(m.test_set.base_rate, 1)}) from the elimination-round data, never used for training or tuning.</p>
  <div class="kpis">
    <div class="kpi"><div class="v">${m.auc.toFixed(3)}</div><div class="l">ROC-AUC (95% CI ${m.auc_ci95[0].toFixed(3)}–${m.auc_ci95[1].toFixed(3)}) · 5-fold CV on training part ${m.cv_auc_train80.toFixed(3)}</div></div>
    <div class="kpi"><div class="v">${pct(m.capture_at_share['20'])}</div><div class="l">of escalations found in the top 20% of the queue (random order: 20%)</div></div>
    <div class="kpi"><div class="v">${pct(m.capture_at_share['50'])}</div><div class="l">of escalations found in the top 50% (random order: 50%)</div></div>
    <div class="kpi"><div class="v">${live ? live.server + ' ms' : m.speed.ms_per_alert_cpu_single_core + ' ms'}</div><div class="l">to score one alert incl. feature extraction${live ? ` (live now; round-trip ${live.round} ms)` : ''}</div></div>
  </div>
  <div class="grid2">
    <div class="card"><h3>How many real escalations you reach, by share of the queue reviewed</h3><div class="chartbox"><canvas id="c-cap"></canvas></div></div>
    <div class="card"><h3>Queue bands (thresholds fixed on the test set)</h3>
      <table><tr><th>band</th><th>share of alerts</th><th>escalation rate</th><th>handling</th></tr>
      ${m.bands.map(b => `<tr><td><span class="chip ${b.name}">${b.name}</span></td><td>${pct(b.share)}</td><td><b>${pct(b.rate, 1)}</b></td><td>${ACTION[b.name]}</td></tr>`).join('')}</table>
      <p class="small muted">P1 alerts are escalated ${(m.bands[0].rate / m.bands[2].rate).toFixed(1)}× as often as P3. The ranking is a priority, not an auto-dismissal: every alert is still reviewed by a person.</p>
      <h3>Hidden client typology (our edge)</h3>
      <p class="small">Amounts have hard "floor bands" whose position differs between two hidden client groups: <b>S</b> (≈30% escalated) and <b>N</b> (≈10%). The bands never co-occur in one client, so they are label-free markers. A second model learns the typology from bulk behaviour of ${m.typology_model.marker_alerts.toLocaleString()} marker clients and extends it to everyone else: AUC <b>${m.typology_model.oof_auc_on_markers.toFixed(3)}</b> at recovering the typology (cross-validated), no escalation labels used.</p>
    </div>
  </div>
  <div class="card"><h3>Architecture (production runs inside the bank's perimeter)</h3>
    <div class="arch">
      <div class="b"><b>1 · Alert feed</b>transaction-monitoring alert + the client's 180-day transactions (core banking)</div><div class="arrow">→</div>
      <div class="b"><b>2 · Features</b>≈280 per-alert features: pre-alert burst, per-channel levels vs. peers (de-trended by day), empirical-Bayes client profile, floor-band markers</div><div class="arrow">→</div>
      <div class="b"><b>3 · Typology model</b>label-free S/N typology (2,000 trees) + exclusive markers</div><div class="arrow">→</div>
      <div class="b"><b>4 · Risk model</b>gradient-boosted trees (3×500), exported to plain numpy — no external API, no GPU</div><div class="arrow">→</div>
      <div class="b"><b>5 · Officer workspace</b>ranked queue, reasons, memo draft (EN/UZ/RU), decision + SHA-256 chained audit receipt</div>
    </div>
    <p class="small muted">Training happens offline on the bank's own labelled alert history; only model files are deployed. Scoring needs ≈${m.speed.ms_per_alert_cpu_single_core} ms of one CPU core: 1 million alerts ≈ ${cpuHours} CPU-hours. This public demo runs the same code on Vercel with synthetic alerts.</p>
  </div>
  <div class="grid2">
    <div class="card"><h3>Known limitations and failure cases</h3>
      <ul class="small">
        <li><b>Ceiling.</b> Escalation labels are noisy: even perfect knowledge of the typology gives AUC ≈ 0.66; our measured ${m.auc.toFixed(3)} is near that ceiling. The tool prioritises; it must not auto-close alerts.</li>
        <li><b>Short histories.</b> Clients with few transactions get weak profiles; the typology stays "unclear" (≈0.5) and the score falls back to population behaviour.</li>
        <li><b>Drift.</b> Floor bands are a property of the current monitoring rules and data feed; they must be re-checked after any rule change (monthly monitoring of marker rates and AUC).</li>
        <li><b>Synthetic demo data.</b> Demo alerts imitate aggregate statistics only; scores on them illustrate behaviour, not real risk.</li>
      </ul></div>
    <div class="card"><h3>Data and licences</h3>
      <ul class="small">
        <li>Training and test: WIUT Hackathon 2026 elimination-round dataset (anonymised alerts, 180-day transactions). Used under the competition terms; not redistributed — only trained model files and aggregate statistics are published.</li>
        <li>Demo alerts: generated by <code>synth/generate.py</code> from aggregate parameters (quantiles, covariances, marker rates).</li>
        <li>Code: our own (MIT). Elimination-round analysis code reused and declared in the README. Libraries: numpy (BSD), LightGBM (MIT, training only), scikit-learn (BSD, training only), Chart.js (MIT).</li>
      </ul></div>
  </div>`;
  const c = m.capture_curve;
  if (window.Chart) new Chart($('#c-cap'), {type: 'line', data: {labels: c.x.map(x => pct(x)), datasets: [
    {label: 'AlertLens order', data: c.y, borderColor: '#0f9d8a', backgroundColor: '#0f9d8a22', fill: true, pointRadius: 0, tension: .2},
    {label: 'Arrival order (FIFO)', data: c.x, borderColor: '#9aa3b2', borderDash: [6, 4], pointRadius: 0}]},
    options: {responsive: true, maintainAspectRatio: false, animation: false, scales: {y: {min: 0, max: 1, ticks: {callback: v => pct(v)}, title: {display: true, text: 'share of escalations reached'}},
      x: {title: {display: true, text: 'share of queue reviewed'}, ticks: {maxTicksLimit: 11}}}}});
}

/* ---------------- ROI ---------------- */
function capAt(share) {
  const c = METRICS.capture_curve, x = c.x, y = c.y;
  for (let i = 1; i < x.length; i++) if (share <= x[i]) return y[i - 1] + (y[i] - y[i - 1]) * (share - x[i - 1]) / (x[i] - x[i - 1]);
  return 1;
}
async function renderROI() {
  if (!METRICS) METRICS = await getJSON(API + '/metrics');
  const f = (id, label, v, step, note) => `<label>${label} <input type="number" id="${id}" value="${v}" step="${step}"></label>${note ? `<div class="small muted" style="margin-top:-4px">${note}</div>` : ''}`;
  $('#roi').innerHTML = `
  <h2>Budget and ROI calculator</h2>
  <p class="muted">Model effects are measured on the held-out test set. Bank-side inputs are <span class="hl">assumptions to replace with the bank's figures</span> — every result updates live.</p>
  <div class="grid2">
    <div class="card"><h3>Bank inputs</h3>
      ${f('r-alerts', 'Alerts per month', 3000, 100)}
      ${f('r-min', 'Minutes per full review', 25, 1)}
      ${f('r-fast', 'Minutes per light review of P3 alerts (policy option)', 12, 1, 'P3 still gets a human look; set equal to the line above to switch this saving off.')}
      ${f('r-rate', 'Loaded officer cost, UZS per hour', 60000, 1000)}
      ${f('r-capacity', 'Share of each day\'s alerts reviewed the same day (%)', 50, 5)}
      <h3 style="margin-top:12px">Pilot cost (3 months)</h3>
      ${f('r-team', 'Team: people × months × UZS/month (total)', 3 * 3 * 12000000, 1000000)}
      ${f('r-infra', 'Server inside the bank (one VM, 4 vCPU), total UZS', 6000000, 500000)}
      ${f('r-run', 'Monthly running cost after pilot, UZS', 4000000, 500000)}
    </div>
    <div class="card"><h3>Results</h3><div id="r-out"></div></div>
  </div>`;
  document.querySelectorAll('#roi input').forEach(i => i.oninput = calcROI);
  calcROI();
}
function calcROI() {
  const v = id => +$('#' + id).value || 0, m = METRICS;
  const alerts = v('r-alerts'), mins = v('r-min'), fast = v('r-fast'), rate = v('r-rate'), cap = Math.min(Math.max(v('r-capacity') / 100, 0), 1);
  const esc = alerts * m.test_set.base_rate;
  const p3 = m.bands[2].share;
  const hours = alerts * p3 * Math.max(mins - fast, 0) / 60;
  const money = hours * rate;
  const sameDayFifo = cap, sameDayAL = capAt(cap);
  const extra = esc * (sameDayAL - sameDayFifo);
  const wait = (0.5 - m.mean_queue_position_of_escalations.alertlens) / 0.5;
  const pilot = v('r-team') + v('r-infra');
  const net = money - v('r-run');
  const payback = net > 0 ? pilot / net : Infinity;
  const U = x => Math.round(x).toLocaleString('en-US');
  $('#r-out').innerHTML = `<table>
    <tr><td>Escalations per month (at ${pct(m.test_set.base_rate, 1)})</td><td><b>${U(esc)}</b></td></tr>
    <tr><td>Reviewed the same day — FIFO vs AlertLens (capacity ${pct(cap)})</td><td><b>${pct(sameDayFifo)} → ${pct(sameDayAL)}</b></td></tr>
    <tr><td>Extra real escalations handled the same day, per month</td><td><b>+${U(extra)}</b></td></tr>
    <tr><td>Average wait of a true escalation</td><td><b>−${pct(wait)}</b></td></tr>
    <tr><td>Officer hours freed per month (light review of P3 = ${pct(p3)} of alerts)</td><td><b>${U(hours)} h</b></td></tr>
    <tr><td>Value of freed hours per month</td><td><b>${U(money)} UZS</b></td></tr>
    <tr><td>Pilot cost (3 months)</td><td><b>${U(pilot)} UZS</b></td></tr>
    <tr><td>Net monthly saving after running cost</td><td><b>${U(net)} UZS</b></td></tr>
    <tr><td>Payback period</td><td><b>${isFinite(payback) ? payback.toFixed(1) + ' months' : 'not reached with these inputs'}</b></td></tr></table>
    <p class="small muted">Same-day and waiting-time effects come from the held-out capture curve (escalations reached when the top X% of the queue is reviewed). Hour savings assume the bank adopts a lighter review for P3, where only ${pct(m.bands[2].rate, 1)} of alerts were escalated on the test set.</p>`;
}

/* ---------------- audit ---------------- */
function canon(o) {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ': ' + canon(o[k])).join(', ') + '}';
}
async function sha256(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
async function renderAudit() {
  const log = auditLog();
  $('#audit').innerHTML = `<h2>Audit log</h2>
  <p class="muted">Every decision gets a SHA-256 receipt from the server that includes the previous receipt's hash, so editing or deleting any past entry breaks the chain. In this demo the log is kept in your browser; in production it is an append-only table in the bank's database.</p>
  <div class="row"><button class="primary" id="a-verify">Verify chain</button><button class="ghost" id="a-export">Export CSV</button><button class="ghost" id="a-clear">Clear demo log</button><span id="a-res" class="small"></span></div>
  <div class="card" style="margin-top:10px;overflow:auto">${log.length ? `<table><tr><th>time</th><th>alert</th><th>decision</th><th>officer</th><th>score</th><th>comment</th><th>receipt</th></tr>
  ${log.map(r => `<tr><td>${new Date(r.server_time * 1000).toISOString().replace('T', ' ').slice(0, 19)}</td><td>${esc(r.alert_id)}</td><td>${esc(r.decision)}</td><td>${esc(r.officer)}</td><td>${r.probability}</td><td>${esc(r.comment || '')}</td><td><code>${r.hash.slice(0, 12)}…</code></td></tr>`).join('')}</table>` : '<div class="muted">No decisions yet — open an alert and escalate or dismiss it.</div>'}</div>`;
  $('#a-verify').onclick = async () => {
    let ok = true, prev = null;
    for (const r of log) {
      const {hash, ...rest} = r;
      if (rest.prev_hash !== prev || await sha256(canon(rest)) !== hash) { ok = false; break; }
      prev = hash;
    }
    $('#a-res').innerHTML = ok ? `<b style="color:var(--down)">✓ chain intact (${log.length} entries)</b>` : '<b style="color:var(--up)">✗ chain broken</b>';
  };
  $('#a-export').onclick = () => {
    const cols = ['server_time', 'alert_id', 'decision', 'officer', 'probability', 'comment', 'model_version', 'prev_hash', 'hash'];
    const s = cols.join(',') + '\n' + log.map(r => cols.map(c => JSON.stringify(r[c] ?? '')).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([s], {type: 'text/csv'})); a.download = 'alertlens_audit.csv'; a.click();
  };
  $('#a-clear').onclick = () => { saveAudit([]); renderAudit(); renderQueue(); };
}

/* ---------------- boot ---------------- */
loadQueue().catch(e => { $('#queue').innerHTML = `<div class="err">Could not load the queue: ${esc(e.message)}</div>`; });
const h = location.hash.slice(1);
if (['try', 'model', 'roi', 'audit'].includes(h)) show(h);
