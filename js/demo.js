// Synthetic data source with the same interface as the live API client (api.js).
// Used when no API URL is configured, e.g. before AWS is deployed. Every value is
// invented and the UI labels it as DEMO DATA; nothing here is a model result.
//
// Transaction n is emitted at n / rate seconds and generated from a seeded PRNG,
// so refreshes are stable and new arrivals appear as the clock moves forward.

const DAY_MS = 86_400_000;
const PROCESSING_MS = 3_000;    // newest few seconds are still PENDING
const ALERT_DELAY_MS = 20_000;  // flagged items wait this long before SENT
const ERROR_RATE = 0.003;
const FRAUD_RATE = 0.03;        // enriched for the demo; the real test file is 0.386%
const THRESHOLD = 0.5;
const MODEL_VERSION = "demo-model-v1";
const SCAN_LIMIT = 200_000;
const CACHE_LIMIT = 50_000;
const SOURCE_EPOCH = Date.UTC(2020, 5, 21, 12, 14, 25); // first fraudTest.csv timestamp
const SOURCE_ROWS = 555_719;   // fraudTest.csv rows; the replay loops over them
const ROWS_PER_DAY = 3_000;    // ~555k rows over ~190 days

const CATEGORIES = [
  ["grocery_pos", 12], ["gas_transport", 11], ["home", 10], ["shopping_pos", 9],
  ["kids_pets", 9], ["shopping_net", 8], ["entertainment", 7], ["food_dining", 7],
  ["personal_care", 7], ["health_fitness", 7], ["misc_pos", 6], ["misc_net", 5],
  ["grocery_net", 4], ["travel", 3],
];
const FRAUD_CATEGORIES = [["shopping_net", 30], ["grocery_pos", 25], ["misc_net", 15],
  ["shopping_pos", 12], ["gas_transport", 8], ["home", 5], ["travel", 5]];
const STATES = [["TX", 9], ["NY", 8], ["PA", 7], ["CA", 6], ["OH", 5], ["MI", 5], ["IL", 4],
  ["FL", 4], ["AL", 4], ["MO", 3], ["MN", 3], ["AR", 3], ["NC", 3], ["VA", 3], ["WI", 3],
  ["SC", 3], ["KY", 3], ["IN", 3], ["IA", 3], ["MD", 3]];
const NIGHT_HOURS = new Set([22, 23, 0, 1, 2, 3]);
const ONLINE_CATEGORIES = new Set(["shopping_net", "misc_net", "grocery_pos"]);

// key -> [stat, unit, label]; mirrors CATALOG in ../cloudwatch_metrics.py (parity-tested)
const METRICS = {
  "producer.cpu": ["Average", "Percent", "Producer CPU"],
  "kinesis.incoming_records": ["Sum", "Count", "Records in"],
  "kinesis.iterator_age": ["Maximum", "Milliseconds", "Stream iterator age"],
  "kinesis.write_throttled": ["Sum", "Count", "Write throttles"],
  "kinesis.read_throttled": ["Sum", "Count", "Read throttles"],
  "writer.invocations": ["Sum", "Count", "Invocations"],
  "writer.errors": ["Sum", "Count", "Errors"],
  "writer.throttles": ["Sum", "Count", "Throttles"],
  "writer.duration_avg": ["Average", "Milliseconds", "Duration (avg)"],
  "writer.duration_max": ["Maximum", "Milliseconds", "Duration (max)"],
  "writer.iterator_age": ["Maximum", "Milliseconds", "Lambda iterator age"],
  "model.invocations": ["Sum", "Count", "Invocations"],
  "model.latency": ["Average", "Microseconds", "Model latency"],
  "model.errors_4xx": ["Sum", "Count", "4xx errors"],
  "model.errors_5xx": ["Sum", "Count", "5xx errors"],
  "table.write_units": ["Sum", "Count", "Write units"],
  "table.read_units": ["Sum", "Count", "Read units"],
  "table.write_throttles": ["Sum", "Count", "Write throttles"],
  "table.read_throttles": ["Sum", "Count", "Read throttles"],
  "alerts.published": ["Sum", "Count", "Published"],
  "alerts.delivered": ["Sum", "Count", "Delivered"],
  "alerts.failed": ["Sum", "Count", "Failed"],
  "api.requests": ["Sum", "Count", "Requests"],
  "api.errors_4xx": ["Sum", "Count", "4xx"],
  "api.errors_5xx": ["Sum", "Count", "5xx"],
  "api.latency": ["Average", "Milliseconds", "Latency"],
};

