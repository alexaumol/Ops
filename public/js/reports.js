/**
 * HITT Ops — Reports
 * ---------------------------------------------------------------------------
 * New module, no direct Access precedent (closest analogue was the
 * per-employee "TimeAllocationLog" report and the admin "Manage
 * calendar.frm" holidays subform). Two reports:
 *
 *   Hours per project   SUM(projectstimetracking.projtimetrackhours) per
 *                        project over an optional date range.
 *   Resource leaves      A month calendar of company holidays (holidays
 *                        table) + employee time-off requests
 *                        (timeoffrequests), Submitted/Pending/Approved.
 *
 * See server/routes/reports.js for why corporateworkcalendar/
 * employeeworkcalendar (annual totals only, no dates) aren't the source
 * for the calendar despite holding "calendar" in their name.
 * ---------------------------------------------------------------------------
 */

const session = HITT_AUTH.requireSession("../index.html");
document.getElementById("userName").textContent = session.displayName;
document.getElementById("userAvatar").textContent = HITT_AUTH.initials(session);
document.getElementById("btnSignOut").addEventListener("click", () => HITT_AUTH.signOut("../index.html"));
HITT_PERMS.guardModule("reports", "../welcome.html");
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

function pad2(n) { return String(n).padStart(2, "0"); }
// Uses the browser's local date components (not UTC) — matches how the
// rest of the app already displays timestamp-without-timezone columns
// (see time-allocation.js formatDateOnly), so a date fetched from the API
// lands in the same calendar cell it's shown as elsewhere in the app.
function toISODate(d) { return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function startOfDay(d) { return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }

/* ============================== PAGE TABS ================================= */
let currentTab = "hours";
document.querySelectorAll("[data-rtab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-rtab]").forEach((b) => b.setAttribute("aria-selected", "false"));
    btn.setAttribute("aria-selected", "true");
    currentTab = btn.dataset.rtab;
    document.getElementById("paneHours").classList.toggle("hidden", currentTab !== "hours");
    document.getElementById("paneLeaves").classList.toggle("hidden", currentTab !== "leaves");
    document.getElementById("paneStats").classList.toggle("hidden", currentTab !== "stats");
    if (currentTab === "leaves") loadLeavesMonth();
    if (currentTab === "stats" && !statsLoaded) { statsLoaded = true; loadStats(); }
  });
});
let statsLoaded = false;

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
  tbody.innerHTML = `<tr><td colspan="6" class="sub-empty">Loading…</td></tr>`;
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
      <tr data-project-id="${r.projectId}" data-project-name="${escapeHtml(r.name)}" title="Click for a per-employee breakdown">
        <td>
          <div>${escapeHtml(r.name)}</div>
          <div class="rpt-proj-code">${escapeHtml(r.code)}</div>
        </td>
        <td>${escapeHtml(r.statusLabel || "—")}</td>
        <td style="text-align:right; font-weight:700;">${Number(r.totalHours).toLocaleString()}</td>
        <td style="text-align:right; color:var(--text-secondary);">${Number(r.poHours).toLocaleString()}</td>
        <td style="text-align:right; color:var(--text-secondary);">${Number(r.resHours).toLocaleString()}</td>
        <td style="text-align:right;">${r.employeeCount}</td>
      </tr>
    `).join("");
    const total = rows.reduce((sum, r) => sum + Number(r.totalHours), 0);
    document.getElementById("hoursTotal").textContent = `${total.toLocaleString()} hours total across ${rows.length} projects`;
  } catch (err) {
    console.error("[reports] failed to load hours-per-project:", err.message);
    lastHoursRows = [];
    tbody.innerHTML = "";
    empty.textContent = "Could not load this report.";
    empty.classList.remove("hidden");
    toast("Could not load the hours-per-project report.", "red");
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
  if (!lastHoursRows.length) { toast("Nothing to export.", "navy"); return; }
  const range = hoursStartInput.value || hoursEndInput.value
    ? `${hoursStartInput.value || "start"}_to_${hoursEndInput.value || "end"}`
    : "all-time";
  downloadCsv(
    `hours-per-project_${range}.csv`,
    ["Project code", "Project name", "Status", "Total hours", "PO hours", "RES hours", "Employees"],
    lastHoursRows.map((r) => [r.code, r.name, r.statusLabel || "", r.totalHours, r.poHours, r.resHours, r.employeeCount])
  );
});

document.getElementById("hoursTableBody").addEventListener("click", (e) => {
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
  document.getElementById("drillTableBody").innerHTML = `<tr><td colspan="4" class="sub-empty">Loading…</td></tr>`;
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
    document.getElementById("drillEmpty").textContent = "Could not load this breakdown.";
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
  if (!lastDrillRows.length) { toast("Nothing to export.", "navy"); return; }
  downloadCsv(
    `hours_${lastDrillProjectName.replace(/[^\w-]+/g, "_")}.csv`,
    ["Employee", "Total hours", "PO hours", "RES hours"],
    lastDrillRows.map((r) => [r.employeeName, r.totalHours, r.poHours, r.resHours])
  );
});

/* ============================== RESOURCE LEAVES ============================ */
let calendarMonth = startOfDay(new Date());
calendarMonth.setDate(1);

const WEEKDAY_LABELS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

function computeGridRange(monthStart) {
  const year = monthStart.getFullYear();
  const month = monthStart.getMonth();
  const monthEnd = new Date(year, month + 1, 0);
  const gridStart = new Date(monthStart);
  gridStart.setDate(gridStart.getDate() - ((gridStart.getDay() + 6) % 7));
  const gridEnd = new Date(monthEnd);
  gridEnd.setDate(gridEnd.getDate() + ((7 - ((gridEnd.getDay() + 6) % 7) - 1) % 7));
  return { monthEnd, gridStart, gridEnd };
}

let lastLeavesData = null;
let lastLeavesMonthLabel = "";

async function loadLeavesMonth() {
  const label = calendarMonth.toLocaleDateString(undefined, { month: "long", year: "numeric" });
  document.getElementById("leavesMonthLabel").textContent = label;
  lastLeavesMonthLabel = label;

  const { gridStart, gridEnd } = computeGridRange(calendarMonth);
  const cal = document.getElementById("leavesCalendar");
  cal.innerHTML = `<div class="rpt-cal-weekdays">${WEEKDAY_LABELS.map((d) => `<div>${d}</div>`).join("")}</div><div class="sub-empty" style="padding:2rem; text-align:center; color:var(--text-secondary);">Loading…</div>`;

  let data;
  try {
    data = await HITT_API.getResourceLeaves(toISODate(gridStart), toISODate(gridEnd));
    lastLeavesData = data;
  } catch (err) {
    console.error("[reports] failed to load resource-leaves:", err.message);
    lastLeavesData = null;
    toast("Could not load the resource leaves calendar.", "red");
    cal.innerHTML = `<div class="rpt-cal-weekdays">${WEEKDAY_LABELS.map((d) => `<div>${d}</div>`).join("")}</div><div style="padding:2rem; text-align:center; color:var(--text-secondary);">Could not load this report.</div>`;
    return;
  }
  renderCalendar(gridStart, gridEnd, data);
}

function renderCalendar(gridStart, gridEnd, data) {
  const holidaysByDate = new Map();
  (data.holidays || []).forEach((h) => {
    holidaysByDate.set(toISODate(new Date(h.date)), h.description);
  });

  const leavesByDate = new Map();
  (data.timeOff || []).forEach((t) => {
    let cur = startOfDay(new Date(t.startDate));
    const end = startOfDay(new Date(t.endDate));
    const isApproved = t.statusLabel === "Approved";
    while (cur <= end) {
      const key = toISODate(cur);
      if (!leavesByDate.has(key)) leavesByDate.set(key, []);
      leavesByDate.get(key).push({ name: t.employeeName || `Employee #${t.empId}`, isApproved });
      cur.setDate(cur.getDate() + 1);
    }
  });

  const today = toISODate(startOfDay(new Date()));
  const cal = document.getElementById("leavesCalendar");
  let html = `<div class="rpt-cal-weekdays">${WEEKDAY_LABELS.map((d) => `<div>${d}</div>`).join("")}</div>`;

  let day = new Date(gridStart);
  while (day <= gridEnd) {
    html += `<div class="rpt-cal-week">`;
    for (let i = 0; i < 7; i++) {
      const key = toISODate(day);
      const isOutside = day.getMonth() !== calendarMonth.getMonth();
      const isToday = key === today;
      const holidayDesc = holidaysByDate.get(key);
      const leaves = leavesByDate.get(key) || [];
      const shown = leaves.slice(0, 3);
      const more = leaves.length - shown.length;

      html += `
        <div class="rpt-cal-day ${isOutside ? "is-outside" : ""} ${isToday ? "is-today" : ""}">
          <div class="rpt-cal-daynum">${day.getDate()}</div>
          ${holidayDesc ? `<div class="rpt-cal-holiday" title="${escapeHtml(holidayDesc)}">${escapeHtml(holidayDesc)}</div>` : ""}
          ${shown.map((l) => `<div class="rpt-cal-leave ${l.isApproved ? "is-approved" : "is-pending"}" title="${escapeHtml(l.name)}${l.isApproved ? "" : " (pending)"}">${escapeHtml(l.name)}</div>`).join("")}
          ${more > 0 ? `<div class="rpt-cal-more">+${more} more</div>` : ""}
        </div>`;
      day.setDate(day.getDate() + 1);
    }
    html += `</div>`;
  }

  cal.innerHTML = html;
}

