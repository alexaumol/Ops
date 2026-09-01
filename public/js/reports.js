/**
 * HITT Ops — Reports
 * ---------------------------------------------------------------------------
 * New module, no direct Access precedent (closest analogue was the
 * per-employee "TimeAllocationLog" report). Tabs:
 *
 *   Project stats       Charts: projects by status/entity, opened vs
 *                        closed by month, the status-change timeline, and
 *                        stale open projects.
 *   Hours per project   SUM(projectstimetracking.projtimetrackhours) per
 *                        project over an optional date range.
 *
 * (The company-holidays + time-off + birthdays calendar that used to be
 * the "Resource leaves" tab moved to the Time allocation page.)
 * ---------------------------------------------------------------------------
 */

const session = HITT_AUTH.requireSession("../index.html");
document.getElementById("userName").textContent = session.displayName;
document.getElementById("userAvatar").textContent = HITT_AUTH.initials(session);
document.getElementById("btnSignOut").addEventListener("click", () => HITT_AUTH.signOut("../index.html"));
HITT_PERMS.guardModule("reports", "../welcome.html");
const T = (k, v) => (window.HITT_I18N ? HITT_I18N.t(k, v) : k);
HITT_PERMS.applyRealName();

function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s ?? "";
  return d.innerHTML;
}