/** JS port of lambdas/writer/scorer.py placeholder_score (features only). */
export function placeholderScore(features) {
  let s = 0.02;
  const amount = Number(features.amount);
  if (amount > 1000) s += 0.5;
  else if (amount > 500) s += 0.35;
  else if (amount > 200) s += 0.1;
  if (NIGHT_HOURS.has(Number(features.hour))) s += 0.3;
  if (ONLINE_CATEGORIES.has(features.category)) s += 0.1;
  return Math.round(Math.min(s, 0.99) * 10_000) / 10_000;
}

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}
const mix = (seed, n, salt = 0) => Math.imul(n ^ Math.imul(salt + 1, 0x9e3779b1), 2_654_435_761) ^ seed;
const hex = (rand, digits) => Array.from({ length: digits },
  () => Math.floor(rand() * 16).toString(16)).join("");
const uuid = (rand) => `${hex(rand, 8)}-${hex(rand, 4)}-${hex(rand, 4)}-${hex(rand, 4)}-${hex(rand, 12)}`;
const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;

function pick(rand, weighted) {
  const total = weighted.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [value, w] of weighted) {
    r -= w;
    if (r < 0) return value;
  }
  return weighted.at(-1)[0];
}

function features(rand, n, account, fraud) {
  const day = new Date(SOURCE_EPOCH + Math.floor((n % SOURCE_ROWS) / ROWS_PER_DAY) * DAY_MS);
  const hour = fraud && rand() < 0.7 ? [22, 23, 0, 1, 2, 3][Math.floor(rand() * 6)]
    : Math.min(23, Math.floor(6 + rand() * 18));
  const source = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour,
    Math.floor(rand() * 60), Math.floor(rand() * 60)));
  const amount = fraud && rand() < 0.8 ? 200 + rand() * 1100 : Math.exp(2.2 + rand() * 2.8);
  return {
    source_timestamp: source.toISOString().slice(0, 19).replace("T", " "),
    features: {
      amount: round(amount),
      category: pick(rand, fraud ? FRAUD_CATEGORIES : CATEGORIES),
      merchant: `demo_merchant_${Math.floor(rand() * 240)}`,
      state: account.state,
      city_population: Math.round(10 ** (2.5 + rand() * 4)),
      customer_lat: account.lat,
      customer_lon: account.lon,
      merchant_lat: round(account.lat + (rand() - 0.5) * 2, 4),
      merchant_lon: round(account.lon + (rand() - 0.5) * 2, 4),
      age_at_transaction: account.age,
      hour,
      weekday: (source.getUTCDay() + 6) % 7,
      month: source.getUTCMonth() + 1,
    },
  };
}

function account(seed, id) {
  const rand = prng(mix(seed, id, 7));
  return { id: hex(rand, 24), state: pick(rand, STATES), age: 18 + Math.floor(rand() * 67),
    lat: round(26 + rand() * 21, 4), lon: round(-122 + rand() * 50, 4) };
}

function transaction(seed, rate, n, now) {
  const rand = prng(mix(seed, n));
  const emitted = Math.floor((n * 1000) / rate + rand() * (1000 / rate));
  const fraud = rand() < FRAUD_RATE;
  const acct = account(seed, Math.floor(rand() * 400));
  const { source_timestamp, features: f } = features(rand, n, acct, fraud);
  const emittedIso = new Date(emitted).toISOString();
  const base = {
    schema_version: "1.0", feature_version: "v1", event_id: uuid(rand),
    replay_id: "00000000-0000-0000-0000-00000000de30", replay_cycle: 0, source_row: n % SOURCE_ROWS,
    source_dataset: "demo (synthetic)", source_transaction_id: `demo_tx_${n}`, source_timestamp,
    emitted_at: emittedIso, emitted_date: emittedIso.slice(0, 10), account_id: acct.id,
    features: f, ground_truth: { is_fraud: fraud ? 1 : 0 },
    created_at: emittedIso, updated_at: emittedIso,
    expires_at: Math.floor(emitted / 1000) + 30 * 86_400, alert_status: "NONE",
  };
  if (now - emitted < PROCESSING_MS) return { ...base, status: "PENDING" };
  const scoredAt = new Date(emitted + 400 + rand() * 2100).toISOString();
  if (rand() < ERROR_RATE) {
    return { ...base, status: "ERROR", attempts: 1, updated_at: scoredAt,
      error_message: "scoring failed: demo endpoint timeout" };
  }
  // Imperfect on purpose: some fraud is missed and some legit traffic is flagged.
  const signal = fraud ? 0.2 + rand() * 0.7 : rand() ** 4 * 0.62;
  const fraudScore = round(Math.min(0.999, placeholderScore(f) * 0.5 + signal), 4);
  const flagged = fraudScore >= THRESHOLD;
  const item = { ...base, status: "SCORED", fraud_score: fraudScore, predicted_fraud: flagged,
    threshold: THRESHOLD, model_version: MODEL_VERSION, scored_at: scoredAt, updated_at: scoredAt };
  if (!flagged) return item;
  const sent = now - emitted >= ALERT_DELAY_MS;
  return { ...item, flag_status: "FLAGGED", alert_status: sent ? "SENT" : "PENDING",
    ...(sent ? { alerted_at: new Date(emitted + ALERT_DELAY_MS).toISOString(),
      alert_message_id: `demo-${n}` } : {}) };
}

