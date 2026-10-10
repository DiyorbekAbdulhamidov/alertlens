/* AlertLens officer workspace (vanilla JS + Chart.js). Talks only to this site's /api. */
const API = '/api';
const TYPES = ['bank', 'card', 'cash', 'intl'];
const TYPE_LABEL = {bank: 'Bank transfer', card: 'Card', cash: 'Cash', intl: 'International'};
const TYPE_COLOR = ['#3b82f6', '#0ea5a0', '#f59e0b', '#8b5cf6'];
const BAND = {
  P1: {action: 'Review today', short: 'review today', color: '#e5484d'},
  P2: {action: 'Standard review', short: 'standard review', color: '#f59e0b'},
  P3: {action: 'Low priority', short: 'after P1/P2', color: '#30a46c'}
};
const PAGES = {
  queue: ['Alert queue', 'Ranked by escalation risk. Start at the top.'],
  detail: ['Alert review', 'Why this alert got its score, and what to do next.'],
  try: ['Score your own', 'Jury mode: give us any client and we score it live.'],
  how: ['How it works', 'From raw transactions to a ranked, explained queue.'],
  model: ['Model card', 'Measured on 2,800 real alerts the model never saw.'],
  roi: ['Budget & ROI', 'What a 3-month pilot costs and what it returns.'],
  audit: ['Audit log', 'Every decision, chained and tamper-evident.']
};
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const pct = (x, d = 0) => (x * 100).toFixed(d) + '%';
const fmtDate = t => new Date(t * 1000).toISOString().slice(0, 10);
const sigmoid = z => 1 / (1 + Math.exp(-z));
let QUEUE = [], METRICS = null, CUR = null, ORDER = 'risk', BANDF = 'all', MEMO_LANG = 'en', PREV = 'queue';
const CH = {};

async function getJSON(url, opt) {
  const r = await fetch(url, opt);
  let j; try { j = await r.json(); } catch (e) { throw new Error('Server error ' + r.status); }
  if (!r.ok || j.error) throw new Error(j.error || r.statusText);
  return j;
}
async function metrics() { if (!METRICS) METRICS = await getJSON(API + '/metrics'); return METRICS; }
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.style.display = 'block'; clearTimeout(t._h); t._h = setTimeout(() => t.style.display = 'none', ms); }
function chart(key, el, cfg) { if (CH[key]) CH[key].destroy(); if (!window.Chart || !el) return; CH[key] = new Chart(el, cfg); return CH[key]; }
function officer() { try { return localStorage.getItem('alertlens_officer') || 'officer.demo'; } catch (e) { return 'officer.demo'; } }

/* ---------- icons ---------- */
const I = (p, s = 18) => `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
const ICON = {
  typology: I('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M21.5 20a6.5 6.5 0 0 0-4-6"/>'),
  burst: I('<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>'),
  bank: I('<path d="M3 10h18M5 10v8M9.5 10v8M14.5 10v8M19 10v8M3 21h18M12 3l9 5H3z"/>'),
  card: I('<rect x="2.5" y="5" width="19" height="14" rx="2"/><path d="M2.5 10h19"/>'),
  cash: I('<rect x="2.5" y="6" width="19" height="12" rx="2"/><circle cx="12" cy="12" r="2.5"/>'),
  intl: I('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>'),
  activity: I('<path d="M3 12h4l3-8 4 16 3-8h4"/>'),
  timing: I('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>'),
  level: I('<path d="M3 17l6-6 4 4 8-8M15 7h6v6"/>'),
  mix: I('<path d="M21 12A9 9 0 1 1 12 3v9z"/><path d="M15 3.5A9 9 0 0 1 20.5 9H15z"/>'),
  relative: I('<path d="M12 3v18M5 7l-3 6h6zM19 7l-3 6h6zM5 7h14"/>'),
  up: I('<path d="M12 19V5M5 12l7-7 7 7"/>', 16), down: I('<path d="M12 5v14M5 12l7 7 7-7"/>', 16),
  play: I('<path d="M6 4l14 8-14 8z"/>', 16), check: I('<path d="M4 12l5 5L20 6"/>', 22),
  lock: I('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>', 22),
  eye: I('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>', 22),
  user: I('<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', 22),
  shield: I('<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/>', 22),
  doc: I('<path d="M6 2h9l5 5v15H6z"/><path d="M14 2v6h6M9 13h6M9 17h6"/>', 22)
};
const conceptIcon = k => ICON[k] || (k.startsWith('bank') ? ICON.bank : k.startsWith('card') ? ICON.card : k.startsWith('cash') ? ICON.cash : k.startsWith('intl') ? ICON.intl : ICON.activity);

/* ---------- navigation ---------- */
function show(page, push = true) {
  $$('.page').forEach(s => s.classList.toggle('active', s.id === 'page-' + page));
  $$('#nav button').forEach(b => b.classList.toggle('active', b.dataset.page === (page === 'detail' ? 'queue' : page)));
  $('#title').textContent = PAGES[page][0];
  $('#subtitle').textContent = PAGES[page][1];
  if (page !== 'detail') PREV = page;
  if (push && page !== 'detail') history.replaceState(null, '', '#' + page);
  window.scrollTo({top: 0});
  const r = {queue: renderQueue, try: renderTry, how: renderHow, model: renderModel, roi: renderROI, audit: renderAudit}[page];
  if (r) r();
}
$$('#nav button').forEach(b => b.onclick = () => show(b.dataset.page));
$('#officer-name').textContent = officer();

/* ---------- audit storage ---------- */
function auditLog() { try { return JSON.parse(localStorage.getItem('alertlens_audit') || '[]'); } catch (e) { return []; } }
function saveAudit(a) { try { localStorage.setItem('alertlens_audit', JSON.stringify(a)); } catch (e) {} }
function decisionOf(id) { const a = auditLog().filter(x => x.alert_id === id); return a.length ? a[a.length - 1] : null; }

/* ---------- small renderers ---------- */
function ring(p, band) {
  const r = 19, c = 2 * Math.PI * r, f = Math.min(p / 0.45, 1);
  return `<div class="ring" title="escalation probability"><svg width="48" height="48"><circle cx="24" cy="24" r="${r}" stroke="#e7ecf3" stroke-width="5" fill="none"/><circle cx="24" cy="24" r="${r}" stroke="${BAND[band].color}" stroke-width="5" fill="none" stroke-linecap="round" stroke-dasharray="${(f * c).toFixed(1)} ${c.toFixed(1)}"/></svg><b>${Math.round(p * 100)}%</b></div>`;
}
function typChip(p) {
  if (p >= 0.7) return `<span class="chip S" title="Probability the client belongs to the high-risk group S">High-risk group · ${p.toFixed(2)}</span>`;
  if (p <= 0.3) return `<span class="chip N" title="Probability the client belongs to the high-risk group S">Low-risk group · ${p.toFixed(2)}</span>`;
  return `<span class="chip U" title="Probability the client belongs to the high-risk group S">Group unclear · ${p.toFixed(2)}</span>`;
}
function gauge(p, cal) {
  const max = 0.5, W = 220, cx = 110, cy = 112, R = 92;
  const ang = v => Math.PI * (1 - Math.min(v, max) / max);
  const pt = (v, rr = R) => [cx + rr * Math.cos(ang(v)), cy - rr * Math.sin(ang(v))];
  const arc = (a, b, col) => { const [x1, y1] = pt(a), [x2, y2] = pt(b); return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)} A${R} ${R} 0 0 1 ${x2.toFixed(1)} ${y2.toFixed(1)}" stroke="${col}" stroke-width="16" fill="none"/>`; };
  const t2 = cal ? cal[1] : 0.133, t1 = cal ? cal[0] : 0.264;
  const [mx, my] = pt(p, R);
  return `<div class="gauge"><svg width="${W}" height="125" viewBox="0 0 ${W} 125">
    ${arc(0, t2, '#bfe8d2')}${arc(t2, t1, '#fde3b0')}${arc(t1, max, '#f8c4c5')}
    ${arc(0, Math.min(p, max), p >= t1 ? '#e5484d' : p >= t2 ? '#f59e0b' : '#30a46c')}
    <circle cx="${mx.toFixed(1)}" cy="${my.toFixed(1)}" r="9" fill="#fff" stroke="#0f1b2d" stroke-width="3"/>
    <text x="10" y="124" font-size="10" fill="#64748b">0%</text><text x="192" y="124" font-size="10" fill="#64748b">50%</text></svg>
    <div class="val"><b>${(p * 100).toFixed(1)}%</b><span>chance of escalation</span></div></div>`;
}
function verdictText(r, kv) {
  const tp = r.typology_p, cs = r.reasons.concepts;
  const grp = tp >= 0.7 ? `The client most likely belongs to the <b>high-risk group</b> (p = ${tp.toFixed(2)})`
    : tp <= 0.3 ? `The client most likely belongs to the <b>low-risk group</b> (p = ${tp.toFixed(2)})`
      : `The client's risk group is <b>unclear</b> (p = ${tp.toFixed(2)})`;
  const ups = cs.filter(c => c.direction === 'up' && c.key !== 'typology').slice(0, 2);
  const dns = cs.filter(c => c.direction === 'down' && c.key !== 'typology').slice(0, 1);
  let s = grp + '.';
  if (ups.length) s += ` Main risk signals: ${ups.map(c => `<b>${esc(c.label.en.toLowerCase())}</b> (${esc(c.evidence.en)})`).join('; ')}.`;
  if (dns.length) s += ` Lowering the risk: ${esc(dns[0].label.en.toLowerCase())}.`;
  if (kv && kv.n_burst) s += ` ${kv.n_burst} transactions in the 200 seconds before the alert.`;
  return s;
}
function bandRates() {
  const b = {}; (METRICS ? METRICS.bands : []).forEach(x => b[x.name] = x); return b;
}

