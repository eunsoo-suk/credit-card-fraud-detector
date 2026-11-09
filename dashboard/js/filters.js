import { clock, duration, label as humanize } from "./format.js";

const category = (item) => humanize(item.features?.category);
const stateOf = (item) => item.features?.state ?? "unknown";

function grouped(name, valueOf, key, shown) {
  if (key === "Other") {
    return { label: `${name}: Other`, test: (item) => !shown.includes(valueOf(item)) };
  }
  return { label: `${name}: ${key}`, test: (item) => valueOf(item) === key };
}

export const filters = {
  category: (key, shown) => grouped("Category", category, key, shown),
  state: (key, shown) => grouped("State", stateOf, key, shown),
  hour: (hour) => ({
    label: `Hour ${hour}:00–${hour}:59`,
    test: (item) => Number(item.features?.hour) === hour,
  }),
  arrival: (start, seconds) => ({
    label: `Arrived ${clock(start, seconds < 60)} + ${duration(seconds * 1000)}`,
    test: (item) => {
      const t = Date.parse(item.emitted_at);
      return t >= start && t < start + seconds * 1000;
    },
  }),
  score: (from, to) => ({
    label: `Score ${from.toFixed(2)}–${to.toFixed(2)}`,
    test: (item) => typeof item.fraud_score === "number" && item.fraud_score >= from
      && (item.fraud_score < to || (to >= 1 && item.fraud_score <= 1)),
  }),
  status: (status) => ({ label: `Status: ${status.toLowerCase()}`, test: (item) => item.status === status }),
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

export function applyFilters(items, filter, query = "") {
  const q = query.trim().toLowerCase();
  return items.filter((item) => (!filter || filter.test(item)) && (!q || matchesQuery(item, q)));
}
