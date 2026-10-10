"""Fit AGGREGATE parameters for the synthetic alert generator (run locally on the elimination data).

Only population-level statistics are written (quantiles, means, covariances of per-client aggregates);
no individual record or client leaves the machine. Output: synth/params.json
Usage: python synth/fit_params.py <build_dir/features.parquet> <tx_all.parquet>
"""
import sys, os, json
import numpy as np
import pandas as pd
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from core.features import TD_NAMES, BLOCKS

QS = np.linspace(0, 1, 41)


def qv(s):
    s = pd.Series(s).dropna()
    return [float(v) for v in np.quantile(s, QS)]


def main(fpath, txpath):
    F = pd.read_parquet(fpath)
    P = {'quantile_grid': [float(q) for q in QS]}
    P['n_hist_q'] = qv(F['n_hist'])
    sh = np.stack([F[f'{td}_n'] / F['n_hist'].clip(lower=1) for td in TD_NAMES], 1)
    sh = np.nan_to_num(sh)
    m = sh.mean(0)
    v = sh.var(0)
    conc = float(np.median([(m[k] * (1 - m[k]) / v[k]) - 1 for k in range(8) if v[k] > 0 and m[k] > 0.02]))
    P['td_share_mean'] = [float(x) for x in m]
    P['td_share_conc'] = conc
    P['td_present_p'] = [float((F[f'{td}_n'] > 0).mean()) for td in TD_NAMES]
    M = F[[f'{td}_mean' for td in TD_NAMES]]
    cov = M.cov().values
    w, V = np.linalg.eigh(cov)
    cov = (V * np.clip(w, 1e-4, None)) @ V.T
    P['client_mean_mu'] = [float(x) for x in M.mean().values]
    P['client_mean_cov'] = [[float(x) for x in r] for r in cov]
    P['client_sd_q'] = [qv(F[f'{td}_std']) for td in TD_NAMES]
    P['n_burst_q'] = qv(F['n_burst'])
    P['burst_type_share'] = [float(F[f'burst_{t}_share'].mean()) for t in ['bank', 'card', 'cash', 'intl']]
    P['burst_in_share'] = float(F['burst_in_share'].mean())
    P['burst_amt_mean_q'] = qv(F['burst_amt_mean'])
    P['burst_amt_sd_med'] = float(F['burst_amt_std'].median())
    # floor-block markers: probability a client carries a block, and count quantiles when present
    blk = {}
    for name in BLOCKS:
        c = F[f'blk_{name}']
        blk[name] = {'p': float((c > 0).mean()), 'count_q': qv(c[c > 0]) if (c > 0).any() else [1.0] * len(QS)}
    P['blocks'] = blk
    hasS = (F[['blk_B', 'blk_D', 'blk_E', 'blk_F', 'blk_xS']] > 0).any(axis=1)
    hasN = (F[['blk_A', 'blk_C', 'blk_nA', 'blk_nB', 'blk_xN']] > 0).any(axis=1)
    P['marker_mix'] = {'S_only': float((hasS & ~hasN).mean()), 'N_only': float((hasN & ~hasS).mean()),
                       'none': float((~hasS & ~hasN).mean())}
    for g, mask in [('S', hasS & ~hasN), ('N', hasN & ~hasS)]:
        P[f'blocks_given_{g}'] = {name: float((F.loc[mask, f'blk_{name}'] > 0).mean()) for name in BLOCKS}
    tx = pd.read_parquet(txpath, columns=['tranzaksiya_vaqti'])
    h = tx['tranzaksiya_vaqti'].dt.hour.value_counts(normalize=True).sort_index()
    P['hour_profile'] = [float(h.get(i, 0.0)) for i in range(24)]
    out = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'params.json')
    json.dump(P, open(out, 'w'))
    print('written', out, 'conc', round(conc, 2), 'marker mix', P['marker_mix'])


if __name__ == '__main__':
    main(*sys.argv[1:3])
