"""Numpy-only gradient-boosted tree ensemble: prediction + per-feature contributions.

Models are trained with LightGBM (training/train.py) and exported to flat arrays (training/export.py),
so the scoring service needs nothing but numpy. Contributions use the path-attribution method
(each split's change in node value is credited to the split feature): they sum exactly to the raw score.
"""
import numpy as np


class TreeEnsemble:
    def __init__(self, arrays, prefix):
        g = lambda k: arrays[f'{prefix}_{k}']
        self.feat = g('feat')          # int32, -1 for leaves
        self.thr = g('thr')            # float64
        self.left = g('left')          # int32 (global node index)
        self.right = g('right')
        self.dleft = g('dleft').astype(bool)
        self.miss = g('miss')          # 0 None, 1 Zero, 2 NaN
        self.value = g('value')        # internal value (split) or leaf value
        self.roots = g('roots')        # int32, one per tree
        self.n_models = int(g('nmodels')[0])   # averaged ensembles (seeds / folds)
        self.expected = float(self.value[self.roots].sum() / self.n_models)

    def raw(self, X, contrib=False):
        X = np.asarray(X, dtype=np.float32).astype(np.float64)
        n, p = X.shape
        T = len(self.roots)
        node = np.tile(self.roots, (n, 1))                # (n, T)
        rows = np.repeat(np.arange(n)[:, None], T, axis=1)
        C = np.zeros((n, p)) if contrib else None
        while True:
            f = self.feat[node]
            active = f >= 0
            if not active.any():
                break
            fa = np.where(active, f, 0)
            x = X[rows, fa]
            miss = self.miss[node]
            isnan = np.isnan(x)
            x = np.where(isnan & (miss != 2), 0.0, x)
            use_default = ((miss == 1) & (np.abs(x) <= 1e-35)) | ((miss == 2) & isnan)
            go_left = np.where(use_default, self.dleft[node], x <= self.thr[node])
            child = np.where(go_left, self.left[node], self.right[node])
            child = np.where(active, child, node)
            if contrib:
                d = np.where(active, self.value[child] - self.value[node], 0.0)
                np.add.at(C, (rows[active], fa[active]), d[active])
            node = child
        raw = self.value[node].sum(axis=1) / self.n_models
        if contrib:
            C /= self.n_models
        return (raw, C) if contrib else raw


def sigmoid(z):
    return 1.0 / (1.0 + np.exp(-z))
