import * as fmt from "./format.js";
import { STAGES } from "./health.js";

const { el } = fmt;
export const STATUS = {
  good: { icon: "✓", text: "Healthy" },
  warning: { icon: "!", text: "Warning" },
  critical: { icon: "✕", text: "Critical" },
  unknown: { icon: "?", text: "No data" },
  off: { icon: "–", text: "Off" },
};

export function pill(status, text = STATUS[status].text) {
  return el("span", { class: `pill pill-${status}` },
    el("span", { class: "pill-icon", "aria-hidden": "true" }, STATUS[status].icon), text);
}

export function banner(level, text) {
  return el("p", { class: "banner", role: level === "critical" ? "alert" : null },
    level === "info" ? null : pill(level), text);
}

const SVG_NS = "http://www.w3.org/2000/svg";
const SHIELD = "M12 2.5 4.5 5.5v5.7c0 4.6 3.1 8.8 7.5 10.3 4.4-1.5 7.5-5.7 7.5-10.3V5.5L12 2.5z";
const MARKS = {
  good: "m8.6 12 2.3 2.3 4.6-4.8",
  warning: "M12 7.6v5M12 15.9v.1",
  critical: "m9.3 9.3 5.4 5.4m0-5.4-5.4 5.4",
  unknown: "M10 9.7a2 2 0 1 1 2.9 1.8c-.6.3-.9.8-.9 1.4v.5M12 15.9v.1",
  off: "M9 12h6",
};

function shieldIcon(status) {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", `shield shield-${status}`);
  svg.setAttribute("aria-hidden", "true");
  for (const [d, cls] of [[SHIELD, "shield-body"], [MARKS[status], "shield-mark"]]) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("class", cls);
    svg.append(path);
  }
  return svg;
}

const MAX_HERO_ROWS = 4;

function heroSentence(status, summary, hasUnconfirmed) {
  if (status !== "good") return null;
  const lead = hasUnconfirmed ? "Every stage reporting data is healthy." : "All monitored stages are healthy.";
  return el("p", { class: "hero-sub" },
    `${lead} ${fmt.count(summary.flagged)} of ${fmt.count(summary.total)} transactions in the sample were flagged.`);
}

export function renderHero(root, { status, issues, unconfirmed = [], summary, demo }, go) {
  const critical = issues.filter((i) => i.status === "critical").length;
  const title = {
    good: "Pipeline is running normally",
    warning: `${fmt.plural(issues.length, "stage")} need${issues.length === 1 ? "s" : ""} attention`,
    critical: `${fmt.plural(critical, "stage")} failing`,
    unknown: "Waiting for data",
  }[status];
  const rows = [...issues, ...unconfirmed].slice(0, MAX_HERO_ROWS);
  const list = rows.length ? el("ul", { class: "hero-issues" }, ...rows.map((i) => el("li", {},
    pill(i.status, i.name), el("span", {}, i.detail || i.headline)))) : null;
  root.replaceChildren(shieldIcon(status),
    el("div", {},
      el("p", { class: "hero-kicker" }, demo ? "Fraud pipeline status · demo data" : "Fraud pipeline status"),
      el("h3", { class: "hero-title" }, title),
      heroSentence(status, summary, unconfirmed.length > 0), list),
    el("div", { class: "hero-actions" },
      issues.length ? el("button", { class: "btn btn-primary", type: "button",
        onclick: () => go.showStage(issues[0].key) }, "Review issues") : null,
      el("button", { class: issues.length ? "btn" : "btn btn-primary", type: "button", onclick: go.showFlagged },
        `View flagged (${fmt.count(summary.flagged)})`)));
}

function tile({ label, value, sub, status, onOpen, hint, hero = false }) {
  const body = [
    el("div", { class: "tile-label" }, label, status && status !== "good" ? pill(status) : null),
    el("div", { class: hero ? "hero-value" : "tile-value" }, value),
    sub ? el("div", { class: "tile-sub" }, sub) : null,
    onOpen ? el("div", { class: "tile-hint", "aria-hidden": "true" }, hint) : null,
  ];
  const cls = `tile${hero ? " tile-hero" : ""}${onOpen ? " tile-action" : ""}`;
  return onOpen
    ? el("button", { class: cls, type: "button", onclick: onOpen, "aria-label": `${label}: ${value}. ${hint}` }, ...body)
    : el("div", { class: cls }, ...body);
}

