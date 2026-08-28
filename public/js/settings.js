/**
 * HITT Ops — Settings (admin-only)
 * ---------------------------------------------------------------------------
 * Thin CRUD UI over /api/settings — see server/routes/settings.js and
 * server/lib/permissions.js for the actual rules (admins allow-list,
 * modulerestrictions block-list, timeoffapprovers allow-list,
 * employees.deactivated). This page has no precedent in the Access app
 * ("General settings.frm" only hinted at the idea; user activation lived
 * in the separate Employees.frm) — it exists purely to make the new
 * permissions layer usable without hand-editing the database.
 *
 * Deactivating someone disables their other toggles here (moot while
 * deactivated, not cleared) and dims the row — mirrors Access's
 * chkDeactivateUser: data/activity is kept, just blocked from every gate.
 *
 * Every mutation here is enforced server-side by requireAdmin regardless
 * of what this page shows — if GET /api/settings/employees 403s (caller
 * isn't an admin), we show a blocked message instead of an empty table.
 * ---------------------------------------------------------------------------
 */

const session = HITT_AUTH.requireSession("../index.html");
document.getElementById("userName").textContent = session.displayName;
document.getElementById("userAvatar").textContent = HITT_AUTH.initials(session);
document.getElementById("btnSignOut").addEventListener("click", () => HITT_AUTH.signOut("../index.html"));
HITT_PERMS.applyRealName();

const MODULE_LABELS = {
  "projects": "Projects",
  "business-partners": "Business partners",
  "time-allocation": "Time allocation",
  "invoicing": "Invoicing",
  "reports": "Reports",
};

let EMPLOYEES = [];

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

function renderRow(emp) {
  const deactivated = !!emp.isDeactivated;
  const moduleChips = Object.keys(MODULE_LABELS).map((key) => {
    const hasAccess = emp.isAdmin || !emp.restrictedModules.includes(key);
    return `
      <label class="module-chip ${hasAccess ? "" : "is-off"}" data-module="${key}">
        <input type="checkbox" ${hasAccess ? "checked" : ""} ${(emp.isAdmin || deactivated) ? "disabled" : ""} class="moduleAccessToggle" data-emp="${emp.id}" data-module="${key}" />
        ${escapeHtml(MODULE_LABELS[key])}
      </label>`;
  }).join("");

  return `
    <tr class="${deactivated ? "is-deactivated-row" : ""}">
      <td>
        <div class="settings-emp-name">${escapeHtml(emp.name || emp.username)}</div>
        <div class="settings-emp-sub">${escapeHtml(emp.emailid || emp.username)}</div>
      </td>
      <td>
        <label class="switch" title="Deactivate this user">
          <input type="checkbox" class="statusToggle" data-emp="${emp.id}" ${deactivated ? "checked" : ""} />
          <span class="switch-track"></span>
        </label>
        <span class="settings-emp-sub">${deactivated ? "Deactivated" : "Active"}</span>
      </td>
      <td>
        <label class="switch" title="Admin">
          <input type="checkbox" class="adminToggle" data-emp="${emp.id}" ${emp.isAdmin ? "checked" : ""} ${deactivated ? "disabled" : ""} />
          <span class="switch-track"></span>
        </label>
        <span class="settings-emp-sub">${emp.isAdmin ? "Admin" : "User"}</span>
      </td>
      <td>
        <label class="switch" title="Time-off approver">
          <input type="checkbox" class="approverToggle" data-emp="${emp.id}" ${emp.isTimeOffApprover ? "checked" : ""} ${deactivated ? "disabled" : ""} />
          <span class="switch-track"></span>
        </label>
      </td>
      <td><div class="module-chip-row">${moduleChips}</div></td>
    </tr>`;
}

function render() {
  const showDeactivated = document.getElementById("showDeactivated").checked;
  const visible = showDeactivated ? EMPLOYEES : EMPLOYEES.filter((e) => !e.isDeactivated);
  document.getElementById("empTableBody").innerHTML = visible.map(renderRow).join("");

  const deactivatedCount = EMPLOYEES.filter((e) => e.isDeactivated).length;
  document.getElementById("deactivatedCount").textContent = deactivatedCount ? `(${deactivatedCount})` : "";
}

document.getElementById("showDeactivated").addEventListener("change", render);