function toast(msg, tone = "navy") {
  const host = document.getElementById("toastHost");
  const el = document.createElement("div");
  el.className = `toast toast-${tone}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function csvEscape(value) {
  const s = String(value ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function downloadCsv(filename, headers, rows) {
  const lines = [headers.map(csvEscape).join(","), ...rows.map((r) => r.map(csvEscape).join(","))];
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Project status → chip colour, kept consistent with the Projects kanban
// column colours (see STAGE_STYLE_BY_KEY in js/projects.js). Matched on the
// lower-cased status label; anything unrecognised falls back to neutral grey.
const STATUS_CHIP_COLORS = {
  lead: "#5C757C",
  oferta: "#BC9A1C",
  guanyat: "#6E8F5A",
  wip: "#171717",
  delivered: "#211916",
  closed: "#8A8676",
  cancelled: "#B24A3A",
};
function statusChipHtml(label) {
  if (!label) return "—";
  const color = STATUS_CHIP_COLORS[String(label).trim().toLowerCase()] || "#8A8676";
  return `<span class="rpt-status-chip" style="background:${color}">${escapeHtml(label)}</span>`;
}

/* ============================== PAGE TABS ================================= */
let currentTab = "stats";
document.querySelectorAll("[data-rtab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-rtab]").forEach((b) => b.setAttribute("aria-selected", "false"));
    btn.setAttribute("aria-selected", "true");
    currentTab = btn.dataset.rtab;
    document.getElementById("paneHours").classList.toggle("hidden", currentTab !== "hours");
    document.getElementById("paneStats").classList.toggle("hidden", currentTab !== "stats");
    if (currentTab === "hours" && !hoursLoaded) { hoursLoaded = true; loadHours(); }
    if (currentTab === "stats" && !statsLoaded) { statsLoaded = true; loadStats(); }
  });
});
let statsLoaded = false;
let hoursLoaded = false;

/* ============================== HOURS PER PROJECT ========================= */
const hoursStartInput = document.getElementById("hoursStartDate");
const hoursEndInput = document.getElementById("hoursEndDate");

function setThisYearRange() {
  const year = new Date().getFullYear();
  hoursStartInput.value = `${year}-01-01`;
  hoursEndInput.value = `${year}-12-31`;
}
setThisYearRange();

let lastHoursRows = [];

async function loadHours() {
  const tbody = document.getElementById("hoursTableBody");
  const empty = document.getElementById("hoursEmpty");
  tbody.innerHTML = `<tr><td colspan="8" class="sub-empty">${T('common.loading')}</td></tr>`;
  empty.classList.add("hidden");
  try {
    const rows = await HITT_API.getHoursPerProject(hoursStartInput.value || null, hoursEndInput.value || null);
    lastHoursRows = rows;
    if (!rows.length) {
      tbody.innerHTML = "";
      empty.classList.remove("hidden");
      document.getElementById("hoursTotal").textContent = "";
      return;
    }
    tbody.innerHTML = rows.map((r) => `
      <tr data-project-id="${r.projectId}" data-project-name="${escapeHtml(r.name)}" title="${T('rpt.tip.drillRow')}">
        <td>
          <div><a href="projects.html?projectId=${encodeURIComponent(r.projectId)}">${escapeHtml(r.name)}</a></div>
          <div class="rpt-proj-code">${escapeHtml(r.code)}</div>
        </td>
        <td>${escapeHtml(r.ownerName || "—")}</td>
        <td>${escapeHtml(r.entityLabel || "—")}</td>
        <td>${statusChipHtml(r.statusLabel)}</td>
        <td style="text-align:right; font-weight:700;">${Number(r.totalHours).toLocaleString()}</td>
        <td style="text-align:right; color:var(--text-secondary);">${Number(r.poHours).toLocaleString()}</td>
        <td style="text-align:right; color:var(--text-secondary);">${Number(r.resHours).toLocaleString()}</td>
        <td style="text-align:right;">${r.employeeCount}</td>
      </tr>
    `).join("");
    const total = rows.reduce((sum, r) => sum + Number(r.totalHours), 0);
    document.getElementById("hoursTotal").textContent = T('rpt.hours.total', { hours: total.toLocaleString(), projects: rows.length });
  } catch (err) {
    console.error("[reports] failed to load hours-per-project:", err.message);
    lastHoursRows = [];
    tbody.innerHTML = "";
    empty.textContent = T('rpt.err.report');
    empty.classList.remove("hidden");
    toast(T('rpt.toast.hoursFail'), "red");
  }
}

hoursStartInput.addEventListener("change", loadHours);
hoursEndInput.addEventListener("change", loadHours);
document.getElementById("btnHoursThisYear").addEventListener("click", () => { setThisYearRange(); loadHours(); });
document.getElementById("btnHoursAllTime").addEventListener("click", () => {
  hoursStartInput.value = "";
  hoursEndInput.value = "";
  loadHours();
});
document.getElementById("btnHoursExport").addEventListener("click", () => {
  if (!lastHoursRows.length) { toast(T('rpt.nothingToExport'), "navy"); return; }
  const range = hoursStartInput.value || hoursEndInput.value
    ? `${hoursStartInput.value || "start"}_to_${hoursEndInput.value || "end"}`
    : "all-time";
  downloadCsv(
    `hours-per-project_${range}.csv`,
    [T('rpt.csv.projectCode'), T('rpt.csv.projectName'), T('rpt.csv.projectOwner'), T('rpt.csv.entity'), T('rpt.csv.status'), T('rpt.csv.totalHours'), T('rpt.csv.poHours'), T('rpt.csv.resHours'), T('rpt.csv.resources')],
    lastHoursRows.map((r) => [r.code, r.name, r.ownerName || "", r.entityLabel || "", r.statusLabel || "", r.totalHours, r.poHours, r.resHours, r.employeeCount])
  );
});

document.getElementById("hoursTableBody").addEventListener("click", (e) => {
  if (e.target.closest("a")) return; // let the project-name link navigate
  const row = e.target.closest("tr[data-project-id]");
  if (!row) return;
  openDrillDown(row.dataset.projectId, row.dataset.projectName);
});

/* ---------- Per-employee drill-down modal ---------- */
const drillOverlay = document.getElementById("drillOverlay");
let lastDrillRows = [];
let lastDrillProjectName = "";

async function openDrillDown(projectId, projectName) {
  lastDrillProjectName = projectName;
  document.getElementById("drillTitle").textContent = projectName;
  document.getElementById("drillTableBody").innerHTML = `<tr><td colspan="4" class="sub-empty">${T('common.loading')}</td></tr>`;
  document.getElementById("drillEmpty").classList.add("hidden");
  drillOverlay.classList.remove("hidden");
  try {
    const rows = await HITT_API.getHoursPerProjectDetail(projectId, hoursStartInput.value || null, hoursEndInput.value || null);
    lastDrillRows = rows;
    const tbody = document.getElementById("drillTableBody");
    if (!rows.length) {
      tbody.innerHTML = "";
      document.getElementById("drillEmpty").classList.remove("hidden");
      return;
    }
    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td>${escapeHtml(r.employeeName)}</td>
        <td style="text-align:right; font-weight:700;">${Number(r.totalHours).toLocaleString()}</td>
        <td style="text-align:right; color:var(--text-secondary);">${Number(r.poHours).toLocaleString()}</td>
        <td style="text-align:right; color:var(--text-secondary);">${Number(r.resHours).toLocaleString()}</td>
      </tr>
    `).join("");
  } catch (err) {
    console.error("[reports] failed to load project drill-down:", err.message);
    lastDrillRows = [];
    document.getElementById("drillTableBody").innerHTML = "";
    document.getElementById("drillEmpty").textContent = T('rpt.err.breakdown');
    document.getElementById("drillEmpty").classList.remove("hidden");
  }
}

function closeDrillDown() { drillOverlay.classList.add("hidden"); }
document.getElementById("drillClose").addEventListener("click", closeDrillDown);
drillOverlay.addEventListener("click", (e) => { if (e.target === drillOverlay) closeDrillDown(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !drillOverlay.classList.contains("hidden")) closeDrillDown();
});
document.getElementById("drillExport").addEventListener("click", () => {
  if (!lastDrillRows.length) { toast(T('rpt.nothingToExport'), "navy"); return; }
  downloadCsv(
    `hours_${lastDrillProjectName.replace(/[^\w-]+/g, "_")}.csv`,
    [T('rpt.csv.employee'), T('rpt.csv.totalHours'), T('rpt.csv.poHours'), T('rpt.csv.resHours')],
    lastDrillRows.map((r) => [r.employeeName, r.totalHours, r.poHours, r.resHours])
  );
});