document.getElementById("btnPrevMonth").addEventListener("click", () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() - 1, 1);
  loadLeavesMonth();
});
document.getElementById("btnNextMonth").addEventListener("click", () => {
  calendarMonth = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth() + 1, 1);
  loadLeavesMonth();
});
document.getElementById("btnThisMonth").addEventListener("click", () => {
  calendarMonth = startOfDay(new Date());
  calendarMonth.setDate(1);
  loadLeavesMonth();
});
document.getElementById("btnLeavesExport").addEventListener("click", () => {
  if (!lastLeavesData || (!lastLeavesData.holidays.length && !lastLeavesData.timeOff.length)) {
    toast("Nothing to export.", "navy");
    return;
  }
  const rows = [
    ...lastLeavesData.holidays.map((h) => {
      const d = toISODate(new Date(h.date));
      return ["Holiday", d, d, h.description, ""];
    }),
    ...lastLeavesData.timeOff.map((t) => [
      "Leave",
      toISODate(new Date(t.startDate)),
      toISODate(new Date(t.endDate)),
      t.employeeName || `Employee #${t.empId}`,
      t.statusLabel || "",
    ]),
  ];
  downloadCsv(
    `resource-leaves_${lastLeavesMonthLabel.replace(/\s+/g, "-")}.csv`,
    ["Type", "Start date", "End date", "Description", "Status"],
    rows
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
const MONTH_LABELS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Rounds a max value up to a "nice" chart ceiling divisible by 5, so the
// gridline labels (0/25/50/75/100%) come out as clean integers instead of
// e.g. 13.75. Floors at 5 so an all-zero dataset still draws a usable axis.
function niceCeil(max) {
  return Math.max(5, Math.ceil(max / 5) * 5);
}

let lastStatusEntityRows = [];
let lastOpenedRows = [];
let lastTimelineRows = [];

const statusYearSelect = document.getElementById("statusYearSelect");

async function loadStats() {
  await Promise.all([loadYearsThenCharts(), loadTimeline()]);
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
  el.innerHTML = `<div class="rpt-chart-empty">Loading…</div>`;
  try {
    const rows = await HITT_API.getProjectsByStatusEntity(statusYearSelect.value || undefined);
    lastStatusEntityRows = rows;
    renderStatusChart(rows);
  } catch (err) {
    console.error("[reports] failed to load projects-by-status-entity:", err.message);
    lastStatusEntityRows = [];
    el.innerHTML = `<div class="rpt-chart-empty">Could not load this chart.</div>`;
    toast("Could not load the projects-by-status chart.", "red");
  }
}

statusYearSelect.addEventListener("change", loadStatusChart);

function renderStatusChart(rows) {
  const el = document.getElementById("statusChart");
  if (!rows.length) { el.innerHTML = `<div class="rpt-chart-empty">No data.</div>`; return; }

  const statuses = [];
  const byStatus = new Map();
  rows.forEach((r) => {
    if (!byStatus.has(r.statusId)) {
      byStatus.set(r.statusId, { label: r.statusLabel, entities: new Map(), total: 0 });
      statuses.push(r.statusId);
    }
    const group = byStatus.get(r.statusId);
    group.entities.set(r.entityLabel, Number(r.count));
    group.total += Number(r.count);
  });
  const entitiesPresent = ENTITY_ORDER.filter((e) => rows.some((r) => r.entityLabel === e));
  const entities = entitiesPresent.length ? entitiesPresent : ENTITY_ORDER;

  // Bars use one real scale (individual entity counts). The total line
  // is NOT plotted against a value axis at all — it just floats a fixed
  // distance above whichever bar is tallest in each group, so it (and its
  // value labels) never collides with a bar's own value label regardless
  // of how big the total is relative to the bars. MT is generous
  // specifically to leave room for this floating line + its labels above
  // the tallest possible bar.
  const maxBar = Math.max(0, ...rows.map((r) => Number(r.count)));
  const yMaxBars = niceCeil(maxBar);

  const W = 480, H = 320, ML = 32, MR = 8, MT = 34, MB = 58;
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
    svg += `<text class="rpt-chart-label" x="${ML - 6}" y="${y + 3}" text-anchor="end">${val}</text>`;
  }
  svg += `<line class="rpt-chart-axis" x1="${ML}" y1="${MT}" x2="${ML}" y2="${MT + plotH}" />`;
  svg += `<line class="rpt-chart-axis" x1="${ML}" y1="${MT + plotH}" x2="${W - MR}" y2="${MT + plotH}" />`;

  statuses.forEach((statusId, si) => {
    const group = byStatus.get(statusId);
    const gx = ML + si * groupW + barGap;
    let tallestBarTopY = MT + plotH; // tracks the highest (smallest y) bar top in this group
    entities.forEach((entityLabel, ei) => {
      const count = group.entities.get(entityLabel) || 0;
      const barH = (count / yMaxBars) * plotH;
      const x = gx + ei * barW;
      const y = MT + plotH - barH;
      tallestBarTopY = Math.min(tallestBarTopY, y);
      svg += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barW * 0.82).toFixed(1)}" height="${barH.toFixed(1)}" fill="${ENTITY_COLORS[entityLabel] || "#999"}" rx="2">
        <title>${escapeHtml(group.label)} · ${escapeHtml(entityLabel)}: ${count}</title>
      </rect>`;
      if (count > 0) {
        svg += `<text class="rpt-chart-value" x="${(x + barW * 0.41).toFixed(1)}" y="${(y - 4).toFixed(1)}" text-anchor="middle">${count}</text>`;
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
    svg += `<circle class="rpt-chart-dot rpt-chart-dot--total" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.5"><title>${escapeHtml(byStatus.get(statuses[si]).label)} total: ${p.total}</title></circle>`;
    svg += `<text class="rpt-chart-value" style="font-weight:700;" x="${p.x.toFixed(1)}" y="${(p.y - 8).toFixed(1)}" text-anchor="middle">${p.total}</text>`;
  });

  const legend = entities.map((e) => `
    <span class="rpt-legend-item"><span class="rpt-swatch" style="background:${ENTITY_COLORS[e] || "#999"}"></span>${escapeHtml(e)}</span>
  `).join("") + `
    <span class="rpt-legend-item"><span class="rpt-swatch" style="width:14px; height:3px; border-radius:2px; background:var(--text-primary);"></span>Total</span>
  `;

  el.innerHTML = `
    <svg class="rpt-chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Projects by status and entity">${svg}</svg>
    <div class="rpt-legend" style="margin-top:0.5rem;">${legend}</div>
  `;
}

document.getElementById("btnStatusExport").addEventListener("click", () => {
  if (!lastStatusEntityRows.length) { toast("Nothing to export.", "navy"); return; }
  downloadCsv(
    "projects-by-status-entity.csv",
    ["Status", "Entity", "Count"],
    lastStatusEntityRows.map((r) => [r.statusLabel, r.entityLabel, r.count])
  );
});

/* ---------- Line chart: projects opened by month ---------- */
const openedYearSelect = document.getElementById("openedYearSelect");

async function loadOpenedChart() {
  const el = document.getElementById("openedChart");
  el.innerHTML = `<div class="rpt-chart-empty">Loading…</div>`;
  try {
    const rows = await HITT_API.getProjectsOpenedByMonth(openedYearSelect.value);
    lastOpenedRows = rows;
    renderOpenedChart(rows);
  } catch (err) {
    console.error("[reports] failed to load projects-opened-by-month:", err.message);
    lastOpenedRows = [];
    el.innerHTML = `<div class="rpt-chart-empty">Could not load this chart.</div>`;
    toast("Could not load the projects-opened-by-month chart.", "red");
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
      svg += `<circle class="${dotClass} rpt-chart-dot--clickable" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="4.5" data-month="${i + 1}" data-type="${type}"><title>${MONTH_LABELS[i]} ${label}: ${p.v} — click for details</title></circle>`;
    });
  }
  drawSeries(opened, "rpt-chart-line", "rpt-chart-dot", "opened", "opened");
  drawSeries(closed, "rpt-chart-line rpt-chart-line--closed", "rpt-chart-dot rpt-chart-dot--closed", "closed", "closed");

  MONTH_LABELS.forEach((label, i) => {
    const x = ML + i * stepX;
    svg += `<text class="rpt-chart-label" x="${x.toFixed(1)}" y="${MT + plotH + 20}" text-anchor="middle">${label}</text>`;
  });

  el.innerHTML = `
    <svg class="rpt-chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Projects opened and closed by month">${svg}</svg>
    <div class="rpt-legend" style="margin-top:0.5rem;">
      <span class="rpt-legend-item"><span class="rpt-swatch" style="width:14px; height:3px; border-radius:2px; background:var(--brand);"></span>Opened</span>
      <span class="rpt-legend-item"><span class="rpt-swatch" style="width:14px; height:3px; border-radius:2px; background:var(--hitt-amber);"></span>Closed</span>
    </div>
  `;
}

