import * as A from "./analytics.js";
import * as charts from "./charts.js";
import * as fmt from "./format.js";

const { el } = fmt;
const STAGE_NAMES = { all: "All stages", producer: "Producer", kinesis: "Stream", writer: "Scoring",
  model: "Model", table: "Storage", alerts: "Alerts", api: "Read API" };

const METRIC_CHARTS = [
  { id: "m-errors", stage: "all", title: "Errors and throttles", sub: "Where the pipeline is failing, by stage",
    bars: true, stacked: true, wide: true, format: fmt.count, series: [
      { keys: ["writer.errors"], label: "Scoring errors", slot: 1 },
      { keys: ["model.errors_4xx", "model.errors_5xx"], label: "Model errors", slot: 2 },
      { keys: ["api.errors_5xx"], label: "API 5xx", slot: 3 },
      { keys: ["api.errors_4xx"], label: "API 4xx", slot: 4 },
      { keys: ["kinesis.write_throttled", "kinesis.read_throttled", "writer.throttles",
        "table.write_throttles", "table.read_throttles"], label: "Throttles", slot: 5 }] },
  { id: "m-cpu", stage: "producer", title: "Producer CPU", sub: "EC2 replay instance (5-minute datapoints)",
    format: (v) => `${Math.round(v)}%`, yMax: 100, series: [{ keys: ["producer.cpu"], label: "CPU", slot: 1 }] },
  { id: "m-incoming", stage: "kinesis", title: "Records into the stream", sub: "Kinesis IncomingRecords per period",
    bars: true, format: fmt.count, series: [{ keys: ["kinesis.incoming_records"], label: "Records", slot: 1 }] },
  { id: "m-lag", stage: "kinesis", title: "Processing lag", sub: "How far behind the readers are (max iterator age)",
    format: fmt.duration, series: [{ keys: ["kinesis.iterator_age"], label: "Stream (GetRecords)", slot: 1 },
      { keys: ["writer.iterator_age"], label: "Scoring Lambda", slot: 2 }] },
  { id: "m-invocations", stage: "writer", title: "Scoring Lambda invocations", sub: "fraud-writer batches per period",
    bars: true, format: fmt.count, series: [{ keys: ["writer.invocations"], label: "Invocations", slot: 1 }] },
  { id: "m-duration", stage: "writer", title: "Scoring Lambda duration", sub: "Per batch of up to 100 records",
    format: fmt.duration, series: [{ keys: ["writer.duration_avg"], label: "Average", slot: 1 },
      { keys: ["writer.duration_max"], label: "Maximum", slot: 2 }] },
  { id: "m-model", stage: "model", title: "Model latency", sub: "SageMaker ModelLatency (average)",
    format: fmt.duration, series: [{ keys: ["model.latency"], label: "Latency", slot: 1, scale: 1 / 1000 }] },
  { id: "m-model-calls", stage: "model", title: "Model invocations", sub: "SageMaker endpoint calls per period",
    bars: true, format: fmt.count, series: [{ keys: ["model.invocations"], label: "Invocations", slot: 1 }] },
  { id: "m-table", stage: "table", title: "DynamoDB capacity consumed", sub: "On-demand units per period",
    format: fmt.count, series: [{ keys: ["table.write_units"], label: "Write units", slot: 1 },
      { keys: ["table.read_units"], label: "Read units", slot: 2 }] },
  { id: "m-alerts", stage: "alerts", title: "Alert emails", sub: "SNS fraud-alerts topic",
    format: fmt.count, series: [{ keys: ["alerts.published"], label: "Published", slot: 1 },
      { keys: ["alerts.delivered"], label: "Delivered", slot: 2 }, { keys: ["alerts.failed"], label: "Failed", slot: 3 }] },
  { id: "m-api", stage: "api", title: "Read API requests", sub: "API Gateway requests per period",
    bars: true, format: fmt.count, series: [{ keys: ["api.requests"], label: "Requests", slot: 1 }] },
  { id: "m-api-latency", stage: "api", title: "Read API latency", sub: "API Gateway latency (average)",
    format: fmt.duration, series: [{ keys: ["api.latency"], label: "Latency", slot: 1 }] },
];

export function stageCardId(stage) {
  const chart = METRIC_CHARTS.find((c) => c.stage === stage);
  return chart ? `card-${chart.id}` : null;
}

export function buildMetricCards(root) {
  root.replaceChildren(...METRIC_CHARTS.map((c) => el("article",
    { class: `card${c.wide ? " span-2" : ""}`, id: `card-${c.id}`, "data-stage": c.stage, tabindex: "-1" },
    el("header", {},
      el("span", { class: "stage-tag" }, STAGE_NAMES[c.stage]),
      el("h3", {}, c.title), el("p", { class: "sub" }, c.sub)),
    el("div", { class: "chart", id: `${c.id}-wrap` }, el("canvas", { id: c.id, role: "img", "aria-label": c.title })),
    el("p", { class: "card-note", id: `${c.id}-note`, hidden: true }))));
}

function noteFor(chart, metrics, mode) {
  if (!metrics) {
    return mode === "live"
      ? "CloudWatch metrics are off. Open the page through python dashboard/serve.py with an AWS "
        + "profile allowed cloudwatch:GetMetricData (and without --no-metrics)."
      : "No metrics available.";
  }
  if (chart.stage !== "all" && !metrics.stages?.[chart.stage]) {
    return { model: "No SageMaker endpoint configured (serve.py --sagemaker-endpoint NAME).",
      alerts: "SNS alerts are not enabled for this backend (deploy with --alert-email).",
      producer: "Producer instance unknown (.local/outputs.json from scripts/manage.py deploy)." }[chart.stage]
      ?? "This stage is not configured.";
  }
  return null;
}

function datasetsFor(chart, metrics) {
  return chart.series.map((s) => {
    const aligned = s.keys.map((k) => A.alignSeries(metrics.series[k], metrics.start, metrics.end, metrics.period));
    const data = aligned[0].values.map((_, i) => {
      const parts = aligned.map((a) => a.values[i]).filter((v) => v != null);
      return parts.length ? parts.reduce((a, b) => a + b, 0) * (s.scale ?? 1) : null;
    });
    return { label: s.label, slot: s.slot, data };
  });
}

export function drawMetrics(sub, metrics, mode) {
  sub.textContent = metrics
    ? `CloudWatch, last ${metrics.hours} h at ${metrics.period / 60}-minute resolution. Gaps mean no datapoints.`
    : "CloudWatch metrics for every stage.";
  const labels = metrics ? A.alignSeries(undefined, metrics.start, metrics.end, metrics.period).labels
    .map((t) => fmt.clock(t)) : [];
  for (const chart of METRIC_CHARTS) {
    const note = noteFor(chart, metrics, mode);
    document.getElementById(`${chart.id}-wrap`).hidden = Boolean(note);
    const noteEl = document.getElementById(`${chart.id}-note`);
    noteEl.hidden = !note;
    noteEl.textContent = note ?? "";
    if (note) continue;
    const spec = { labels, datasets: datasetsFor(chart, metrics), stacked: chart.stacked,
      yFormat: chart.format, yMax: chart.yMax,
      tooltipLabel: (ctx) => ` ${ctx.dataset.label}: ${ctx.raw == null ? "no data" : chart.format(ctx.raw)}` };
    (chart.bars ? charts.bars : charts.lines)(chart.id, spec);
  }
}
