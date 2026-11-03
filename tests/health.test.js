import { test } from "node:test";
import assert from "node:assert/strict";
import { stageHealth, STAGES, overall } from "../js/health.js";

const END = "2026-11-01T12:00:00+00:00";
const START = "2026-11-01T11:00:00+00:00";

function series(stat, values) {
  const end = Date.parse(END);
  const points = values.map((v, i) => [new Date(end - (values.length - i) * 60_000).toISOString(), v]);
  return { stat, points };
}

function metrics(seriesByKey, stages) {
  return { start: START, end: END, period: 60, hours: 1, stages, series: seriesByKey };
}

const summary = {
  total: 100, scored: 100, errors: 0, pending: 0, flagged: 2, arrivalAgeSec: 3,
  alerts: { NONE: 98, PENDING: 0, SENT: 2 }, modelVersions: [{ version: "lgbm-v1", count: 100 }],
};
const apiHealth = { ok: true, latencyMs: 80 };

test("every stage gets a status", () => {
  const h = stageHealth({ metrics: null, summary, apiHealth });
  assert.deepEqual(Object.keys(h).sort(), STAGES.map((s) => s.key).sort());
  for (const stage of Object.values(h)) {
    assert.ok(["good", "warning", "critical", "unknown", "off"].includes(stage.status));
    assert.equal(typeof stage.headline, "string");
  }
});

test("stream lag over five minutes is critical", () => {
  const m = metrics({
    "kinesis.incoming_records": series("Sum", Array(15).fill(120)),
    "kinesis.iterator_age": series("Maximum", Array(15).fill(400_000)),
    "writer.iterator_age": series("Maximum", Array(15).fill(90_000)),
  }, { kinesis: "s", writer: "w" });
  const h = stageHealth({ metrics: m, summary, apiHealth });
  assert.equal(h.kinesis.status, "critical");
  assert.equal(h.writer.status, "warning");
  assert.match(h.kinesis.headline, /rec\/s/);
});

test("writer error rate drives warning then critical", () => {
  const some = metrics({
    "writer.invocations": series("Sum", Array(15).fill(100)),
    "writer.errors": series("Sum", [1, ...Array(14).fill(0)]),
  }, { writer: "w" });
  assert.equal(stageHealth({ metrics: some, summary, apiHealth }).writer.status, "warning");
  const many = metrics({
    "writer.invocations": series("Sum", Array(15).fill(10)),
    "writer.errors": series("Sum", Array(15).fill(2)),
  }, { writer: "w" });
  assert.equal(stageHealth({ metrics: many, summary, apiHealth }).writer.status, "critical");
});

test("failed SNS deliveries and API 5xx are critical", () => {
  const m = metrics({
    "alerts.published": series("Sum", Array(15).fill(1)),
    "alerts.failed": series("Sum", [0, 0, 1]),
    "api.requests": series("Sum", Array(15).fill(10)),
    "api.errors_5xx": series("Sum", Array(15).fill(1)),
  }, { alerts: "t", api: "a" });
  const h = stageHealth({ metrics: m, summary, apiHealth });
  assert.equal(h.alerts.status, "critical");
  assert.equal(h.api.status, "critical");
});

test("an idle stream is a warning, not healthy", () => {
  const m = metrics({ "kinesis.incoming_records": series("Sum", Array(15).fill(0)) },
    { kinesis: "s" });
  assert.equal(stageHealth({ metrics: m, summary, apiHealth }).kinesis.status, "warning");
});

test("without CloudWatch, status comes from the transactions themselves", () => {
  const stale = { ...summary, arrivalAgeSec: 900, errors: 3,
    modelVersions: [{ version: "placeholder-rules-v0", count: 100 }],
    alerts: { NONE: 100, PENDING: 0, SENT: 0 } };
  const h = stageHealth({ metrics: null, summary: stale, apiHealth });
  assert.equal(h.producer.status, "warning");
  assert.equal(h.writer.status, "warning");
  assert.equal(h.model.status, "off");
  assert.match(h.model.headline, /placeholder/i);
  assert.equal(h.alerts.status, "off");
  assert.equal(h.table.status, "good");
});

test("an unreachable API is critical and data stages are unknown", () => {
  const h = stageHealth({ metrics: null, summary: null, apiHealth: { ok: false } });
  assert.equal(h.api.status, "critical");
  assert.equal(h.table.status, "unknown");
});

test("briefly pending alerts are normal", () => {
  const busy = { ...summary, alerts: { NONE: 90, PENDING: 3, SENT: 7 } };
  assert.equal(stageHealth({ metrics: null, summary: busy, apiHealth }).alerts.status, "good");
});

// record_score marks every flagged item PENDING even when SNS is not deployed
// (db/repository.py), so PENDING with nothing SENT is the normal no-SNS state.
test("without SNS, flagged items stay PENDING: off with metrics, unknown without", () => {
  const noSns = { ...summary, alerts: { NONE: 90, PENDING: 4, SENT: 0 } };
  const m = metrics({ "kinesis.incoming_records": series("Sum", Array(15).fill(60)) }, { kinesis: "s" });
  assert.equal(stageHealth({ metrics: m, summary: noSns, apiHealth }).alerts.status, "off");
  const h = stageHealth({ metrics: null, summary: noSns, apiHealth });
  assert.equal(h.alerts.status, "unknown");
  assert.notEqual(overall(h), "warning");
});

test("stream rate counts missing CloudWatch periods as zero", () => {
  const m = metrics({ "kinesis.incoming_records": series("Sum", [30]) }, { kinesis: "s" });
  assert.match(stageHealth({ metrics: m, summary, apiHealth }).kinesis.headline, /^0\.0 rec\/s/);
});

test("a producer with no CPU datapoints and no transactions is unknown, not healthy", () => {
  const m = metrics({}, { producer: "i-1" });
  assert.equal(stageHealth({ metrics: m, summary: null, apiHealth }).producer.status, "unknown");
});

test("issues lists critical stages first, then warnings, skipping healthy, off and no-data", async () => {
  const { issues } = await import("../js/health.js");
  const h = {
    producer: { status: "good", headline: "", detail: "" },
    kinesis: { status: "warning", headline: "0.0 rec/s", detail: "No records in 15 min" },
    writer: { status: "critical", headline: "160 ms avg", detail: "12 errors / 40 calls" },
    model: { status: "off", headline: "placeholder rules", detail: "" },
    table: { status: "unknown", headline: "no data", detail: "" },
    alerts: { status: "good", headline: "", detail: "" },
    api: { status: "good", headline: "", detail: "" },
  };
  const list = issues(h);
  assert.deepEqual(list.map((i) => [i.key, i.status]), [["writer", "critical"], ["kinesis", "warning"]]);
  assert.equal(list[0].name, "Scoring");
  assert.equal(list[0].detail, "12 errors / 40 calls");
  assert.deepEqual(issues({ ...h, kinesis: h.producer, writer: h.producer }), []);
});