/* ============================== PROJECT STATS ============================ */
const ENTITY_COLORS = {
  "HiTT": "#5C757C",       // --hitt-teal
  "FHiTT": "#B3B07D",      // --hitt-olive
  "HiTT/OSM": "#BC9A1C",   // --hitt-amber
  "Unassigned": "#ABAF96", // --hitt-sage
};
const ENTITY_ORDER = ["HiTT", "FHiTT", "HiTT/OSM", "Unassigned"];
const MONTH_LABELS = () => T('common.monthsShort').split('|');

// Rounds a max value up to a "nice" chart ceiling divisible by 5, so the
// gridline labels (0/25/50/75/100%) come out as clean integers instead of
// e.g. 13.75. Floors at 5 so an all-zero dataset still draws a usable axis.
// Used for project-count scales (small integers) — see niceCeilMagnitude
// below for the currency scale, which needs a different step size.
function niceCeil(max) {
  return Math.max(5, Math.ceil(max / 5) * 5);
}

// Same idea as niceCeil but for values that can span orders of magnitude
// (budget euros, hundreds to hundreds of thousands) — a flat ÷5 step would
// produce ugly ceilings like 47330. Picks the next 1/2/5×10^n above max,
// the standard "nice numbers" chart-axis approach.
function niceCeilMagnitude(max) {
  if (max <= 0) return 100;
  const magnitude = Math.pow(10, Math.floor(Math.log10(max)));
  const residual = max / magnitude;
  const niceResidual = residual <= 1 ? 1 : residual <= 2 ? 2 : residual <= 5 ? 5 : 10;
  return niceResidual * magnitude;
}

