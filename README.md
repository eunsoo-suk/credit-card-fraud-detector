# Dashboard

One page that shows the whole fraud pipeline: what is being flagged, and whether every
AWS stage is healthy.

```
EC2 producer -> Kinesis -> fraud-writer Lambda (-> SageMaker) -> DynamoDB -> read API -> this dashboard
                                   +-> SNS email alerts
```

Everything for the dashboard lives in this folder. It does not change any other file in
the repository, and it adds nothing to AWS.

## Run it

From the repository root, with the project's Python environment active:

```bash
# No AWS needed: synthetic data, clearly labeled DEMO DATA
python dashboard/serve.py --demo

# Live: after scripts/deploy_backend.py deploy (it writes .local/backend.json)
python dashboard/serve.py

# Live, with an explicit API URL (e.g. a teammate's shared backend)
python dashboard/serve.py --api https://ID.execute-api.us-east-1.amazonaws.com
```

It opens `http://127.0.0.1:8050/`. Other options: `--port`, `--region`,
`--sagemaker-endpoint fraud-detector-serverless` (also chart the model endpoint),
`--no-metrics`, `--no-browser`. On Windows PowerShell set `$env:AWS_PROFILE="fraud-team"`
first; on Mac/Linux `export AWS_PROFILE=fraud-team`.

## Where the data comes from

| Section | Source | Needs |
|---|---|---|
| Transactions, flags, scores, alerts, label check | Read API (`GET /transactions/recent`, `/transactions/flagged`, `/transactions/{id}`, `/health`) | The backend deployed by `scripts/deploy_backend.py` |
| Pipeline health charts, ingest rate, lag | CloudWatch, through `serve.py` at `/local/metrics` | Your AWS identity with `cloudwatch:GetMetricData` |

The browser never holds AWS credentials (see `docs/HANDOFF.md`). The read API is
public GET-only. CloudWatch is read by `serve.py` on your machine with your own
profile (the normal boto3 credential chain), and only `cloudwatch:GetMetricData`
is called. Resource names come from the files the deploy scripts already write:

- `.local/backend.json`: API URL and id, table, writer function, stream ARN, SNS topic
- `.local/outputs.json`: EC2 producer instance id

A stage whose resource is unknown is shown as not configured; it is not counted
as zero. Results are cached for 60 seconds, so auto-refresh (every 30 s) costs at
most about one GetMetricData call a minute (~26 metrics each).

## Look

A security-console style: graphite sidebar navigation, light workspace (dark mode
included), teal accent, and a status panel at the top of Overview that says in one
sentence whether the pipeline is healthy, what needs attention, and where to go. Every
box is plain (one gray border, no colored edges or shading); status is shown only by its
symbol and word. It is inspired by security-vendor consoles but uses no third-party logo,
name or font. Chart colors were checked with a colorblind-safety validator in both themes.

## Finding your way around

- **Sidebar** (a top bar on phones): Overview · Fraud activity · Transactions · Pipeline
  health. The current section is highlighted; overall status is next to the page title.
- **Click to drill down.** Every overview tile opens the transactions or chart behind it.
  Every bar in Fraud activity filters the transaction table to exactly the rows that bar
  counted, shown as a chip you can remove with ✕. Clicking a dot on the scatter opens that
  transaction.
- **Pipeline diagram:** each stage's “Metrics ↓” jumps to its CloudWatch charts. Each chart
  card is labeled with the stage it belongs to.
- **Search:** press `/` anywhere to search the loaded transactions by merchant, category,
  state or ID. Older transactions can be found by full event ID under the table.
- Status always shows an icon and a word (Healthy, Warning, Critical, No data, Off), with a
  key under the diagram. Light and dark mode follow your system, and ◐ switches them.

## What is on the page

1. **Overview**: flagged count (headline), transactions, ingest rate, time to score,
   alerts, scoring errors, plus a **pipeline diagram** with a status for each stage
   (healthy / warning / critical / no data / off; always an icon and a label).
2. **Fraud activity** (the latest N transactions, N = Sample): volume over time, score
   distribution against the threshold, flagged by category and by state, transactions by
   hour of day, amount vs score, label check (confusion matrix against the replay's
   `ground_truth`), processing and alert status, model version.
3. **Transactions**: flagged and recent tables, lookup by `event_id`, and a detail panel
   with every stored field.
4. **Pipeline health** (CloudWatch, 1–24 h): records into Kinesis, processing lag
   (iterator age), errors and throttles across all stages, Lambda invocations and
   duration, SageMaker latency and calls, DynamoDB capacity, SNS alerts, API requests
   and latency, producer CPU.

Status rules are in `js/health.js` (`LIMITS`): lag over 1 min is a warning and over
5 min is critical; any Lambda or model error is a warning and over 5% is critical; an
idle stream or no new transaction for 5 min is a warning; any SNS delivery failure or
API 5xx above 5% is critical.

The label check uses the replay labels in the current window only. It is for
monitoring, not model evaluation: enriched demo samples change fraud prevalence, and
the placeholder scorer is not a model (see `lambdas/README.md`).

## Static hosting (optional)

`index.html`, `config.js`, `css/` and `js/` are plain static files. To host them (for
example in an S3 website bucket), set `apiUrl` in `config.js`. Static hosting has no
CloudWatch charts, because those need `serve.py`. The page then infers stage status
from the transactions instead.

## Tests

```bash
python -m unittest discover -s dashboard/tests   # server, security checks, CloudWatch collector (18)
cd dashboard && npm test                          # analytics, health rules, filters, demo, URL checks (36)
```

The page needs a browser from 2024 or later (Chrome/Edge 123+, Firefox 120+, Safari 17.5+)
for CSS `light-dark()` theme colors.

The JavaScript tests use Node's built-in test runner (Node 18+); there are no npm
dependencies. Chart.js 4.4.1 is vendored in `js/vendor/` (MIT license included), so the
page works offline and its Content-Security-Policy allows scripts only from itself.

## Files

| File | Role |
|---|---|
| `serve.py` | Local server: static files, `config.js`, `/local/metrics`; 127.0.0.1 only, refuses cross-site requests and path tricks |
| `cloudwatch_metrics.py` | One GetMetricData query for every configured stage |
| `index.html`, `config.js`, `css/dashboard.css` | Page, default config, styles (light and dark) |
| `js/main.js` | Loads data, refreshes, navigation, transaction table and drawer |
| `js/activity.js`, `js/metrics-view.js` | Fraud activity charts; CloudWatch pipeline charts |
| `js/filters.js` | Drill-down filters and search (unit-tested) |
| `js/api.js`, `js/demo.js` | Live API client and synthetic demo source (same interface) |
| `js/analytics.js`, `js/health.js` | Pure aggregations and stage status rules (unit-tested) |
| `js/charts.js`, `js/views.js`, `js/format.js` | Chart.js wrappers, DOM views, formatting |
