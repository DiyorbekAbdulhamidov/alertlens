"""AlertLens feature extraction for ONE alert (numpy only).

The same function is used for training (looped over every alert) and in the live scoring API,
so there is no training/serving skew.

Input: the client's transactions before the alert
    t      : int64 seconds (epoch, naive local time)
    is_in  : 0 = outgoing (chiqim), 1 = incoming (kirim)
    typ    : 0 = bank transfer, 1 = card, 2 = cash, 3 = international
    amt    : amount index (normalised log-amount, as in the competition data)
    alert_t: int64 seconds of the alert
Output: dict feature_name -> float (NaN when undefined).
"""
import numpy as np

TYPES = ['bank', 'card', 'cash', 'intl']
DIRS = ['out', 'in']
TD_NAMES = [f'{TYPES[t]}_{DIRS[d]}' for t in range(4) for d in range(2)]   # td = typ*2 + is_in
BURST_SEC = 200
AMT_BINS = np.array([-np.inf, -1.5, -1.0, -0.5, 0.0, 0.5, 1.0, 1.5, 2.0, 3.0, np.inf])

# "Floor blocks": narrow amount bands at the bottom of a type/direction distribution.
# They are label-free markers of two hidden client typologies (found in our elimination-round analysis):
#   S-typology (~30% escalation) and N-typology (~10% escalation). They never co-occur in one client.
BLOCKS = {  # name: (td, lo, hi, typology)
    'A': (1, -2.917, -2.898, 'N'),   # bank in
    'B': (1, -2.898, -2.876, 'S'),   # bank in
    'C': (0, -2.842, -2.810, 'N'),   # bank out
    'D': (0, -2.810, -2.771, 'S'),   # bank out
    'E': (2, -2.272, -2.130, 'S'),   # card out
    'F': (3, -2.232, -2.194, 'S'),   # card in
    'nA': (4, -1.33, -1.21, 'N'),    # cash out
    'nB': (5, -1.27, -1.225, 'N'),   # cash in
    'xN': (7, -0.37, -0.265, 'N'),   # intl in
    'xS': (6, -0.60, -0.15, 'S'),    # intl out
}
# everything below these cut-offs is the "floor zone" (excluded from the typology model inputs)
FLOOR_CUT = {1: -2.876, 0: -2.771, 2: -1.94, 3: -2.02, 4: -1.20, 5: -1.22, 6: -0.14, 7: -0.26}
EB_PAIRS = [(0, 1), (0, 2), (0, 3), (0, 5), (1, 3), (1, 5), (2, 3), (3, 5), (0, 4), (1, 2)]


def _stats(x, prefix, out, full=True):
    n = len(x)
    out[prefix + 'n'] = float(n)
    if n == 0:
        keys = ['mean', 'std', 'min', 'max', 'med', 'q10', 'q90'] if full else ['mean', 'std', 'q25', 'med', 'q75']
        for k in keys:
            out[prefix + k] = np.nan
        return
    out[prefix + 'mean'] = float(x.mean())
    out[prefix + 'std'] = float(x.std(ddof=1)) if n > 1 else np.nan
    if full:
        q = np.quantile(x, [0.1, 0.5, 0.9])
        out[prefix + 'min'] = float(x.min())
        out[prefix + 'max'] = float(x.max())
        out[prefix + 'med'] = float(q[1])
        out[prefix + 'q10'] = float(q[0])
        out[prefix + 'q90'] = float(q[2])
    else:
        q = np.quantile(x, [0.25, 0.5, 0.75])
        out[prefix + 'q25'] = float(q[0])
        out[prefix + 'med'] = float(q[1])
        out[prefix + 'q75'] = float(q[2])


