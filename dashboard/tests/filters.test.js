import { test } from "node:test";
import assert from "node:assert/strict";
import { filters, applyFilters } from "../js/filters.js";

const T0 = Date.parse("2026-11-01T12:00:00Z");
const tx = (o = {}) => ({
  event_id: "a3836b30-2a39-543c-a8af-baca7121e670", status: "SCORED", fraud_score: 0.3,
  emitted_at: new Date(T0).toISOString(), account_id: "f9cd960a82c1087546af0c24",
  ...o, features: { category: "shopping_net", state: "MD", hour: 2, merchant: "demo_merchant_7", ...o.features },
});

test("category filter matches the chart's humanized label, and Other means the rest", () => {
  const shown = ["shopping net", "grocery pos"];
  assert.ok(filters.category("shopping net", shown).test(tx()));
  const other = filters.category("Other", shown);
  assert.ok(other.test(tx({ features: { category: "travel" } })));
  assert.ok(!other.test(tx()));
  assert.match(other.label, /Other/);
});

test("state and hour filters", () => {
  assert.ok(filters.state("MD", ["MD"]).test(tx()));
  assert.ok(!filters.state("TX", ["TX"]).test(tx()));
  assert.ok(filters.hour(2).test(tx()));
  assert.ok(!filters.hour(3).test(tx()));
});

test("arrival filter covers exactly one bucket", () => {
  const f = filters.arrival(T0, 60);
  assert.ok(f.test(tx()));
  assert.ok(f.test(tx({ emitted_at: new Date(T0 + 59_999).toISOString() })));
  assert.ok(!f.test(tx({ emitted_at: new Date(T0 + 60_000).toISOString() })));
});

test("score filter includes 1.0 in the last bin and skips unscored items", () => {
  assert.ok(filters.score(0.95, 1).test(tx({ fraud_score: 1 })));
  assert.ok(!filters.score(0.25, 0.3).test(tx({ fraud_score: 0.3 })));
  assert.ok(!filters.score(0, 0.05).test(tx({ status: "PENDING", fraud_score: undefined })));
});

test("status filter", () => {
  assert.ok(filters.status("ERROR").test(tx({ status: "ERROR" })));
  assert.ok(!filters.status("ERROR").test(tx()));
});

test("text search looks at id, merchant, category, state and account, case-insensitively", () => {
  const items = [tx(), tx({ event_id: "ffff0000-0000-0000-0000-000000000000",
    features: { merchant: "Acme Grocers", category: "grocery_pos", state: "TX" } })];
  assert.equal(applyFilters(items, null, "acme").length, 1);
  assert.equal(applyFilters(items, null, "grocery pos").length, 1);
  assert.equal(applyFilters(items, null, "a3836b30").length, 1);
  assert.equal(applyFilters(items, null, "tx").length, 1);
  assert.equal(applyFilters(items, null, "  ").length, 2);
  assert.equal(applyFilters(items, filters.state("MD", ["MD"]), "demo").length, 1);
});

test("flagged() narrows any filter to predicted fraud, so a click lists exactly what the bar counted", () => {
  const f = filters.flagged(filters.hour(2));
  assert.ok(f.test(tx({ predicted_fraud: true })));
  assert.ok(!f.test(tx({ predicted_fraud: false })));
  assert.ok(!f.test(tx({ predicted_fraud: true, features: { hour: 5 } })));
  assert.match(f.label, /Hour 2.*flagged/);
  assert.equal(filters.flagged().label, "Flagged");
  assert.ok(filters.flagged().test(tx({ predicted_fraud: true })));
});