async function loadEmployees() {
  try {
    EMPLOYEES = await HITT_API.getSettingsEmployees();
    document.getElementById("settingsBlocked").classList.add("hidden");
    document.getElementById("settingsContent").classList.remove("hidden");
    render();
  } catch (err) {
    console.error("[settings] failed to load employees:", err.message);
    document.getElementById("settingsContent").classList.add("hidden");
    document.getElementById("settingsBlocked").classList.remove("hidden");
  }
}

document.getElementById("empTableBody").addEventListener("change", async (e) => {
  const empId = Number(e.target.dataset.emp);
  if (!empId) return;
  const emp = EMPLOYEES.find((x) => Number(x.id) === empId);
  if (!emp) return;

  try {
    if (e.target.classList.contains("statusToggle")) {
      const isDeactivated = e.target.checked;
      if (isDeactivated && !confirm(`Deactivate ${emp.name}? They won't be able to use HITT Ops until reactivated. Their data and activity are kept.`)) {
        e.target.checked = false;
        return;
      }
      await HITT_API.setEmployeeStatus(empId, isDeactivated);
      emp.isDeactivated = isDeactivated;
      toast(`${emp.name}: ${isDeactivated ? "deactivated" : "reactivated"}.`, isDeactivated ? "navy" : "green");
      render();
    } else if (e.target.classList.contains("adminToggle")) {
      const isAdmin = e.target.checked;
      await HITT_API.setEmployeeAdmin(empId, isAdmin);
      emp.isAdmin = isAdmin;
      // Admins still bypass every module restriction (unrelated to
      // time-off approval, which is a fully independent flag) — reflect
      // that bypass locally without touching isTimeOffApprover.
      if (isAdmin) { emp.restrictedModules = []; }
      toast(`${emp.name}: ${isAdmin ? "granted" : "removed"} admin.`, "green");
      render();
    } else if (e.target.classList.contains("approverToggle")) {
      const isApprover = e.target.checked;
      await HITT_API.setEmployeeTimeOffApprover(empId, isApprover);
      emp.isTimeOffApprover = isApprover;
      toast(`${emp.name}: ${isApprover ? "granted" : "removed"} time-off approver.`, "green");
    } else if (e.target.classList.contains("moduleAccessToggle")) {
      const chip = e.target.closest(".module-chip");
      const moduleKey = chip.dataset.module;
      const hasAccess = e.target.checked;
      await HITT_API.setEmployeeModuleAccess(empId, moduleKey, hasAccess);
      if (hasAccess) {
        emp.restrictedModules = emp.restrictedModules.filter((k) => k !== moduleKey);
      } else {
        emp.restrictedModules = [...new Set([...emp.restrictedModules, moduleKey])];
      }
      chip.classList.toggle("is-off", !hasAccess);
      toast(`${emp.name}: ${MODULE_LABELS[moduleKey]} ${hasAccess ? "access restored" : "restricted"}.`, "green");
    }
  } catch (err) {
    console.error("[settings] update failed:", err.message);
    toast(`Couldn't save that change: ${err.message}`, "red");
    render();
  }
});

/* ============================== TABS ================================== */
let holidaysLoaded = false;
let calendarLoaded = false;
let auditLoaded = false;

document.querySelectorAll("[data-stab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-stab]").forEach((b) => b.setAttribute("aria-selected", "false"));
    btn.setAttribute("aria-selected", "true");
    const tab = btn.dataset.stab;
    document.getElementById("paneUserPerms").classList.toggle("hidden", tab !== "permissions");
    document.getElementById("paneHolidays").classList.toggle("hidden", tab !== "holidays");
    document.getElementById("paneCalendar").classList.toggle("hidden", tab !== "calendar");
    document.getElementById("paneAudit").classList.toggle("hidden", tab !== "audit");
    if (tab === "holidays" && !holidaysLoaded) {
      holidaysLoaded = true;
      loadHolidayYears().then(loadHolidays);
    }
    if (tab === "calendar" && !calendarLoaded) {
      calendarLoaded = true;
      loadWorkCalendar();
    }
    if (tab === "audit" && !auditLoaded) {
      auditLoaded = true;
      loadAuditUsers().then(loadAudit);
    }
  });
});

/* ============================== HOLIDAYS ============================== */
let HOLIDAYS = [];

