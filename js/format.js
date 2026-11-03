// Number, time and DOM helpers shared by every view. No data is ever inserted as
// HTML: el() only sets textContent, so merchant names and other dataset strings
// cannot inject markup.

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** @param {number|null|undefined} n @returns {string} 1,284 / 12.9K / 4.2M */
export function count(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return Math.abs(n) < 10_000 ? whole.format(n) : compact.format(n);
}

/** @param {number|null|undefined} n amount in source units (currency unspecified) */
export function amount(n) {
  return n == null ? "—" : money.format(n);
}

/** @param {number|null|undefined} ratio 0..1 @returns {string} */
export function percent(ratio, digits = 1) {
  if (ratio == null || Number.isNaN(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

/** @param {number|null|undefined} s fraud score 0..1 */
export function score(s) {
  return s == null ? "—" : s.toFixed(3);
}

/** @param {number|null|undefined} ms @returns {string} 85 ms / 4.2 s / 3.1 min */
export function duration(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/** @param {number|null} perSecond records per second */
export function rate(perSecond) {
  if (perSecond == null) return "—";
  return `${perSecond < 10 ? perSecond.toFixed(1) : whole.format(perSecond)} rec/s`;
}

/** @param {number|string} t epoch ms or ISO string @returns {string} local HH:MM(:SS) */
export function clock(t, withSeconds = false) {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}) });
}

/** @param {number|null} seconds @returns {string} "12s ago" / "4 min ago" */
export function ago(seconds) {
  if (seconds == null) return "—";
  if (seconds < 60) return `${Math.max(0, Math.round(seconds))}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${(seconds / 3600).toFixed(1)} h ago`;
}

/** Humanize a dataset category: "shopping_net" -> "shopping net". */
export function label(text) {
  return String(text ?? "—").replaceAll("_", " ");
}

/**
 * Create an element with attributes and children (strings become text nodes).
 * @param {string} tag
 * @param {Record<string, unknown>} [attrs] "class", "on<event>" handlers, or attributes
 * @param {...(Node|string|number|null|undefined)} children
 */
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === false || value == null) continue;
    if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else if (key === "class") {
      node.className = String(value);
    } else {
      node.setAttribute(key, value === true ? "" : String(value));
    }
  }
  for (const child of children.flat()) {
    if (child == null) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}
