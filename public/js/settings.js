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

loadEmployees();