openedYearSelect.addEventListener("change", loadOpenedChart);

document.getElementById("btnOpenedExport").addEventListener("click", () => {
  if (!lastOpenedRows.length) { toast("Nothing to export.", "navy"); return; }
  downloadCsv(
    `projects-opened-closed_${openedYearSelect.value || "all-years"}.csv`,
    ["Month", "Opened", "Closed"],
    lastOpenedRows.map((r) => [MONTH_LABELS[r.month - 1], r.openedCount, r.closedCount])
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
  const label = `${type === "closed" ? "Closed" : "Opened"} — ${MONTH_LABELS[month - 1]} ${year || "All years"}`;
  document.getElementById("monthDetailTitle").textContent = label;
  document.getElementById("monthDetailTableBody").innerHTML = `<tr><td colspan="3" class="sub-empty">Loading…</td></tr>`;
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
    document.getElementById("monthDetailEmpty").textContent = "Could not load this list.";
    document.getElementById("monthDetailEmpty").classList.remove("hidden");
    toast("Could not load the project list.", "red");
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
  tbody.innerHTML = `<tr><td colspan="4" class="sub-empty">Loading…</td></tr>`;
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
    empty.textContent = "Could not load the project timeline.";
    empty.classList.remove("hidden");
    toast("Could not load the project timeline.", "red");
  }
  updateTimelinePagination();
}

function renderTimeline() {
  const tbody = document.getElementById("timelineTableBody");
  const empty = document.getElementById("timelineEmpty");
  if (!lastTimelineRows.length) {
    tbody.innerHTML = "";
    empty.textContent = timelineFilterInput.value.trim() ? "No changes match that filter." : "No status changes logged yet.";
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
      <td>${escapeHtml(r.changedByName || (r.changedBy ? `Employee #${r.changedBy}` : "—"))}</td>
    </tr>
  `).join("");
}

function timelineTotalPages() {
  return Math.max(1, Math.ceil(timelineTotal / Number(timelinePageSizeSelect.value)));
}

function updateTimelinePagination() {
  const totalPages = timelineTotalPages();
  document.getElementById("timelinePageInfo").textContent = timelineTotal
    ? `Page ${timelinePage} of ${totalPages} · ${timelineTotal} change${timelineTotal === 1 ? "" : "s"}`
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
    if (!rows.length) { toast("Nothing to export.", "navy"); return; }
    downloadCsv(
      "project-timeline.csv",
      ["Project code", "Project name", "Old status", "New status", "Changed at", "Changed by"],
      rows.map((r) => [
        r.projectCode, r.projectName, r.oldStatusLabel, r.newStatusLabel,
        new Date(r.changedAt).toLocaleString(), r.changedByName || (r.changedBy ? `Employee #${r.changedBy}` : ""),
      ])
    );
  } catch (err) {
    console.error("[reports] failed to export project-timeline:", err.message);
    toast("Could not export the project timeline.", "red");
  }
});

/* ============================== INIT ==================================== */
loadHours();
