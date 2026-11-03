// Formatting and DOM helpers. el() only sets text, so data can never inject HTML.

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
const whole = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function count(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return Math.abs(n) < 10_000 ? whole.format(n) : compact.format(n);
}

/** "1 stage", "3 stages"; pass `many` for irregular plurals ("deliveries"). */
export function plural(n, one, many = `${one}s`) {
  return `${count(n)} ${n === 1 ? one : many}`;
}

export function amount(n) {
  return n == null ? "—" : money.format(n);
}

export function percent(ratio, digits = 1) {
  if (ratio == null || Number.isNaN(ratio)) return "—";
  return `${(ratio * 100).toFixed(digits)}%`;
}

export function score(s) {
  return s == null ? "—" : s.toFixed(3);
}

export function duration(ms) {
  if (ms == null || Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

export function rate(perSecond) {
  if (perSecond == null) return "—";
  return `${perSecond < 10 ? perSecond.toFixed(1) : whole.format(perSecond)} rec/s`;
}

export function clock(t, withSeconds = false) {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit",
    ...(withSeconds ? { second: "2-digit" } : {}) });
}

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