function metricValue(key, rand, ctx) {
  const { perPeriod, spike, period } = ctx;
  const jitter = (lo, hi) => lo + rand() * (hi - lo);
  const rare = (p) => (rand() < p ? 1 : 0);
  switch (key) {
    case "producer.cpu": return round(jitter(6, 14), 1);
    case "kinesis.incoming_records": return Math.round(perPeriod * jitter(0.9, 1.04));
    case "kinesis.iterator_age": return Math.round(spike ? jitter(40_000, 95_000) : jitter(150, 1400));
    case "writer.iterator_age": return Math.round(spike ? jitter(38_000, 90_000) : jitter(300, 1900));
    case "writer.invocations": return Math.round(period * jitter(0.8, 0.95));
    case "writer.errors": return spike ? rare(0.5) : rare(0.03);
    case "writer.duration_avg": return round(jitter(110, 240), 1);
    case "writer.duration_max": return round(spike ? jitter(1800, 4200) : jitter(380, 950), 1);
    case "model.invocations": return Math.round(perPeriod * jitter(0.9, 1.04));
    case "model.latency": return Math.round(spike ? jitter(90_000, 210_000) : jitter(14_000, 42_000));
    case "model.errors_4xx": return rare(0.01);
    case "table.write_units": return Math.round(perPeriod * jitter(2.8, 3.2));
    case "table.read_units": return Math.round(jitter(20, 90) * (period / 60));
    case "alerts.published":
    case "alerts.delivered": return Math.round(perPeriod * jitter(0.01, 0.035));
    case "api.requests": return Math.round(jitter(20, 32) * (period / 60));
    case "api.errors_4xx": return rare(0.05);
    case "api.latency": return round(jitter(35, 120), 1);
    default: return 0; // throttles and failures stay at zero in the demo
  }
}

/**
 * @param {{seed?: number, rate?: number, now?: () => number}} [options]
 *   rate: transactions per second (the README's producer runs at 2-5)
 */
export function createDemoSource({ seed = 7, rate = 2, now = () => Date.now() } = {}) {
  const cache = new Map();
  const at = (n, t) => {
    const item = transaction(seed, rate, n, t);
    if (cache.size > CACHE_LIMIT) cache.clear();
    cache.set(item.event_id, item);
    return item;
  };
  const newest = (t) => Math.floor((t * rate) / 1000) - 1;

  return {
    mode: "demo",
    label: "Demo data (synthetic)",

    health: async () => ({ ok: true, latencyMs: 40 + Math.round(Math.random() * 30) }),
    takeWarnings: () => [],

    async recent(limit) {
      const t = now();
      const top = newest(t);
      return Array.from({ length: limit }, (_, k) => at(top - k, t))
        .filter((i) => Date.parse(i.emitted_at) <= t);
    },

    async flagged(limit) {
      const t = now();
      const found = [];
      for (let n = newest(t), scanned = 0; found.length < limit && scanned < SCAN_LIMIT; n -= 1, scanned += 1) {
        const item = at(n, t);
        if (item.predicted_fraud === true && Date.parse(item.emitted_at) <= t) found.push(item);
      }
      return found;
    },

    transaction: async (eventId) => cache.get(eventId) ?? null,

    async metrics(hours) {
      const h = Math.max(1, Math.min(24, hours));
      const period = h <= 3 ? 60 : 300;
      const end = Math.floor(now() / (period * 1000)) * period * 1000;
      const start = end - h * 3_600_000;
      const n = (h * 3600) / period;
      const spikeAt = Math.floor(n * 0.62);
      const spikeLength = Math.max(2, Math.round(360 / period));
      const series = {};
      Object.entries(METRICS).forEach(([key, [stat, unit, label]], keyIndex) => {
        const points = Array.from({ length: n }, (_, k) => {
          const slot = (start / 1000) / period + k;
          const rand = prng(mix(seed, slot, 100 + keyIndex));
          const spike = k >= spikeAt && k < spikeAt + spikeLength;
          return [new Date(start + k * period * 1000).toISOString(),
            metricValue(key, rand, { perPeriod: rate * period, spike, period })];
        });
        series[key] = { stage: key.split(".")[0], label, stat, unit, points };
      });
      return {
        hours: h, period, start: new Date(start).toISOString(), end: new Date(end).toISOString(),
        stages: { producer: "i-0demo00000000000", kinesis: "fraud-ingestion-stream",
          writer: "fraud-writer", model: "fraud-detector-serverless", table: "FraudTransactions",
          alerts: "fraud-alerts", api: "demo-api" },
        series,
      };
    },
  };
}
