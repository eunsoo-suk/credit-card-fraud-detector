// Drill-down filters for the transaction table. Clicking a chart mark creates one of
// these ({label, test}); the table shows the label as a removable chip.

import { clock, duration, label as humanize } from "./format.js";

const category = (item) => humanize(item.features?.category);
const stateOf = (item) => item.features?.state ?? "unknown";

/** Matches `key`, or for the folded "Other" bar, anything not among `shown`. */
function grouped(name, valueOf, key, shown) {
  if (key === "Other") {
    return { label: `${name}: Other`, test: (item) => !shown.includes(valueOf(item)) };
  }
  return { label: `${name}: ${key}`, test: (item) => valueOf(item) === key };
}

export const filters = {
  /** @param {string} key humanized category or "Other" @param {string[]} shown keys on the chart */
  category: (key, shown) => grouped("Category", category, key, shown),
  state: (key, shown) => grouped("State", stateOf, key, shown),
  /** Source transaction hour 0-23. */
  hour: (hour) => ({
    label: `Hour ${hour}:00–${hour}:59`,
    test: (item) => Number(item.features?.hour) === hour,
  }),
  /** Arrived in [start, start + seconds). */
  arrival: (start, seconds) => ({
    label: `Arrived ${clock(start, seconds < 60)} + ${duration(seconds * 1000)}`,
    test: (item) => {
      const t = Date.parse(item.emitted_at);
      return t >= start && t < start + seconds * 1000;
    },
  }),
  /** Score in [from, to); the last bin also includes 1.0. */
  score: (from, to) => ({
    label: `Score ${from.toFixed(2)}–${to.toFixed(2)}`,
    test: (item) => typeof item.fraud_score === "number" && item.fraud_score >= from
      && (item.fraud_score < to || (to >= 1 && item.fraud_score <= 1)),
  }),
  status: (status) => ({ label: `Status: ${status.toLowerCase()}`, test: (item) => item.status === status }),
  /** Only predicted fraud, optionally within another filter (for the orange bars). */
  flagged: (inner = null) => ({
    label: inner ? `${inner.label} · flagged` : "Flagged",
    test: (item) => item.predicted_fraud === true && (!inner || inner.test(item)),
  }),
};

function matchesQuery(item, query) {
  const f = item.features ?? {};
  return [item.event_id, item.account_id, f.merchant, f.category, humanize(f.category), f.state]
    .some((value) => value != null && String(value).toLowerCase().includes(query));
}

/**
 * Items passing the chip filter and the free-text search (both optional).
 * @param {object[]} items
 * @param {{test: (item: object) => boolean}|null} filter
 * @param {string} [query]
 */
export function applyFilters(items, filter, query = "") {
  const q = query.trim().toLowerCase();
  return items.filter((item) => (!filter || filter.test(item)) && (!q || matchesQuery(item, q)));
}
