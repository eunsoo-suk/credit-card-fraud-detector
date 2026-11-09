// Dashboard controller: data source, refresh timer, drawing and navigation.

import { createApiSource, normalizeApiUrl, EVENT_ID } from "./api.js";
import { createDemoSource } from "./demo.js";
import * as A from "./analytics.js";
import { stageHealth, overall, issues, unconfirmed, LIMITS } from "./health.js";
import * as charts from "./charts.js";
import * as views from "./views.js";
import * as fmt from "./format.js";
import { filters, applyFilters } from "./filters.js";
import { drawActivity } from "./activity.js";
import { buildMetricCards, drawMetrics, stageCardId } from "./metrics-view.js";

const PREFS_KEY = "fraud-dashboard-prefs";
const DEFAULT_PREFS = { window: 500, hours: 3, auto: true, tab: "flagged", theme: "" };
const REFRESH_MS = 30_000;
const TABLE_ROWS = 150;
const FLASH_MS = 1600;
const { el } = fmt;
const $ = (id) => document.getElementById(id);
const hostOf = (url) => (URL.canParse(url) ? new URL(url).host : url);

function loadPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function savePrefs(prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // storage blocked (private window); preferences just won't persist
  }
}

/** Live source from config (or ?api= when nothing is configured), otherwise demo data. */
function chooseSource() {
  const params = new URLSearchParams(location.search);
  const config = window.FRAUD_DASHBOARD_CONFIG ?? {};
  if (params.has("demo")) return { source: createDemoSource(), notices: [] };
  const configured = config.apiUrl ?? "";
  const requested = params.get("api");
  const notices = [];
  if (requested && configured) {
    notices.push({ level: "warning", text: "Ignored the ?api= link parameter: this dashboard is already "
      + `configured for ${hostOf(configured)}.` });
  }
  const raw = configured || requested || "";
  if (!raw) {
    return { source: createDemoSource(), notices: [{ level: "warning", text:
      "No API URL configured: showing synthetic DEMO data. After scripts/deploy_backend.py, run "
      + "python dashboard/serve.py (or open this page with ?api=https://…)." }] };
  }
  const url = normalizeApiUrl(raw);
  if (!url) {
    return { source: createDemoSource(), notices: [{ level: "critical",
      text: "The API URL is not a valid https:// URL, so DEMO data is shown instead." }] };
  }
  if (!configured) {
    notices.push({ level: "info", text: `Showing data from ${hostOf(url)}, set by the page link (?api=).` });
  }
  return { source: createApiSource(url, { metricsUrl: config.metricsUrl ?? "" }), notices };
}

const state = {
  prefs: loadPrefs(),
  ...chooseSource(),
  recent: [], flagged: [], metrics: null, apiHealth: null,
  errors: [], loading: false, reloadQueued: false, loadedAt: null, timer: null,
  filter: null, query: "", drawerId: null,
};

async function load() {
  if (state.loading) {
    state.reloadQueued = true; // e.g. Sample changed mid-load: run again with the new settings
    return;
  }
  state.loading = true;
  $("refresh").disabled = true;
  try {
    const { source, prefs } = state;
    const [health, recent, flagged, metrics] = await Promise.allSettled([
      source.health(), source.recent(prefs.window), source.flagged(prefs.window), source.metrics(prefs.hours)]);
    const errors = [];
    const take = (result, what, fallback) => {
      if (result.status === "fulfilled") return result.value;
      errors.push({ level: "critical", text: `${what}: ${result.reason.message}` });
      return fallback;
    };
    state.apiHealth = health.value ?? { ok: false, error: String(health.reason) };
    state.recent = take(recent, "Recent transactions", state.recent); // failures keep the last rows
    state.flagged = take(flagged, "Flagged transactions", state.flagged);
    state.metrics = take(metrics, "CloudWatch metrics", null); // never judge health on stale metrics
    state.errors = [...errors, ...source.takeWarnings().map((text) => ({ level: "warning", text }))];
    state.loadedAt = Date.now();
  } finally {
    state.loading = false;
    $("refresh").disabled = false;
  }
  draw();
  if (state.reloadQueued) {
    state.reloadQueued = false;
    load();
  }
}

function schedule() {
  clearInterval(state.timer);
  state.timer = state.prefs.auto ? setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS) : null;
}

