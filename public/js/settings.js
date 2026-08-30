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
  "expenses": "Expenses",
  "reports": "Reports",
  "chat": "Ops assistant",
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
        <div class="settings-emp-name">
          <span>${escapeHtml(emp.name || emp.username || "—")}</span>
          <button type="button" class="settings-emp-edit" data-edit-user="${emp.id}" title="Edit this user">✎</button>
        </div>
        <div class="settings-emp-sub">${escapeHtml(emp.emailid || emp.username || "")}</div>
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

/* ---------- Add / edit user ---------- */
let editingUserId = null;
let oneDriveDocsBase = "";
const userModal = document.getElementById("userModal");

// modal field id -> employeesinfo column
const USER_INFO_FIELDS = {
  userOnboard: "onboarddate",
  userTermination: "terminationdate",
  userBirthday: "birthdaydate",
  userPhonePersonal: "phone_personal",
  userEmailPersonal: "email_personal",
  userContact1: "contact_emergency1",
  userPhone1: "phone_emergency1",
  userContact2: "contact_emergency2",
  userPhone2: "phone_emergency2",
  userBankName: "bankname",
  userBankAcct: "bankacctemp",
};
const isoDay = (v) => (v ? String(v).slice(0, 10) : "");

function updateDocPathPreview() {
  const username = document.getElementById("userUsername").value.trim();
  const el = document.getElementById("userDocPath");
  const hint = document.getElementById("userDocPathHint");
  if (oneDriveDocsBase && username) {
    el.value = `${oneDriveDocsBase.replace(/[/\\]+$/, "")}/${username}`;
    hint.textContent = "Saved automatically as the base folder (Paths tab) plus the username.";
  } else {
    el.value = "";
    hint.textContent = oneDriveDocsBase
      ? "Set a username to generate the documents folder."
      : "Set the base folder on the Paths tab to generate this.";
  }
}
document.getElementById("userUsername").addEventListener("input", updateDocPathPreview);

function fillUserModal(detail) {
  const emp = detail || {};
  document.getElementById("userModalTitle").textContent =
    (window.HITT_I18N ? HITT_I18N.t(detail ? "settings.user.editTitle" : "settings.user.addTitle") : (detail ? "Edit user" : "Add new user"));
  document.getElementById("userFirstName").value = emp.firstName || "";
  document.getElementById("userLastName").value = emp.lastName || "";
  document.getElementById("userUsername").value = emp.username || "";
  document.getElementById("userEmail").value = emp.emailid || "";
  const info = emp.info || {};
  Object.entries(USER_INFO_FIELDS).forEach(([fieldId, col]) => {
    const isDate = fieldId === "userOnboard" || fieldId === "userTermination" || fieldId === "userBirthday";
    document.getElementById(fieldId).value = isDate ? isoDay(info[col]) : (info[col] || "");
  });
  updateDocPathPreview();
}

async function openUserModal(empId) {
  editingUserId = empId || null;
  fillUserModal(null); // reset first
  if (empId) {
    try {
      const detail = await HITT_API.getEmployeeDetail(empId);
      if (editingUserId !== empId) return; // modal closed/reopened while loading
      fillUserModal(detail);
    } catch (err) {
      toast(`Couldn't load that user: ${err.message}`, "red");
      return;
    }
  }
  userModal.classList.remove("hidden");
  setTimeout(() => document.getElementById("userFirstName").focus(), 50);
}
function closeUserModal() { userModal.classList.add("hidden"); editingUserId = null; }

document.getElementById("btnAddUser").addEventListener("click", () => openUserModal(null));
document.getElementById("userModalClose").addEventListener("click", closeUserModal);
document.getElementById("userModalCancel").addEventListener("click", closeUserModal);
userModal.addEventListener("click", (e) => { if (e.target === userModal) closeUserModal(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !userModal.classList.contains("hidden")) closeUserModal();
});

document.getElementById("empTableBody").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-edit-user]");
  if (btn) openUserModal(Number(btn.dataset.editUser));
});

document.getElementById("userModalSave").addEventListener("click", async () => {
  const info = {};
  Object.entries(USER_INFO_FIELDS).forEach(([fieldId, col]) => {
    info[col] = document.getElementById(fieldId).value.trim() || null;
  });
  const payload = {
    firstName: document.getElementById("userFirstName").value.trim(),
    lastName: document.getElementById("userLastName").value.trim(),
    username: document.getElementById("userUsername").value.trim(),
    email: document.getElementById("userEmail").value.trim(),
    info,
  };
  if (!payload.firstName || !payload.lastName) {
    toast("First and last name are required.", "red");
    return;
  }
  const btn = document.getElementById("userModalSave");
  btn.disabled = true;
  try {
    if (editingUserId) {
      await HITT_API.updateEmployeeProfile(editingUserId, payload);
      toast("User updated.", "green");
    } else {
      await HITT_API.createEmployee(payload);
      toast("User added.", "green");
    }
    closeUserModal();
    await loadEmployees();
  } catch (err) {
    toast(`Couldn't save the user: ${err.message}`, "red");
  } finally {
    btn.disabled = false;
  }
});

