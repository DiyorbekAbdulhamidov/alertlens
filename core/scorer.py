"""AlertLens scorer: transactions -> escalation probability, typology, reasons. numpy only."""
import os, json
import numpy as np
from .features import extract, marker_groups, posterior_typology
from .model import TreeEnsemble, sigmoid
from .reasons import explain

ART = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'artifacts')


class Scorer:
    def __init__(self, art_dir=ART):
        A = np.load(os.path.join(art_dir, 'model.npz'))
        self.main = TreeEnsemble(A, 'main')
        self.typo = TreeEnsemble(A, 'typo')
        self.tables = {'mu': A['tab_mu'], 'sd': A['tab_sd'], 'eb_k': A['tab_eb_k']}
        cols = json.load(open(os.path.join(art_dir, 'columns.json')))
        self.feat_cols, self.typo_cols = cols['feat_cols'], cols['typo_cols']
        self.pop = json.load(open(os.path.join(art_dir, 'population.json')))
        cal = os.path.join(art_dir, 'calibration.json')
        self.cal = json.load(open(cal)) if os.path.exists(cal) else None

    def features(self, t, is_in, typ, amt, alert_t):
        f = extract(t, is_in, typ, amt, alert_t, self.tables)
        xt = np.array([[f[c] for c in self.typo_cols]])
        p_model = float(sigmoid(self.typo.raw(xt))[0])
        f['typology_p'] = posterior_typology(p_model, *marker_groups(f))
        f['_typology_model_p'] = p_model
        return f

    def score_features(self, flist, with_reasons=True):
        X = np.array([[f[c] for c in self.feat_cols] for f in flist], dtype=np.float64)
        if with_reasons:
            raw, C = self.main.raw(X, contrib=True)
        else:
            raw, C = self.main.raw(X), None
        p = sigmoid(raw)
        out = []
        for i, f in enumerate(flist):
            r = {'probability': float(p[i]), 'raw': float(raw[i]), 'typology_p': float(f['typology_p'])}
            if self.cal:
                r.update(self.band(float(p[i])))
            if with_reasons:
                r['reasons'] = explain(f, C[i], self.feat_cols, self.pop, self.main.expected)
            out.append(r)
        return out

    def band(self, p):
        """Queue position on the held-out test set: share of alerts with a higher score, and the escalation
        rate observed in that score band."""
        c = self.cal
        q = float(np.searchsorted(np.array(c['sorted_p']), p) / len(c['sorted_p']))
        top_share = 1.0 - q
        for b in c['bands']:
            if p >= b['min_p']:
                return {'band': b['name'], 'band_escalation_rate': b['rate'], 'top_share': top_share}
        b = c['bands'][-1]
        return {'band': b['name'], 'band_escalation_rate': b['rate'], 'top_share': top_share}

    def score(self, t, is_in, typ, amt, alert_t):
        f = self.features(t, is_in, typ, amt, alert_t)
        r = self.score_features([f])[0]
        r['features'] = {k: (None if (isinstance(v, float) and np.isnan(v)) else v) for k, v in f.items()}
        return r
