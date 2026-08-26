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
    if (currentTab === "leaves") loadLeavesMonth();
  });
});

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

/* ============================== INIT ==================================== */
loadHours();