function fmtDate(iso) {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

async function loadHolidayYears() {
  try {
    const years = await HITT_API.getHolidayYears();
    const sel = document.getElementById("holidayYearFilter");
    const current = sel.value;
    const asStr = years.map(String);
    sel.innerHTML = `<option value="">All years</option>` + years.map((y) => `<option value="${y}">${y}</option>`).join("");
    const thisYear = String(new Date().getFullYear());
    sel.value = asStr.includes(current) ? current : asStr.includes(thisYear) ? thisYear : "";
  } catch (err) {
    console.error("[settings] holiday years:", err.message);
  }
}

async function loadHolidays() {
  const tbody = document.getElementById("holidaysTableBody");
  const empty = document.getElementById("holidaysEmpty");
  tbody.innerHTML = `<tr><td colspan="5" class="settings-emp-sub" style="padding:1rem;">Loading…</td></tr>`;
  empty.classList.add("hidden");
  try {
    HOLIDAYS = await HITT_API.getHolidays(document.getElementById("holidayYearFilter").value || null);
    renderHolidays();
  } catch (err) {
    console.error("[settings] holidays:", err.message);
    tbody.innerHTML = "";
    empty.textContent = "Could not load holidays.";
    empty.classList.remove("hidden");
  }
}

function renderHolidays() {
  const tbody = document.getElementById("holidaysTableBody");
  const empty = document.getElementById("holidaysEmpty");
  if (!HOLIDAYS.length) {
    tbody.innerHTML = "";
    empty.textContent = "No holidays for this selection.";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  tbody.innerHTML = HOLIDAYS.map((h) => {
    const src = String(h.source || "legacy");
    const srcLabel = src === "catalonia" ? "Public" : src === "hitt" ? "HITT" : "Legacy";
    return `
      <tr>
        <td>${fmtDate(h.date)}</td>
        <td class="settings-emp-sub">${escapeHtml(h.weekday || "")}</td>
        <td>${escapeHtml(h.description || "")}</td>
        <td><span class="hol-source-chip is-${src}">${srcLabel}</span></td>
        <td style="text-align:right;"><button class="icon-btn" data-del-holiday="${h.id}" title="Delete this holiday">✕</button></td>
      </tr>`;
  }).join("");
  tbody.querySelectorAll("[data-del-holiday]").forEach((btn) => {
    btn.addEventListener("click", () => deleteHoliday(btn.dataset.delHoliday));
  });
}

async function deleteHoliday(id) {
  const h = HOLIDAYS.find((x) => String(x.id) === String(id));
  if (!h || !confirm(`Delete holiday "${h.description}" (${fmtDate(h.date)})?`)) return;
  try {
    await HITT_API.deleteHoliday(id);
    toast("Holiday deleted.", "navy");
    await loadHolidays();
  } catch (err) {
    toast(`Couldn't delete that holiday: ${err.message}`, "red");
  }
}

document.getElementById("holidayYearFilter").addEventListener("change", loadHolidays);

document.getElementById("btnAddHoliday").addEventListener("click", async () => {
  const date = document.getElementById("newHolidayDate").value;
  const desc = document.getElementById("newHolidayDesc").value.trim();
  if (!date || !desc) {
    toast("Pick a date and enter a description.", "red");
    return;
  }
  try {
    await HITT_API.addHoliday({ date, description: desc });
    document.getElementById("newHolidayDate").value = "";
    document.getElementById("newHolidayDesc").value = "";
    toast("HITT holiday added.", "green");
    await loadHolidayYears();
    await loadHolidays();
  } catch (err) {
    toast(`Couldn't add that holiday: ${err.message}`, "red");
  }
});

document.getElementById("btnImportHolidays").addEventListener("click", async () => {
  const btn = document.getElementById("btnImportHolidays");
  const status = document.getElementById("holidayImportStatus");
  if (!confirm("Import public holidays from the Generalitat de Catalunya feed? This replaces the previously imported set — HITT holidays you added here are kept.")) return;
  btn.disabled = true;
  status.textContent = "Importing…";
  try {
    const result = await HITT_API.importPublicHolidays();
    const span = result.years && result.years.length
      ? ` (${result.years[0]}–${result.years[result.years.length - 1]})`
      : "";
    status.textContent = `Imported ${result.imported} holidays${span}.`;
    toast(`Imported ${result.imported} public holidays.`, "green");
    await loadHolidayYears();
    await loadHolidays();
  } catch (err) {
    status.textContent = "";
    toast(`Import failed: ${err.message}`, "red");
  } finally {
    btn.disabled = false;
  }
});

/* ============================== WORK CALENDAR ======================== */
let WORK_CALENDAR = [];

async function loadWorkCalendar() {
  const tbody = document.getElementById("workCalendarTableBody");
  const empty = document.getElementById("workCalendarEmpty");
  tbody.innerHTML = `<tr><td colspan="4" class="settings-emp-sub" style="padding:1rem;">Loading…</td></tr>`;
  empty.classList.add("hidden");
  try {
    WORK_CALENDAR = await HITT_API.getWorkCalendar();
    renderWorkCalendar();
  } catch (err) {
    console.error("[settings] work calendar:", err.message);
    tbody.innerHTML = "";
    empty.textContent = "Could not load the work calendar.";
    empty.classList.remove("hidden");
  }
}

function renderWorkCalendar() {
  const tbody = document.getElementById("workCalendarTableBody");
  const empty = document.getElementById("workCalendarEmpty");
  if (!WORK_CALENDAR.length) {
    tbody.innerHTML = "";
    empty.textContent = "No years configured yet.";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  tbody.innerHTML = WORK_CALENDAR.map((r) => `
    <tr data-year="${r.year}">
      <td style="font-weight:600;">${r.year}</td>
      <td><input type="number" min="0" step="0.5" class="cal-input" data-field="leaveDays" value="${r.leaveDays ?? ""}" /></td>
      <td><input type="number" min="0" step="1" class="cal-input" data-field="workingHours" value="${r.workingHours ?? ""}" /></td>
      <td class="settings-emp-sub">${r.updatedAt ? new Date(r.updatedAt).toLocaleDateString() : "—"}</td>
    </tr>
  `).join("");
  tbody.querySelectorAll("input[data-field]").forEach((input) => {
    let original = input.value;
    input.addEventListener("focus", () => { original = input.value; });
    input.addEventListener("change", async () => {
      if (input.value === original) return;
      const tr = input.closest("tr");
      const year = Number(tr.dataset.year);
      const payload = {
        leaveDays: tr.querySelector('[data-field="leaveDays"]').value,
        workingHours: tr.querySelector('[data-field="workingHours"]').value,
      };
      try {
        await HITT_API.setWorkCalendarYear(year, payload);
        original = input.value;
        const row = WORK_CALENDAR.find((x) => x.year === year);
        if (row) {
          row.leaveDays = payload.leaveDays === "" ? null : Number(payload.leaveDays);
          row.workingHours = payload.workingHours === "" ? null : Number(payload.workingHours);
        }
        toast(`${year} work calendar saved.`, "green");
      } catch (err) {
        input.value = original;
        toast(`Couldn't save that change: ${err.message}`, "red");
      }
    });
  });
}

document.getElementById("btnAddCalendarYear").addEventListener("click", async () => {
  const year = Number(document.getElementById("newCalendarYear").value);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) {
    toast("Enter a valid year (2000–2100).", "red");
    return;
  }
  if (WORK_CALENDAR.some((r) => r.year === year)) {
    toast("That year is already in the list.", "navy");
    return;
  }
  try {
    await HITT_API.setWorkCalendarYear(year, { leaveDays: "", workingHours: "" });
    document.getElementById("newCalendarYear").value = "";
    toast(`${year} added.`, "green");
    await loadWorkCalendar();
  } catch (err) {
    toast(`Couldn't add that year: ${err.message}`, "red");
  }
});

/* ============================== AUDITING ============================= */
let auditPage = 1;
let auditTotal = 0;
let auditSearchDebounce = null;

const AUDIT_CATEGORY = {
  project: "Project",
  timetracking: "Time tracking",
  bp: "Business partner",
  invoice: "Invoicing",
  timeoff: "Time off",
  settings: "Settings",
};
function auditCategory(kind) {
  if (!kind) return "Other";
  if (kind === "login" || kind === "logout") return "Session";
  return AUDIT_CATEGORY[String(kind).split(".")[0]] || "Other";
}
function auditActionClass(kind) {
  if (!kind) return "is-update";
  if (kind === "login" || kind === "logout") return "is-session";
  if (/\.(delete|remove)$/.test(kind)) return "is-delete";
  if (/\.(create|insert|add|submit|import)$/.test(kind)) return "is-create";
  return "is-update";
}

async function loadAuditUsers() {
  try {
    const users = await HITT_API.getAuditUsers();
    const sel = document.getElementById("auditUserFilter");
    const current = sel.value;
    sel.innerHTML = `<option value="">Everyone</option>` +
      users.map((u) => `<option value="${u.id}">${escapeHtml(u.name || `#${u.id}`)}</option>`).join("");
    if (users.some((u) => String(u.id) === current)) sel.value = current;
  } catch (err) {
    console.error("[settings] audit users:", err.message);
  }
}

function auditFilters() {
  return {
    userId: document.getElementById("auditUserFilter").value || undefined,
    startDate: document.getElementById("auditStartDate").value || undefined,
    endDate: document.getElementById("auditEndDate").value || undefined,
    search: document.getElementById("auditSearch").value.trim() || undefined,
    page: auditPage,
    limit: Number(document.getElementById("auditPageSize").value),
  };
}

async function loadAudit() {
  const tbody = document.getElementById("auditTableBody");
  const empty = document.getElementById("auditEmpty");
  tbody.innerHTML = `<tr><td colspan="6" class="settings-emp-sub" style="padding:1rem;">Loading…</td></tr>`;
  empty.classList.add("hidden");
  try {
    const { rows, total } = await HITT_API.getAuditLogs(auditFilters());
    auditTotal = total;
    renderAudit(rows);
  } catch (err) {
    console.error("[settings] audit logs:", err.message);
    tbody.innerHTML = "";
    empty.textContent = "Could not load the audit log.";
    empty.classList.remove("hidden");
    auditTotal = 0;
  }
  updateAuditPagination();
}

function renderAudit(rows) {
  const tbody = document.getElementById("auditTableBody");
  const empty = document.getElementById("auditEmpty");
  if (!rows.length) {
    tbody.innerHTML = "";
    empty.textContent = "No audit entries match these filters.";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  tbody.innerHTML = rows.map((r) => `
    <tr>
      <td class="settings-emp-sub" style="white-space:nowrap;">${new Date(r.at).toLocaleString()}</td>
      <td>${escapeHtml(r.employeeName || r.username || "—")}</td>
      <td>
        <span class="audit-action-chip ${auditActionClass(r.action)}">${escapeHtml(auditCategory(r.action))}</span>
        ${r.action ? `<div class="audit-action-kind">${escapeHtml(r.action)}</div>` : ""}
      </td>
      <td>${escapeHtml(r.summary || "")}</td>
      <td class="settings-emp-sub">${escapeHtml(r.ip || "—")}</td>
      <td class="settings-emp-sub" title="${escapeHtml(r.userAgent || "")}">${escapeHtml(r.computer || "—")}</td>
    </tr>
  `).join("");
}

function auditTotalPages() {
  return Math.max(1, Math.ceil(auditTotal / Number(document.getElementById("auditPageSize").value)));
}

function updateAuditPagination() {
  const pages = auditTotalPages();
  document.getElementById("auditPageInfo").textContent = auditTotal
    ? `Page ${auditPage} of ${pages} · ${auditTotal} ${auditTotal === 1 ? "entry" : "entries"}`
    : "";
  document.getElementById("btnAuditPrev").disabled = auditPage <= 1;
  document.getElementById("btnAuditNext").disabled = auditPage >= pages;
}

["auditUserFilter", "auditStartDate", "auditEndDate", "auditPageSize"].forEach((id) => {
  document.getElementById(id).addEventListener("change", () => { auditPage = 1; loadAudit(); });
});
document.getElementById("auditSearch").addEventListener("input", () => {
  clearTimeout(auditSearchDebounce);
  auditSearchDebounce = setTimeout(() => { auditPage = 1; loadAudit(); }, 300);
});
document.getElementById("btnAuditClear").addEventListener("click", () => {
  document.getElementById("auditUserFilter").value = "";
  document.getElementById("auditStartDate").value = "";
  document.getElementById("auditEndDate").value = "";
  document.getElementById("auditSearch").value = "";
  auditPage = 1;
  loadAudit();
});
document.getElementById("btnAuditPrev").addEventListener("click", () => {
  if (auditPage > 1) { auditPage--; loadAudit(); }
});
document.getElementById("btnAuditNext").addEventListener("click", () => {
  if (auditPage < auditTotalPages()) { auditPage++; loadAudit(); }
});

loadEmployees();