async function loadEmployees() {
  try {
    EMPLOYEES = await HITT_API.getSettingsEmployees();
    document.getElementById("settingsBlocked").classList.add("hidden");
    document.getElementById("settingsContent").classList.remove("hidden");
    render();
    // Prime the OneDrive base so the user modal's folder preview works
    // before the Paths tab is opened.
    HITT_API.getAppConfig().then((d) => applyOneDriveBase(d.keys)).catch(() => {});
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
let calendarLoaded = false; // covers both holidays + work calendar
let auditLoaded = false;
let pathsLoaded = false;
let expCatsLoaded = false;
let currenciesLoaded = false;
let entitiesLoaded = false;
let customizationsLoaded = false;

document.querySelectorAll("[data-stab]").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-stab]").forEach((b) => b.setAttribute("aria-selected", "false"));
    btn.setAttribute("aria-selected", "true");
    const tab = btn.dataset.stab;
    document.getElementById("paneUserPerms").classList.toggle("hidden", tab !== "permissions");
    document.getElementById("paneCalendar").classList.toggle("hidden", tab !== "calendar");
    document.getElementById("panePaths").classList.toggle("hidden", tab !== "paths");
    document.getElementById("paneExpCats").classList.toggle("hidden", tab !== "expcats");
    document.getElementById("paneCurrencies").classList.toggle("hidden", tab !== "currencies");
    document.getElementById("paneEntities").classList.toggle("hidden", tab !== "entities");
    document.getElementById("paneCustomizations").classList.toggle("hidden", tab !== "customizations");
    document.getElementById("paneAudit").classList.toggle("hidden", tab !== "audit");
    if (tab === "calendar" && !calendarLoaded) {
      calendarLoaded = true;
      loadHolidayYears().then(loadHolidays);
      loadWorkCalendar();
    }
    if (tab === "paths" && !pathsLoaded) {
      pathsLoaded = true;
      loadPaths();
    }
    if (tab === "expcats" && !expCatsLoaded) {
      expCatsLoaded = true;
      loadCategoriesTab();
    }
    if (tab === "currencies" && !currenciesLoaded) {
      currenciesLoaded = true;
      loadCurrencies();
    }
    if (tab === "entities" && !entitiesLoaded) {
      entitiesLoaded = true;
      loadEntities();
    }
    if (tab === "customizations" && !customizationsLoaded) {
      customizationsLoaded = true;
      loadBranding();
      loadDefaultLanguage();
    }
    if (tab === "audit" && !auditLoaded) {
      auditLoaded = true;
      Promise.all([loadAuditUsers(), loadAuditKinds()]).then(loadAudit);
    }
  });
});

/* ============================== PATHS ================================== */
function applyOneDriveBase(keys) {
  const k = (keys || []).find((x) => x.key === "onedrive.employee_docs_base");
  oneDriveDocsBase = k?.value || "";
}

async function loadPaths() {
  const host = document.getElementById("pathsList");
  host.innerHTML = `<div class="settings-emp-sub">Loading…</div>`;
  let data;
  try {
    data = await HITT_API.getAppConfig();
  } catch (err) {
    console.error("[settings] config:", err.message);
    host.innerHTML = `<div class="settings-pane-empty">Could not load the configuration.</div>`;
    return;
  }
  applyOneDriveBase(data.keys);
  host.innerHTML = data.keys.map((k, i) => `
    <div class="path-item" data-key="${escapeHtml(k.key)}">
      <label for="pathInput${i}">${escapeHtml(k.label)}</label>
      <div class="path-row">
        <input id="pathInput${i}" type="text" value="${escapeHtml(k.value || "")}" placeholder="${escapeHtml(k.placeholder || "")}" />
        <button type="button" class="btn btn-primary" data-save-path>Save</button>
      </div>
      ${k.hint ? `<p class="path-hint">${escapeHtml(k.hint)}</p>` : ""}
    </div>
  `).join("");
  host.querySelectorAll("[data-save-path]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const item = btn.closest(".path-item");
      const key = item.dataset.key;
      const value = item.querySelector("input").value.trim();
      btn.disabled = true;
      try {
        await HITT_API.setAppConfig(key, value);
        if (key === "onedrive.employee_docs_base") oneDriveDocsBase = value;
        toast("Saved.", "green");
      } catch (err) {
        toast(`Couldn't save: ${err.message}`, "red");
      } finally {
        btn.disabled = false;
      }
    });
  });
}

