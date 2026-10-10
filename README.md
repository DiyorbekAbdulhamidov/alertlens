# AlertLens — AML alert triage copilot

**Mode: Partner product.** Owner: the bank's **Financial Monitoring (AML/compliance) unit**. Process it changes: the daily review of transaction-monitoring alerts.

Team **WWWPRO** (Cyber University of Uzbekistan) · WIUT Hackathon 2026 Final, FinTech / AI in Finance track.

## The problem

Transaction monitoring produces far more alerts than officers can review carefully. Most of them are dismissed (83% in the competition data), but they are reviewed in arrival order, so the alerts that really need escalation wait in the same queue as everything else.

## What AlertLens does

1. **Ranks the queue** by escalation risk and assigns bands P1 / P2 / P3 (thresholds fixed on a held-out test set).
2. **Explains every score**: per-feature path attributions from the tree model (they add up exactly to the score), grouped into business reasons with the client's measured values next to the peer median.
3. **Drafts the case memo** in English, Uzbek and Russian from those reasons. It is deterministic, with no LLM in the decision path.
4. **Keeps the human in the loop**: the officer escalates, dismisses or requests information, and every decision gets a SHA-256 receipt chained to the previous one (tamper-evident audit log).
5. **What-if and jury input**: re-score live after removing the pre-alert burst, adding micro-amount transfers or shifting amounts, or upload any CSV of transactions.

## Results (held-out test set: 2,800 competition alerts, never used for training)

| metric | value |
|---|---|
| ROC-AUC | **0.666** (95% bootstrap CI 0.639–0.692); 5-fold CV on the training part 0.660 |
| escalations reached in the top 20% / 50% of the queue | **36% / 72%** (arrival order: 20% / 50%) |
| escalation rate P1 / P2 / P3 | **31.1% / 20.4% / 9.7%** |
| average queue position of a true escalation | 36% of the queue vs 50% in arrival order (−28% waiting) |
| typology model, recovering the hidden client group (label-free, CV) | AUC 0.927 |
| scoring time | ≈6 ms per alert on one CPU core, including feature extraction from ~500 transactions |

The full numbers are in `artifacts/metrics.json` and on the **Model card** page of the app.

## How it works

```
alert + 180-day transactions
   → core/features.py   ≈280 features: pre-alert burst, per-channel levels de-trended by day before the alert,
                        empirical-Bayes client profile, floor-band typology markers
   → typology model     label-free S/N client typology (LightGBM, 5×400 trees) + exclusive markers
   → risk model         LightGBM 3 seeds × 500 trees (num_leaves 7), exported to numpy arrays
   → core/reasons.py    path attributions → reasons → memo (EN/UZ/RU)
   → officer UI         queue, detail, decision, audit receipt
```

**Our edge: the hidden typology.** Amount distributions have narrow "floor bands" whose position differs between two hidden client groups, S (≈30% escalated) and N (≈10%). The bands never co-occur in one client, so they act as label-free markers. A second model learns the typology from the bulk behaviour of marker clients and extends it to all clients. We found this structure in the elimination round; it does not come out of general-purpose LLM tooling.

**Inside the bank's perimeter.** The scoring service needs only numpy: no external API, no GPU, no internet. Training runs offline on the bank's own labelled alert history; only model files are deployed. The public demo runs the same code on Vercel with synthetic alerts.

## Repository

```
api/            Vercel entry points (one per route) → server/app.py
server/app.py   HTTP API: /api/queue, /api/alert, /api/score, /api/generate, /api/metrics, /api/receipt, /api/health
core/           features.py, model.py (numpy tree inference + attributions), reasons.py, scorer.py
synth/          synthetic alert generator + aggregate parameters (params.json)
artifacts/      model.npz (exported trees + de-trending tables), metrics, calibration, population medians
training/       prepare_data.py → build_dataset.py → train.py → export.py → evaluate.py (needs the NDA data)
index.html, assets/   officer web app (vanilla JS + Chart.js)
dev_server.py   local server: static files + the same API handler
```

## Run locally

```bash
pip install -r requirements.txt          # numpy only
python dev_server.py 8000                # open http://localhost:8000
```