const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

function goTo(id) {
  const target = id && $(id);
  if (!target) return;
  target.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
  target.focus({ preventScroll: true });
  target.classList.add("flash");
  setTimeout(() => target.classList.remove("flash"), FLASH_MS);
}

function setFilter(filter, tab) {
  state.filter = filter;
  updatePrefs({ tab });
  drawTable();
  goTo("transactions");
}

const go = {
  showFlagged: () => setFilter(filters.flagged(), "recent"), // the same rows the hero counts
  showRecent: () => setFilter(null, "recent"),
  showErrors: () => setFilter(filters.status("ERROR"), "recent"),
  showChart: goTo,
  // Scoring errors live in the table; other stage problems are best seen on their charts.
  showStage: (key) => (key === "writer" && state.recent.some((i) => i.status === "ERROR")
    ? go.showErrors() : goTo(stageCardId(key))),
};

function watchSections() {
  const links = new Map([...document.querySelectorAll(".sectionnav a")]
    .map((a) => [a.getAttribute("href").slice(1), a]));
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      links.forEach((a, id) => a.toggleAttribute("aria-current", id === entry.target.id));
    }
  }, { rootMargin: "-45% 0px -50% 0px" });
  links.forEach((_, id) => $(id) && observer.observe($(id)));
}

function ingestRate(metrics, items) {
  const series = metrics?.series?.["kinesis.incoming_records"];
  if (!series) return A.arrivalRate(items);
  const values = A.alignSeries(series, metrics.start, metrics.end, metrics.period).values;
  const tail = values.slice(-Math.ceil(LIMITS.RECENT_SECONDS / metrics.period));
  return tail.length ? tail.reduce((a, b) => a + (b ?? 0), 0) / (tail.length * metrics.period) : null;
}

function drawHeader(health) {
  const { source, loadedAt, errors, notices } = state;
  $("mode").textContent = source.mode === "demo" ? "DEMO DATA" : "LIVE";
  const status = overall(health);
  $("overall").replaceChildren(views.pill(status, `Pipeline ${views.STATUS[status].text.toLowerCase()}`));
  $("source").textContent = source.mode === "demo" ? source.label : `API ${source.label}`;
  $("updated").textContent = loadedAt ? `updated ${fmt.clock(loadedAt, true)}` : "loading…";
  $("banners").replaceChildren(...[...notices, ...errors].map((n) => views.banner(n.level, n.text)));
}

function drawTable() {
  const tab = state.prefs.tab;
  const base = tab === "flagged" ? state.flagged : state.recent;
  const rows = applyFilters(base, state.filter, state.query);
  $("tab-flagged").setAttribute("aria-selected", String(tab === "flagged"));
  $("tab-recent").setAttribute("aria-selected", String(tab === "recent"));
  $("count-flagged").textContent = fmt.count(state.flagged.length);
  $("count-recent").textContent = fmt.count(state.recent.length);
  $("filter-chips").replaceChildren(...(state.filter ? [
    el("span", { class: "chips-label" }, "Filtered by"),
    el("button", { class: "chip", type: "button", onclick: () => { state.filter = null; drawTable(); },
      "aria-label": `Remove filter ${state.filter.label}` }, state.filter.label, el("span", { "aria-hidden": "true" }, " ✕")),
  ] : []));
  const narrowed = Boolean(state.filter || state.query.trim());
  views.renderTable($("table"), rows.slice(0, TABLE_ROWS), openDrawer,
    narrowed ? "No transactions match. Remove the filter or clear the search." : "No transactions to show yet.");
  const shown = Math.min(rows.length, TABLE_ROWS);
  const what = tab === "flagged" ? "newest flagged transactions (may reach back beyond the sample)"
    : "transactions in the sample";
  $("table-sub").textContent = `Showing ${fmt.count(shown)} of ${fmt.count(rows.length)} `
    + (narrowed ? `matching ${what} (out of ${fmt.count(base.length)}).` : `${what}. Click an ID for full details.`);
}

