import { test } from "node:test";
import assert from "node:assert/strict";
import {
  summarize, labelCheck, volumeSeries, scoreHistogram, groupBy, hourProfile,
  scatterPoints, alignSeries,
} from "../js/analytics.js";

const T0 = Date.parse("2026-11-01T12:00:00Z");

function item(overrides = {}) {
  const { features, ...rest } = overrides;
  return {
    event_id: "00000000-0000-0000-0000-000000000000",
    emitted_at: new Date(T0).toISOString(),
    status: "SCORED",
    alert_status: "NONE",
    fraud_score: 0.1,
    predicted_fraud: false,
    threshold: 0.5,
    model_version: "placeholder-rules-v0",
    scored_at: new Date(T0 + 2000).toISOString(),
    features: { amount: 10, category: "grocery_pos", state: "MD", hour: 12, ...features },
    ground_truth: { is_fraud: 0 },
    ...rest,
  };
}

const flaggedItem = (o = {}) => item({
  fraud_score: 0.9, predicted_fraud: true, alert_status: "SENT", ...o,
});

test("summarize counts statuses, flags, alerts and latency", () => {
  const items = [
    item(), item({ status: "PENDING", fraud_score: undefined, predicted_fraud: undefined }),
    item({ status: "ERROR" }), flaggedItem({ features: { amount: 900 } }),
    flaggedItem({ alert_status: "PENDING", scored_at: new Date(T0 + 4000).toISOString() }),
  ];
  const s = summarize(items, T0 + 60_000);
  assert.equal(s.total, 5);
  assert.equal(s.scored, 3);
  assert.equal(s.pending, 1);
  assert.equal(s.errors, 1);
  assert.equal(s.flagged, 2);
  assert.equal(s.flagRate, 2 / 3);
  assert.deepEqual(s.alerts, { NONE: 3, PENDING: 1, SENT: 1 });
  assert.equal(s.flaggedAmount, 910);
  assert.equal(s.arrivalAgeSec, 60);
  assert.equal(s.medianScoringSec, 2);
  assert.equal(s.threshold, 0.5);
  assert.deepEqual(s.modelVersions, [{ version: "placeholder-rules-v0", count: 3 }]);
});

test("summarize of nothing is all zeros and nulls, never NaN", () => {
  const s = summarize([], T0);
  assert.equal(s.total, 0);
  assert.equal(s.flagRate, null);
  assert.equal(s.avgScore, null);
  assert.equal(s.arrivalAgeSec, null);
});

test("labelCheck builds a confusion matrix from replay labels", () => {
  const items = [
    flaggedItem({ ground_truth: { is_fraud: 1 } }),
    flaggedItem(),
    item({ ground_truth: { is_fraud: 1 } }),
    item(), item(),
    item({ status: "PENDING", predicted_fraud: undefined }),
  ];
  const c = labelCheck(items);
  assert.deepEqual([c.tp, c.fp, c.fn, c.tn, c.labeled], [1, 1, 1, 2, 5]);
  assert.equal(c.precision, 0.5);
  assert.equal(c.recall, 0.5);
  assert.equal(labelCheck([item()]).precision, null);
});

test("volumeSeries fills empty buckets and picks a readable bucket size", () => {
  const items = [
    item({ emitted_at: new Date(T0).toISOString() }),
    flaggedItem({ emitted_at: new Date(T0 + 1000).toISOString() }),
    item({ emitted_at: new Date(T0 + 30 * 60_000).toISOString() }),
  ];
  const v = volumeSeries(items, 40);
  assert.equal(v.bucketSeconds, 60);
  assert.equal(v.buckets.length, 31);
  assert.deepEqual(v.buckets[0], { t: T0, total: 2, flagged: 1 });
  assert.equal(v.buckets[15].total, 0);
  assert.equal(volumeSeries([]).buckets.length, 0);
});

test("scoreHistogram splits each bin at the threshold", () => {
  const items = [item({ fraud_score: 0.02 }), item({ fraud_score: 0.49 }),
    flaggedItem({ fraud_score: 0.5 }), flaggedItem({ fraud_score: 1 })];
  const h = scoreHistogram(items, 10, 0.5);
  assert.equal(h.bins.length, 10);
  assert.equal(h.bins[0].below, 1);
  assert.equal(h.bins[4].below, 1);
  assert.equal(h.bins[5].above, 1);
  assert.equal(h.bins[9].above, 1); // score 1.0 lands in the last bin
});

test("groupBy ranks by flagged count and folds the tail into Other", () => {
  const items = [
    flaggedItem({ features: { category: "shopping_net" } }),
    flaggedItem({ features: { category: "shopping_net" } }),
    flaggedItem({ features: { category: "misc_net" } }),
    item({ features: { category: "grocery_pos" } }),
    item({ features: { category: "travel" } }),
  ];
  const groups = groupBy(items, (i) => i.features.category, 2);
  assert.deepEqual(groups.map((g) => g.key), ["shopping_net", "misc_net", "Other"]);
  assert.deepEqual(groups[0], { key: "shopping_net", total: 2, flagged: 2, rate: 1 });
  assert.equal(groups[2].total, 2);
});

test("hourProfile always has 24 hours", () => {
  const p = hourProfile([flaggedItem({ features: { hour: 23 } }), item({ features: { hour: 23 } })]);
  assert.equal(p.length, 24);
  assert.deepEqual(p[23], { hour: 23, total: 2, flagged: 1, rate: 0.5 });
  assert.equal(p[0].rate, null);
});

test("scatterPoints separates flagged and caps the sample", () => {
  const items = Array.from({ length: 50 }, (_, i) => (i % 5 ? item() : flaggedItem()));
  const s = scatterPoints(items, 20);
  assert.equal(s.flagged.length + s.other.length, 20);
  assert.ok(s.flagged.every((p) => p.y >= 0.5));
});

test("alignSeries fills gaps with 0 for sums and null otherwise", () => {
  const start = "2026-11-01T12:00:00+00:00";
  const end = "2026-11-01T12:03:00+00:00";
  const sum = { stat: "Sum", points: [["2026-11-01T12:01:00+00:00", 4]] };
  const avg = { stat: "Average", points: [["2026-11-01T12:01:00+00:00", 4]] };
  assert.deepEqual(alignSeries(sum, start, end, 60).values, [0, 4, 0]);
  assert.deepEqual(alignSeries(avg, start, end, 60).values, [null, 4, null]);
  assert.equal(alignSeries(undefined, start, end, 60).values.length, 3);
});

test("arrivalRate is transactions per second across the window", async () => {
  const { arrivalRate } = await import("../js/analytics.js");
  const items = Array.from({ length: 11 }, (_, k) => item({ emitted_at: new Date(T0 + k * 500).toISOString() }));
  assert.equal(arrivalRate(items), 2);
  assert.equal(arrivalRate([item()]), null);
});