/* ===================== CATEGORIES TAB (id/name catalogs) ============== */
// One factory drives all three lists on the Categories tab: expense
// categories, biotech spectrum, project type. Same table markup + CRUD.
function makeCatalog({ slug, bodyId, emptyId, inputId, addBtnId }) {
  const api = () => HITT_API.settingsCatalog(slug);
  let items = [];
  const tbody = () => document.getElementById(bodyId);
  const emptyEl = () => document.getElementById(emptyId);

  function render() {
    if (!items.length) {
      tbody().innerHTML = "";
      emptyEl().classList.remove("hidden");
      return;
    }
    emptyEl().classList.add("hidden");
    tbody().innerHTML = items.map((c) => `
      <tr data-id="${c.id}">
        <td><input type="text" class="cal-input" style="width:100%; text-align:left;" data-cat-name value="${escapeHtml(c.name)}" /></td>
        <td class="settings-emp-sub" style="text-align:right;">${c.usageCount}</td>
        <td style="text-align:right;">
          <button class="icon-btn" data-del-cat title="${c.usageCount ? "In use — cannot delete" : "Delete"}" ${c.usageCount ? "disabled style='opacity:.35;'" : ""}>✕</button>
        </td>
      </tr>`).join("");
    tbody().querySelectorAll("input[data-cat-name]").forEach((input) => {
      let original = input.value;
      input.addEventListener("focus", () => { original = input.value; });
      input.addEventListener("change", async () => {
        const name = input.value.trim();
        const id = input.closest("tr").dataset.id;
        if (!name || name === original) { input.value = original; return; }
        try {
          await api().rename(id, name);
          original = name;
          const it = items.find((x) => String(x.id) === String(id));
          if (it) it.name = name;
          toast("Renamed.", "green");
        } catch (err) {
          input.value = original;
          toast(`Couldn't rename: ${err.message}`, "red");
        }
      });
    });
    tbody().querySelectorAll("[data-del-cat]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.closest("tr").dataset.id;
        const it = items.find((x) => String(x.id) === String(id));
        if (!it || !confirm(`Delete "${it.name}"?`)) return;
        try {
          await api().remove(id);
          items = items.filter((x) => String(x.id) !== String(id));
          render();
          toast("Deleted.", "navy");
        } catch (err) {
          toast(`Couldn't delete: ${err.message}`, "red");
        }
      });
    });
  }

  async function load() {
    tbody().innerHTML = `<tr><td colspan="3" class="settings-emp-sub" style="padding:1rem;">Loading…</td></tr>`;
    emptyEl().classList.add("hidden");
    try {
      items = await api().list();
      render();
    } catch (err) {
      console.error(`[settings] ${slug}:`, err.message);
      tbody().innerHTML = "";
      emptyEl().textContent = "Could not load the list.";
      emptyEl().classList.remove("hidden");
    }
  }

  const addBtn = document.getElementById(addBtnId);
  if (addBtn) {
    addBtn.addEventListener("click", async () => {
      const input = document.getElementById(inputId);
      const name = input.value.trim();
      if (!name) { toast("Enter a name.", "red"); return; }
      try {
        const created = await api().create(name);
        items.push(created);
        items.sort((a, b) => a.name.localeCompare(b.name));
        input.value = "";
        render();
        toast("Added.", "green");
      } catch (err) {
        toast(`Couldn't add: ${err.message}`, "red");
      }
    });
  }

  return { load };
}

const CATALOGS_UI = [
  makeCatalog({ slug: "expense-categories", bodyId: "expCatTableBody", emptyId: "expCatEmpty", inputId: "newExpCatName", addBtnId: "btnAddExpCat" }),
  makeCatalog({ slug: "biotech-spectrums", bodyId: "bioSpectrumTableBody", emptyId: "bioSpectrumEmpty", inputId: "newBioSpectrumName", addBtnId: "btnAddBioSpectrum" }),
  makeCatalog({ slug: "project-types", bodyId: "projTypeTableBody", emptyId: "projTypeEmpty", inputId: "newProjTypeName", addBtnId: "btnAddProjType" }),
];

function loadCategoriesTab() {
  CATALOGS_UI.forEach((c) => c.load());
}

/* ============================== INVOICE CURRENCIES ================== */
let CURRENCIES = [];

async function loadCurrencies() {
  const tbody = document.getElementById("currencyTableBody");
  const empty = document.getElementById("currencyEmpty");
  tbody.innerHTML = `<tr><td colspan="6" class="settings-emp-sub" style="padding:1rem;">Loading…</td></tr>`;
  empty.classList.add("hidden");
  try {
    CURRENCIES = await HITT_API.getInvoiceCurrencies();
    renderCurrencies();
  } catch (err) {
    console.error("[settings] currencies:", err.message);
    tbody.innerHTML = "";
    empty.textContent = "Could not load currencies.";
    empty.classList.remove("hidden");
  }
}