export function renderKpis(root, { summary, health, ingestRate, ingestFromKinesis }, go) {
  const s = summary;
  root.replaceChildren(
    tile({ hero: true, label: "Flagged as suspicious", value: fmt.count(s.flagged),
      sub: `${fmt.percent(s.flagRate, 2)} of ${fmt.count(s.scored)} scored · ${fmt.amount(s.flaggedAmount)} total`,
      onOpen: go.showFlagged, hint: "See flagged transactions →" }),
    tile({ label: "Transactions in window", value: fmt.count(s.total),
      sub: `${fmt.count(s.pending)} pending · newest ${fmt.ago(s.arrivalAgeSec)}`,
      status: health.producer.status === "warning" ? "warning" : null,
      onOpen: go.showRecent, hint: "See all →" }),
    tile({ label: "Ingest rate", value: fmt.rate(ingestRate),
      sub: ingestFromKinesis ? "into Kinesis, last 15 min" : "from arrival times in window",
      onOpen: () => go.showChart("card-m-incoming"), hint: "Stream chart →" }),
    tile({ label: "Median time to score", value: fmt.duration(s.medianScoringSec == null ? null : s.medianScoringSec * 1000),
      sub: "from arrival to score", status: health.writer.status === "critical" ? "critical" : null,
      onOpen: () => go.showChart("card-m-lag"), hint: "Lag chart →" }),
    tile({ label: "Alerts sent", value: fmt.count(s.alerts.SENT),
      sub: s.alerts.PENDING ? `${fmt.count(s.alerts.PENDING)} pending` : "none pending",
      status: ["critical", "warning"].includes(health.alerts.status) ? health.alerts.status : null,
      onOpen: () => go.showChart("card-m-alerts"), hint: "Alerts chart →" }),
    tile({ label: "Scoring errors", value: fmt.count(s.errors), sub: "transactions that failed scoring",
      status: s.errors ? "warning" : null, onOpen: go.showErrors, hint: "See errors →" }));
}

function stageNode(stage, h, resource, onMetrics) {
  return el("li", { class: "stage", "data-stage": stage.key },
    el("div", { class: "stage-head" }, el("span", { class: "stage-name" }, stage.name), pill(h.status)),
    el("div", { class: "stage-service" }, stage.service),
    el("div", { class: "stage-headline" }, h.headline),
    h.detail ? el("div", { class: "stage-detail" }, h.detail) : null,
    resource ? el("div", { class: "stage-resource", title: resource }, resource) : null,
    onMetrics ? el("button", { class: "stage-link", type: "button", onclick: onMetrics,
      "aria-label": `${stage.name} metrics` }, "Metrics ↓") : null);
}

function statusLegend() {
  return el("ul", { class: "legend", "aria-label": "Status key" },
    ...Object.keys(STATUS).map((key) => el("li", {}, pill(key))));
}

export function renderFlow(root, health, resources = {}, onMetrics) {
  const byKey = Object.fromEntries(STAGES.map((s) => [s.key, s]));
  const node = (key) => stageNode(byKey[key], health[key], resources[key], () => onMetrics(key));
  const dashboard = el("li", { class: "stage" },
    el("div", { class: "stage-head" }, el("span", { class: "stage-name" }, "Dashboard")),
    el("div", { class: "stage-service" }, "this page"),
    el("div", { class: "stage-headline" }, "you are here"));
  root.replaceChildren(
    el("ol", { class: "flow-main", "aria-label": "Main pipeline path" },
      ...["producer", "kinesis", "writer", "model", "table", "api"].map(node), dashboard),
    el("div", { class: "flow-foot" },
      el("div", { class: "flow-branch" },
        el("span", { class: "branch-label" }, "Scoring also publishes flagged transactions to"),
        el("ol", { class: "flow-side", "aria-label": "Alert branch" }, node("alerts"))),
      statusLegend()));
}

export function renderLabelCheck(root, check) {
  const cell = (n, name) => el("td", { class: `cm-${name}` }, el("strong", {}, fmt.count(n)),
    el("span", {}, name.toUpperCase()));
  root.replaceChildren(
    el("div", { class: "cm-stats" },
      el("div", {}, el("span", { class: "tile-label" }, "Precision"), el("span", { class: "cm-big" }, fmt.percent(check.precision))),
      el("div", {}, el("span", { class: "tile-label" }, "Recall"), el("span", { class: "cm-big" }, fmt.percent(check.recall))),
      el("div", {}, el("span", { class: "tile-label" }, "Labeled"), el("span", { class: "cm-big" }, fmt.count(check.labeled)))),
    el("table", { class: "cm" },
      el("caption", { class: "sr-only" }, "Predictions versus replay ground truth"),
      el("thead", {}, el("tr", {}, el("th", {}), el("th", { scope: "col" }, "Actually fraud"),
        el("th", { scope: "col" }, "Actually legit"))),
      el("tbody", {},
        el("tr", {}, el("th", { scope: "row" }, "Flagged"), cell(check.tp, "tp"), cell(check.fp, "fp")),
        el("tr", {}, el("th", { scope: "row" }, "Not flagged"), cell(check.fn, "fn"), cell(check.tn, "tn")))),
    el("p", { class: "note" }, "Live monitoring against the replay's labels in this window only. "
      + "The demo replay and enriched samples change fraud prevalence, so these are not model evaluation results."));
}

function meterList(entries, total) {
  return el("ul", { class: "meters" }, ...entries.map(([name, n]) => {
    const fill = el("span", { class: "meter-fill" });
    fill.style.width = `${total ? (100 * n) / total : 0}%`;
    return el("li", {},
      el("div", { class: "meter-row" }, el("span", {}, name), el("span", { class: "num" }, fmt.count(n))),
      el("div", { class: "meter", role: "img", "aria-label": `${name}: ${fmt.count(n)} of ${fmt.count(total)}` },
        fill));
  }));
}