// Full precision, for tooltips/CSV — matches the EUR formatting already
// established in invoicing.js's formatMoney.
function formatMoney(n) {
  return Number(n).toLocaleString(undefined, { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
}
// Compact, for axis/bar labels where full "€225,000.00" would crowd a
// narrow chart — "€225k", "€1.2M".
function formatCompactCurrency(n) {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `€${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `€${Math.round(n / 1000)}k`;
  return `€${Math.round(n)}`;
}

let lastStatusEntityRows = [];
let lastOpenedRows = [];
let lastTimelineRows = [];
let lastStaleRows = [];

const statusYearSelect = document.getElementById("statusYearSelect");
const statusMetricSelect = document.getElementById("statusMetricSelect");

async function loadStats() {
  await Promise.all([loadYearsThenCharts(), loadTimeline(), loadStaleProjects()]);
}

// Populates both year dropdowns (status chart + opened/closed chart) from
// one shared GET /api/reports/project-years call, then loads both charts.
// Status chart defaults to "All years" (matches its original all-time
// behavior, before this dropdown existed); opened/closed still defaults
// to the current year (its "All years" option — aggregating every year
// per calendar month — exists but isn't the default, so the chart doesn't
// change appearance for anyone who already had it open).
async function loadYearsThenCharts() {
  let years = [];
  try {
    years = await HITT_API.getProjectYears();
  } catch (err) {
    console.error("[reports] failed to load project-years:", err.message);
  }
  const currentYear = new Date().getFullYear();
  const yearOptions = years.length ? years : [currentYear];
  const allYearsOption = `<option value="">All years</option>`;

  statusYearSelect.innerHTML = allYearsOption + yearOptions.map((y) => `<option value="${y}">${y}</option>`).join("");
  statusYearSelect.value = "";

  openedYearSelect.innerHTML = allYearsOption + yearOptions.map((y) => `<option value="${y}">${y}</option>`).join("");
  openedYearSelect.value = yearOptions.includes(currentYear) ? String(currentYear) : String(yearOptions[0]);

  await Promise.all([loadStatusChart(), loadOpenedChart()]);
}

/* ---------- Bar chart: projects by status x entity ---------- */
async function loadStatusChart() {
  const el = document.getElementById("statusChart");
  el.innerHTML = `<div class="rpt-chart-empty">${T('common.loading')}</div>`;
  try {
    const rows = await HITT_API.getProjectsByStatusEntity(statusYearSelect.value || undefined);
    lastStatusEntityRows = rows;
    renderStatusChart(rows);
  } catch (err) {
    console.error("[reports] failed to load projects-by-status-entity:", err.message);
    lastStatusEntityRows = [];
    el.innerHTML = `<div class="rpt-chart-empty">${T('rpt.err.chart')}</div>`;
    toast(T('rpt.toast.statusChartFail'), "red");
  }
}

statusYearSelect.addEventListener("change", loadStatusChart);
// Both metrics come back in the same response (see routes/reports.js) —
// switching the dropdown just re-renders already-loaded data, no re-fetch.
statusMetricSelect.addEventListener("change", () => renderStatusChart(lastStatusEntityRows));

function renderStatusChart(rows) {
  const el = document.getElementById("statusChart");
  if (!rows.length) { el.innerHTML = `<div class="rpt-chart-empty">${T('rpt.noData')}</div>`; return; }

  // "Total" = project count; "Budgeted" = sum of each project's latest
  // projectquotations.finalquotation (see routes/reports.js — both come
  // back in every row, this just picks which field to plot).
  const isBudget = statusMetricSelect.value === "budget";
  const metricField = isBudget ? "budget" : "count";
  const fmtAxis = isBudget ? formatCompactCurrency : (v) => v;
  const fmtFull = isBudget ? formatMoney : (v) => v;

  const statuses = [];
  const byStatus = new Map();
  rows.forEach((r) => {
    if (!byStatus.has(r.statusId)) {
      byStatus.set(r.statusId, { label: r.statusLabel, entities: new Map(), counts: new Map(), total: 0 });
      statuses.push(r.statusId);
    }
    const group = byStatus.get(r.statusId);
    group.entities.set(r.entityLabel, Number(r[metricField]));
    group.counts.set(r.entityLabel, Number(r.count)); // kept for tooltip context even in Budgeted mode
    group.total += Number(r[metricField]);
  });
  const entitiesPresent = ENTITY_ORDER.filter((e) => rows.some((r) => r.entityLabel === e));
  const entities = entitiesPresent.length ? entitiesPresent : ENTITY_ORDER;

  // Bars use one real scale (whichever metric is selected). The total
  // line is NOT plotted against a value axis at all — it just floats a
  // fixed distance above whichever bar is tallest in each group, so it
  // (and its value labels) never collides with a bar's own value label
  // regardless of how big the total is relative to the bars. MT is
  // generous specifically to leave room for this floating line + its
  // labels above the tallest possible bar.
  const maxBar = Math.max(0, ...rows.map((r) => Number(r[metricField])));
  const yMaxBars = isBudget ? niceCeilMagnitude(maxBar) : niceCeil(maxBar);

  // W is 1200 (not the usual ~480) specifically to shrink the RENDERED
  // height: this SVG is width:100%/height:auto (see reports.css), so its
  // on-screen height is container-width * H/W. Widening W keeps H and
  // every absolute layout constant below (MT/MB, label font sizes, the
  // -40deg rotation) unchanged and correctly proportioned, while the
  // wider coordinate system alone makes the rendered aspect ratio — and
  // therefore the on-screen height — 40% of what it was (a 60% cut) at
  // the same on-screen width. This card is full-width, unlike the other
  // charts on this page, which is why only this one was oversized.
  const W = 1200, H = 320, ML = isBudget ? 44 : 32, MR = 8, MT = 34, MB = 58;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const groupW = plotW / statuses.length;
  const barGap = groupW * 0.1;
  const groupInner = groupW - barGap * 2;
  const barW = groupInner / entities.length;
  const yScaleBars = (v) => plotH - (v / yMaxBars) * plotH;
  const FLOAT_GAP = 16; // px the total line floats above each group's tallest bar

  let svg = "";
  for (let i = 0; i <= 4; i++) {
    const val = Math.round((yMaxBars * i) / 4);
    const y = MT + yScaleBars(val);
    svg += `<line class="rpt-chart-gridline" x1="${ML}" y1="${y}" x2="${W - MR}" y2="${y}" />`;
    svg += `<text class="rpt-chart-label" x="${ML - 6}" y="${y + 3}" text-anchor="end">${fmtAxis(val)}</text>`;
  }
  svg += `<line class="rpt-chart-axis" x1="${ML}" y1="${MT}" x2="${ML}" y2="${MT + plotH}" />`;
  svg += `<line class="rpt-chart-axis" x1="${ML}" y1="${MT + plotH}" x2="${W - MR}" y2="${MT + plotH}" />`;

  statuses.forEach((statusId, si) => {
    const group = byStatus.get(statusId);
    const gx = ML + si * groupW + barGap;
    let tallestBarTopY = MT + plotH; // tracks the highest (smallest y) bar top in this group
    entities.forEach((entityLabel, ei) => {
      const value = group.entities.get(entityLabel) || 0;
      const barH = (value / yMaxBars) * plotH;
      const x = gx + ei * barW;
      const y = MT + plotH - barH;
      tallestBarTopY = Math.min(tallestBarTopY, y);
      const tooltip = isBudget
        ? T('rpt.chart.tooltipBudget', { status: escapeHtml(group.label), entity: escapeHtml(entityLabel), value: fmtFull(value), n: group.counts.get(entityLabel) || 0 })
        : T('rpt.chart.tooltip', { status: escapeHtml(group.label), entity: escapeHtml(entityLabel), value });
      svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW * 0.82).toFixed(1)}" height="${barH.toFixed(1)}" fill="${ENTITY_COLORS[entityLabel] || "#999"}" rx="2">
        <title>${tooltip}</title>
      </rect>`;
      if (value > 0) {
        svg += `<text class="rpt-chart-value" x="${(x + barW * 0.41).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle">${fmtAxis(value)}</text>`;
      }
    });
    group.floatY = tallestBarTopY - FLOAT_GAP;
    const labelX = ML + si * groupW + groupW / 2;
    const labelY = MT + plotH + 14;
    svg += `<text class="rpt-chart-label" x="${labelX.toFixed(1)}" y="${labelY}" text-anchor="end" transform="rotate(-40 ${labelX.toFixed(1)} ${labelY})">${escapeHtml(group.label)}</text>`;
  });

  // Total-per-status line, floating above the bars (see FLOAT_GAP above —
  // not a scaled data series), drawn last so it layers on top.
  const totalPoints = statuses.map((statusId, si) => {
    const group = byStatus.get(statusId);
    return { x: ML + si * groupW + groupW / 2, y: group.floatY, total: group.total };
  });
  svg += `<polyline class="rpt-chart-line rpt-chart-line--total" points="${totalPoints.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}" />`;
  totalPoints.forEach((p, si) => {
    svg += `<circle class="rpt-chart-dot rpt-chart-dot--total" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5"><title>${T('rpt.chart.groupTotal', { status: escapeHtml(byStatus.get(statuses[si]).label), value: fmtFull(p.total) })}</title></circle>`;
    svg += `<text class="rpt-chart-value" style="font-weight:700;" x="${p.x.toFixed(1)}" y="${(p.y - 8).toFixed(1)}" text-anchor="middle">${fmtAxis(p.total)}</text>`;
  });

  const legend = entities.map((e) => `
    <span class="rpt-legend-item"><span class="rpt-swatch" style="background:${ENTITY_COLORS[e] || "#999"}"></span>${escapeHtml(e)}</span>
  `).join("") + `
    <span class="rpt-legend-item"><span class="rpt-swatch" style="width:14px; height:3px; border-radius:2px; background:var(--text-primary);"></span>${T('rpt.legend.total')}</span>
  `;

  el.innerHTML = `
    <svg class="rpt-chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Projects by status and entity, ${isBudget ? "budgeted amount" : "count"}">${svg}</svg>
    <div class="rpt-legend" style="margin-top:0.5rem;">${legend}</div>
  `;
}

