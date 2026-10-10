"""Train the AlertLens models and export them for numpy-only inference.

Usage: python training/train.py <build_dir> <artifacts_dir>
1. Typology model (label-free): learns the hidden S/N client typology from clients that carry exclusive
   floor-block markers, using bulk amount statistics only (floor zones excluded). Cross-fitted.
2. Escalation model: LightGBM on all features + typology posterior. Trained on an 80% split of the labelled
   alerts; the remaining 20% is a held-out test set used for every number we report.
"""
import sys, os, json, time
import numpy as np
import pandas as pd
import lightgbm as lgb
from sklearn.model_selection import StratifiedKFold, train_test_split
from sklearn.metrics import roc_auc_score
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from core.features import posterior_typology

P_MAIN = dict(objective='binary', learning_rate=0.01, num_leaves=7, min_data_in_leaf=200, feature_fraction=0.3,
              bagging_fraction=0.8, bagging_freq=1, lambda_l2=20, verbose=-1, deterministic=True, force_col_wise=True,
              num_threads=2)
P_TYPO = dict(objective='binary', learning_rate=0.03, num_leaves=15, min_data_in_leaf=50, feature_fraction=0.5,
              bagging_fraction=0.8, bagging_freq=1, lambda_l2=10, verbose=-1, deterministic=True, force_col_wise=True,
              num_threads=2)
N_MAIN, N_TYPO = 500, 400
SEEDS = (0, 1, 2)
META = ['signal_id', 'eskalatsiya', 'is_test']


def typo_columns(cols):
    drop = lambda c: c.startswith('blk_') or c.endswith('_min') or c.endswith('_q10') or c.endswith('_h0')
    return [c for c in cols if c not in META and not drop(c)]


def marker_arrays(F):
    has_n = (F[['blk_A', 'blk_C', 'blk_nA', 'blk_nB', 'blk_xN']] > 0).any(axis=1).values
    has_sx = (F[['blk_E', 'blk_F', 'blk_xS']] > 0).any(axis=1).values
    has_sb = (F[['blk_B', 'blk_D']] > 0).any(axis=1).values
    return has_n, has_sx, has_sb


def train_typology(F):
    cols = typo_columns(F.columns)
    has_n, has_sx, has_sb = marker_arrays(F)
    lab = np.full(len(F), -1)
    lab[has_n & ~(has_sx | has_sb)] = 0
    lab[(has_sx | has_sb) & ~has_n] = 1
    L = np.flatnonzero(lab >= 0)
    U = np.flatnonzero(lab < 0)
    X = F[cols].values.astype(np.float32)
    pred = np.zeros(len(F))
    models = []
    for a, b in StratifiedKFold(5, shuffle=True, random_state=0).split(L, lab[L]):
        m = lgb.train(dict(P_TYPO, seed=0), lgb.Dataset(X[L[a]], lab[L[a]]), N_TYPO)
        pred[L[b]] = m.predict(X[L[b]])
        pred[U] += m.predict(X[U]) / 5
        models.append(m)
    print('typology model: marker alerts', len(L), 'share S', lab[L].mean().round(3),
          'OOF AUC on markers', round(roc_auc_score(lab[L], pred[L]), 4))
    post = np.array([posterior_typology(p, n, sx, sb) for p, n, sx, sb in zip(pred, has_n, has_sx, has_sb)])
    return cols, models, pred, post


def main(build_dir, art_dir):
    os.makedirs(art_dir, exist_ok=True)
    F = pd.read_parquet(os.path.join(build_dir, 'features.parquet'))
    tcols, tmodels, p_raw, p_post = train_typology(F)
    F['typology_p'] = p_post.astype(np.float32)
    feat_cols = [c for c in F.columns if c not in META]
    lab = F[F.is_test == 0]
    y = lab['eskalatsiya'].values
    idx_tr, idx_te = train_test_split(np.arange(len(lab)), test_size=0.2, stratify=y, random_state=2026)
    Xtr, ytr = lab[feat_cols].values[idx_tr], y[idx_tr]
    Xte, yte = lab[feat_cols].values[idx_te], y[idx_te]
    # CV on the training part (sanity)
    oof = np.zeros(len(ytr))
    for s in SEEDS:
        for a, b in StratifiedKFold(5, shuffle=True, random_state=s).split(Xtr, ytr):
            m = lgb.train(dict(P_MAIN, seed=s), lgb.Dataset(Xtr[a], ytr[a]), N_MAIN)
            oof[b] += m.predict(Xtr[b]) / len(SEEDS)
    cv_auc = roc_auc_score(ytr, oof)
    models = [lgb.train(dict(P_MAIN, seed=s), lgb.Dataset(Xtr, ytr), N_MAIN) for s in SEEDS]
    pte = np.mean([m.predict(Xte) for m in models], axis=0)
    te_auc = roc_auc_score(yte, pte)
    print(f'CV AUC (train 80%) {cv_auc:.4f} | HOLD-OUT AUC (20%, n={len(yte)}) {te_auc:.4f}')
    # export
    dump = {'main': [m.dump_model() for m in models], 'typo': [m.dump_model() for m in tmodels],
            'feat_cols': feat_cols, 'typo_cols': tcols}
    with open(os.path.join(build_dir, 'lgb_dump.json'), 'w') as fh:
        json.dump(dump, fh)
    np.savez(os.path.join(build_dir, 'holdout.npz'), y=yte, p=pte, oof=oof, ytr=ytr,
             sid_te=lab.index.values[idx_te], sid_tr=lab.index.values[idx_tr])
    # reference rows for parity tests and population medians (aggregates only)
    med = lab[feat_cols].iloc[idx_tr].median().to_dict()
    q = lab[feat_cols].iloc[idx_tr].quantile([0.1, 0.9])
    pop = {c: [float(med[c]) if pd.notna(med[c]) else None,
               float(q.loc[0.1, c]) if pd.notna(q.loc[0.1, c]) else None,
               float(q.loc[0.9, c]) if pd.notna(q.loc[0.9, c]) else None] for c in feat_cols}
    with open(os.path.join(art_dir, 'population.json'), 'w') as fh:
        json.dump(pop, fh)
    print('exported')


if __name__ == '__main__':
    main(*sys.argv[1:3])