/* ---------- queue ---------- */
async function renderQueue() {
  const el = $('#page-queue');
  if (!QUEUE.length) {
    el.innerHTML = '<div class="spinner">Scoring the queue…</div>';
    try { const [q] = await Promise.all([getJSON(API + '/queue'), metrics()]); QUEUE = q.alerts; }
    catch (e) { el.innerHTML = `<div class="card err">Could not load the queue: ${esc(e.message)}</div>`; return; }
  }
  const m = METRICS, br = bandRates();
  const p1 = QUEUE.filter(a => a.band === 'P1').length;
  const cap = Math.round(m.capture_at_share['20'] * 100);
  const wait = (0.5 - m.mean_queue_position_of_escalations.alertlens) / 0.5;
  const dots = (n, cls) => `<div class="dots ${cls}">${Array.from({length: 100}, (_, i) => `<i class="${i < n ? 'on' : ''}"></i>`).join('')}</div>`;
  el.innerHTML = `
  <div class="hero" id="t-hero">
    <div><h2>${QUEUE.length} alerts are waiting. Start with the ${p1} in P1.</h2>
      <p>AlertLens ranks every alert by how likely it is to be escalated, explains why, and drafts the case memo. On real held-out data the top 20% of the queue holds ${cap}% of all escalations.</p></div>
    <div class="row"><button class="btn white" id="tour-btn">${ICON.play} 60-second tour</button><button class="btn wline" id="top-btn">Open top alert →</button></div>
  </div>
  <div class="grid g4" style="margin-bottom:16px">
    <div class="kpi"><div class="v">${QUEUE.length}</div><div class="l">alerts waiting (synthetic demo queue)</div></div>
    <div class="kpi"><div class="v red">${p1}</div><div class="l">P1: review today. ${pct(br.P1 ? br.P1.rate : 0)} of P1 alerts were escalated in the test set</div></div>
    <div class="kpi"><div class="v teal">${cap}%</div><div class="l">of real escalations are in the top 20% of the queue (arrival order: 20%)</div></div>
    <div class="kpi"><div class="v teal">−${pct(wait)}</div><div class="l">average waiting time of a real escalation vs. arrival order</div></div>
  </div>
  <div class="card" id="t-why"><h3>Why the order matters</h3><p class="hint">Out of 100 alerts that really needed escalation, how many does an officer reach after reviewing the first 20% of the queue? Measured on ${m.test_set.n_alerts.toLocaleString()} real alerts the model never saw.</p>
    <div class="arrays">
      <div class="arr"><h4>Arrival order (today)</h4><div class="big">20 <span class="small muted">of 100</span></div>${dots(20, '')}</div>
      <div class="arr"><h4>AlertLens order</h4><div class="big" style="color:var(--accent2)">${cap} <span class="small muted">of 100</span></div>${dots(cap, 'al')}</div>
    </div></div>
  <div class="qtools" id="t-tools">
    <div class="seg" id="band-seg">${['all', 'P1', 'P2', 'P3'].map(b => `<button data-b="${b}" class="${BANDF === b ? 'active' : ''}">${b === 'all' ? 'All bands' : b}</button>`).join('')}</div>
    <div class="seg" id="order-seg"><button data-o="risk" class="${ORDER === 'risk' ? 'active' : ''}">AlertLens order</button><button data-o="fifo" class="${ORDER === 'fifo' ? 'active' : ''}">Arrival order (today)</button></div>
  </div>
  <div class="qhead"><div>#</div><div>Risk</div><div>Alert</div><div>Band</div><div>Client group</div><div>Main reasons</div><div></div></div>
  <div class="qlist" id="qlist"></div>`;
  $('#tour-btn').onclick = () => tour(0);
  $('#top-btn').onclick = () => openAlert(QUEUE[0].id);
  $$('#band-seg button').forEach(b => b.onclick = () => { BANDF = b.dataset.b; $$('#band-seg button').forEach(x => x.classList.toggle('active', x === b)); drawQueue(); });
  $$('#order-seg button').forEach(b => b.onclick = () => { ORDER = b.dataset.o; $$('#order-seg button').forEach(x => x.classList.toggle('active', x === b)); drawQueue(); });
  drawQueue();
}
function drawQueue() {
  let items = [...QUEUE];
  if (ORDER === 'fifo') items.sort((a, b) => a.alert_t - b.alert_t || a.id.localeCompare(b.id));
  const pos = new Map(items.map((a, i) => [a.id, i + 1]));
  if (BANDF !== 'all') items = items.filter(a => a.band === BANDF);
  $('#qlist').innerHTML = items.map(a => {
    const d = decisionOf(a.id);
    return `<div class="qrow" data-id="${a.id}">
      <div class="rank">${pos.get(a.id)}</div>
      <div class="gcell">${ring(a.probability, a.band)}</div>
      <div class="id">${a.id}<div class="tiny muted">${fmtDate(a.alert_t)} · ${a.n_tx} transactions</div></div>
      <div class="bcell"><span class="chip ${a.band}">${a.band}</span><div class="act">${BAND[a.band].short}</div></div>
      <div class="tcell">${typChip(a.typology_p)}</div>
      <div class="why">${a.top_reasons.map(esc).join(' · ') || '—'} ${a.n_burst >= 40 ? `<span class="chip burst">${ICON.burst.replace(/18/g, '12')} burst ${a.n_burst}</span>` : ''}</div>
      <div class="st" title="${d ? esc(d.decision) : ''}">${d ? (d.decision === 'escalate' ? '🔺' : d.decision === 'dismiss' ? '✅' : '❔') : ''}</div>
    </div>`;
  }).join('') || '<div class="muted">No alerts in this band.</div>';
  $$('.qrow').forEach(r => r.onclick = () => openAlert(r.dataset.id));
}