export function renderStatus(root, summary) {
  const { total, scored, pending, errors, alerts, modelVersions } = summary;
  root.replaceChildren(
    el("h4", {}, "Processing"),
    meterList([["Scored", scored], ["Pending", pending], ["Error", errors]], total),
    el("h4", {}, "Alerts (flagged only)"),
    meterList([["Sent", alerts.SENT], ["Pending", alerts.PENDING]], alerts.SENT + alerts.PENDING),
    el("h4", {}, "Model version"),
    el("ul", { class: "versions" }, ...(modelVersions.length ? modelVersions : [{ version: "—", count: 0 }])
      .map((v) => el("li", {}, el("code", {}, v.version), el("span", { class: "num" }, fmt.count(v.count))))));
}

function decision(item) {
  if (item.status === "PENDING") return pill("unknown", "Pending");
  if (item.status === "ERROR") return pill("warning", "Error");
  return item.predicted_fraud ? pill("critical", "Flagged") : pill("good", "Clear");
}

export function renderTable(root, items, onOpen, emptyText = "No transactions to show yet.") {
  if (!items.length) {
    root.replaceChildren(el("p", { class: "empty" }, emptyText));
    return;
  }
  const head = ["Transaction", "Arrived", "Amount", "Category", "Merchant", "State", "Score",
    "Decision", "Alert", "Label"];
  const rows = items.map((it) => el("tr", {},
    el("td", {}, el("button", { class: "link", type: "button", onclick: () => onOpen(it),
      "aria-label": `Open transaction ${it.event_id}` }, it.event_id.slice(0, 8))),
    el("td", { class: "num" }, fmt.clock(it.emitted_at, true)),
    el("td", { class: "num" }, fmt.amount(it.features?.amount)),
    el("td", {}, fmt.label(it.features?.category)),
    el("td", { class: "truncate", title: it.features?.merchant ?? "" }, it.features?.merchant ?? "—"),
    el("td", {}, it.features?.state ?? "—"),
    el("td", { class: "num" }, fmt.score(it.fraud_score)),
    el("td", {}, decision(it)),
    el("td", {}, fmt.label(it.alert_status?.toLowerCase())),
    el("td", {}, it.ground_truth?.is_fraud === 1 ? "fraud" : "legit")));
  root.replaceChildren(el("table", { class: "data" },
    el("thead", {}, el("tr", {}, ...head.map((h) => el("th", { scope: "col" }, h)))),
    el("tbody", {}, ...rows)));
}

function fields(title, pairs) {
  return el("section", { class: "detail-section" }, el("h4", {}, title),
    el("dl", {}, ...pairs.flatMap(([k, v]) => [el("dt", {}, k), el("dd", {}, v ?? "—")])));
}

export function renderDetail(root, item) {
  const f = item.features ?? {};
  const latency = Date.parse(item.scored_at) - Date.parse(item.emitted_at);
  root.replaceChildren(...[
    el("div", { class: "detail-decision" }, decision(item),
      el("span", { class: "detail-score" }, `score ${fmt.score(item.fraud_score)}`),
      el("span", { class: "muted" }, `threshold ${item.threshold ?? "—"}`)),
    item.error_message ? banner("warning", item.error_message) : null,
    fields("Decision", [["Status", item.status], ["Model", item.model_version],
      ["Alert", fmt.label(item.alert_status?.toLowerCase())],
      ["Alerted at", item.alerted_at && new Date(item.alerted_at).toLocaleString()]]),
    fields("Transaction features (model inputs)", [["Amount", fmt.amount(f.amount)],
      ["Category", fmt.label(f.category)], ["Merchant", f.merchant], ["State", f.state],
      ["City population", fmt.count(f.city_population)], ["Age", f.age_at_transaction],
      ["Hour / weekday / month", `${f.hour} / ${f.weekday} / ${f.month}`],
      ["Customer location", `${f.customer_lat}, ${f.customer_lon}`],
      ["Merchant location", `${f.merchant_lat}, ${f.merchant_lon}`]]),
    fields("Timing", [["Source timestamp", item.source_timestamp],
      ["Emitted", item.emitted_at && new Date(item.emitted_at).toLocaleString()],
      ["Scored", item.scored_at && new Date(item.scored_at).toLocaleString()],
      ["Time to score", Number.isFinite(latency) ? fmt.duration(latency) : null]]),
    fields("Identity", [["Event ID", el("code", {}, item.event_id)],
      ["Account (pseudonym)", el("code", {}, item.account_id ?? "—")],
      ["Source transaction", item.source_transaction_id], ["Dataset", item.source_dataset],
      ["Source row / replay cycle", `${item.source_row} / ${item.replay_cycle}`]]),
    fields("Evaluation label (never sent to the model)", [
      ["Ground truth", item.ground_truth?.is_fraud === 1 ? "fraud" : "legit"]]),
  ].filter(Boolean));
}
