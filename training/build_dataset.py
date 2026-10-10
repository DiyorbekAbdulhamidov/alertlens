"""Build the AlertLens training table from the elimination-round data (kept locally, never published).

Usage: python training/build_dataset.py <tx_all.parquet> <sig_all.parquet> <out_dir>
Writes: <out_dir>/tables.npz  (label-free detrending tables, shipped with the model)
        <out_dir>/features.parquet (one row per alert; stays local)
"""
import sys, os, time, json
import numpy as np
import pandas as pd
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
from core.features import extract, BURST_SEC

TYPE_MAP = {'bank_otkazmasi': 0, 'karta': 1, 'naqd': 2, 'xalqaro': 3}


def main(tx_path, sig_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    tx = pd.read_parquet(tx_path)
    sig = pd.read_parquet(sig_path)
    tx = tx.sort_values(['sid', 'tranzaksiya_vaqti'], kind='stable')
    t = tx['tranzaksiya_vaqti'].values.astype('datetime64[s]').astype(np.int64)
    is_in = (tx['kirim_chiqim'].astype(str).values == 'kirim').astype(np.int64)
    typ = tx['tranzaksiya_turi'].astype(str).map(TYPE_MAP).values.astype(np.int64)
    amt = tx['miqdor_indeksi'].values.astype(np.float64)
    sid = tx['sid'].values
    at = pd.Series(sig['signal_sanasi'].values.astype('datetime64[s]').astype(np.int64), index=sig['sid'].values)
    alert_t = at.reindex(sid).values
    age = (alert_t - t).astype(np.float64)
    td = typ * 2 + is_in
    burst = (age >= 0) & (age <= BURST_SEC)
    ab = np.clip(np.floor(age / 86400.0), -1, 180).astype(np.int64)
    ab = np.where(burst, -2, ab) + 2
    key = td * 183 + ab
    cnt = np.bincount(key, minlength=8 * 183)
    s1 = np.bincount(key, weights=amt, minlength=8 * 183)
    s2 = np.bincount(key, weights=amt ** 2, minlength=8 * 183)
    mu = s1 / np.maximum(cnt, 1)
    sd = np.sqrt(np.maximum(s2 / np.maximum(cnt, 1) - mu ** 2, 1e-4))
    # fill empty cells with the type/direction overall mean
    for k in range(8):
        m = td == k
        gm, gs = amt[m].mean(), amt[m].std()
        row = slice(k * 183, (k + 1) * 183)
        e = cnt[row] < 20
        mu[row][e] = gm
        sd[row][e] = gs
    mu = mu.reshape(8, 183)
    sd = sd.reshape(8, 183)
    res = (amt - mu[td, ab]) / sd[td, ab]
    # empirical-Bayes shrinkage constant per td: within-client variance / between-client variance of means
    eb_k = np.zeros(8)
    hist = age > BURST_SEC
    for k in range(8):
        m = (td == k) & hist
        df = pd.DataFrame({'s': sid[m], 'r': res[m]})
        g = df.groupby('s')['r']
        n = g.size()
        within = g.var().dropna()
        means = g.mean()[n >= 5]
        eb_k[k] = max(within.mean() / max(means.var() - within.mean() / n[n >= 5].mean(), 1e-3), 0.5)
    tables = {'mu': mu, 'sd': sd, 'eb_k': eb_k}
    np.savez(os.path.join(out_dir, 'tables.npz'), **tables)
    print('eb_k', np.round(eb_k, 2))

    bounds = np.flatnonzero(np.r_[True, sid[1:] != sid[:-1], True])
    rows, sids = [], []
    t0 = time.time()
    for i, (s, e) in enumerate(zip(bounds[:-1], bounds[1:])):
        rows.append(extract(t[s:e], is_in[s:e], typ[s:e], amt[s:e], int(alert_t[s]), tables))
        sids.append(sid[s])
        if i % 5000 == 0:
            print(i, round(time.time() - t0, 1), 's', flush=True)
    F = pd.DataFrame(rows, index=pd.Index(sids, name='sid')).astype(np.float32)
    meta = sig.set_index('sid')[['signal_id', 'eskalatsiya', 'is_test']]
    F = meta.join(F, how='left')
    F.to_parquet(os.path.join(out_dir, 'features.parquet'))
    print(F.shape, 'done in', round(time.time() - t0, 1), 's')


if __name__ == '__main__':
    main(*sys.argv[1:4])