function renderCurrencies() {
  const tbody = document.getElementById("currencyTableBody");
  const empty = document.getElementById("currencyEmpty");
  if (!CURRENCIES.length) {
    tbody.innerHTML = "";
    empty.textContent = "No currencies yet.";
    empty.classList.remove("hidden");
    return;
  }
  empty.classList.add("hidden");
  tbody.innerHTML = CURRENCIES.map((c, i) => {
    const locked = c.code === "EUR";
    const canDelete = !locked && !c.usageCount;
    return `
    <tr data-id="${c.id}">
      <td style="white-space:nowrap;">
        <button class="icon-btn" data-cur-up title="Move up" ${i === 0 ? "disabled style='opacity:.35;'" : ""}>▲</button>
        <button class="icon-btn" data-cur-down title="Move down" ${i === CURRENCIES.length - 1 ? "disabled style='opacity:.35;'" : ""}>▼</button>
      </td>
      <td style="font-family:ui-monospace,monospace; font-weight:700;">${escapeHtml(c.code)}</td>
      <td><input type="text" class="cal-input" style="width:4rem; text-align:center;" data-cur-symbol value="${escapeHtml(c.symbol || "")}" /></td>
      <td><input type="text" class="cal-input" style="width:12rem; text-align:left;" data-cur-label value="${escapeHtml(c.label || "")}" /></td>
      <td class="settings-emp-sub" style="text-align:right;">${c.usageCount}</td>
      <td style="text-align:right;">
        <button class="icon-btn" data-del-cur title="${locked ? "Default currency" : c.usageCount ? "In use — cannot delete" : "Delete"}" ${canDelete ? "" : "disabled style='opacity:.35;'"}>✕</button>
      </td>
    </tr>`;
  }).join("");

  tbody.querySelectorAll("tr").forEach((tr) => {
    const id = tr.dataset.id;
    const cur = CURRENCIES.find((x) => String(x.id) === String(id));

    const move = async (dir) => {
      const idx = CURRENCIES.findIndex((x) => String(x.id) === String(id));
      const swap = idx + dir;
      if (idx < 0 || swap < 0 || swap >= CURRENCIES.length) return;
      [CURRENCIES[idx], CURRENCIES[swap]] = [CURRENCIES[swap], CURRENCIES[idx]];
      renderCurrencies();
      try {
        await HITT_API.reorderInvoiceCurrencies(CURRENCIES.map((x) => x.id));
      } catch (err) {
        toast(`Couldn't save order: ${err.message}`, "red");
        loadCurrencies();
      }
    };
    tr.querySelector("[data-cur-up]").addEventListener("click", () => move(-1));
    tr.querySelector("[data-cur-down]").addEventListener("click", () => move(1));
    const save = async () => {
      const symbol = tr.querySelector("[data-cur-symbol]").value.trim();
      const label = tr.querySelector("[data-cur-label]").value.trim();
      if (cur && symbol === cur.symbol && label === cur.label) return;
      try {
        const updated = await HITT_API.updateInvoiceCurrency(id, { symbol, label });
        if (cur) { cur.symbol = updated.symbol; cur.label = updated.label; }
        toast("Currency updated.", "green");
      } catch (err) {
        toast(`Couldn't update: ${err.message}`, "red");
        renderCurrencies();
      }
    };
    tr.querySelector("[data-cur-symbol]").addEventListener("change", save);
    tr.querySelector("[data-cur-label]").addEventListener("change", save);
    tr.querySelector("[data-del-cur]").addEventListener("click", async () => {
      if (!cur || !confirm(`Delete the ${cur.code} currency?`)) return;
      try {
        await HITT_API.deleteInvoiceCurrency(id);
        CURRENCIES = CURRENCIES.filter((x) => String(x.id) !== String(id));
        renderCurrencies();
        toast("Currency deleted.", "navy");
      } catch (err) {
        toast(`Couldn't delete: ${err.message}`, "red");
      }
    });
  });
}

