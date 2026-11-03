// Pure aggregations over API items (item shape: db/repository.py).

const DEFAULT_THRESHOLD = 0.5;
const BUCKET_STEPS = [10, 30, 60, 300, 900, 1800, 3600, 21600]; // seconds

const isScored = (i) => i.status === "SCORED" && typeof i.fraud_score === "number";
const isFlagged = (i) => i.predicted_fraud === true;
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const ratio = (a, b) => (b ? a / b : null);

export function summarize(items, now = Date.now()) {
  const scored = items.filter(isScored);
  const flagged = items.filter(isFlagged);
  const alerts = { NONE: 0, PENDING: 0, SENT: 0 };
  const versions = new Map();
  for (const it of items) {
    if (it.alert_status in alerts) alerts[it.alert_status] += 1;
    if (isScored(it) && it.model_version) versions.set(it.model_version, (versions.get(it.model_version) ?? 0) + 1);
  }
  const emitted = items.map((i) => Date.parse(i.emitted_at)).filter(Number.isFinite);
  const newest = emitted.length ? Math.max(...emitted) : null;
  const latencies = scored
    .map((i) => (Date.parse(i.scored_at) - Date.parse(i.emitted_at)) / 1000)
    .filter((s) => Number.isFinite(s) && s >= 0);
  const amountOf = (list) => list.reduce((sum, i) => sum + (Number(i.features?.amount) || 0), 0);
  return {
    total: items.length,
    scored: scored.length,
    pending: items.filter((i) => i.status === "PENDING").length,
    errors: items.filter((i) => i.status === "ERROR").length,
    flagged: flagged.length,
    flagRate: ratio(flagged.length, scored.length),
    alerts,
    avgScore: scored.length ? scored.reduce((s, i) => s + i.fraud_score, 0) / scored.length : null,
    totalAmount: amountOf(items),
    flaggedAmount: amountOf(flagged),
    newestAt: newest,
    arrivalAgeSec: newest == null ? null : Math.max(0, (now - newest) / 1000),
    medianScoringSec: median(latencies),
    threshold: scored.find((i) => typeof i.threshold === "number")?.threshold ?? DEFAULT_THRESHOLD,
    modelVersions: [...versions].map(([version, n]) => ({ version, count: n }))
      .sort((a, b) => b.count - a.count),
  };
}

/** Predictions vs the replay's ground-truth labels (monitoring only, not model evaluation). */
export function labelCheck(items) {
  const c = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const it of items.filter(isScored)) {
    const actual = it.ground_truth?.is_fraud === 1;
    const predicted = isFlagged(it);
    if (predicted && actual) c.tp += 1;
    else if (predicted) c.fp += 1;
    else if (actual) c.fn += 1;
    else c.tn += 1;
  }
  return { ...c, labeled: c.tp + c.fp + c.fn + c.tn,
    precision: ratio(c.tp, c.tp + c.fp), recall: ratio(c.tp, c.tp + c.fn) };
}

/** Arrivals per time bucket (by emitted_at), contiguous, oldest first. */
export function volumeSeries(items, targetBuckets = 40) {
  const times = items.map((i) => Date.parse(i.emitted_at)).filter(Number.isFinite);
  if (!times.length) return { bucketSeconds: BUCKET_STEPS[0], buckets: [] };
  const [first, last] = [Math.min(...times), Math.max(...times)];
  const span = (last - first) / 1000;
  const bucketSeconds = BUCKET_STEPS.find((s) => span / s <= targetBuckets) ?? BUCKET_STEPS.at(-1);
  const size = bucketSeconds * 1000;
  const start = Math.floor(first / size) * size;
  const buckets = Array.from({ length: Math.floor((last - start) / size) + 1 },
    (_, k) => ({ t: start + k * size, total: 0, flagged: 0 }));
  for (const it of items) {
    const t = Date.parse(it.emitted_at);
    if (!Number.isFinite(t)) continue;
    const bucket = buckets[Math.floor((t - start) / size)];
    bucket.total += 1;
    if (isFlagged(it)) bucket.flagged += 1;
  }
  return { bucketSeconds, buckets };
}