def extract(t, is_in, typ, amt, alert_t, tables):
    """tables: dict with 'mu' (8 x 183), 'sd' (8 x 183) day-of-history detrending tables and 'eb_k' (8,)."""
    t = np.asarray(t, dtype=np.int64)
    is_in = np.asarray(is_in, dtype=np.int64)
    typ = np.asarray(typ, dtype=np.int64)
    amt = np.asarray(amt, dtype=np.float64)
    o = np.argsort(t, kind='stable')
    t, is_in, typ, amt = t[o], is_in[o], typ[o], amt[o]
    td = typ * 2 + is_in
    age = (alert_t - t).astype(np.float64)                     # seconds before the alert
    burst = (age >= 0) & (age <= BURST_SEC)
    hist = age > BURST_SEC
    # age-detrended residual (z-score vs. all clients' same type/direction on the same day before the alert)
    ab = np.clip(np.floor(age / 86400.0), -1, 180).astype(np.int64)
    ab = np.where(burst, -2, ab) + 2
    res = (amt - tables['mu'][td, ab]) / tables['sd'][td, ab]

    f = {}
    f['n_all'] = float(len(t))
    f['n_hist'] = float(hist.sum())
    f['n_burst'] = float(burst.sum())
    th, ah, tdh, ih, rh = t[hist], amt[hist], td[hist], is_in[hist], res[hist]
    nh = len(th)
    if nh:
        f['span_days'] = float((alert_t - th.min()) / 86400.0)
        days = np.unique(th // 86400)
        f['active_days'] = float(len(days))
        f['tx_per_active_day'] = nh / len(days)
        gaps = np.diff(th) / 3600.0
        f['gap_max_h'] = float(gaps.max()) if len(gaps) else np.nan
        f['gap_med_h'] = float(np.median(gaps)) if len(gaps) else np.nan
        hour = (th // 3600) % 24
        dow = ((th // 86400) + 3) % 7
        f['in_share'] = float(ih.mean())
        f['night_share'] = float((hour < 6).mean())
        f['weekend_share'] = float((dow >= 5).mean())
        for k in range(4):
            f[f'{TYPES[k]}_share'] = float((tdh // 2 == k).mean())
        f['amt_mean'] = float(ah.mean())
        f['amt_std'] = float(ah.std(ddof=1)) if nh > 1 else np.nan
        f['res_mean'] = float(rh.mean())
        dd = (alert_t - th) / 86400.0
        for w in (7, 30):
            m = dd <= w
            f[f'w{w}_n'] = float(m.sum())
            f[f'w{w}_res_mean'] = float(rh[m].mean()) if m.any() else np.nan
        old = dd > 30
        f['drift_res'] = (f['w30_res_mean'] - float(rh[old].mean())) if (old.any() and (dd <= 30).any()) else np.nan
    else:
        for k in ['span_days', 'active_days', 'tx_per_active_day', 'gap_max_h', 'gap_med_h', 'in_share', 'night_share',
                  'weekend_share', 'amt_mean', 'amt_std', 'res_mean', 'w7_n', 'w7_res_mean', 'w30_n', 'w30_res_mean',
                  'drift_res'] + [f'{x}_share' for x in TYPES]:
            f[k] = np.nan

    # burst (the dense cluster of transactions in the last ~3 minutes before the alert)
    ab_ = amt[burst]
    f['burst_amt_mean'] = float(ab_.mean()) if len(ab_) else np.nan
    f['burst_amt_std'] = float(ab_.std(ddof=1)) if len(ab_) > 1 else np.nan
    f['burst_in_share'] = float(is_in[burst].mean()) if len(ab_) else np.nan
    f['burst_res_mean'] = float(res[burst].mean()) if len(ab_) else np.nan
    for k in range(4):
        f[f'burst_{TYPES[k]}_share'] = float((typ[burst] == k).mean()) if len(ab_) else np.nan

    # per type x direction (history)
    eb_mu = np.zeros(8)
    for k in range(8):
        m = tdh == k
        x = ah[m]
        p = TD_NAMES[k] + '_'
        _stats(x, p, f, full=True)
        r = rh[m]
        f[p + 'res_mean'] = float(r.mean()) if len(r) else np.nan
        f[p + 'res_std'] = float(r.std(ddof=1)) if len(r) > 1 else np.nan
        h = np.histogram(x, AMT_BINS)[0]
        for b in range(len(h)):
            f[p + f'h{b}'] = float(h[b] / len(x)) if len(x) else np.nan
        # empirical-Bayes shrunk client level: sum(res) / (n + k)
        eb_mu[k] = r.sum() / (len(r) + tables['eb_k'][k])
        f[p + 'eb_mu'] = float(eb_mu[k])
        f[p + 'eb_lsd'] = float(np.log((np.sum((r - r.mean()) ** 2) + 2.0) / (len(r) + 2.0))) if len(r) else 0.0
        # bulk stats above the floor zone (used by the typology model)
        xb = x[x >= FLOOR_CUT[k]]
        _stats(xb, 'a_' + p, f, full=False)
    for a, b in EB_PAIRS:
        f[f'eb_{TD_NAMES[a]}_minus_{TD_NAMES[b]}'] = float(eb_mu[a] - eb_mu[b])

    # floor-block typology markers (whole history incl. burst)
    pos = neg = 0
    for name, (k, lo, hi, cls) in BLOCKS.items():
        c = int(((td == k) & (amt >= lo) & (amt < hi)).sum())
        f['blk_' + name] = float(c)
        if cls == 'S':
            pos += c
        else:
            neg += c
    f['blk_S_n'] = float(pos)
    f['blk_N_n'] = float(neg)
    f['blk_balance'] = float(pos - neg)
    return f


def marker_groups(f):
    """Label-free typology evidence from floor blocks: returns (has_N, has_S_strong, has_S_bank)."""
    has_n = any(f['blk_' + k] > 0 for k in ('A', 'C', 'nA', 'nB', 'xN'))
    has_sx = any(f['blk_' + k] > 0 for k in ('E', 'F', 'xS'))
    has_sb = any(f['blk_' + k] > 0 for k in ('B', 'D'))
    return has_n, has_sx, has_sb


def posterior_typology(p_model, has_n, has_sx, has_sb):
    """Combine the typology model with exclusive floor markers (constants fixed a priori, no labels)."""
    p = p_model
    if has_n and not has_sx and not has_sb:
        return 0.02
    if has_sx and not has_n:
        return 0.98
    if has_sb and not has_n and not has_sx:
        return max(p, 0.9)
    return p
