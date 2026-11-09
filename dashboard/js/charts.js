// Chart.js wrappers: thin marks, recessive grid, theme colors from CSS tokens.

const charts = new Map();
const FONT = { family: 'system-ui, -apple-system, "Segoe UI", sans-serif', size: 11 };

let probe;
/** A color token resolved for the current theme (custom properties keep light-dark() unresolved). */
function token(name) {
  probe ??= document.body.appendChild(Object.assign(document.createElement("i"), { hidden: true }));
  probe.style.color = `var(${name})`;
  return getComputedStyle(probe).color;
}

function series(slot) {
  return token(`--series-${slot}`);
}

const crosshair = {
  id: "crosshair",
  afterDatasetsDraw(chart) {
    const active = chart.tooltip?.getActiveElements?.() ?? [];
    if (!active.length || chart.config.type !== "line") return;
    const { ctx, chartArea } = chart;
    const x = active[0].element.x;
    ctx.save();
    Object.assign(ctx, { strokeStyle: token("--axis"), lineWidth: 1 });
    ctx.beginPath();
    ctx.moveTo(x, chartArea.top);
    ctx.lineTo(x, chartArea.bottom);
    ctx.stroke();
    ctx.restore();
  },
};

function pickHandlers(onPick) {
  if (!onPick) return {};
  return {
    onClick: (_, elements) => {
      if (elements.length) onPick(elements[0].index, elements[0].datasetIndex);
    },
    onHover: (event, elements) => {
      event.native.target.style.cursor = elements.length ? "pointer" : "default";
    },
  };
}

function baseOptions({ legend, yFormat, xFormat, horizontal = false, stacked = false,
  tooltipLabel, yMax, xType = "category", onPick }) {
  const grid = { color: token("--grid"), lineWidth: 1, drawTicks: false };
  const ticks = { color: token("--text-muted"), font: FONT, padding: 6, maxRotation: 0, autoSkipPadding: 12 };
  // Only override Chart.js' tick formatter when one is given (undefined would blank it).
  const valueAxis = { stacked, beginAtZero: true, grid, border: { display: false }, max: yMax,
    ticks: { ...ticks, precision: 0, ...(yFormat ? { callback: (v) => yFormat(v) } : {}) } };
  const categoryAxis = { type: xType, stacked, grid: { display: false },
    border: { color: token("--axis") },
    ticks: { ...ticks, ...(xFormat ? { callback(v) { return xFormat(this.getLabelForValue(v), v); } } : {}) } };
  return {
    responsive: true, maintainAspectRatio: false, animation: false, indexAxis: horizontal ? "y" : "x",
    interaction: { mode: horizontal ? "nearest" : "index", intersect: horizontal, axis: horizontal ? "y" : "x" },
    layout: { padding: { top: 4, right: 8 } },
    ...pickHandlers(onPick),
    // Horizontal bars list categories: show every label (at most ~11), never auto-skip.
    scales: horizontal ? { x: valueAxis, y: { ...categoryAxis, ticks: { ...categoryAxis.ticks, autoSkip: false } } }
      : { x: categoryAxis, y: valueAxis },
    plugins: {
      legend: { display: legend, position: "top", align: "start",
        labels: { color: token("--text-secondary"), font: FONT, usePointStyle: true,
          pointStyle: "rectRounded", boxWidth: 8, boxHeight: 8, padding: 12 } },
      tooltip: { backgroundColor: token("--surface-raised"), titleColor: token("--text-primary"),
        bodyColor: token("--text-secondary"), borderColor: token("--border"), borderWidth: 1,
        padding: 10, boxPadding: 4, usePointStyle: true, titleFont: { ...FONT, weight: "600" },
        bodyFont: FONT, callbacks: tooltipLabel ? { label: tooltipLabel } : {} },
    },
  };
}

function draw(id, config) {
  const canvas = document.getElementById(id);
  if (!canvas || !window.Chart) return;
  const existing = charts.get(id);
  if (existing && existing.data.datasets.length === config.data.datasets.length) {
    // Update in place so Chart.js keeps per-dataset state such as legend-hidden series.
    existing.data.labels = config.data.labels;
    config.data.datasets.forEach((d, k) => Object.assign(existing.data.datasets[k], d));
    existing.options = config.options;
    existing.update("none");
    return;
  }
  existing?.destroy();
  charts.set(id, new window.Chart(canvas, { ...config, plugins: [crosshair] }));
}

/** Forget every chart (after a theme change) so the next draw picks up new tokens. */
export function resetAll() {
  for (const chart of charts.values()) chart.destroy();
  charts.clear();
}

const barStyle = (color, rounded = true) => ({
  backgroundColor: color, hoverBackgroundColor: color,
  borderColor: token("--surface"), borderWidth: { top: 2 }, // 2px surface gap between stacks
  borderRadius: rounded ? 4 : 0, borderSkipped: "start",
  maxBarThickness: 24, categoryPercentage: 0.88, barPercentage: 0.9,
});

/** Vertical or horizontal bars; with stacked=true only the top dataset gets the rounded end. */
export function bars(id, spec) {
  const { labels, datasets, stacked = false } = spec;
  draw(id, {
    type: "bar",
    data: { labels, datasets: datasets.map((d, k) => ({
      label: d.label, data: d.data,
      ...barStyle(series(d.slot), !stacked || k === datasets.length - 1),
      ...(spec.horizontal ? { borderWidth: { right: 0 } } : {}),
    })) },
    options: baseOptions({ ...spec, legend: datasets.length > 1, stacked }),
  });
}

// A value with no neighbours (5-minute EC2 CPU on a 1-minute grid) is drawn as a dot.
function isolatedPoint({ dataset: { data }, dataIndex: i }) {
  return data[i] != null && data[i - 1] == null && data[i + 1] == null ? 3 : 0;
}

/** Time-series lines on a shared x grid; nulls stay gaps (no data), never zero. */
export function lines(id, spec) {
  const { labels, datasets } = spec;
  draw(id, {
    type: "line",
    data: { labels, datasets: datasets.map((d) => ({
      label: d.label, data: d.data, borderColor: series(d.slot), backgroundColor: series(d.slot),
      borderWidth: 2, borderJoinStyle: "round", borderCapStyle: "round",
      pointRadius: isolatedPoint, pointHoverRadius: 4, pointHoverBorderWidth: 2, pointHoverBorderColor: token("--surface"),
      pointHitRadius: 8, tension: 0, spanGaps: false, fill: false,
    })) },
    options: baseOptions({ ...spec, legend: datasets.length > 1 }),
  });
}

/** Scatter of {x, y} points; 8px markers with a 2px surface ring. */
export function scatter(id, spec) {
  const { datasets } = spec;
  const options = baseOptions({ ...spec, legend: datasets.length > 1, xType: spec.xType ?? "linear" });
  options.interaction = { mode: "nearest", intersect: true };
  const title = (text) => ({ display: Boolean(text), text, color: token("--text-muted"), font: FONT });
  options.scales.x = { ...options.scales.x, grid: { color: token("--grid"), drawTicks: false }, title: title(spec.xTitle) };
  options.scales.y = { ...options.scales.y, ticks: { ...options.scales.y.ticks, precision: 1 }, title: title(spec.yTitle) };
  draw(id, {
    type: "scatter",
    data: { datasets: datasets.map((d) => ({
      label: d.label, data: d.data, backgroundColor: series(d.slot),
      borderColor: token("--surface"), borderWidth: 2, pointRadius: 4, pointHoverRadius: 6, pointHitRadius: 6,
    })) },
    options,
  });
}