Score your own alert:

```bash
curl -X POST localhost:8000/api/score -H 'Content-Type: application/json' -d '{
  "alert_time": "2026-05-10T00:00:00",
  "transactions": [
    {"time": "2026-05-01T10:00:00", "direction": "in",  "type": "bank", "amount_index": 0.42},
    {"time": "2026-05-02T11:30:00", "direction": "out", "type": "card", "amount_index": -0.31}
  ]}'
```

`direction`: `in` | `out`. `type`: `bank` | `card` | `cash` | `intl`. `amount_index`: normalised log-amount, on the same scale as the monitoring feed. CSV with header `time,direction,type,amount_index` is accepted too.

## Deployment

- **Public demo:** Vercel. Static front-end on the CDN and the Python API as serverless functions in region `fra1` (Frankfurt), deployed automatically from this repository on every push to `master`; Vercel keeps the deployment history.
- **Bank (production design):** the same code in one Docker container (`Dockerfile`) on a server or Kubernetes cluster inside the bank's network. numpy only, no outbound internet, no paid API. Officers sign in through the bank's SSO (Active Directory). The roles are officer, supervisor and auditor, and every action is logged with the user ID in an append-only table. Model files are versioned, and retraining runs offline on the bank's labelled alert history.

```bash
docker build -t alertlens .
docker run -p 8000:8000 alertlens     # http://<server>:8000
```

## Retrain (requires the competition data, which is not included)

```bash
pip install -r requirements-train.txt
python training/prepare_data.py <fintech_data_dir> <work_dir>
python training/build_dataset.py <work_dir>/tx_all.parquet <work_dir>/sig_all.parquet <build_dir>
python training/train.py <build_dir> artifacts
python training/export.py <build_dir> artifacts
python training/evaluate.py <build_dir> artifacts
python synth/fit_params.py <build_dir>/features.parquet <work_dir>/tx_all.parquet
```

Deterministic: the split uses seed 2026 and LightGBM runs with `deterministic=True`.

## What was built in the Final and what was reused

- **Written during the Final (10–11 Oct 2026):** all code in this repository: the single-alert feature pipeline, numpy inference with attributions, typology posterior integration, reasons and memo generator, API, synthetic generator, officer web app, audit receipts, evaluation, ROI calculator.
- **Reused from our elimination-round work (submitted 27 Sep 2026), declared here:** the analytical findings (floor-band typology markers and their band limits, pre-alert burst, day-de-trended amounts, empirical-Bayes client profile) and the LightGBM hyper-parameters. The typology-posterior constants (0.02 / 0.98 / 0.9) were fixed a priori in that work.
- Tools: an AI coding assistant (Claude) helped write the code; every number reported here was produced by the scripts in `training/`.

## Data sources and licences

| source | use | licence / terms |
|---|---|---|
| WIUT Hackathon 2026 elimination-round dataset (20,000 alerts, ≈10M transactions; per the organisers synthetic, transformed and localised, no real customer records) | training and held-out evaluation | competition terms and NDA. Not redistributed; only trained model files and aggregate statistics are published |
| Synthetic alerts (`synth/generate.py`, `synth/params.json`) | public demo | our own; generated from aggregate statistics (quantiles, covariances, marker rates), no individual records |
| numpy | inference | BSD-3-Clause |
| LightGBM, scikit-learn, pandas, pyarrow | training only | MIT, BSD-3-Clause, BSD-3-Clause, Apache-2.0 |
| Chart.js (CDN) | charts in the UI | MIT |

No real personal or confidential bank data is used in the demo.

## Limitations

- Escalation labels are noisy; even perfect knowledge of the typology gives AUC ≈ 0.66. AlertLens **prioritises** alerts and must not auto-close them.
- Clients with short histories get weak profiles (typology "unclear").
- Floor bands depend on the current monitoring rules and data feed. Marker rates and AUC should be monitored monthly and the model retrained after rule changes.
- The demo audit log lives in the browser; in production it is an append-only table in the bank's database.

## Licence

MIT. See `LICENSE`.