document.getElementById("btnStatusExport").addEventListener("click", () => {
  if (!lastStatusEntityRows.length) { toast(T('rpt.nothingToExport'), "navy"); return; }
  downloadCsv(
    "projects-by-status-entity.csv",
    [T('rpt.csv.status'), T('rpt.csv.entity'), T('rpt.csv.count'), T('rpt.csv.budgetEur')],
    lastStatusEntityRows.map((r) => [r.statusLabel, r.entityLabel, r.count, r.budget])
  );
});

/* ---------- Line chart: projects opened by month ---------- */
const openedYearSelect = document.getElementById("openedYearSelect");

async function loadOpenedChart() {
  const el = document.getElementById("openedChart");
  el.innerHTML = `<div class="rpt-chart-empty">${T('common.loading')}</div>`;
  try {
    const rows = await HITT_API.getProjectsOpenedByMonth(openedYearSelect.value);
    lastOpenedRows = rows;
    renderOpenedChart(rows);
  } catch (err) {
    console.error("[reports] failed to load projects-opened-by-month:", err.message);
    lastOpenedRows = [];
    el.innerHTML = `<div class="rpt-chart-empty">${T('rpt.err.chart')}</div>`;
    toast(T('rpt.toast.openedChartFail'), "red");
  }
}

// Two series: openings (from projects.entrydate) and closures (from
// projectstatushistory, newstatusid = Closed — see routes/reports.js).
// The closures series will read as sparse/zero for any month before the
// timeline log existed, same caveat as the Project timeline table below.
function renderOpenedChart(rows) {
  const el = document.getElementById("openedChart");
  const opened = rows.map((r) => Number(r.openedCount));
  const closed = rows.map((r) => Number(r.closedCount));
  const maxCount = Math.max(0, ...opened, ...closed);
  const yMax = niceCeil(maxCount);

  const W = 480, H = 300, ML = 32, MR = 8, MT = 10, MB = 32;
  const plotW = W - ML - MR, plotH = H - MT - MB;
  const stepX = plotW / (opened.length - 1 || 1);
  const yScale = (v) => plotH - (v / yMax) * plotH;

  let svg = "";
  for (let i = 0; i <= 4; i++) {
    const val = Math.round((yMax * i) / 4);
    const y = MT + yScale(val);
    svg += `<line class="rpt-chart-gridline" x1="${ML}" y1="${y}" x2="${W - MR}" y2="${y}" />`;
    svg += `<text class="rpt-chart-label" x="${ML - 6}" y="${y + 3}" text-anchor="end">${val}</text>`;
  }
  svg += `<line class="rpt-chart-axis" x1="${ML}" y1="${MT}" x2="${ML}" y2="${MT + plotH}" />`;
  svg += `<line class="rpt-chart-axis" x1="${ML}" y1="${MT + plotH}" x2="${W - MR}" y2="${MT + plotH}" />`;

  function seriesPoints(values) {
    return values.map((v, i) => ({ x: ML + i * stepX, y: MT + yScale(v), v }));
  }
  // Every dot is clickable — data-month/data-type identify it for the
  // delegated click handler below (openedChart.addEventListener), which
  // opens the month-detail modal listing the actual projects behind it.
  function drawSeries(values, lineClass, dotClass, type, label) {
    const pts = seriesPoints(values);
    svg += `<polyline class="${lineClass}" points="${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")}" />`;
    pts.forEach((p, i) => {
      svg += `<circle class="${dotClass} rpt-chart-dot--clickable" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" data-month="${i + 1}" data-type="${type}"><title>${T('rpt.chart.dotTooltip', { month: MONTH_LABELS()[i], series: label, value: p.v })}</title></circle>`;
    });
  }
  drawSeries(opened, "rpt-chart-line", "rpt-chart-dot", "opened", T('rpt.series.opened'));
  drawSeries(closed, "rpt-chart-line rpt-chart-line--closed", "rpt-chart-dot rpt-chart-dot--closed", "closed", T('rpt.series.closed'));

  MONTH_LABELS().forEach((label, i) => {
    const x = ML + i * stepX;
    svg += `<text class="rpt-chart-label" x="${x.toFixed(1)}" y="${MT + plotH + 20}" text-anchor="middle">${label}</text>`;
  });

  el.innerHTML = `
    <svg class="rpt-chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Projects opened and closed by month">${svg}</svg>
    <div class="rpt-legend" style="margin-top:0.5rem;">
      <span class="rpt-legend-item"><span class="rpt-swatch" style="width:14px; height:3px; border-radius:2px; background:var(--brand);"></span>${T('rpt.series.opened')}</span>
      <span class="rpt-legend-item"><span class="rpt-swatch" style="width:14px; height:3px; border-radius:2px; background:var(--hitt-amber);"></span>${T('rpt.series.closed')}</span>
    </div>
  `;
}

