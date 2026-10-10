"""Synthetic AML alerts for the public demo (numpy only).

Clients are sampled from AGGREGATE parameters (synth/params.json): quantiles and covariances of per-client
statistics, the day-of-history drift table and the floor-block marker rates. No real record is used or
reproduced. Synthetic alerts have no ground-truth label; model quality is reported only on real held-out data.
"""
import os, json
import numpy as np
from core.features import BLOCKS, FLOOR_CUT, BURST_SEC

HERE = os.path.dirname(os.path.abspath(__file__))
TYPES = ['bank', 'card', 'cash', 'intl']


class Generator:
    def __init__(self, tables, params_path=os.path.join(HERE, 'params.json')):
        self.P = json.load(open(params_path))
        self.mu = tables['mu']
        self.grid = np.array(self.P['quantile_grid'])

    def _q(self, qs, rng):
        return float(np.interp(rng.random(), self.grid, qs))

    def client(self, seed, typology=None, burst=None, n_hist=None, level_shift=0.0, alert_day=None):
        """typology: 'S', 'N', 'none' or None (random by population mix). burst: number of burst tx or None."""
        rng = np.random.default_rng(seed)
        P = self.P
        if typology is None:
            mix = P['marker_mix']
            w = np.array([mix['S_only'], mix['N_only'], mix['none']])
            typology = str(rng.choice(['S', 'N', 'none'], p=w / w.sum()))
        day0 = np.datetime64('2026-03-01') + int(rng.integers(0, 200)) if alert_day is None else np.datetime64(alert_day)
        alert_t = int(day0.astype('datetime64[s]').astype(np.int64))
        nh = int(round(self._q(P['n_hist_q'], rng))) if n_hist is None else int(n_hist)
        nh = max(nh, 5)
        shares = rng.dirichlet(np.array(P['td_share_mean']) * P['td_share_conc'] + 1e-3)
        counts = rng.multinomial(nh, shares)
        means = rng.multivariate_normal(P['client_mean_mu'], P['client_mean_cov']) + level_shift
        hp = np.array(P['hour_profile'])
        hp = hp / hp.sum()
        T, D, Y, A = [], [], [], []
        for td in range(8):
            c = counts[td]
            if c == 0:
                continue
            sd = max(self._q(P['client_sd_q'][td], rng), 0.05) if not np.isnan(P['client_sd_q'][td][0]) else 0.5
            days = rng.random(c) * 179.99 + 0.01
            hours = rng.choice(24, size=c, p=hp)
            t = alert_t - (np.floor(days) * 86400).astype(np.int64) - 86400 + hours * 3600 + rng.integers(0, 3600, c)
            t = np.minimum(t, alert_t - BURST_SEC - 1)
            age_d = np.clip(np.floor((alert_t - t) / 86400), 0, 180).astype(int)
            drift = self.mu[td, age_d + 2] - self.mu[td, 2:].mean()
            a = means[td] + drift + sd * rng.standard_normal(c)
            cut = FLOOR_CUT[td]
            a = np.where(a < cut, cut + (cut - a), a)        # reflect: no artificial floor-band mass
            a = np.minimum(a, 6.6)
            T.append(t); D.append(np.full(c, td % 2)); Y.append(np.full(c, td // 2)); A.append(a)
        # floor-block typology markers
        if typology in ('S', 'N'):
            probs = P[f'blocks_given_{typology}']
            names = [k for k, v in BLOCKS.items() if v[3] == typology]
            chosen = [k for k in names if rng.random() < probs[k]] or [max(names, key=lambda k: probs[k])]
            for k in chosen:
                td, lo, hi, _ = BLOCKS[k]
                c = max(1, int(round(self._q(P['blocks'][k]['count_q'], rng))))
                t = alert_t - BURST_SEC - 1 - rng.integers(0, 179 * 86400, c)
                T.append(t); D.append(np.full(c, td % 2)); Y.append(np.full(c, td // 2))
                A.append(lo + (hi - lo) * rng.random(c))
        # pre-alert burst
        nb = int(round(self._q(P['n_burst_q'], rng))) if burst is None else int(burst)
        if nb > 0:
            bt = rng.choice(4, size=nb, p=np.array(P['burst_type_share']) / sum(P['burst_type_share']))
            bd = (rng.random(nb) < P['burst_in_share']).astype(int)
            bm = self._q(P['burst_amt_mean_q'], rng)
            ba = bm + P['burst_amt_sd_med'] * rng.standard_normal(nb)
            for i in range(nb):
                cut = FLOOR_CUT[bt[i] * 2 + bd[i]]
                if ba[i] < cut:
                    ba[i] = cut + (cut - ba[i])
            T.append(alert_t - rng.integers(0, 180, nb)); D.append(bd); Y.append(bt); A.append(np.minimum(ba, 6.6))
        t = np.concatenate(T); d = np.concatenate(D); y = np.concatenate(Y); a = np.round(np.concatenate(A), 4)
        o = np.argsort(t, kind='stable')
        return {'alert_t': alert_t, 't': t[o].tolist(), 'is_in': d[o].astype(int).tolist(),
                'typ': y[o].astype(int).tolist(), 'amt': a[o].tolist(), 'generator': {
                    'seed': int(seed), 'typology': typology, 'burst': nb, 'n_hist': nh, 'level_shift': level_shift}}
