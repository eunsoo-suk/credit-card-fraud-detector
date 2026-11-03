// Per-stage health for the pipeline diagram. CloudWatch (GET /metrics) is used when
// the stage is configured; otherwise status is inferred from the transactions the
// API returned, so the diagram still says something useful without metrics.

import { count, duration, percent, rate, ago } from "./format.js";

export const STAGES = [
  { key: "producer", name: "Producer", service: "EC2 replay" },
  { key: "kinesis", name: "Stream", service: "Kinesis Data Streams" },
  { key: "writer", name: "Scoring", service: "Lambda fraud-writer" },
  { key: "model", name: "Model", service: "SageMaker endpoint" },
  { key: "table", name: "Storage", service: "DynamoDB" },
  { key: "alerts", name: "Alerts", service: "SNS email" },
  { key: "api", name: "Read API", service: "API Gateway + Lambda" },
];

export const LIMITS = {
  RECENT_SECONDS: 900,      // status looks at the last 15 minutes of the window
  LAG_WARN_MS: 60_000,      // records waiting > 1 min to be read
  LAG_CRIT_MS: 300_000,     // > 5 min: scoring is falling behind
  ERROR_RATE_CRIT: 0.05,    // > 5% of Lambda / endpoint calls failing
  API_4XX_WARN: 0.05,
  CPU_WARN: 85,             // percent
  STALE_SECONDS: 300,       // no new transaction for 5 min
};

const RANK = { off: 0, good: 1, unknown: 2, warning: 3, critical: 4 };
const worst = (...statuses) => statuses.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), "good");
const result = (status, headline, detail = "") => ({ status, headline, detail });

function recent(metrics, key) {
  const series = metrics?.series?.[key];
  if (!series) return [];
  const from = Date.parse(metrics.end) - LIMITS.RECENT_SECONDS * 1000;
  return series.points.filter(([t]) => Date.parse(t) >= from).map(([, v]) => v);
}
const sum = (values) => values.reduce((a, b) => a + b, 0);
const max = (values) => (values.length ? Math.max(...values) : null);
const avg = (values) => (values.length ? sum(values) / values.length : null);
const has = (metrics, stage) => Boolean(metrics?.stages?.[stage]);

function lagStatus(ms) {
  if (ms == null) return "good";
  if (ms > LIMITS.LAG_CRIT_MS) return "critical";
  return ms > LIMITS.LAG_WARN_MS ? "warning" : "good";
}

function errorStatus(errors, calls) {
  if (!errors) return "good";
  return calls && errors / calls > LIMITS.ERROR_RATE_CRIT ? "critical" : "warning";
}

function freshness(summary) {
  if (summary?.arrivalAgeSec == null) return null;
  const stale = summary.arrivalAgeSec > LIMITS.STALE_SECONDS;
  return result(stale ? "warning" : "good", `newest ${ago(summary.arrivalAgeSec)}`,
    stale ? "No new transactions recently: is the producer running?" : "");
}

function producer(m, summary) {
  const fresh = freshness(summary);
  if (!has(m, "producer")) return fresh ?? result("unknown", "no data");
  const cpu = avg(recent(m, "producer.cpu"));
  if (cpu == null && !fresh) return result("unknown", "no data", "No CPU datapoints or transactions");
  const cpuStatus = cpu != null && cpu > LIMITS.CPU_WARN ? "warning" : "good";
  return result(worst(cpuStatus, fresh?.status ?? "good"), fresh?.headline ?? "running",
    cpu == null ? "No CPU datapoints yet" : `CPU ${cpu.toFixed(0)}%`);
}

function kinesis(m, summary) {
  if (!has(m, "kinesis")) return freshness(summary) ?? result("unknown", "no data");
  const incoming = recent(m, "kinesis.incoming_records");
  const seconds = LIMITS.RECENT_SECONDS; // CloudWatch omits empty periods; they still count as time
  const lag = max(recent(m, "kinesis.iterator_age"));
  const throttled = sum(recent(m, "kinesis.write_throttled")) + sum(recent(m, "kinesis.read_throttled"));
  const idle = sum(incoming) === 0;
  const status = worst(idle ? "warning" : "good", lagStatus(lag), throttled ? "warning" : "good");
  const detail = [idle ? "No records in 15 min" : null, `lag ${duration(lag)}`,
    throttled ? `${count(throttled)} throttled` : null].filter(Boolean).join(" · ");
  return result(status, rate(sum(incoming) / seconds), detail);
}

