// "Fraud activity" section. Every bar is clickable: it filters the transaction table
// to exactly those rows (filters.js). Dots on the scatter open the transaction.

import * as A from "./analytics.js";
import * as charts from "./charts.js";
import * as fmt from "./format.js";
import { filters } from "./filters.js";
import * as views from "./views.js";

const $ = (id) => document.getElementById(id);
const FLAGGED = 2; // series slot: orange = flagged, everywhere on the page
const CLEAR = 1;   // teal = not flagged

// Charts are drawn from the sample, so clicks filter the sample ("recent" tab); a click
// on an orange (dataset 1) segment also narrows to flagged rows, matching the bar.
const flaggedIf = (datasetIndex, filter) => (datasetIndex === 1 ? filters.flagged(filter) : filter);

function drawGroups(id, groups, makeFilter, onFilter) {
  const shown = groups.filter((g) => g.key !== "Other").map((g) => g.key);
  charts.bars(id, { horizontal: true, labels: groups.map((g) => g.key), yFormat: fmt.count,
    datasets: [{ label: "Flagged", data: groups.map((g) => g.flagged), slot: FLAGGED }],
    tooltipLabel: (ctx) => {
      const g = groups[ctx.dataIndex];
      return ` ${fmt.count(g.flagged)} flagged of ${fmt.count(g.total)} (${fmt.percent(g.rate)})`;
    },
    onPick: (i) => onFilter(filters.flagged(makeFilter(groups[i].key, shown)), "recent") });
}

/**
 * @param {object[]} items newest-first transactions in the window
 * @param {object} summary analytics.summarize(items)
 * @param {{onFilter: (filter: object, tab: string) => void, onOpen: (eventId: string) => void}} actions
 */
export function drawActivity(items, summary, { onFilter, onOpen }) {
  $("activity-sub").textContent = `Based on the latest ${fmt.count(items.length)} transactions. `
    + "Orange = flagged by the model, teal = not flagged. Click any bar to list those transactions.";

  const volume = A.volumeSeries(items);
  $("volume-sub").textContent = `Arrivals per ${fmt.duration(volume.bucketSeconds * 1000)} (emitted_at)`;
  charts.bars("c-volume", { stacked: true, yFormat: fmt.count,
    labels: volume.buckets.map((b) => fmt.clock(b.t, volume.bucketSeconds < 60)),
    datasets: [{ label: "Not flagged", data: volume.buckets.map((b) => b.total - b.flagged), slot: CLEAR },
      { label: "Flagged", data: volume.buckets.map((b) => b.flagged), slot: FLAGGED }],
    onPick: (i, ds) => onFilter(flaggedIf(ds, filters.arrival(volume.buckets[i].t, volume.bucketSeconds)),
      "recent") });

  const hist = A.scoreHistogram(items, 20, summary.threshold);
  $("hist-sub").textContent = `Orange bins are at or above the ${summary.threshold} alert threshold`;
  charts.bars("c-hist", { stacked: true, yFormat: fmt.count, labels: hist.bins.map((b) => b.from.toFixed(2)),
    datasets: [{ label: "Below threshold", data: hist.bins.map((b) => b.below), slot: CLEAR },
      { label: "At or above threshold", data: hist.bins.map((b) => b.above), slot: FLAGGED }],
    onPick: (i) => onFilter(filters.score(hist.bins[i].from, hist.bins[i].to), "recent") });

  drawGroups("c-category", A.groupBy(items, (i) => fmt.label(i.features?.category), 10),
    filters.category, onFilter);
  drawGroups("c-state", A.groupBy(items, (i) => i.features?.state, 10), filters.state, onFilter);

  const hours = A.hourProfile(items);
  charts.bars("c-hour", { stacked: true, labels: hours.map((h) => String(h.hour)), yFormat: fmt.count,
    datasets: [{ label: "Not flagged", data: hours.map((h) => h.total - h.flagged), slot: CLEAR },
      { label: "Flagged", data: hours.map((h) => h.flagged), slot: FLAGGED }],
    tooltipLabel: (ctx) => {
      const h = hours[ctx.dataIndex];
      return ` ${ctx.dataset.label}: ${fmt.count(ctx.raw)} (${fmt.percent(h.rate)} of hour ${h.hour} flagged)`;
    },
    onPick: (i, ds) => onFilter(flaggedIf(ds, filters.hour(i)), "recent") });

  const points = A.scatterPoints(items);
  const sets = [points.other, points.flagged];
  charts.scatter("c-scatter", { xType: "logarithmic", xTitle: "Amount (log scale)", yTitle: "Fraud score", yMax: 1,
    xFormat: (_, v) => fmt.amount(v).replace(".00", ""),
    datasets: [{ label: "Not flagged", data: points.other, slot: CLEAR },
      { label: "Flagged", data: points.flagged, slot: FLAGGED }],
    tooltipLabel: (ctx) => ` ${fmt.amount(ctx.raw.x)} · score ${fmt.score(ctx.raw.y)} (click to open)`,
    onPick: (i, ds) => onOpen(sets[ds][i].id) });

  views.renderLabelCheck($("label-check"), A.labelCheck(items));
  views.renderStatus($("status"), summary);
}
