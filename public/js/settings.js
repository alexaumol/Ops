/**
 * HITT Ops — Settings (admin-only)
 * ---------------------------------------------------------------------------
 * Thin CRUD UI over /api/settings — see server/routes/settings.js and
 * server/lib/permissions.js for the actual rules (admins allow-list,
 * modulerestrictions block-list, timeoffapprovers allow-list). This page
 * has no precedent in the Access app ("General settings.frm" only hinted
 * at the idea) — it exists purely to make the new permissions layer usable
 * without hand-editing the database.
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

const MODULE_LABELS = {
  "projects": "Projects",
  "business-partners": "Business partners",
  "time-allocation": "Time allocation",
  "invoicing": "Invoicing",
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
  const moduleChips = Object.keys(MODULE_LABELS).map((key) => {
    const hasAccess = emp.isAdmin || !emp.restrictedModules.includes(key);
    return `
      <label class="module-chip ${hasAccess ? "" : "is-off"}" data-module="${key}">
        <input type="checkbox" ${hasAccess ? "checked" : ""} ${emp.isAdmin ? "disabled" : ""} class="moduleAccessToggle" data-emp="${emp.id}" data-module="${key}" />
        ${escapeHtml(MODULE_LABELS[key])}
      </label>`;
  }).join("");

  return `
    <tr>
      <td>
        <div class="settings-emp-name">${escapeHtml(emp.name || emp.username)}</div>
        <div class="settings-emp-sub">${escapeHtml(emp.emailid || emp.username)}</div>
      </td>
      <td>
        <label class="switch" title="Admin">
          <input type="checkbox" class="adminToggle" data-emp="${emp.id}" ${emp.isAdmin ? "checked" : ""} />
          <span class="switch-track"></span>
        </label>
        <span class="settings-emp-sub">${emp.isAdmin ? "Admin" : "User"}</span>
      </td>
      <td>
        <label class="switch" title="Time-off approver">
          <input type="checkbox" class="approverToggle" data-emp="${emp.id}" ${emp.isTimeOffApprover ? "checked" : ""} ${emp.isAdmin ? "disabled" : ""} />
          <span class="switch-track"></span>
        </label>
        ${emp.isAdmin ? '<span class="settings-badge" title="Admins are always approvers">Auto</span>' : ""}
      </td>
      <td><div class="module-chip-row">${moduleChips}</div></td>
    </tr>`;
}

function render() {
  document.getElementById("empTableBody").innerHTML = EMPLOYEES.map(renderRow).join("");
}

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
    if (e.target.classList.contains("adminToggle")) {
      const isAdmin = e.target.checked;
      await HITT_API.setEmployeeAdmin(empId, isAdmin);
      emp.isAdmin = isAdmin;
      if (isAdmin) { emp.isTimeOffApprover = true; emp.restrictedModules = []; }
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