function draw() {
  const items = state.recent;
  const summary = A.summarize(items);
  const health = stageHealth({ metrics: state.metrics, summary: items.length ? summary : null,
    apiHealth: state.apiHealth });
  drawHeader(health);
  views.renderHero($("status-hero"), { status: overall(health), issues: issues(health),
    unconfirmed: unconfirmed(health), summary, demo: state.source.mode === "demo" }, go);
  views.renderKpis($("kpis"), { summary, health, ingestRate: ingestRate(state.metrics, items),
    ingestFromKinesis: Boolean(state.metrics?.series?.["kinesis.incoming_records"]) }, go);
  views.renderFlow($("flow"), health, state.metrics?.stages, (stage) => goTo(stageCardId(stage)));
  drawActivity(items, summary, { onFilter: setFilter, onOpen: openById });
  drawTable();
  drawMetrics($("health-sub"), state.metrics, state.source.mode);
}

async function openDrawer(item) {
  const dialog = $("drawer");
  state.drawerId = item.event_id;
  $("drawer-title").textContent = `Transaction ${item.event_id.slice(0, 8)}`;
  views.renderDetail($("drawer-body"), item);
  if (!dialog.open) dialog.showModal();
  try {
    const fresh = await state.source.transaction(item.event_id);
    // Ignore late answers for a transaction the user has already moved away from.
    if (fresh && dialog.open && state.drawerId === item.event_id) views.renderDetail($("drawer-body"), fresh);
  } catch (error) {
    if (state.drawerId === item.event_id) {
      $("drawer-body").prepend(views.banner("warning", `Could not refresh: ${error.message}`));
    }
  }
}

async function openById(eventId) {
  const known = [...state.flagged, ...state.recent].find((i) => i.event_id === eventId);
  const item = known ?? await state.source.transaction(eventId);
  if (item) openDrawer(item);
}

async function lookup(event) {
  event.preventDefault();
  const id = $("lookup-id").value.trim();
  const msg = $("lookup-msg");
  if (!EVENT_ID.test(id)) {
    msg.textContent = "Enter a full 36-character event_id.";
    return;
  }
  msg.textContent = "Searching…";
  try {
    const item = await state.source.transaction(id);
    msg.textContent = item ? "" : "Not found.";
    if (item) openDrawer(item);
  } catch (error) {
    msg.textContent = error.message;
  }
}

function applyTheme() {
  if (state.prefs.theme) document.documentElement.dataset.theme = state.prefs.theme;
  else delete document.documentElement.dataset.theme;
}

function updatePrefs(patch) {
  state.prefs = { ...state.prefs, ...patch };
  savePrefs(state.prefs);
}

function toggleTheme() {
  const dark = document.documentElement.dataset.theme === "dark"
    || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  updatePrefs({ theme: dark ? "light" : "dark" });
  applyTheme();
  charts.resetAll();
  draw();
}

function wire() {
  $("window").value = String(state.prefs.window);
  $("hours").value = String(state.prefs.hours);
  $("auto").checked = state.prefs.auto;
  $("window").addEventListener("change", (e) => { updatePrefs({ window: Number(e.target.value) }); load(); });
  $("hours").addEventListener("change", (e) => { updatePrefs({ hours: Number(e.target.value) }); load(); });
  $("auto").addEventListener("change", (e) => { updatePrefs({ auto: e.target.checked }); schedule(); });
  $("refresh").addEventListener("click", load);
  $("theme").addEventListener("click", toggleTheme);
  for (const tab of ["flagged", "recent"]) {
    $(`tab-${tab}`).addEventListener("click", () => { updatePrefs({ tab }); drawTable(); });
  }
  $("search").addEventListener("input", (e) => { state.query = e.target.value; drawTable(); });
  $("lookup").addEventListener("submit", lookup);
  $("drawer-close").addEventListener("click", () => $("drawer").close());
  $("drawer").addEventListener("click", (e) => { if (e.target === $("drawer")) $("drawer").close(); });
  $("drawer").addEventListener("close", () => { state.drawerId = null; });
  document.addEventListener("keydown", (e) => {
    const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "");
    if (e.key === "/" && !typing && !$("drawer").open) {
      e.preventDefault();
      goTo("transactions");
      $("search").focus();
    }
  });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.prefs.auto) load(); });
}

applyTheme();
buildMetricCards($("metric-grid"));
wire();
watchSections();
if (!window.Chart) {
  state.notices = [...state.notices, { level: "critical",
    text: "Chart.js did not load: charts are unavailable, tables still work." }];
}
schedule();
load();