/* ---------- detail ---------- */
async function openAlert(id) {
  show('detail');
  $('#page-detail').innerHTML = '<div class="spinner">Scoring…</div>';
  try { await metrics(); renderDetail(await getJSON(`${API}/alert?id=${encodeURIComponent(id)}`)); }
  catch (e) { $('#page-detail').innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}
function renderDetail(r, prev) {
  CUR = r;
  const el = $('#page-detail'), tx = r.transactions, kv = r.key_values || {}, br = bandRates();
  const cal = METRICS ? [METRICS.bands[0].min_p, METRICS.bands[1].min_p] : null;
  const d = decisionOf(r.id);
  const delta = prev ? r.probability - prev.probability : null;
  el.innerHTML = `
  <div class="crumb"><a id="crumb-back">← ${PREV === 'try' ? 'Score your own' : 'Alert queue'}</a> / ${esc(r.id)}</div>
  <div class="card" id="t-dhero"><div class="dhero">
    <div>${gauge(r.probability, cal)}</div>
    <div class="verdict">
      <h2>${BAND[r.band].action} <span class="chip ${r.band}" style="font-size:13px">${r.band}</span>
        ${delta !== null ? `<span class="chip ${delta >= 0 ? 'P1' : 'P3'}">${delta >= 0 ? '▲ +' : '▼ '}${(delta * 100).toFixed(1)} pts after edit</span>` : ''}</h2>
      <p>${verdictText(r, kv)}</p>
      <p class="small muted" style="margin-top:8px">In band ${r.band}, ${pct(r.band_escalation_rate)} of past alerts were escalated (P1 ${pct(br.P1 ? br.P1.rate : 0)} · P3 ${pct(br.P3 ? br.P3.rate : 0)}). This alert ranks above ${pct(1 - r.top_share)} of the test-set alerts.</p>
    </div>
    <div class="facts">
      <div><span class="muted">Alert</span><b>${esc(r.id)}</b></div>
      <div><span class="muted">Alert date</span><b>${fmtDate(tx.alert_t)}</b></div>
      <div><span class="muted">Transactions, 180 days</span><b>${tx.t.length}</b></div>
      <div><span class="muted">Burst before alert</span><b>${kv.n_burst ?? '—'} tx / 200 s</b></div>
      <div><span class="muted">Client group</span><b>${r.typology_p >= 0.7 ? 'high-risk' : r.typology_p <= 0.3 ? 'low-risk' : 'unclear'} (${r.typology_p.toFixed(2)})</b></div>
      <div><span class="muted">Scored in</span><b>${r.latency_ms} ms</b></div>
    </div>
  </div></div>
  <div class="grid g2">
    <div class="card" id="t-water"><h3>How the score was built</h3><p class="hint">Start from the average alert, then each reason moves the probability up (red) or down (green). The steps add up exactly to this alert's score.</p><div class="chartbox" style="height:400px"><canvas id="c-water"></canvas></div></div>
    <div class="card"><h3>Reasons</h3><p class="hint">Measured facts about this client next to the typical client. ×odds is how much each reason multiplies the odds of escalation.</p>
      <div class="reasons">${r.reasons.concepts.map(c => `<div class="rc ${c.direction}"><div class="ic">${conceptIcon(c.key)}</div>
        <div><div class="t">${esc(c.label.en)}</div><div class="e">${esc(c.evidence.en)}</div></div>
        <div class="x">${c.direction === 'up' ? '▲' : '▼'} ×${c.odds_x.toFixed(2)}<small>odds</small></div></div>`).join('')}</div></div>
  </div>
  <div class="grid g32">
    <div class="card"><h3>Activity in the 180 days before the alert</h3><p class="hint">Transactions per day by channel. The pre-alert burst is shown separately on the right.</p><div class="chartbox"><canvas id="c-daily"></canvas></div></div>
    <div class="card"><h3>The last 200 seconds</h3><p class="hint">Cumulative number of transactions just before the alert fired.</p><div class="chartbox"><canvas id="c-burst"></canvas></div></div>
  </div>
  <div class="grid g2">
    <div class="card" id="t-memo"><h3>Case memo draft</h3><p class="hint">Written from the reasons above with fixed templates: the same input always gives the same memo. The officer edits and signs it.</p>
      <div class="seg" id="memo-seg"><button data-l="en">English</button><button data-l="uz">O'zbekcha</button><button data-l="ru">Русский</button></div>
      <textarea class="memo" id="memo" style="margin-top:10px"></textarea>
      <div class="row" style="margin-top:8px"><button class="btn ghost sm" id="memo-copy">Copy memo</button></div></div>
    <div>
      <div class="card" id="t-decide"><h3>Officer decision</h3><p class="hint">AlertLens never closes an alert by itself. The decision and the score are written to the audit log with a SHA-256 receipt.</p>
        ${d ? `<div class="small" style="margin-bottom:6px">Last decision: <b>${esc(d.decision)}</b> by ${esc(d.officer)} · <code>${d.hash.slice(0, 12)}…</code></div>` : ''}
        <div class="grid g2" style="gap:10px"><div><label>Officer</label><input type="text" id="off" value="${esc(officer())}"></div><div><label>Comment</label><input type="text" id="cmt" placeholder="reason for the decision"></div></div>
        <div class="row" style="margin-top:12px"><button class="btn esc" data-dec="escalate">Escalate</button><button class="btn dis" data-dec="dismiss">Dismiss</button><button class="btn ghost" data-dec="request_info">Request more info</button></div>
        <div id="rcpt" style="margin-top:10px"></div></div>
      <div class="card" id="t-whatif"><h3>What if…? Re-score live</h3><p class="hint">Change this client's data and watch the score react, in milliseconds.</p>
        <div class="whatif">
          <button class="btn ghost sm" data-w="noburst">Remove the pre-alert burst</button>
          <button class="btn ghost sm" data-w="burst">Add a 40-transaction burst</button>
          <button class="btn ghost sm" data-w="smark">Add 3 high-risk micro transfers</button>
          <button class="btn ghost sm" data-w="nmark">Add 3 low-risk micro transfers</button>
          <button class="btn ghost sm" data-w="up">All amounts +0.5</button>
          <button class="btn ghost sm" data-w="down">All amounts −0.5</button>
          <button class="btn ghost sm" data-w="csv">Download as CSV</button>
        </div><div id="w-err" class="err"></div></div>
    </div>
  </div>
  <div class="card"><details><summary>Feature-level audit trail (for model validation)</summary>
    <table style="margin-top:8px"><tr><th>feature</th><th>value</th><th>peer median</th><th>log-odds</th></tr>
    ${r.reasons.features.map(f => `<tr><td><code>${esc(f.feature)}</code></td><td>${f.value ?? '—'}</td><td>${f.peer_median == null ? '—' : (+f.peer_median).toFixed(3)}</td><td>${f.logodds.toFixed(3)}</td></tr>`).join('')}</table>
    <p class="tiny muted">Base log-odds ${r.reasons.base_logodds}; model ${esc(r.model_version)}.</p></details></div>`;
  $('#crumb-back').onclick = () => show(PREV);
  setMemo(MEMO_LANG);
  $$('#memo-seg button').forEach(b => b.onclick = () => setMemo(b.dataset.l));
  $('#memo-copy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText($('#memo').value); toast('Memo copied'); };
  $$('[data-dec]').forEach(b => b.onclick = () => decide(b.dataset.dec));
  $$('[data-w]').forEach(b => b.onclick = () => whatIf(b.dataset.w));
  drawWaterfall(r); drawDaily(tx); drawBurst(tx);
}
function setMemo(l) { MEMO_LANG = l; $('#memo').value = CUR.memo[l]; $$('#memo-seg button').forEach(b => b.classList.toggle('active', b.dataset.l === l)); }
function drawWaterfall(r) {
  const cs = r.reasons.concepts;
  let z = r.reasons.base_logodds, labels = ['Average alert'], data = [[0, sigmoid(z)]], col = ['#94a3b8'];
  let used = 0;
  cs.forEach(c => { const a = sigmoid(z); z += c.logodds; used += c.logodds; labels.push(c.label.en); data.push([a, sigmoid(z)]); col.push(c.logodds > 0 ? '#e5484d' : '#30a46c'); });
  const rest = r.raw - r.reasons.base_logodds - used;
  if (Math.abs(rest) > 1e-4) { const a = sigmoid(z); z += rest; labels.push('All other factors'); data.push([a, sigmoid(z)]); col.push(rest > 0 ? '#f19a9d' : '#8fd3b0'); }
  labels.push('This alert'); data.push([0, r.probability]); col.push(BAND[r.band].color);
  chart('water', $('#c-water'), {type: 'bar', data: {labels, datasets: [{data, backgroundColor: col, borderRadius: 4, barPercentage: .75}]},
    options: {indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation: {duration: 400},
      plugins: {legend: {display: false}, tooltip: {callbacks: {label: c => { const [a, b] = c.raw; return c.dataIndex === 0 || c.dataIndex === data.length - 1 ? `${(b * 100).toFixed(1)}%` : `${(a * 100).toFixed(1)}% → ${(b * 100).toFixed(1)}% (${b >= a ? '+' : ''}${((b - a) * 100).toFixed(1)} pts)`; }}}},
      scales: {x: {min: 0, max: Math.max(0.45, r.probability + 0.05), ticks: {callback: v => Math.round(v * 100) + '%'}, grid: {color: '#eef2f7'}}, y: {grid: {display: false}, ticks: {font: {weight: '600'}, callback: function (v) { const l = this.getLabelForValue(v); const n = innerWidth < 700 ? 18 : 40; return l.length > n ? l.slice(0, n - 1) + '…' : l; }}}}}});
}
function drawDaily(tx) {
  const days = 180, cnt = TYPES.map(() => new Array(days).fill(0));
  for (let i = 0; i < tx.t.length; i++) { const age = tx.alert_t - tx.t[i]; if (age <= 200) continue; const dd = Math.min(days - 1, Math.floor(age / 86400)); cnt[tx.typ[i]][days - 1 - dd]++; }
  const labels = Array.from({length: days}, (_, i) => `${i - days} d`);
  chart('daily', $('#c-daily'), {type: 'bar', data: {labels, datasets: TYPES.map((t, k) => ({label: TYPE_LABEL[t], data: cnt[k], backgroundColor: TYPE_COLOR[k], stack: 's', barPercentage: 1, categoryPercentage: .95}))},
    options: {responsive: true, maintainAspectRatio: false, animation: false, plugins: {legend: {position: 'bottom', labels: {boxWidth: 10, font: {size: 11}}}},
      scales: {x: {stacked: true, ticks: {maxTicksLimit: 10, font: {size: 10}}, grid: {display: false}}, y: {stacked: true, title: {display: true, text: 'transactions per day'}, grid: {color: '#eef2f7'}}}}});
}
function drawBurst(tx) {
  const ages = [];
  for (let i = 0; i < tx.t.length; i++) { const age = tx.alert_t - tx.t[i]; if (age >= 0 && age <= 200) ages.push(age); }
  ages.sort((a, b) => b - a);
  const pts = [{x: -200, y: 0}]; ages.forEach((a, i) => pts.push({x: -a, y: i + 1})); pts.push({x: 0, y: ages.length});
  chart('burst', $('#c-burst'), {type: 'line', data: {datasets: [{label: 'transactions', data: pts, stepped: true, borderColor: '#4338ca', backgroundColor: '#4338ca22', fill: true, pointRadius: 0, borderWidth: 2}]},
    options: {responsive: true, maintainAspectRatio: false, animation: false, plugins: {legend: {display: false}},
      scales: {x: {type: 'linear', min: -200, max: 0, title: {display: true, text: 'seconds before the alert'}, grid: {color: '#eef2f7'}}, y: {beginAtZero: true, title: {display: true, text: 'transactions so far'}, grid: {color: '#eef2f7'}}}}});
}
async function decide(dec) {
  const off = $('#off').value.trim() || 'officer.demo';
  try { localStorage.setItem('alertlens_officer', off); } catch (e) {}
  $('#officer-name').textContent = off;
  const log = auditLog();
  const body = {alert_id: CUR.id, decision: dec, officer: off, comment: $('#cmt').value.trim() || null,
    probability: Math.round(CUR.probability * 1e6) / 1e6, prev_hash: log.length ? log[log.length - 1].hash : null};
  try {
    const rec = await getJSON(API + '/receipt', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    log.push(rec); saveAudit(log);
    $('#rcpt').innerHTML = `<div class="small" style="margin-bottom:4px">${ICON.check.replace(/22/g, '14')} Recorded: <b>${esc(dec)}</b>. Receipt (SHA-256, chained to the previous entry):</div><div class="receipt">${rec.hash}</div>`;
    toast(`Decision recorded: ${dec}`);
  } catch (e) { $('#rcpt').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
const rnd = (a, b) => a + Math.random() * (b - a);
function txRows(tx) { return tx.t.map((t, i) => ({time: t, direction: tx.is_in[i] ? 'in' : 'out', type: TYPES[tx.typ[i]], amount_index: tx.amt[i]})); }
async function whatIf(kind) {
  const tx = CUR.transactions, A = tx.alert_t;
  let rows = txRows(tx);
  if (kind === 'csv') return downloadCSV(rows, A, CUR.id);
  if (kind === 'noburst') rows = rows.filter(r => A - r.time > 200);
  if (kind === 'burst') for (let i = 0; i < 40; i++) { const u = Math.random(); rows.push({time: A - Math.floor(rnd(0, 180)), direction: Math.random() < 0.75 ? 'in' : 'out', type: u < 0.45 ? 'bank' : u < 0.92 ? 'card' : u < 0.99 ? 'cash' : 'intl', amount_index: +rnd(-0.8, 1.2).toFixed(3)}); }
  if (kind === 'smark') for (let i = 0; i < 3; i++) rows.push({time: A - Math.floor(rnd(2, 170) * 86400), direction: 'out', type: 'bank', amount_index: +rnd(-2.809, -2.772).toFixed(4)});
  if (kind === 'nmark') for (let i = 0; i < 3; i++) rows.push({time: A - Math.floor(rnd(2, 170) * 86400), direction: 'in', type: 'bank', amount_index: +rnd(-2.916, -2.899).toFixed(4)});
  if (kind === 'up' || kind === 'down') rows = rows.map(r => ({...r, amount_index: +(r.amount_index + (kind === 'up' ? 0.5 : -0.5)).toFixed(4)}));
  try {
    const prev = CUR;
    const r = await getJSON(API + '/score', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({alert_time: A, transactions: rows})});
    r.id = prev.id.replace(/ \(edited\)$/, '') + ' (edited)';
    renderDetail(r, prev);
    const dp = (r.probability - prev.probability) * 100;
    toast(`Re-scored in ${r.latency_ms} ms: ${(prev.probability * 100).toFixed(1)}% → ${(r.probability * 100).toFixed(1)}% (${dp >= 0 ? '+' : ''}${dp.toFixed(1)} pts)`, 4000);
  } catch (e) { $('#w-err').textContent = e.message; }
}
function downloadCSV(rows, A, name) {
  const iso = t => new Date(t * 1000).toISOString().slice(0, 19);
  const s = `#alert_time=${iso(A)}\ntime,direction,type,amount_index\n` + rows.map(r => `${iso(r.time)},${r.direction},${r.type},${r.amount_index}`).join('\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([s], {type: 'text/csv'})); a.download = (name || 'alert').replace(/[^\w-]+/g, '_') + '.csv'; a.click();
}

/* ---------- score your own ---------- */
function renderTry() {
  const el = $('#page-try');
  if (el.dataset.ready) return;
  el.dataset.ready = '1';
  el.innerHTML = `
  <div class="hero"><div><h2>Give us any client. We score it live.</h2><p>Generate a client with the properties you choose, paste or upload transactions as CSV, or open any alert in the queue and use the "What if" buttons. Scoring takes milliseconds.</p></div></div>
  <div class="grid g2">
    <div class="card"><h3>1 · Generate a client</h3><p class="hint">Synthetic client built from aggregate statistics: no real customer data.</p>
      <label>Hidden client group</label><select id="g-typ"><option value="">Random (population mix)</option><option value="S">High-risk group (S markers)</option><option value="N">Low-risk group (N markers)</option><option value="none">No markers</option></select>
      <label>Pre-alert burst: <span id="g-burst-v">40</span> transactions in the last 200 s</label><input id="g-burst" type="range" min="0" max="150" value="40">
      <label>History: <span id="g-n-v">450</span> transactions in 180 days</label><input id="g-n" type="range" min="20" max="2000" step="10" value="450">
      <label>Amount level shift: <span id="g-shift-v">0.0</span> SD</label><input id="g-shift" type="range" min="-1.5" max="1.5" step="0.1" value="0">
      <label>Seed</label><input id="g-seed" type="number" value="42">
      <div class="row" style="margin-top:14px"><button class="btn primary" id="g-go">${ICON.play} Generate &amp; score</button></div></div>
    <div class="card"><h3>2 · Paste or upload transactions</h3><p class="hint">Columns <code>time,direction,type,amount_index</code>. Direction <code>in</code>/<code>out</code>; type <code>bank</code>/<code>card</code>/<code>cash</code>/<code>intl</code>; amount_index is the normalised log-amount from the monitoring feed. Optional first line <code>#alert_time=2026-05-10T00:00:00</code>.</p>
      <input type="file" id="u-file" accept=".csv,text/csv">
      <textarea class="code" id="u-text" rows="9" spellcheck="false" style="margin-top:8px" placeholder="time,direction,type,amount_index&#10;2026-05-01T10:00:00,in,bank,0.42&#10;2026-05-02T11:30:00,out,card,-0.31"></textarea>
      <div class="row" style="margin-top:10px"><button class="btn primary" id="u-go">Score CSV</button><button class="btn ghost" id="u-template">Download a template</button></div>
      <div id="u-err" class="err"></div></div>
  </div>
  <div class="card"><h3>3 · Edit a real queue alert</h3><p class="hint">Open any alert and use "What if": remove the burst, add micro transfers, shift amounts. The waterfall shows which reason changed.</p><button class="btn ghost" id="t-open">Open a random alert from the queue</button></div>`;
  ['burst', 'n', 'shift'].forEach(k => { const i = $('#g-' + k); i.oninput = () => $('#g-' + k + '-v').textContent = k === 'shift' ? (+i.value).toFixed(1) : i.value; });
  $('#g-go').onclick = async () => {
    PREV = 'try'; show('detail'); $('#page-detail').innerHTML = '<div class="spinner">Generating and scoring…</div>';
    const q = new URLSearchParams({typology: $('#g-typ').value, burst: $('#g-burst').value, n: $('#g-n').value, shift: $('#g-shift').value, seed: $('#g-seed').value});
    try { await metrics(); renderDetail(await getJSON(`${API}/generate?${q}`)); } catch (e) { $('#page-detail').innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
  };
  $('#u-file').onchange = e => { const f = e.target.files[0]; if (!f) return; const rd = new FileReader(); rd.onload = () => $('#u-text').value = rd.result; rd.readAsText(f); };
  $('#u-template').onclick = () => {
    const A = Math.floor(Date.UTC(2026, 4, 10) / 1000), rows = [];
    for (let i = 0; i < 80; i++) rows.push({time: A - Math.floor(rnd(1, 170) * 86400), direction: Math.random() < 0.7 ? 'in' : 'out', type: Math.random() < 0.5 ? 'card' : 'bank', amount_index: +rnd(-1.2, 1.2).toFixed(3)});
    rows.sort((a, b) => a.time - b.time); downloadCSV(rows, A, 'alertlens_template');
  };
  $('#u-go').onclick = async () => {
    $('#u-err').textContent = '';
    const text = $('#u-text').value.trim();
    if (!text) { $('#u-err').textContent = 'Paste CSV or choose a file first.'; return; }
    let alert_time = null;
    const body = text.split(/\r?\n/).filter(l => l.trim()).filter(l => { const m = l.match(/^#\s*alert_time\s*=\s*(.+)$/i); if (m) { alert_time = m[1].trim(); return false; } return true; });
    const hdr = body[0].split(',').map(s => s.trim().toLowerCase()), need = ['time', 'direction', 'type', 'amount_index'];
    if (!need.every(n => hdr.includes(n))) { $('#u-err').textContent = 'The header must contain: ' + need.join(','); return; }
    const rows = body.slice(1).map(l => { const v = l.split(','); const o = {}; hdr.forEach((h, i) => o[h] = (v[i] || '').trim()); return o; });
    PREV = 'try'; show('detail'); $('#page-detail').innerHTML = '<div class="spinner">Scoring…</div>';
    try { await metrics(); renderDetail(await getJSON(API + '/score', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({alert_time, transactions: rows})})); }
    catch (e) { show('try'); $('#u-err').textContent = e.message; }
  };
  $('#t-open').onclick = async () => { if (!QUEUE.length) QUEUE = (await getJSON(API + '/queue')).alerts; PREV = 'try'; openAlert(QUEUE[Math.floor(Math.random() * QUEUE.length)].id); };
}

/* ---------- how it works ---------- */
async function renderHow() {
  const el = $('#page-how'); const m = await metrics();
  el.innerHTML = `
  <div class="card"><h3>From raw transactions to a ranked, explained queue</h3><p class="hint">The whole pipeline runs inside the bank. Scoring needs only numpy: no external API, no GPU, no internet.</p>
    <div class="pipe">
      <div class="step"><div class="n">1</div><b>Alert arrives</b><span>The monitoring system raises an alert. AlertLens reads the client's last 180 days of transactions (≈500).</span></div>
      <div class="step"><div class="n">2</div><b>280 features</b><span>Pre-alert burst, amounts vs. other clients on the same day, a statistical profile per channel, micro-amount markers.</span></div>
      <div class="step"><div class="n">3</div><b>Hidden client group</b><span>A label-free model recognises the high-risk vs. low-risk group (AUC ${m.typology_model.oof_auc_on_markers.toFixed(2)} at recovering it).</span></div>
      <div class="step"><div class="n">4</div><b>Risk score</b><span>Gradient-boosted trees give the escalation probability in ≈${m.speed.ms_per_alert_cpu_single_core} ms, with an exact breakdown by reason.</span></div>
      <div class="step"><div class="n">5</div><b>Officer decides</b><span>Ranked queue, plain-language reasons, memo in EN/UZ/RU, decision with a chained audit receipt.</span></div>
    </div></div>
  <div class="grid g23">
    <div class="card"><h3>Our edge: a hidden client group we found in the data</h3><p class="hint">Incoming bank transfers at the very bottom of the amount scale fall into two narrow bands. Clients in the left band were escalated ≈10% of the time; clients in the right band ≈30%. The two bands never appear in the same client, so they work as labels for free. Aggregate of the labelled competition data.</p>
      <div class="chartbox"><canvas id="c-floor"></canvas></div></div>
    <div class="card"><h3>Why it is hard to copy</h3>
      <p class="small">Another team with the same LLM tools cannot rebuild this in a weekend. The advantage comes from the data, not from a prompt:</p>
      <ul class="small">
        <li><b>Discovery:</b> the micro-amount bands and their 10% vs. 30% escalation rates came out of our own analysis of 10 million transactions.</li>
        <li><b>Model:</b> a second model learns the group from ordinary behaviour, so clients without marker transactions are covered too.</li>
        <li><b>Engineering:</b> trained trees are exported to plain numpy, so the scorer runs on any bank server, and each score breaks down exactly into reasons.</li>
        <li><b>Domain:</b> P1/P2/P3 bands, a memo in three languages and an audit chain fit the existing compliance process.</li>
      </ul></div>
  </div>
  <div class="card"><h3>Built for a regulated bank</h3>
    <div class="trust">
      <div>${ICON.shield}<b>Inside the perimeter</b><span>No customer data leaves the bank. numpy only, no external API.</span></div>
      <div>${ICON.eye}<b>Explainable</b><span>Every score breaks down exactly into reasons with measured values.</span></div>
      <div>${ICON.doc}<b>Deterministic memo</b><span>Template-based in EN/UZ/RU: no hallucinations, reproducible for audit.</span></div>
      <div>${ICON.user}<b>Human in the loop</b><span>Nothing is auto-closed. The officer decides; P3 alerts are still reviewed.</span></div>
      <div>${ICON.lock}<b>Tamper-evident</b><span>Each decision gets a SHA-256 receipt chained to the previous one.</span></div>
    </div></div>`;
  const fb = m.floor_bands.bank_in;
  chart('floor', $('#c-floor'), {type: 'bar', data: {labels: fb.map(b => b.lo.toFixed(3)), datasets: [
      {type: 'line', label: 'escalation rate of these clients', data: fb.map(b => b.esc_rate), yAxisID: 'y2', borderColor: '#0f1b2d', backgroundColor: '#0f1b2d', pointRadius: 3, tension: .2},
      {label: 'clients with a transaction here', data: fb.map(b => b.n_clients), backgroundColor: fb.map(b => (b.esc_rate ?? 0) >= 0.2 ? '#e5484d' : '#30a46c'), borderRadius: 3, yAxisID: 'y'}]},
    options: {responsive: true, maintainAspectRatio: false, animation: false, plugins: {legend: {position: 'bottom', labels: {boxWidth: 10, font: {size: 11}}}},
      scales: {x: {title: {display: true, text: 'amount index (incoming bank transfers, lowest band)'}, ticks: {maxTicksLimit: 8, font: {size: 10}}, grid: {display: false}},
        y: {title: {display: true, text: 'clients'}, grid: {color: '#eef2f7'}}, y2: {position: 'right', min: 0, max: 0.4, ticks: {callback: v => Math.round(v * 100) + '%'}, grid: {display: false}, title: {display: true, text: 'escalated'}}}}});
}

/* ---------- model card ---------- */
async function renderModel() {
  const el = $('#page-model'); const m = await metrics();
  let live = null;
  try { const t0 = performance.now(); const r = await getJSON(API + '/alert?id=AL-2026-0001'); live = {server: r.latency_ms, round: Math.round(performance.now() - t0)}; } catch (e) {}
  const cpuHours = (m.speed.ms_per_alert_cpu_single_core * 1e6 / 3.6e6).toFixed(1);
  el.innerHTML = `
  <div class="grid g4" style="margin-bottom:16px">
    <div class="kpi"><div class="v">${m.auc.toFixed(3)}</div><div class="l">ROC-AUC on ${m.test_set.n_alerts.toLocaleString()} held-out alerts (95% CI ${m.auc_ci95[0].toFixed(3)}–${m.auc_ci95[1].toFixed(3)})</div></div>
    <div class="kpi"><div class="v teal">${pct(m.capture_at_share['20'])}</div><div class="l">of escalations in the top 20% of the queue (arrival order: 20%)</div></div>
    <div class="kpi"><div class="v teal">${pct(m.capture_at_share['50'])}</div><div class="l">of escalations in the top 50% (arrival order: 50%)</div></div>
    <div class="kpi"><div class="v">${live ? live.server : m.speed.ms_per_alert_cpu_single_core} ms</div><div class="l">to score one alert incl. feature extraction${live ? ` (measured just now; round trip ${live.round} ms)` : ''}</div></div>
  </div>
  <div class="grid g2">
    <div class="card"><h3>Escalations reached vs. share of queue reviewed</h3><p class="hint">Test set: ${m.test_set.n_alerts.toLocaleString()} real alerts, ${m.test_set.n_escalated} escalated (${pct(m.test_set.base_rate, 1)}), a stratified 20% split never used in training. 5-fold CV on the training part: AUC ${m.cv_auc_train80.toFixed(3)}.</p><div class="chartbox"><canvas id="c-cap"></canvas></div></div>
    <div class="card"><h3>Queue bands</h3><p class="hint">Thresholds fixed on the test set.</p>
      <table><tr><th>band</th><th>share of alerts</th><th>escalated</th><th>handling</th></tr>
      ${m.bands.map(b => `<tr><td><span class="chip ${b.name}">${b.name}</span></td><td>${pct(b.share)}</td><td><b>${pct(b.rate, 1)}</b></td><td>${BAND[b.name].action}</td></tr>`).join('')}</table>
      <p class="small">P1 alerts are escalated <b>${(m.bands[0].rate / m.bands[2].rate).toFixed(1)}×</b> as often as P3. The ranking sets priority only: every alert is still reviewed by a person.</p>
      <h3 style="margin-top:14px">Speed and cost</h3>
      <p class="small">≈${m.speed.ms_per_alert_cpu_single_core} ms of one CPU core per alert, so 1 million alerts take ≈${cpuHours} CPU-hours. A single 4-vCPU server inside the bank is enough. No GPU, no paid API.</p></div>
  </div>
  <div class="grid g2">
    <div class="card"><h3>Where it is weaker (measured)</h3>
      <table><tr><th>segment</th><th>alerts</th><th>escalated</th><th>AUC</th></tr>
      ${(m.segments || []).map(s => `<tr><td>${esc(s.segment)}</td><td>${s.n}</td><td>${pct(s.esc_rate, 1)}</td><td>${s.auc == null ? '—' : s.auc.toFixed(3)}</td></tr>`).join('')}</table>
      <ul class="small">
        <li><b>Noise ceiling:</b> even perfect knowledge of the client group gives AUC ≈ 0.66, so labels are noisy and the tool must prioritise, never auto-close.</li>
        <li><b>Short histories</b> (≤ 309 transactions) and the rare <b>conflicting-marker</b> clients are the weakest cases.</li>
        <li><b>Drift:</b> marker bands depend on the current data feed. We monitor marker rates and AUC monthly and retrain after rule changes.</li>
      </ul></div>
    <div class="card"><h3>Data and licences</h3>
      <ul class="small">
        <li><b>Training and test:</b> WIUT Hackathon 2026 elimination-round dataset (anonymised alerts with 180-day transactions), used under the competition terms. Not redistributed: only model files and aggregate statistics are published.</li>
        <li><b>Demo alerts:</b> synthetic, generated from aggregate statistics by <code>synth/generate.py</code>.</li>
        <li><b>Code:</b> MIT. Elimination-round findings reused and declared in the README. numpy (BSD) at runtime; LightGBM (MIT) and scikit-learn (BSD) for training only; Chart.js (MIT).</li>
      </ul></div>
  </div>`;
  const c = m.capture_curve;
  chart('cap', $('#c-cap'), {type: 'line', data: {labels: c.x.map(x => pct(x)), datasets: [
    {label: 'AlertLens order', data: c.y, borderColor: '#0ea5a0', backgroundColor: '#0ea5a022', fill: true, pointRadius: 0, tension: .2, borderWidth: 2.5},
    {label: 'Arrival order (today)', data: c.x, borderColor: '#94a3b8', borderDash: [6, 4], pointRadius: 0}]},
    options: {responsive: true, maintainAspectRatio: false, animation: false, plugins: {legend: {position: 'bottom'}},
      scales: {y: {min: 0, max: 1, ticks: {callback: v => pct(v)}, title: {display: true, text: 'escalations reached'}, grid: {color: '#eef2f7'}}, x: {title: {display: true, text: 'share of the queue reviewed'}, ticks: {maxTicksLimit: 11}, grid: {display: false}}}}});
}

/* ---------- ROI ---------- */
function capAt(s) { const c = METRICS.capture_curve; for (let i = 1; i < c.x.length; i++) if (s <= c.x[i]) return c.y[i - 1] + (c.y[i] - c.y[i - 1]) * (s - c.x[i - 1]) / (c.x[i] - c.x[i - 1]); return 1; }
async function renderROI() {
  const el = $('#page-roi'); await metrics();
  if (el.dataset.ready) return calcROI();
  el.dataset.ready = '1';
  const f = (id, label, v, step, note) => `<label>${label}</label><input type="number" id="${id}" value="${v}" step="${step}">${note ? `<div class="tiny muted" style="margin-top:3px">${note}</div>` : ''}`;
  el.innerHTML = `
  <div class="grid g4" style="margin-bottom:16px" id="roi-kpis"></div>
  <div class="grid g23">
    <div class="card"><h3>Bank inputs</h3><p class="hint">Assumptions: replace them with the bank's own figures. Model effects come from the held-out test set.</p>
      ${f('r-alerts', 'Alerts per month', 3000, 100)}
      ${f('r-min', 'Minutes per full review', 25, 1)}
      ${f('r-fast', 'Minutes per light review of P3 alerts', 12, 1, 'Policy option: P3 alerts still get a human look. Set it equal to the full review to switch this saving off.')}
      ${f('r-rate', 'Loaded officer cost, UZS per hour', 60000, 1000)}
      ${f('r-capacity', 'Share of each day\'s alerts reviewed the same day, %', 50, 5)}
      <h3 style="margin-top:16px">Pilot (3 months)</h3>
      ${f('r-team', 'Team: people × months × monthly cost, UZS', 3 * 3 * 12000000, 1000000)}
      ${f('r-infra', 'One server inside the bank (4 vCPU), UZS', 6000000, 500000)}
      ${f('r-run', 'Running cost per month after the pilot, UZS', 4000000, 500000)}</div>
    <div class="card"><h3>Results</h3><div id="r-out"></div></div>
  </div>`;
  $$('#page-roi input').forEach(i => i.oninput = calcROI);
  calcROI();
}
function calcROI() {
  const v = id => +$('#' + id).value || 0, m = METRICS;
  const alerts = v('r-alerts'), mins = v('r-min'), fast = v('r-fast'), rate = v('r-rate'), cap = Math.min(Math.max(v('r-capacity') / 100, 0), 1);
  const escN = alerts * m.test_set.base_rate, p3 = m.bands[2].share;
  const hours = alerts * p3 * Math.max(mins - fast, 0) / 60, money = hours * rate;
  const sameAL = capAt(cap), extra = escN * (sameAL - cap);
  const wait = (0.5 - m.mean_queue_position_of_escalations.alertlens) / 0.5;
  const pilot = v('r-team') + v('r-infra'), net = money - v('r-run'), payback = net > 0 ? pilot / net : Infinity;
  const U = x => Math.round(x).toLocaleString('en-US');
  $('#roi-kpis').innerHTML = `
    <div class="kpi"><div class="v teal">${U(hours)} h</div><div class="l">officer hours freed per month</div></div>
    <div class="kpi"><div class="v teal">${(money / 1e6).toFixed(1)}M UZS</div><div class="l">value of freed time per month</div></div>
    <div class="kpi"><div class="v teal">+${U(extra)}</div><div class="l">more real escalations handled the same day, per month</div></div>
    <div class="kpi"><div class="v">${isFinite(payback) ? payback.toFixed(1) + ' mo' : '—'}</div><div class="l">payback of the pilot</div></div>`;
  $('#r-out').innerHTML = `<table>
    <tr><td>Escalations per month (${pct(m.test_set.base_rate, 1)} of alerts)</td><td><b>${U(escN)}</b></td></tr>
    <tr><td>Handled the same day: arrival order → AlertLens (capacity ${pct(cap)})</td><td><b>${pct(cap)} → ${pct(sameAL)}</b></td></tr>
    <tr><td>Extra real escalations handled the same day</td><td><b>+${U(extra)} / month</b></td></tr>
    <tr><td>Average waiting time of a real escalation</td><td><b>−${pct(wait)}</b></td></tr>
    <tr><td>Hours freed by a light review of P3 (${pct(p3)} of alerts, ${pct(m.bands[2].rate, 1)} escalated)</td><td><b>${U(hours)} h / month</b></td></tr>
    <tr><td>Value of freed hours</td><td><b>${U(money)} UZS / month</b></td></tr>
    <tr><td>Pilot cost</td><td><b>${U(pilot)} UZS</b></td></tr>
    <tr><td>Net saving after running cost</td><td><b>${U(net)} UZS / month</b></td></tr>
    <tr><td>Payback</td><td><b>${isFinite(payback) ? payback.toFixed(1) + ' months' : 'not reached with these inputs'}</b></td></tr></table>`;
}

/* ---------- audit ---------- */
function canon(o) { if (o === null || typeof o !== 'object') return JSON.stringify(o); return '{' + Object.keys(o).sort().map(k => JSON.stringify(k) + ': ' + canon(o[k])).join(', ') + '}'; }
async function sha256(s) { const b = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); return [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, '0')).join(''); }
function renderAudit() {
  const log = auditLog(), el = $('#page-audit');
  el.innerHTML = `<div class="card"><h3>Decisions</h3><p class="hint">The server issues a SHA-256 receipt for every decision and includes the previous receipt's hash, so editing or deleting any past entry breaks the chain. In this demo the log is kept in your browser; in production it is an append-only table in the bank's database.</p>
    <div class="row"><button class="btn primary" id="a-verify">Verify chain</button><button class="btn ghost" id="a-export">Export CSV</button><button class="btn ghost" id="a-clear">Clear demo log</button><span id="a-res" class="small"></span></div>
    <div style="overflow:auto;margin-top:12px">${log.length ? `<table><tr><th>time (UTC)</th><th>alert</th><th>decision</th><th>officer</th><th>score</th><th>comment</th><th>receipt</th></tr>
    ${log.map(r => `<tr><td>${new Date(r.server_time * 1000).toISOString().replace('T', ' ').slice(0, 19)}</td><td>${esc(r.alert_id)}</td><td>${esc(r.decision)}</td><td>${esc(r.officer)}</td><td>${(r.probability * 100).toFixed(1)}%</td><td>${esc(r.comment || '')}</td><td><code>${r.hash.slice(0, 12)}…</code></td></tr>`).join('')}</table>` : '<div class="muted">No decisions yet. Open an alert and escalate or dismiss it.</div>'}</div></div>`;
  $('#a-verify').onclick = async () => {
    let ok = true, prev = null;
    for (const r of log) { const {hash, ...rest} = r; if (rest.prev_hash !== prev || await sha256(canon(rest)) !== hash) { ok = false; break; } prev = hash; }
    $('#a-res').innerHTML = ok ? `<b style="color:var(--p3)">✓ Chain intact (${log.length} entries)</b>` : '<b style="color:var(--p1)">✗ Chain broken</b>';
  };
  $('#a-export').onclick = () => {
    const cols = ['server_time', 'alert_id', 'decision', 'officer', 'probability', 'comment', 'model_version', 'prev_hash', 'hash'];
    const s = cols.join(',') + '\n' + log.map(r => cols.map(c => JSON.stringify(r[c] ?? '')).join(',')).join('\n');
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([s], {type: 'text/csv'})); a.download = 'alertlens_audit.csv'; a.click();
  };
  $('#a-clear').onclick = () => { saveAudit([]); renderAudit(); };
}

/* ---------- 60-second tour ---------- */
const TOUR = [
  {sel: '.qrow', page: 'queue', t: 'The ranked queue', p: 'Every alert gets an escalation probability. P1 means review today. Officers simply work from the top.'},
  {sel: '#t-tools', page: 'queue', t: 'Compare with today', p: 'Switch to "Arrival order" to see the current process: high-risk alerts are scattered through the queue.'},
  {sel: '#t-why', page: 'queue', t: 'Measured, not promised', p: 'On 2,800 real alerts the model never saw, the top 20% of our queue holds 36 of every 100 real escalations; arrival order holds 20.'},
  {sel: '#t-dhero', page: 'detail', t: 'One-glance verdict', p: 'Risk gauge, band and a plain-language summary of why, written from measured facts about the client.'},
  {sel: '#t-water', page: 'detail', t: 'Exactly why', p: 'Starting from the average alert, each reason moves the probability up or down. The steps add up exactly to the score.'},
  {sel: '#t-memo', page: 'detail', t: 'Memo in three languages', p: 'The case memo is drafted in English, Uzbek or Russian with fixed templates: no hallucinations, reproducible for audit.'},
  {sel: '#t-decide', page: 'detail', t: 'The officer decides', p: 'Nothing is auto-closed. Each decision gets a SHA-256 receipt chained to the previous one.'},
  {sel: '#t-whatif', page: 'detail', t: 'Try it yourself', p: 'Change the client\'s data and the score updates live. Or go to "Score your own" and give us any client.'}
];
let TOUR_I = -1;
function endTour() { TOUR_I = -1; $$('.tour-hl').forEach(e => e.classList.remove('tour-hl')); $$('.tour-dim,.tour-box').forEach(e => e.remove()); }
async function tour(i) {
  endTour(); if (i < 0 || i >= TOUR.length) return;
  TOUR_I = i; const s = TOUR[i];
  if (s.page === 'queue' && !$('#page-queue').classList.contains('active')) { show('queue'); await new Promise(r => setTimeout(r, 300)); }
  if (s.page === 'detail' && (!$('#page-detail').classList.contains('active') || !$(s.sel))) { await openAlert(QUEUE[0].id); }
  const el = $(s.sel); if (!el) return;
  el.scrollIntoView({block: 'center', behavior: 'instant'});
  el.classList.add('tour-hl');
  const dim = document.createElement('div'); dim.className = 'tour-dim'; dim.onclick = endTour; document.body.appendChild(dim);
  const box = document.createElement('div'); box.className = 'tour-box';
  box.innerHTML = `<div class="k">Step ${i + 1} of ${TOUR.length}</div><h4>${s.t}</h4><p>${s.p}</p><div class="row" style="justify-content:space-between"><button class="btn ghost sm" id="tour-x">Close</button><div class="row">${i ? '<button class="btn ghost sm" id="tour-p">Back</button>' : ''}<button class="btn primary sm" id="tour-n">${i === TOUR.length - 1 ? 'Finish' : 'Next'}</button></div></div>`;
  document.body.appendChild(box);
  const rc = el.getBoundingClientRect(), bw = box.offsetWidth, bh = box.offsetHeight;
  let top = rc.bottom + 12; if (top + bh > innerHeight - 10) top = Math.max(10, rc.top - bh - 12);
  if (top < 10 || top + bh > innerHeight - 10) top = innerHeight - bh - 16;
  box.style.top = top + 'px'; box.style.left = Math.min(Math.max(16, rc.left), innerWidth - bw - 16) + 'px';
  $('#tour-x').onclick = endTour; $('#tour-n').onclick = () => tour(i + 1); if (i) $('#tour-p').onclick = () => tour(i - 1);
}
document.addEventListener('keydown', e => { if (TOUR_I < 0) return; if (e.key === 'Escape') endTour(); if (e.key === 'ArrowRight') tour(TOUR_I + 1); if (e.key === 'ArrowLeft') tour(TOUR_I - 1); });

/* ---------- boot ---------- */
const start = location.hash.slice(1);
show(PAGES[start] && start !== 'detail' ? start : 'queue', false);
