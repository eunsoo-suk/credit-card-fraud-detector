import { test } from "node:test";
import assert from "node:assert/strict";
import { plural } from "../js/format.js";

test("plural picks the singular only for exactly one, and formats the count", () => {
  assert.equal(plural(1, "stage"), "1 stage");
  assert.equal(plural(0, "stage"), "0 stages");
  assert.equal(plural(3, "failed delivery", "failed deliveries"), "3 failed deliveries");
  assert.equal(plural(1, "failed delivery", "failed deliveries"), "1 failed delivery");
  assert.equal(plural(12_500, "call"), "12.5K calls");
});
