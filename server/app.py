"""AlertLens HTTP API (one handler for every route; numpy only, no external calls).
On Vercel each api/<route>.py re-exports this handler; locally dev_server.py serves it.

GET  /api/health
GET  /api/queue                      demo queue of synthetic alerts, ranked by risk
GET  /api/alert?id=AL-...            one alert: transactions, score, reasons, memo (EN/UZ/RU)
POST /api/score                      score your own transactions (JSON or CSV), see README
GET  /api/generate?typology=S|N|none&burst=40&n=500&shift=0&seed=1   new synthetic client + score
GET  /api/metrics                    held-out test-set metrics of the deployed model
POST /api/receipt                    tamper-evident audit receipt for an officer decision
POST /api/copilot                    LLM explanation grounded on the scorer's facts (see core/copilot.py)
"""
import os, sys, json, time, hashlib, io, csv
from http.server import BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..')
sys.path.insert(0, ROOT)
import numpy as np
from core.scorer import Scorer
from core.reasons import memo
from synth.generate import Generator
from core import copilot

MODEL_VERSION = 'alertlens-1.0 (LightGBM-exported, 1500 trees + typology 2000 trees)'
_S = None
_G = None
_QUEUE = None
N_DEMO = 120
TYPES = ['bank', 'card', 'cash', 'intl']


def S():
    global _S, _G
    if _S is None:
        _S = Scorer(os.path.join(ROOT, 'artifacts'))
        _G = Generator(_S.tables, os.path.join(ROOT, 'synth', 'params.json'))
    return _S


def demo_client(i):
    S()
    return _G.client(1000 + i)


def alert_id(i):
    return f'AL-2026-{i:04d}'


def compact(c):
    return {'alert_t': c['alert_t'], 't': c['t'], 'is_in': c['is_in'], 'typ': c['typ'], 'amt': c['amt']}


def run(c):
    s = S()
    return s.score(np.array(c['t'], dtype=np.int64), np.array(c['is_in']), np.array(c['typ']),
                   np.array(c['amt'], dtype=np.float64), int(c['alert_t']))


def full_result(aid, c):
    t0 = time.perf_counter()
    r = run(c)
    ms = (time.perf_counter() - t0) * 1000
    feats = r.pop('features')
    return {'id': aid, 'model_version': MODEL_VERSION, 'latency_ms': round(ms, 2), **r,
            'memo': {lang: memo(aid, r, lang, MODEL_VERSION) for lang in ('en', 'uz', 'ru')},
            'key_values': {k: feats.get(k) for k in ['n_hist', 'n_burst', 'active_days', 'typology_p',
                                                     '_typology_model_p', 'blk_S_n', 'blk_N_n']},
            'transactions': compact(c)}


def queue():
    global _QUEUE
    if _QUEUE is None:
        s = S()
        items = []
        for i in range(1, N_DEMO + 1):
            c = demo_client(i)
            f = s.features(np.array(c['t']), np.array(c['is_in']), np.array(c['typ']), np.array(c['amt']), c['alert_t'])
            items.append((i, c, f))
        res = s.score_features([f for _, _, f in items])
        out = []
        for (i, c, f), r in zip(items, res):
            ups = [x['label']['en'] for x in r['reasons']['concepts'] if x['direction'] == 'up'][:2]
            out.append({'id': alert_id(i), 'alert_t': c['alert_t'], 'n_tx': len(c['t']), 'probability': r['probability'],
                        'band': r.get('band'), 'band_escalation_rate': r.get('band_escalation_rate'),
                        'typology_p': r['typology_p'], 'top_reasons': ups, 'n_burst': int(f['n_burst'])})
        out.sort(key=lambda x: -x['probability'])
        for k, x in enumerate(out):
            x['rank'] = k + 1
        _QUEUE = out
    return _QUEUE


def parse_transactions(body, ctype):
    """Accept JSON {alert_time, transactions:[{time, direction, type, amount_index}]} or CSV with header
    time,direction,type,amount_index (+ optional alert_time query/field)."""
    if 'csv' in ctype or (isinstance(body, str) and body.lstrip().lower().startswith('time')):
        rows = list(csv.DictReader(io.StringIO(body)))
        data = {'transactions': rows}
    else:
        data = json.loads(body or '{}')
    txs = data.get('transactions') or []
    if not txs:
        raise ValueError('no transactions')
    if len(txs) > 5000:
        raise ValueError('max 5000 transactions per alert')

    def ts(v):
        if isinstance(v, (int, float)):
            return int(v)
        return int(np.datetime64(str(v).replace('Z', '').strip(), 's').astype(np.int64))
    t, d, y, a = [], [], [], []
    for r in txs:
        t.append(ts(r['time']))
        dv = str(r.get('direction', '')).lower()
        d.append(1 if dv in ('in', 'kirim', 'incoming', '1') else 0)
        tv = str(r.get('type', '')).lower()
        y.append({'bank': 0, 'bank_transfer': 0, 'bank_otkazmasi': 0, 'card': 1, 'karta': 1, 'cash': 2, 'naqd': 2,
                  'intl': 3, 'international': 3, 'xalqaro': 3}[tv])
        a.append(float(r['amount_index']))
    at = data.get('alert_time')
    alert_t = ts(at) if at not in (None, '') else int(max(t)) + 1
    return {'alert_t': alert_t, 't': t, 'is_in': d, 'typ': y, 'amt': a}


