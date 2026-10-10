"""AlertLens Copilot: an LLM that explains a score, grounded only on facts computed by the scorer.

The LLM never produces the score or the decision. It receives a FACTS JSON built server-side from the
scoring result, answers the officer's question in EN/UZ/RU, and every number in its answer is checked
against the facts (unverified numbers are flagged in the UI).

Demo: an open-weight model through Vercel AI Gateway (OpenAI-compatible endpoint, OIDC auth, no key in code).
Production design: the same open-weight model served inside the bank (e.g. vLLM), set via ALERTLENS_LLM_URL.
Standard library only.
"""
import os, re, json, time, urllib.request, urllib.error

GATEWAY_URL = os.getenv('ALERTLENS_LLM_URL', 'https://ai-gateway.vercel.sh/v1/chat/completions')
MODELS = [m for m in os.getenv('ALERTLENS_LLM_MODELS', 'meta/llama-3.3-70b,alibaba/qwen-3-32b').split(',') if m]
LANG = {'en': 'English', 'uz': "Uzbek (Latin script, o'zbek tili)", 'ru': 'Russian'}
SYSTEM = """You are AlertLens Copilot, an assistant for an AML / compliance officer in the Financial Monitoring unit of a bank in Uzbekistan.
You explain a machine-learning risk score for ONE transaction-monitoring alert.
Rules:
- Use ONLY the facts in the FACTS JSON. Never invent numbers, names, dates, counterparties or client details. If something is not in the facts, say it is not available in the alert data.
- You do not decide. The officer decides whether to escalate or dismiss. Never call the client a criminal; describe risk indicators.
- The score comes from a separate machine-learning model; do not change it or give your own probability.
- Be concise: at most 120 words unless the officer asks you to draft a document. Use short bullet points for lists.
- When suggesting next checks, propose standard AML review steps (source of funds, purpose of transfers, counterparties, KYC documents, link to other alerts) and tie each one to a fact.
- If the question is not about this alert or AML review, politely decline.
- Answer in {lang}."""


def build_facts(alert_id, r, kv, bands, pop, lang='en'):
    lg = lang if lang in ('en', 'uz', 'ru') else 'en'
    concepts = r['reasons']['concepts']
    tp = r['typology_p']
    return {
        'alert_id': alert_id,
        'escalation_probability_percent': round(r['probability'] * 100, 1),
        'queue_band': r.get('band'),
        'band_meaning': {'P1': 'priority review today', 'P2': 'standard review', 'P3': 'low priority, after P1/P2'}.get(r.get('band')),
        'historical_escalation_rate_in_this_band_percent': round((r.get('band_escalation_rate') or 0) * 100, 1),
        'historical_escalation_rate_by_band_percent': {b['name']: round(b['rate'] * 100, 1) for b in bands},
        'ranks_above_percent_of_test_alerts': round((1 - r.get('top_share', 0)) * 100),
        'client_group': {
            'probability_high_risk_group': round(tp, 2),
            'interpretation': 'high-risk group S (about 30% of such alerts escalated)' if tp >= 0.7 else
            'low-risk group N (about 10% of such alerts escalated)' if tp <= 0.3 else 'unclear',
            'marker_transactions_high_risk_group': int(kv.get('blk_S_n') or 0),
            'marker_transactions_low_risk_group': int(kv.get('blk_N_n') or 0)},
        'transactions_in_180_days': int(kv.get('n_hist') or 0),
        'active_days': int(kv.get('active_days') or 0),
        'transactions_in_last_200_seconds_before_alert': int(kv.get('n_burst') or 0),
        'typical_client_transactions_in_last_200_seconds': (pop.get('n_burst') or [None])[0],
        'reasons_ranked': [{'factor': c['label'][lg], 'effect': 'raises risk' if c['direction'] == 'up' else 'lowers risk',
                            'odds_multiplier': round(c['odds_x'], 2), 'evidence': c['evidence'][lg]} for c in concepts],
        'note': 'amounts are a normalised amount index, not currency; SD = standard deviations versus comparable clients',
    }


def _numbers(text):
    return [float(x.replace(',', '.')) for x in re.findall(r'(?<![\w.])\d+(?:[.,]\d+)?', text)]


def verify(answer, facts):
    """Every number in the answer must match a number in the facts (or a simple percent/rounding of one)."""
    ref = {180.0, 200.0, 2.0, 3.0}          # window lengths used in the facts' field names
    for v in _numbers(json.dumps(facts)):
        for x in (v, v * 100, v / 100):
            for nd in (0, 1, 2):
                ref.add(round(x, nd))
    bad = []
    for v in _numbers(answer):
        if v <= 10 and float(v).is_integer():
            continue                       # list numbering, "3 checks", etc.
        if not any(abs(v - r) <= 0.051 for r in ref):
            bad.append(v)
    return {'all_numbers_verified': not bad, 'unverified_numbers': bad[:10]}


def ask(question, facts, lang, token, timeout=13):
    if not token:
        raise RuntimeError('AI copilot is not configured on this server')
    msgs = [{'role': 'system', 'content': SYSTEM.format(lang=LANG.get(lang, 'English'))},
            {'role': 'user', 'content': 'FACTS JSON:\n' + json.dumps(facts, ensure_ascii=False, indent=1) +
             '\n\nOFFICER QUESTION:\n' + question.strip()[:800]}]
    last = None
    for model in MODELS[:2]:
        t0 = time.time()
        req = urllib.request.Request(GATEWAY_URL, data=json.dumps({
            'model': model, 'messages': msgs, 'temperature': 0.2, 'max_tokens': 600}).encode(),
            headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                d = json.loads(resp.read().decode())
            text = d['choices'][0]['message']['content'] or ''
            text = re.sub(r'<think>.*?</think>', '', text, flags=re.S).strip()
            return {'answer': text, 'model': model, 'latency_ms': round((time.time() - t0) * 1000),
                    'usage': d.get('usage'), **verify(text, facts)}
        except urllib.error.HTTPError as e:
            last = f'{model}: HTTP {e.code} {e.read()[:200].decode(errors="ignore")}'
        except Exception as e:  # timeout, network
            last = f'{model}: {e}'
    raise RuntimeError('AI copilot unavailable (' + str(last) + ')')