function writer(m, summary) {
  const itemErrors = summary?.errors ?? 0;
  const itemStatus = itemErrors ? "warning" : "good";
  const itemDetail = itemErrors ? `${count(itemErrors)} scoring errors in window` : "";
  if (!has(m, "writer")) {
    if (!summary) return result("unknown", "no data");
    return result(itemStatus, `${count(summary.scored)} scored`, itemDetail);
  }
  const calls = sum(recent(m, "writer.invocations"));
  const errors = sum(recent(m, "writer.errors"));
  const throttles = sum(recent(m, "writer.throttles"));
  const lag = max(recent(m, "writer.iterator_age"));
  const status = worst(errorStatus(errors, calls), lagStatus(lag), throttles ? "warning" : "good",
    itemStatus);
  const detail = [`${count(errors)} errors / ${count(calls)} calls`, `lag ${duration(lag)}`, itemDetail]
    .filter(Boolean).join(" · ");
  return result(status, `${duration(avg(recent(m, "writer.duration_avg")))} avg`, detail);
}

function model(m, summary) {
  if (has(m, "model")) {
    const calls = sum(recent(m, "model.invocations"));
    const e5 = sum(recent(m, "model.errors_5xx"));
    const e4 = sum(recent(m, "model.errors_4xx"));
    const latencyUs = avg(recent(m, "model.latency"));
    return result(worst(errorStatus(e5, calls), e4 ? "warning" : "good"),
      latencyUs == null ? "no calls" : `${duration(latencyUs / 1000)} latency`,
      `${count(calls)} calls · ${count(e4 + e5)} errors`);
  }
  const version = summary?.modelVersions?.[0]?.version;
  if (!version) return result("unknown", "no data");
  if (version.startsWith("placeholder")) {
    return result("off", "placeholder rules", "SageMaker not connected; scores are rule-based");
  }
  return result("good", version, "model_version on recent items");
}

function table(m, summary) {
  if (!has(m, "table")) return summary ? result("good", "reachable") : result("unknown", "no data");
  const throttles = sum(recent(m, "table.write_throttles")) + sum(recent(m, "table.read_throttles"));
  return result(throttles ? "warning" : "good",
    `${count(sum(recent(m, "table.write_units")))} WCU / 15 min`,
    throttles ? `${count(throttles)} throttle events` : `${count(sum(recent(m, "table.read_units")))} RCU / 15 min`);
}

function alerts(m, summary) {
  if (has(m, "alerts")) {
    const failed = sum(recent(m, "alerts.failed"));
    return result(failed ? "critical" : "good", `${count(sum(recent(m, "alerts.delivered")))} delivered`,
      failed ? `${count(failed)} failed deliveries` : `${count(sum(recent(m, "alerts.published")))} published`);
  }
  const notConfigured = result("off", "not configured", "Deploy with --alert-email to enable");
  if (m) return notConfigured; // metrics name every deployed stage, and there is no SNS topic
  if (!summary) return result("unknown", "no data");
  const { SENT, PENDING } = summary.alerts;
  if (SENT + PENDING === 0) return notConfigured;
  // record_score marks every flagged item PENDING even when SNS is not deployed, so
  // PENDING with nothing SENT cannot be told apart from "alerts disabled" here.
  if (SENT === 0) {
    return result("unknown", "not confirmed",
      `${count(PENDING)} flagged items pending; SNS may be off (needs --alert-email)`);
  }
  return result("good", `${count(SENT)} sent`, PENDING ? `${count(PENDING)} pending` : "");
}

function api(m, apiHealth) {
  if (apiHealth && !apiHealth.ok) return result("critical", "unreachable", apiHealth.error ?? "");
  if (!has(m, "api")) {
    return apiHealth ? result("good", duration(apiHealth.latencyMs), "GET /health") : result("unknown", "no data");
  }
  const requests = sum(recent(m, "api.requests"));
  const e5 = sum(recent(m, "api.errors_5xx"));
  const e4 = sum(recent(m, "api.errors_4xx"));
  const status = worst(errorStatus(e5, requests),
    requests && e4 / requests > LIMITS.API_4XX_WARN ? "warning" : "good");
  return result(status, `${duration(avg(recent(m, "api.latency")))} latency`,
    `${count(requests)} requests · ${percent(requests ? (e4 + e5) / requests : null)} errors`);
}

/**
 * Status for every stage in STAGES.
 * @param {{metrics: object|null, summary: object|null, apiHealth: {ok: boolean, latencyMs?: number, error?: string}|null}} input
 * @returns {Record<string, {status: string, headline: string, detail: string}>}
 */
export function stageHealth({ metrics, summary, apiHealth }) {
  return {
    producer: producer(metrics, summary),
    kinesis: kinesis(metrics, summary),
    writer: writer(metrics, summary),
    model: model(metrics, summary),
    table: table(metrics, summary),
    alerts: alerts(metrics, summary),
    api: api(metrics, apiHealth),
  };
}

/** Overall status: the worst stage, ignoring stages that are off. */
export function overall(health) {
  return worst(...Object.values(health).map((h) => h.status));
}

/** Stages that need attention, critical first, for the status panel. */
export function issues(health) {
  return STAGES
    .filter((s) => ["critical", "warning"].includes(health[s.key]?.status))
    .map((s) => ({ key: s.key, name: s.name, ...health[s.key] }))
    .sort((a, b) => RANK[b.status] - RANK[a.status]);
}