openedYearSelect.addEventListener("change", loadOpenedChart);

document.getElementById("btnOpenedExport").addEventListener("click", () => {
  if (!lastOpenedRows.length) { toast(T('rpt.nothingToExport'), "navy"); return; }
  downloadCsv(
    `projects-opened-closed_${openedYearSelect.value || "all-years"}.csv`,
    [T('rpt.csv.month'), T('rpt.series.opened'), T('rpt.series.closed')],
    lastOpenedRows.map((r) => [MONTH_LABELS()[r.month - 1], r.openedCount, r.closedCount])
  );
});

// Attached once (not per-render) — el's innerHTML is replaced on every
// renderOpenedChart() call, but el itself persists, so delegation still
// finds the current dots.
document.getElementById("openedChart").addEventListener("click", (e) => {
  const dot = e.target.closest("circle[data-month]");
  if (!dot) return;
  // openedYearSelect.value is "" in All-years mode — passed through as
  // falsy so the drill-down aggregates across every year too, matching
  // whatever the chart itself is currently showing.
  openMonthDetail(dot.dataset.type, openedYearSelect.value ? Number(openedYearSelect.value) : null, Number(dot.dataset.month));
});

/* ---------- Month detail modal (line chart drill-down) ---------- */
const monthDetailOverlay = document.getElementById("monthDetailOverlay");

async function openMonthDetail(type, year, month) {
  const label = T('rpt.monthDetail.title', { series: type === "closed" ? T('rpt.series.closed') : T('rpt.series.opened'), month: MONTH_LABELS()[month - 1], year: year || T('rpt.allYears') });
  document.getElementById("monthDetailTitle").textContent = label;
  document.getElementById("monthDetailTableBody").innerHTML = `<tr><td colspan="3" class="sub-empty">${T('common.loading')}</td></tr>`;
  document.getElementById("monthDetailEmpty").classList.add("hidden");
  monthDetailOverlay.classList.remove("hidden");
  try {
    const rows = await HITT_API.getProjectsByMonthDetail(year, month, type);
    const tbody = document.getElementById("monthDetailTableBody");
    if (!rows.length) {
      tbody.innerHTML = "";
      document.getElementById("monthDetailEmpty").classList.remove("hidden");
      return;
    }
    tbody.innerHTML = rows.map((r) => `
      <tr>
        <td>
          <a href="projects.html?projectId=${encodeURIComponent(r.id)}">${escapeHtml(r.name)}</a>
          <div class="rpt-proj-code">${escapeHtml(r.code)}</div>
        </td>
        <td style="font-size:0.82rem; color:var(--text-secondary);">${r.entryDate ? new Date(r.entryDate).toLocaleDateString() : "—"}</td>
        <td>${escapeHtml(r.entityLabel || "—")}</td>
      </tr>
    `).join("");
  } catch (err) {
    console.error("[reports] failed to load month detail:", err.message);
    document.getElementById("monthDetailTableBody").innerHTML = "";
    document.getElementById("monthDetailEmpty").textContent = T('rpt.err.list');
    document.getElementById("monthDetailEmpty").classList.remove("hidden");
    toast(T('rpt.toast.listFail'), "red");
  }
}

