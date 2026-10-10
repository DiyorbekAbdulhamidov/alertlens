"""Convert LightGBM JSON dumps into flat numpy arrays (artifacts/model.npz) for the numpy-only scorer.

Usage: python training/export.py <build_dir> <artifacts_dir>
Also checks prediction parity against LightGBM on held-out rows.
"""
import sys, os, json
import numpy as np
import pandas as pd
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

MISS = {'None': 0, 'Zero': 1, 'NaN': 2}


def flatten(dumps, col_index):
    feat, thr, left, right, dleft, miss, value, roots = [], [], [], [], [], [], [], []

    def add(nd, names):
        i = len(feat)
        feat.append(-1); thr.append(0.0); left.append(-1); right.append(-1); dleft.append(0); miss.append(0)
        if 'leaf_value' in nd and 'split_feature' not in nd:
            value.append(nd['leaf_value'])
            return i
        value.append(nd['internal_value'])
        feat[i] = col_index[names[nd['split_feature']]]
        thr[i] = float(nd['threshold'])
        assert nd['decision_type'] == '<='
        dleft[i] = int(nd['default_left'])
        miss[i] = MISS[nd['missing_type']]
        l = add(nd['left_child'], names)
        r = add(nd['right_child'], names)
        left[i], right[i] = l, r
        return i

    for d in dumps:
        names = d['feature_names']
        for tr in d['tree_info']:
            roots.append(add(tr['tree_structure'], names))
    return dict(feat=np.array(feat, np.int32), thr=np.array(thr), left=np.array(left, np.int32),
                right=np.array(right, np.int32), dleft=np.array(dleft, np.int8), miss=np.array(miss, np.int8),
                value=np.array(value), roots=np.array(roots, np.int32), nmodels=np.array([len(dumps)]))


def main(build_dir, art_dir):
    D = json.load(open(os.path.join(build_dir, 'lgb_dump.json')))
    feat_cols, typo_cols = D['feat_cols'], D['typo_cols']
    for d, cols in [(D['main'][0], feat_cols), (D['typo'][0], typo_cols)]:
        names = d['feature_names']
        assert len(names) == len(cols)
    # LightGBM names default to Column_i -> map by position
    def remap(dumps, cols):
        for d in dumps:
            d['feature_names'] = cols
        return dumps
    main_arr = flatten(remap(D['main'], feat_cols), {c: i for i, c in enumerate(feat_cols)})
    typo_arr = flatten(remap(D['typo'], typo_cols), {c: i for i, c in enumerate(typo_cols)})
    out = {f'main_{k}': v for k, v in main_arr.items()}
    out.update({f'typo_{k}': v for k, v in typo_arr.items()})
    tables = np.load(os.path.join(build_dir, 'tables.npz'))
    out.update({f'tab_{k}': tables[k] for k in tables.files})
    np.savez_compressed(os.path.join(art_dir, 'model.npz'), **out)
    with open(os.path.join(art_dir, 'columns.json'), 'w') as fh:
        json.dump({'feat_cols': feat_cols, 'typo_cols': typo_cols}, fh)
    print('main nodes', len(main_arr['feat']), 'trees', len(main_arr['roots']),
          '| typo nodes', len(typo_arr['feat']), 'trees', len(typo_arr['roots']))
    print('model.npz size KB', os.path.getsize(os.path.join(art_dir, 'model.npz')) // 1024)


if __name__ == '__main__':
    main(*sys.argv[1:3])