document.getElementById("btnAddCurrency").addEventListener("click", async () => {
  const code = document.getElementById("newCurrencyCode").value.trim().toUpperCase();
  const symbol = document.getElementById("newCurrencySymbol").value.trim();
  const label = document.getElementById("newCurrencyLabel").value.trim();
  if (!code) { toast("Enter a currency code.", "red"); return; }
  try {
    const created = await HITT_API.createInvoiceCurrency({ code, symbol, label });
    CURRENCIES.push(created);
    ["newCurrencyCode", "newCurrencySymbol", "newCurrencyLabel"].forEach((id) => { document.getElementById(id).value = ""; });
    renderCurrencies();
    toast("Currency added.", "green");
  } catch (err) {
    toast(`Couldn't add: ${err.message}`, "red");
  }
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
  const SRC_LABELS = { catalonia: "Public", hitt: "HITT", local: "Local", legacy: "Legacy" };
  tbody.innerHTML = HOLIDAYS.map((h) => {
    const src = String(h.source || "legacy");
    const srcLabel = SRC_LABELS[src] || "Legacy";
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
  const kind = document.getElementById("newHolidayType").value; // 'hitt' | 'local'
  if (!date || !desc) {
    toast("Pick a date and enter a description.", "red");
    return;
  }
  try {
    await HITT_API.addHoliday({ date, description: desc, kind });
    document.getElementById("newHolidayDate").value = "";
    document.getElementById("newHolidayDesc").value = "";
    toast(`${kind === "local" ? "Local bank holiday" : "HITT holiday"} added.`, "green");
    await loadHolidayYears();
    await loadHolidays();
  } catch (err) {
    toast(`Couldn't add that holiday: ${err.message}`, "red");
  }
});

document.getElementById("btnImportHolidays").addEventListener("click", async () => {
  const btn = document.getElementById("btnImportHolidays");
  const status = document.getElementById("holidayImportStatus");
  if (!confirm("Import public holidays (2024 onwards) from the Generalitat de Catalunya feed? This replaces the previously imported set — HITT and local holidays you added here are kept.")) return;
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
let auditSort = "at";
let auditDir = "desc";

const AUDIT_CATEGORY = {
  project: "Project",
  timetracking: "Time tracking",
  bp: "Business partner",
  invoice: "Invoicing",
  expense: "Expenses",
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

async function loadAuditKinds() {
  try {
    const kinds = await HITT_API.getAuditKinds();
    const sel = document.getElementById("auditKindFilter");
    const current = sel.value;
    // Category shortcuts first, then the exact codes actually present.
    const cats = Object.entries({ session: "Session", ...AUDIT_CATEGORY })
      .map(([k, label]) => `<option value="cat:${k}">All ${label}</option>`).join("");
    const specific = kinds.map((k) => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join("");
    sel.innerHTML =
      `<option value="">All actions</option>` +
      `<optgroup label="By category">${cats}</optgroup>` +
      (specific ? `<optgroup label="Specific">${specific}</optgroup>` : "");
    sel.value = current; // keep selection if still valid; browser drops it otherwise
  } catch (err) {
    console.error("[settings] audit kinds:", err.message);
  }
}

function auditFilters() {
  return {
    userId: document.getElementById("auditUserFilter").value || undefined,
    kind: document.getElementById("auditKindFilter").value || undefined,
    startDate: document.getElementById("auditStartDate").value || undefined,
    endDate: document.getElementById("auditEndDate").value || undefined,
    search: document.getElementById("auditSearch").value.trim() || undefined,
    sort: auditSort,
    dir: auditDir,
    page: auditPage,
    limit: Number(document.getElementById("auditPageSize").value),
  };
}

function updateAuditSortIndicators() {
  document.querySelectorAll(".audit-table th[data-sort]").forEach((th) => {
    const active = th.dataset.sort === auditSort;
    th.classList.toggle("sorted", active);
    const arrow = th.querySelector(".sort-arrow");
    if (arrow) arrow.textContent = active ? (auditDir === "asc" ? "▲" : "▼") : "";
  });
}

document.querySelectorAll(".audit-table th[data-sort]").forEach((th) => {
  th.addEventListener("click", () => {
    const col = th.dataset.sort;
    if (auditSort === col) {
      auditDir = auditDir === "asc" ? "desc" : "asc";
    } else {
      auditSort = col;
      auditDir = col === "at" ? "desc" : "asc";
    }
    auditPage = 1;
    loadAudit();
  });
});

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
  updateAuditSortIndicators();
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

["auditUserFilter", "auditKindFilter", "auditStartDate", "auditEndDate", "auditPageSize"].forEach((id) => {
  document.getElementById(id).addEventListener("change", () => { auditPage = 1; loadAudit(); });
});
document.getElementById("auditSearch").addEventListener("input", () => {
  clearTimeout(auditSearchDebounce);
  auditSearchDebounce = setTimeout(() => { auditPage = 1; loadAudit(); }, 300);
});
document.getElementById("btnAuditClear").addEventListener("click", () => {
  document.getElementById("auditUserFilter").value = "";
  document.getElementById("auditKindFilter").value = "";
  document.getElementById("auditStartDate").value = "";
  document.getElementById("auditEndDate").value = "";
  document.getElementById("auditSearch").value = "";
  auditSort = "at";
  auditDir = "desc";
  auditPage = 1;
  loadAudit();
});
document.getElementById("btnAuditPrev").addEventListener("click", () => {
  if (auditPage > 1) { auditPage--; loadAudit(); }
});
document.getElementById("btnAuditNext").addEventListener("click", () => {
  if (auditPage < auditTotalPages()) { auditPage++; loadAudit(); }
});

/* ============================== CUSTOMIZATIONS (logo) ================== */
const BRAND_FRAME = 260;   // on-screen crop frame, px (matches canvas + CSS)
const BRAND_EXPORT = 512;  // saved PNG size, px

const brandEls = {
  current: document.getElementById("brandCurrentLogo"),
  file: document.getElementById("brandFile"),
  cropArea: document.getElementById("brandCropArea"),
  stage: document.getElementById("brandCropStage"),
  canvas: document.getElementById("brandCropCanvas"),
  zoom: document.getElementById("brandZoom"),
  cancel: document.getElementById("btnBrandCancel"),
  save: document.getElementById("btnBrandSave"),
};

const brandCrop = { img: null, baseScale: 1, zoom: 1, offsetX: 0, offsetY: 0, drag: null };
const DEFAULT_LOGO_SRC = "../assets/fhitt-logo.png";

const TI = (k, v) => (window.HITT_I18N ? HITT_I18N.t(k, v) : k);

async function loadBranding() {
  try {
    const { dataUrl } = await HITT_API.getBrandingLogo();
    brandEls.current.src = dataUrl || DEFAULT_LOGO_SRC;
  } catch (err) {
    console.error("[settings] branding:", err.message);
  }
}

/* ---- default UI language --------------------------------------------- */
const langEls = {
  select: document.getElementById("defaultLangSelect"),
  save: document.getElementById("btnSaveDefaultLang"),
  note: document.getElementById("langOverrideNote"),
};
let savedDefaultLang = "en";

function fillLangSelect() {
  const codes = (window.HITT_I18N && HITT_I18N.supported) || ["en", "es", "ca"];
  langEls.select.innerHTML = codes
    .map((c) => `<option value="${c}">${TI("lang." + c)}</option>`)
    .join("");
  langEls.select.value = savedDefaultLang;
}

function paintLangOverrideNote() {
  const uw = window.HITT_I18N && HITT_I18N.userLang;
  if (uw) {
    langEls.note.innerHTML =
      escapeHtml(TI("cust.lang.yourChoice", { lang: TI("lang." + uw) })) +
      ` <button type="button" class="linklike" id="btnClearLangOverride">${escapeHtml(TI("cust.lang.clearOverride"))}</button>`;
    const btn = document.getElementById("btnClearLangOverride");
    if (btn) btn.addEventListener("click", () => { HITT_I18N.clearUserLang(); paintLangOverrideNote(); });
  } else {
    langEls.note.textContent = "";
  }
}

async function loadDefaultLanguage() {
  fillLangSelect();
  paintLangOverrideNote();
  try {
    const { language } = await HITT_API.getAppLanguage();
    savedDefaultLang = language || "en";
    langEls.select.value = savedDefaultLang;
  } catch (err) {
    console.error("[settings] default language:", err.message);
  }
}

langEls.save.addEventListener("click", async () => {
  const code = langEls.select.value;
  langEls.save.disabled = true;
  try {
    await HITT_API.setAppLanguage(code);
    savedDefaultLang = code;
    // Updates the remembered default; if this admin has no personal
    // override the UI switches to it right away.
    if (window.HITT_I18N) HITT_I18N.setDefaultLang(code);
    toast(TI("cust.lang.saved"), "green");
  } catch (err) {
    toast(err.message || TI("cust.lang.savedError"), "red");
  } finally {
    langEls.save.disabled = false;
  }
});

window.addEventListener("hitt:langchange", () => {
  if (customizationsLoaded) {
    fillLangSelect();
    paintLangOverrideNote();
    loadBranding();
  }
});

function brandClampOffsets() {
  if (!brandCrop.img) return;
  const w = brandCrop.img.naturalWidth * brandCrop.baseScale * brandCrop.zoom;
  const h = brandCrop.img.naturalHeight * brandCrop.baseScale * brandCrop.zoom;
  const maxX = Math.max(0, (w - BRAND_FRAME) / 2);
  const maxY = Math.max(0, (h - BRAND_FRAME) / 2);
  brandCrop.offsetX = Math.min(maxX, Math.max(-maxX, brandCrop.offsetX));
  brandCrop.offsetY = Math.min(maxY, Math.max(-maxY, brandCrop.offsetY));
}

function brandDraw() {
  const ctx = brandEls.canvas.getContext("2d");
  ctx.clearRect(0, 0, BRAND_FRAME, BRAND_FRAME);
  if (!brandCrop.img) return;
  const w = brandCrop.img.naturalWidth * brandCrop.baseScale * brandCrop.zoom;
  const h = brandCrop.img.naturalHeight * brandCrop.baseScale * brandCrop.zoom;
  const x = (BRAND_FRAME - w) / 2 + brandCrop.offsetX;
  const y = (BRAND_FRAME - h) / 2 + brandCrop.offsetY;
  ctx.drawImage(brandCrop.img, x, y, w, h);
}

function brandStartCrop(dataUrl) {
  const img = new Image();
  img.onload = () => {
    brandCrop.img = img;
    // "contain" — whole image visible at zoom 1, user zooms in to crop.
    brandCrop.baseScale = Math.min(BRAND_FRAME / img.naturalWidth, BRAND_FRAME / img.naturalHeight);
    brandCrop.zoom = 1;
    brandCrop.offsetX = 0;
    brandCrop.offsetY = 0;
    brandEls.zoom.value = "1";
    brandEls.cropArea.classList.remove("hidden");
    brandDraw();
  };
  img.onerror = () => toast("That image could not be read.", "red");
  img.src = dataUrl;
}

brandEls.file.addEventListener("change", () => {
  const f = brandEls.file.files && brandEls.file.files[0];
  if (!f) return;
  if (!/^image\/(png|jpeg|webp)$/.test(f.type)) {
    toast("Choose a PNG, JPEG or WebP image.", "red");
    brandEls.file.value = "";
    return;
  }
  if (f.size > 8 * 1024 * 1024) {
    toast("That file is over 8 MB — pick a smaller one.", "red");
    brandEls.file.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => brandStartCrop(reader.result);
  reader.onerror = () => toast("That image could not be read.", "red");
  reader.readAsDataURL(f);
});

brandEls.zoom.addEventListener("input", () => {
  brandCrop.zoom = Number(brandEls.zoom.value) || 1;
  brandClampOffsets();
  brandDraw();
});

function brandPointerXY(e) {
  const t = e.touches && e.touches[0];
  return { x: (t || e).clientX, y: (t || e).clientY };
}
brandEls.stage.addEventListener("pointerdown", (e) => {
  if (!brandCrop.img) return;
  const p = brandPointerXY(e);
  brandCrop.drag = { x: p.x, y: p.y, ox: brandCrop.offsetX, oy: brandCrop.offsetY };
  try { brandEls.stage.setPointerCapture(e.pointerId); } catch (err) {}
});
brandEls.stage.addEventListener("pointermove", (e) => {
  if (!brandCrop.drag) return;
  const p = brandPointerXY(e);
  brandCrop.offsetX = brandCrop.drag.ox + (p.x - brandCrop.drag.x);
  brandCrop.offsetY = brandCrop.drag.oy + (p.y - brandCrop.drag.y);
  brandClampOffsets();
  brandDraw();
});
["pointerup", "pointercancel", "pointerleave"].forEach((ev) =>
  brandEls.stage.addEventListener(ev, () => { brandCrop.drag = null; })
);

function brandCloseCrop() {
  brandCrop.img = null;
  brandCrop.drag = null;
  brandEls.cropArea.classList.add("hidden");
  brandEls.file.value = "";
}
brandEls.cancel.addEventListener("click", brandCloseCrop);

brandEls.save.addEventListener("click", async () => {
  if (!brandCrop.img) return;
  const out = document.createElement("canvas");
  out.width = BRAND_EXPORT;
  out.height = BRAND_EXPORT;
  const k = BRAND_EXPORT / BRAND_FRAME;
  const ctx = out.getContext("2d");
  const w = brandCrop.img.naturalWidth * brandCrop.baseScale * brandCrop.zoom * k;
  const h = brandCrop.img.naturalHeight * brandCrop.baseScale * brandCrop.zoom * k;
  const x = (BRAND_EXPORT - w) / 2 + brandCrop.offsetX * k;
  const y = (BRAND_EXPORT - h) / 2 + brandCrop.offsetY * k;
  ctx.drawImage(brandCrop.img, x, y, w, h);
  const dataUrl = out.toDataURL("image/png");

  brandEls.save.disabled = true;
  try {
    await HITT_API.setBrandingLogo(dataUrl);
    brandEls.current.src = dataUrl;
    if (window.HITT_BRANDING) {
      window.HITT_BRANDING.cache(dataUrl);
      window.HITT_BRANDING.apply(dataUrl);
    }
    brandCloseCrop();
    toast("Logo saved. Other pages update on their next load.", "green");
  } catch (err) {
    toast(err.message || "Could not save the logo.", "red");
  } finally {
    brandEls.save.disabled = false;
  }
});

/* ============================== ENTITIES ============================== */
const ENT_MAX_LOGO_BYTES = 1.5 * 1024 * 1024;
let ENTITIES = [];
let editingEntityId = null;
let entLogoValue; // undefined = unchanged, null = clear, string = new data URL

const entModal = document.getElementById("entityModal");
const entEls = {
  body: document.getElementById("entityTableBody"),
  empty: document.getElementById("entityEmpty"),
  title: document.getElementById("entityModalTitle"),
  name: document.getElementById("entName"),
  legalName: document.getElementById("entLegalName"),
  vat: document.getElementById("entVat"),
  email: document.getElementById("entEmail"),
  web: document.getElementById("entWeb"),
  address: document.getElementById("entAddress"),
  bankName: document.getElementById("entBankName"),
  bankAddr1: document.getElementById("entBankAddr1"),
  bankAddr2: document.getElementById("entBankAddr2"),
  iban: document.getElementById("entIban"),
  bic: document.getElementById("entBic"),
  logoPreview: document.getElementById("entLogoPreview"),
  logoFile: document.getElementById("entLogoFile"),
  logoClear: document.getElementById("btnEntLogoClear"),
  del: document.getElementById("btnEntityDelete"),
};

async function loadEntities() {
  entEls.body.innerHTML = `<tr><td colspan="6" class="settings-emp-sub" style="padding:1rem;">Loading…</td></tr>`;
  try {
    ENTITIES = await HITT_API.getEntities();
  } catch (err) {
    console.error("[settings] entities:", err.message);
    ENTITIES = [];
    entEls.body.innerHTML = `<tr><td colspan="6" class="settings-emp-sub" style="padding:1rem;">Could not load entities.</td></tr>`;
    return;
  }
  renderEntities();
}

function renderEntities() {
  entEls.empty.classList.toggle("hidden", ENTITIES.length > 0);
  entEls.body.innerHTML = ENTITIES.map((e) => `
    <tr>
      <td>
        <span class="settings-emp-name">${escapeHtml(e.entitydesc || "—")}</span>
        ${e.hasLogo ? `<span class="settings-badge" style="margin-left:0.4rem;">logo</span>` : ""}
      </td>
      <td>${escapeHtml(e.legalname || "—")}</td>
      <td>${escapeHtml(e.vatnumber || "—")}</td>
      <td>${escapeHtml(e.emailinvoicing || "—")}</td>
      <td style="text-align:right;">${e.projectCount}</td>
      <td style="text-align:right;">
        <button class="settings-emp-edit" data-edit-entity="${e.id}" title="${escapeHtml(TI("entities.edit"))}">✎</button>
      </td>
    </tr>`).join("");
  entEls.body.querySelectorAll("[data-edit-entity]").forEach((btn) => {
    btn.addEventListener("click", () => openEntityModal(btn.dataset.editEntity));
  });
}

function setEntityLogoPreview(dataUrl) {
  if (dataUrl) {
    entEls.logoPreview.src = dataUrl;
    entEls.logoPreview.style.display = "";
  } else {
    entEls.logoPreview.removeAttribute("src");
    entEls.logoPreview.style.display = "none";
  }
}

function fillEntityModal(e) {
  const d = e || {};
  const b = d.bank || {};
  entEls.name.value = d.entitydesc || "";
  entEls.legalName.value = d.legalname || "";
  entEls.vat.value = d.vatnumber || "";
  entEls.email.value = d.emailinvoicing || "";
  entEls.web.value = d.webpage || "";
  entEls.address.value = d.address || "";
  entEls.bankName.value = b.bankname || "";
  entEls.bankAddr1.value = b.bankaddrline1 || "";
  entEls.bankAddr2.value = b.bankaddrline2 || "";
  entEls.iban.value = b.iban || "";
  entEls.bic.value = b.bicswift || "";
  entLogoValue = undefined;
  entEls.logoFile.value = "";
  setEntityLogoPreview(d.logo || null);
}

async function openEntityModal(id) {
  editingEntityId = id || null;
  entEls.title.textContent = TI(id ? "entities.modal.editTitle" : "entities.modal.addTitle");
  entEls.del.classList.toggle("hidden", !id);
  fillEntityModal(null);
  entModal.classList.remove("hidden");
  if (id) {
    try {
      const detail = await HITT_API.getEntity(id);
      if (editingEntityId !== id) return;
      fillEntityModal(detail);
    } catch (err) {
      toast(err.message || "Could not load that entity.", "red");
    }
  }
  setTimeout(() => entEls.name.focus(), 40);
}
function closeEntityModal() { entModal.classList.add("hidden"); editingEntityId = null; }

document.getElementById("btnAddEntity").addEventListener("click", () => openEntityModal(null));
document.getElementById("entityModalClose").addEventListener("click", closeEntityModal);
document.getElementById("entityModalCancel").addEventListener("click", closeEntityModal);
entModal.addEventListener("click", (e) => { if (e.target === entModal) closeEntityModal(); });

entEls.logoFile.addEventListener("change", () => {
  const f = entEls.logoFile.files && entEls.logoFile.files[0];
  if (!f) return;
  if (!/^image\/(png|jpeg)$/.test(f.type)) {
    toast("Choose a PNG or JPEG image.", "red");
    entEls.logoFile.value = "";
    return;
  }
  if (f.size > ENT_MAX_LOGO_BYTES) {
    toast("That image is too large — use a smaller file (under 1.5 MB).", "red");
    entEls.logoFile.value = "";
    return;
  }
  const reader = new FileReader();
  reader.onload = () => { entLogoValue = reader.result; setEntityLogoPreview(reader.result); };
  reader.onerror = () => toast("That image could not be read.", "red");
  reader.readAsDataURL(f);
});

entEls.logoClear.addEventListener("click", () => {
  entLogoValue = null;
  entEls.logoFile.value = "";
  setEntityLogoPreview(null);
});

document.getElementById("entityModalSave").addEventListener("click", async () => {
  const name = entEls.name.value.trim();
  if (!name) { toast(TI("entities.nameRequired"), "red"); return; }
  const payload = {
    entitydesc: name,
    legalname: entEls.legalName.value,
    vatnumber: entEls.vat.value,
    emailinvoicing: entEls.email.value,
    webpage: entEls.web.value,
    address: entEls.address.value,
    bank: {
      bankname: entEls.bankName.value,
      bankaddrline1: entEls.bankAddr1.value,
      bankaddrline2: entEls.bankAddr2.value,
      iban: entEls.iban.value,
      bicswift: entEls.bic.value,
    },
  };
  if (entLogoValue !== undefined) payload.logo = entLogoValue; // string or null
  const btn = document.getElementById("entityModalSave");
  btn.disabled = true;
  try {
    if (editingEntityId) await HITT_API.updateEntity(editingEntityId, payload);
    else await HITT_API.createEntity(payload);
    toast(TI("entities.saved"), "green");
    closeEntityModal();
    await loadEntities();
  } catch (err) {
    toast(err.message || "Could not save the entity.", "red");
  } finally {
    btn.disabled = false;
  }
});

entEls.del.addEventListener("click", async () => {
  if (!editingEntityId) return;
  const ent = ENTITIES.find((e) => String(e.id) === String(editingEntityId));
  if (!confirm(TI("entities.deleteConfirm", { name: (ent && ent.entitydesc) || "" }))) return;
  try {
    await HITT_API.deleteEntity(editingEntityId);
    toast(TI("entities.deleted"), "green");
    closeEntityModal();
    await loadEntities();
  } catch (err) {
    toast(err.message || "Could not delete the entity.", "red");
  }
});

window.addEventListener("hitt:langchange", () => {
  if (entitiesLoaded) renderEntities();
  if (!entModal.classList.contains("hidden")) {
    entEls.title.textContent = TI(editingEntityId ? "entities.modal.editTitle" : "entities.modal.addTitle");
  }
});

loadEmployees();
