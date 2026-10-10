"""Evaluate on the held-out test set (20% of labelled alerts, never used in training) and write
artifacts/metrics.json + artifacts/calibration.json (queue bands). Only aggregates are written.

Usage: python training/evaluate.py <build_dir> <artifacts_dir>
"""
import sys, os, json
import numpy as np
from sklearn.metrics import roc_auc_score, average_precision_score


def capture(y, p, shares):
    o = np.argsort(-p)
    ys = y[o]
    tot = ys.sum()
    return {f'{int(s * 100)}': float(ys[: int(round(s * len(y)))].sum() / tot) for s in shares}


def main(build_dir, art_dir):
    H = np.load(os.path.join(build_dir, 'holdout.npz'))
    y, p = H['y'], H['p']
    rng = np.random.default_rng(0)
    boots = []
    for _ in range(1000):
        i = rng.integers(0, len(y), len(y))
        if y[i].min() != y[i].max():
            boots.append(roc_auc_score(y[i], p[i]))
    auc = roc_auc_score(y, p)
    shares = [0.1, 0.2, 0.3, 0.5, 0.7]
    cap = capture(y, p, shares)
    curve_x = np.linspace(0, 1, 51)
    o = np.argsort(-p)
    cy = np.r_[0, np.cumsum(y[o])] / y.sum()
    curve = [float(cy[int(round(x * len(y)))]) for x in curve_x]
    q80, q50 = np.quantile(p, 0.8), np.quantile(p, 0.5)
    bands = []
    for name, lo, hi in [('P1', q80, 1.1), ('P2', q50, q80), ('P3', -1, q50)]:
        m = (p >= lo) & (p < hi)
        bands.append({'name': name, 'min_p': float(max(lo, 0)), 'rate': float(y[m].mean()), 'share': float(m.mean()),
                      'n': int(m.sum())})
    cal = {'sorted_p': [round(float(v), 6) for v in np.sort(p)], 'bands': bands}
    metrics = {
        'test_set': {'n_alerts': int(len(y)), 'n_escalated': int(y.sum()), 'base_rate': float(y.mean()),
                     'description': 'stratified random 20% of the labelled elimination-round alerts, held out from all training'},
        'auc': float(auc), 'auc_ci95': [float(np.quantile(boots, 0.025)), float(np.quantile(boots, 0.975))],
        'cv_auc_train80': float(roc_auc_score(H['ytr'], H['oof'])),
        'average_precision': float(average_precision_score(y, p)),
        'capture_at_share': cap, 'capture_curve': {'x': [float(v) for v in curve_x], 'y': curve},
        'bands': bands,
    }
    json.dump(metrics, open(os.path.join(art_dir, 'metrics.json'), 'w'), indent=1)
    json.dump(cal, open(os.path.join(art_dir, 'calibration.json'), 'w'))
    print(json.dumps({k: v for k, v in metrics.items() if k != 'capture_curve'}, indent=1))


if __name__ == '__main__':
    main(*sys.argv[1:3])
