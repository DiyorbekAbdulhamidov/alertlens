"""Convert the competition files into the compact tables used by build_dataset.py.

Usage: python training/prepare_data.py <fintech_data_dir> <out_dir>
Input (not included in this repository, NDA): train_signals.csv, test_signals.csv,
train_transactions.parquet, test_transactions.parquet
Output: <out_dir>/sig_all.parquet, <out_dir>/tx_all.parquet
"""
import sys, os
import numpy as np
import pandas as pd


def main(src, out):
    os.makedirs(out, exist_ok=True)
    tr = pd.read_csv(os.path.join(src, 'train_signals.csv'), parse_dates=['signal_sanasi'])
    te = pd.read_csv(os.path.join(src, 'test_signals.csv'), parse_dates=['signal_sanasi'])
    sig = pd.concat([tr.assign(is_test=0), te.assign(eskalatsiya=-1, is_test=1)], ignore_index=True)
    sig['sid'] = sig['signal_id'].str.split('_').str[1].astype(np.int32)
    sig['eskalatsiya'] = sig['eskalatsiya'].astype(np.int64)
    sig.to_parquet(os.path.join(out, 'sig_all.parquet'))
    parts = []
    for f in ('train_transactions.parquet', 'test_transactions.parquet'):
        t = pd.read_parquet(os.path.join(src, f))
        t['sid'] = t['signal_id'].str.split('_').str[1].astype(np.int32)
        parts.append(t.drop(columns=['signal_id']))
    tx = pd.concat(parts, ignore_index=True)
    tx['kirim_chiqim'] = tx['kirim_chiqim'].astype('category')
    tx['tranzaksiya_turi'] = tx['tranzaksiya_turi'].astype('category')
    tx['miqdor_indeksi'] = tx['miqdor_indeksi'].astype(np.float32)
    tx[['tranzaksiya_vaqti', 'kirim_chiqim', 'tranzaksiya_turi', 'miqdor_indeksi', 'sid']].to_parquet(os.path.join(out, 'tx_all.parquet'))
    print(len(sig), 'signals,', len(tx), 'transactions')


if __name__ == '__main__':
    main(*sys.argv[1:3])