function closeMonthDetail() { monthDetailOverlay.classList.add("hidden"); }
document.getElementById("monthDetailClose").addEventListener("click", closeMonthDetail);
monthDetailOverlay.addEventListener("click", (e) => { if (e.target === monthDetailOverlay) closeMonthDetail(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !monthDetailOverlay.classList.contains("hidden")) closeMonthDetail();
});

/* ---------- Project timeline (server-paginated) ---------- */
const timelineFilterInput = document.getElementById("timelineFilter");
const timelinePageSizeSelect = document.getElementById("timelinePageSizeSelect");
let timelinePage = 1;
let timelineTotal = 0;
let timelineSearchDebounce = null;

async function loadTimeline() {
  const tbody = document.getElementById("timelineTableBody");
  const empty = document.getElementById("timelineEmpty");
  tbody.innerHTML = `<tr><td colspan="4" class="sub-empty">${T('common.loading')}</td></tr>`;
  empty.classList.add("hidden");
  try {
    const { rows, total } = await HITT_API.getProjectTimeline({
      search: timelineFilterInput.value.trim() || undefined,
      page: timelinePage,
      limit: Number(timelinePageSizeSelect.value),
    });
    lastTimelineRows = rows;
    timelineTotal = total;
    renderTimeline();
  } catch (err) {
    console.error("[reports] failed to load project-timeline:", err.message);
    lastTimelineRows = [];
    timelineTotal = 0;
    tbody.innerHTML = "";
    empty.textContent = T('rpt.err.timeline');
    empty.classList.remove("hidden");
    toast(T('rpt.toast.timelineFail'), "red");
  }
  updateTimelinePagination();
}