class handler(BaseHTTPRequestHandler):
    def _send(self, code, obj):
        b = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(b)

    def do_OPTIONS(self):
        self._send(204, {})

    def do_GET(self):
        u = urlparse(self.path)
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        p = u.path.rstrip('/')
        try:
            if p.endswith('/health'):
                S()
                return self._send(200, {'ok': True, 'model_version': MODEL_VERSION})
            if p.endswith('/queue'):
                return self._send(200, {'model_version': MODEL_VERSION, 'alerts': queue()})
            if p.endswith('/alert'):
                aid = q.get('id', '')
                i = int(aid.split('-')[-1])
                if not 1 <= i <= N_DEMO:
                    return self._send(404, {'error': 'unknown alert'})
                return self._send(200, full_result(aid, demo_client(i)))
            if p.endswith('/generate'):
                S()
                typ = q.get('typology') or None
                if typ not in (None, 'S', 'N', 'none'):
                    typ = None
                c = _G.client(int(q.get('seed', np.random.randint(1, 10**6))), typology=typ,
                              burst=int(q['burst']) if q.get('burst') not in (None, '') else None,
                              n_hist=int(q['n']) if q.get('n') not in (None, '') else None,
                              level_shift=float(q.get('shift', 0) or 0))
                return self._send(200, {**full_result('CUSTOM-' + str(c['generator']['seed']), c), 'generator': c['generator']})
            if p.endswith('/metrics'):
                m = json.load(open(os.path.join(ROOT, 'artifacts', 'metrics.json')))
                return self._send(200, m)
            return self._send(404, {'error': 'not found'})
        except Exception as e:
            return self._send(400, {'error': str(e)})

    def do_POST(self):
        u = urlparse(self.path)
        n = int(self.headers.get('Content-Length', 0) or 0)
        body = self.rfile.read(n).decode('utf-8') if n else ''
        try:
            if u.path.rstrip('/').endswith('/score'):
                c = parse_transactions(body, self.headers.get('Content-Type', ''))
                return self._send(200, full_result('UPLOAD-' + hashlib.sha1(body.encode()).hexdigest()[:8], c))
            if u.path.rstrip('/').endswith('/copilot'):
                d = json.loads(body or '{}')
                tx = d.get('transactions') or {}
                c = {k: tx[k] for k in ('alert_t', 't', 'is_in', 'typ', 'amt')}
                if len(c['t']) > 5000:
                    raise ValueError('max 5000 transactions per alert')
                r = run(c)
                feats = r.pop('features')
                kv = {k: feats.get(k) for k in ('n_hist', 'n_burst', 'active_days', 'blk_S_n', 'blk_N_n')}
                m = json.load(open(os.path.join(ROOT, 'artifacts', 'metrics.json')))
                facts = copilot.build_facts(str(d.get('alert_id', 'alert'))[:60], r, kv, m['bands'], S().pop)
                token = (os.getenv('AI_GATEWAY_API_KEY') or os.getenv('VERCEL_OIDC_TOKEN')
                         or self.headers.get('x-vercel-oidc-token'))
                try:
                    out = copilot.ask(str(d.get('question', '')), facts, d.get('lang', 'en'), token)
                except RuntimeError as e:
                    return self._send(503, {'error': str(e), 'facts': facts})
                return self._send(200, {**out, 'facts': facts})
            if u.path.rstrip('/').endswith('/receipt'):
                d = json.loads(body)
                rec = {k: d.get(k) for k in ('alert_id', 'decision', 'officer', 'comment', 'probability', 'prev_hash')}
                rec['model_version'] = MODEL_VERSION
                rec['server_time'] = int(time.time())
                rec['hash'] = hashlib.sha256(json.dumps(rec, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
                return self._send(200, rec)
            return self._send(404, {'error': 'not found'})
        except Exception as e:
            return self._send(400, {'error': str(e)})