/** Score distribution; each bin's count is split into below / at-or-above threshold. */
export function scoreHistogram(items, binCount = 20, threshold = DEFAULT_THRESHOLD) {
  const bins = Array.from({ length: binCount }, (_, k) => ({
    from: k / binCount, to: (k + 1) / binCount, below: 0, above: 0 }));
  for (const it of items.filter(isScored)) {
    const k = Math.min(binCount - 1, Math.max(0, Math.floor(it.fraud_score * binCount)));
    bins[k][it.fraud_score >= threshold ? "above" : "below"] += 1;
  }
  return { bins, threshold };
}

/** Totals and flags per key, most-flagged first; past `top` keys fold into "Other". */
export function groupBy(items, keyOf, top = 8) {
  const groups = new Map();
  for (const it of items) {
    const key = keyOf(it) ?? "unknown";
    const g = groups.get(key) ?? { key, total: 0, flagged: 0 };
    groups.set(key, { ...g, total: g.total + 1, flagged: g.flagged + (isFlagged(it) ? 1 : 0) });
  }
  const ranked = [...groups.values()]
    .sort((a, b) => b.flagged - a.flagged || b.total - a.total || a.key.localeCompare(b.key));
  const head = ranked.slice(0, top);
  const tail = ranked.slice(top);
  if (tail.length) {
    head.push(tail.reduce((o, g) => ({ ...o, total: o.total + g.total, flagged: o.flagged + g.flagged }),
      { key: "Other", total: 0, flagged: 0 }));
  }
  return head.map((g) => ({ ...g, rate: ratio(g.flagged, g.total) }));
}

/** Flag rate by the transaction's source hour (0-23), always 24 entries. */
export function hourProfile(items) {
  const hours = Array.from({ length: 24 }, (_, hour) => ({ hour, total: 0, flagged: 0 }));
  for (const it of items) {
    const h = Number(it.features?.hour);
    if (!(h >= 0 && h < 24)) continue;
    hours[h].total += 1;
    if (isFlagged(it)) hours[h].flagged += 1;
  }
  return hours.map((h) => ({ ...h, rate: ratio(h.flagged, h.total) }));
}

/** Amount (x) vs fraud score (y), capped to `max` points, keeping every flagged one first. */
export function scatterPoints(items, max = 800) {
  const scored = items.filter(isScored);
  const point = (i) => ({ x: Number(i.features?.amount) || 0, y: i.fraud_score, id: i.event_id });
  const flagged = scored.filter(isFlagged).slice(0, max).map(point);
  const other = scored.filter((i) => !isFlagged(i)).slice(0, max - flagged.length).map(point);
  return { flagged, other };
}

/** Align a series onto a fixed grid; a missing CloudWatch period is 0 for Sum, null otherwise. */
export function alignSeries(series, start, end, period) {
  const step = period * 1000;
  const first = Date.parse(start);
  const n = Math.max(0, Math.round((Date.parse(end) - first) / step));
  const labels = Array.from({ length: n }, (_, k) => first + k * step);
  const empty = series?.stat === "Sum" ? 0 : null;
  const values = labels.map(() => empty);
  for (const [t, v] of series?.points ?? []) {
    const k = Math.round((Date.parse(t) - first) / step);
    if (k >= 0 && k < n) values[k] = v;
  }
  return { labels, values };
}

/** Arrivals per second across the window's emitted_at span; null with < 2 items. */
export function arrivalRate(items) {
  const times = items.map((i) => Date.parse(i.emitted_at)).filter(Number.isFinite);
  if (times.length < 2) return null;
  const span = (Math.max(...times) - Math.min(...times)) / 1000;
  return span > 0 ? (times.length - 1) / span : null;
}
