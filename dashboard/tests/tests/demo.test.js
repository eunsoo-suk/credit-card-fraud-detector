import { test } from "node:test";
import assert from "node:assert/strict";
import { createDemoSource, placeholderScore } from "../js/demo.js";

const NOW = Date.parse("2026-11-01T12:00:00Z");
const source = () => createDemoSource({ now: () => NOW });
const FEATURES = ["amount", "category", "merchant", "state", "city_population", "customer_lat",
  "customer_lon", "merchant_lat", "merchant_lon", "age_at_transaction", "hour", "weekday", "month"];

test("placeholder score matches lambdas/writer/scorer.py", () => {
  assert.equal(placeholderScore({ amount: 8.5, hour: 12, category: "travel" }), 0.02);
  assert.equal(placeholderScore({ amount: 1500, hour: 1, category: "shopping_net" }), 0.92);
  assert.equal(placeholderScore({ amount: 600, hour: 23, category: "grocery_pos" }), 0.77);
  assert.equal(placeholderScore({ amount: 250, hour: 12, category: "misc_net" }), 0.22);
});

test("recent items look like API items, newest first", async () => {
  const items = await source().recent(300);
  assert.equal(items.length, 300);
  for (const it of items) {
    assert.match(it.event_id, /^[0-9a-f-]{36}$/);
    assert.deepEqual(Object.keys(it.features).sort(), [...FEATURES].sort());
    assert.ok([0, 1].includes(it.ground_truth.is_fraud));
    assert.ok(["SCORED", "PENDING", "ERROR"].includes(it.status));
    if (it.status === "SCORED") assert.equal(it.predicted_fraud, it.fraud_score >= it.threshold);
  }
  const times = items.map((i) => Date.parse(i.emitted_at));
  assert.deepEqual(times, [...times].sort((a, b) => b - a));
  assert.ok(times[0] <= NOW);
});

test("demo data is deterministic for the same clock", async () => {
  const [a, b] = [await source().recent(50), await source().recent(50)];
  assert.deepEqual(a, b);
});

test("flagged returns only predicted fraud and lookups work", async () => {
  const s = source();
  const flagged = await s.flagged(40);
  assert.equal(flagged.length, 40);
  assert.ok(flagged.every((i) => i.predicted_fraud === true && i.flag_status === "FLAGGED"));
  assert.deepEqual(await s.transaction(flagged[3].event_id), flagged[3]);
  assert.equal(await s.transaction("ffffffff-ffff-ffff-ffff-ffffffffffff"), null);
});

test("demo metrics use the /metrics shape for every stage", async () => {
  const m = await source().metrics(3);
  assert.equal(m.period, 60);
  assert.deepEqual(Object.keys(m.stages).sort(),
    ["alerts", "api", "kinesis", "model", "producer", "table", "writer"]);
  const incoming = m.series["kinesis.incoming_records"];
  assert.equal(incoming.points.length, 180);
  assert.ok(incoming.points.every(([t, v]) => t >= m.start && t < m.end && v >= 0));
});

test("only https or local http API URLs are accepted", async () => {
  const { normalizeApiUrl } = await import("../js/api.js");
  assert.equal(normalizeApiUrl("https://abc.execute-api.us-east-1.amazonaws.com/"),
    "https://abc.execute-api.us-east-1.amazonaws.com");
  assert.equal(normalizeApiUrl("http://localhost:3000"), "http://localhost:3000");
  assert.equal(normalizeApiUrl("http://example.com"), null);
  assert.equal(normalizeApiUrl("javascript:alert(1)"), null);
  assert.equal(normalizeApiUrl("https://user:pw@example.com"), null);
  assert.equal(normalizeApiUrl("not a url"), null);
});

test("demo source timestamps stay inside the fraudTest.csv date range", async () => {
  for (const it of await source().recent(200)) {
    assert.ok(it.source_timestamp >= "2020-06-21" && it.source_timestamp < "2021-01-01", it.source_timestamp);
  }
});