function renderTimeline() {
  const tbody = document.getElementById("timelineTableBody");
  const empty = document.getElementById("timelineEmpty");
  if (!lastTimelineRows.length) {
    tbody.innerHTML = "";
    empty.textContent = timelineFilterInput.value.trim() ? T('rpt.timeline.noMatch') : T('rpt.timeline.empty');
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  tbody.innerHTML = lastTimelineRows.map((r) => `
    <tr>
      <td>
        <a href="projects.html?projectId=${encodeURIComponent(r.projectId)}">${escapeHtml(r.projectName || `#${r.projectId}`)}</a>
        <div class="rpt-proj-code">${escapeHtml(r.projectCode || "")}</div>
      </td>
      <td>${escapeHtml(r.oldStatusLabel || "—")}<span class="rpt-change-arrow">&rarr;</span><b>${escapeHtml(r.newStatusLabel || "—")}</b></td>
      <td style="font-size:0.82rem; color:var(--text-secondary);">${new Date(r.changedAt).toLocaleString()}</td>
      <td>${escapeHtml(r.changedByName || (r.changedBy ? T('rpt.employeeNum', { n: r.changedBy }) : "—"))}</td>
    </tr>
  `).join("");
}

function timelineTotalPages() {
  return Math.max(1, Math.ceil(timelineTotal / Number(timelinePageSizeSelect.value)));
}

function updateTimelinePagination() {
  const totalPages = timelineTotalPages();
  document.getElementById("timelinePageInfo").textContent = timelineTotal
    ? T('rpt.pageInfo.changes', { page: timelinePage, pages: totalPages, n: timelineTotal })
    : "";
  document.getElementById("btnTimelinePrev").disabled = timelinePage <= 1;
  document.getElementById("btnTimelineNext").disabled = timelinePage >= totalPages;
}

// Debounced — search now hits the server (project code/name ILIKE) instead
// of filtering whatever page happened to already be loaded, so pagination
// and filtering stay consistent with each other.
timelineFilterInput.addEventListener("input", () => {
  clearTimeout(timelineSearchDebounce);
  timelineSearchDebounce = setTimeout(() => {
    timelinePage = 1;
    loadTimeline();
  }, 300);
});

timelinePageSizeSelect.addEventListener("change", () => {
  timelinePage = 1;
  loadTimeline();
});

document.getElementById("btnTimelinePrev").addEventListener("click", () => {
  if (timelinePage > 1) { timelinePage--; loadTimeline(); }
});
document.getElementById("btnTimelineNext").addEventListener("click", () => {
  if (timelinePage < timelineTotalPages()) { timelinePage++; loadTimeline(); }
});

// Exports every row matching the current search (capped at 1000, same as
// the backend's hard cap), not just the current page — "export" should
// mean the filtered dataset, not whatever 50 rows happen to be on screen.
document.getElementById("btnTimelineExport").addEventListener("click", async () => {
  try {
    const { rows } = await HITT_API.getProjectTimeline({
      search: timelineFilterInput.value.trim() || undefined,
      limit: 1000,
    });
    if (!rows.length) { toast(T('rpt.nothingToExport'), "navy"); return; }
    downloadCsv(
      "project-timeline.csv",
      [T('rpt.csv.projectCode'), T('rpt.csv.projectName'), T('rpt.csv.oldStatus'), T('rpt.csv.newStatus'), T('rpt.csv.changedAt'), T('rpt.csv.changedBy')],
      rows.map((r) => [
        r.projectCode, r.projectName, r.oldStatusLabel, r.newStatusLabel,
        new Date(r.changedAt).toLocaleString(), r.changedByName || (r.changedBy ? T('rpt.employeeNum', { n: r.changedBy }) : ""),
      ])
    );
  } catch (err) {
    console.error("[reports] failed to export project-timeline:", err.message);
    toast(T('rpt.toast.timelineExportFail'), "red");
  }
});

/* ---------- Stale projects (server-paginated, small fixed page size to
   match the line chart's card height — see rpt-charts-grid--row2 CSS) ---- */
const STALE_PAGE_SIZE = 5;
let stalePage = 1;
let staleTotal = 0;

async function loadStaleProjects() {
  const tbody = document.getElementById("staleTableBody");
  const empty = document.getElementById("staleEmpty");
  tbody.innerHTML = `<tr><td colspan="3" class="sub-empty">${T('common.loading')}</td></tr>`;
  empty.classList.add("hidden");
  try {
    const { rows, total } = await HITT_API.getStaleProjects(stalePage, STALE_PAGE_SIZE);
    lastStaleRows = rows;
    staleTotal = total;
    renderStaleProjects();
  } catch (err) {
    console.error("[reports] failed to load stale-projects:", err.message);
    lastStaleRows = [];
    staleTotal = 0;
    tbody.innerHTML = "";
    empty.textContent = T('rpt.err.stale');
    empty.classList.remove("hidden");
    toast(T('rpt.toast.staleFail'), "red");
  }
  updateStalePagination();
}

function renderStaleProjects() {
  const tbody = document.getElementById("staleTableBody");
  const empty = document.getElementById("staleEmpty");
  if (!lastStaleRows.length) {
    tbody.innerHTML = "";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  tbody.innerHTML = lastStaleRows.map((r) => `
    <tr>
      <td>
        <a href="projects.html?projectId=${encodeURIComponent(r.id)}">${escapeHtml(r.name)}</a>
        <div class="rpt-proj-code">${escapeHtml(r.code)}</div>
      </td>
      <td style="font-size:0.82rem; color:var(--text-secondary);">${r.entryDate ? new Date(r.entryDate).toLocaleDateString() : "—"}</td>
      <td style="font-size:0.82rem; color:var(--text-secondary);">${r.lastStatusChangeAt ? new Date(r.lastStatusChangeAt).toLocaleDateString() : "—"}</td>
    </tr>
  `).join("");
}

function staleTotalPages() {
  return Math.max(1, Math.ceil(staleTotal / STALE_PAGE_SIZE));
}

function updateStalePagination() {
  const totalPages = staleTotalPages();
  document.getElementById("stalePageInfo").textContent = staleTotal
    ? T('rpt.pageInfo.open', { page: stalePage, pages: totalPages, n: staleTotal })
    : "";
  document.getElementById("btnStalePrev").disabled = stalePage <= 1;
  document.getElementById("btnStaleNext").disabled = stalePage >= totalPages;
}

document.getElementById("btnStalePrev").addEventListener("click", () => {
  if (stalePage > 1) { stalePage--; loadStaleProjects(); }
});
document.getElementById("btnStaleNext").addEventListener("click", () => {
  if (stalePage < staleTotalPages()) { stalePage++; loadStaleProjects(); }
});

// Exports the full stale list (capped at the backend's 200), not just the
// current 5-row page — same "export = the whole filtered dataset"
// reasoning as the project timeline.
document.getElementById("btnStaleExport").addEventListener("click", async () => {
  try {
    const { rows } = await HITT_API.getStaleProjects(1, 200);
    if (!rows.length) { toast(T('rpt.nothingToExport'), "navy"); return; }
    downloadCsv(
      "stale-projects.csv",
      [T('rpt.csv.projectCode'), T('rpt.csv.projectName'), T('rpt.csv.entryDate'), T('rpt.csv.lastStatusChange')],
      rows.map((r) => [
        r.code, r.name,
        r.entryDate ? new Date(r.entryDate).toLocaleDateString() : "",
        r.lastStatusChangeAt ? new Date(r.lastStatusChangeAt).toLocaleDateString() : "",
      ])
    );
  } catch (err) {
    console.error("[reports] failed to export stale-projects:", err.message);
    toast(T('rpt.toast.staleExportFail'), "red");
  }
});

/* ============================== INIT ==================================== */
statsLoaded = true;
loadStats();


/* Re-render dynamic content when the UI language changes. */
window.addEventListener("hitt:langchange", () => {
  if (currentTab === "hours" && hoursLoaded) loadHours();
  else if (currentTab === "stats" && statsLoaded) loadStats();
});
