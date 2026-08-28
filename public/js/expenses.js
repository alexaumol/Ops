/**
 * HITT Ops — Expenses
 * ---------------------------------------------------------------------------
 * Company expense records (see server/routes/expenses.js). CRUD + bulk
 * edit/delete + one evidence document (image/PDF) per expense.
 * ---------------------------------------------------------------------------
 */
const session = HITT_AUTH.requireSession("../index.html");
HITT_PERMS.guardModule("expenses", "../welcome.html");
document.getElementById("userName").textContent = session.displayName;
document.getElementById("userAvatar").textContent = HITT_AUTH.initials(session);
document.getElementById("btnSignOut").addEventListener("click", () => HITT_AUTH.signOut("../index.html"));
HITT_PERMS.applyRealName();

function escapeHtml(s) { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; }
function toast(msg, tone = "navy") {
  const host = document.getElementById("toastHost");
  const el = document.createElement("div");
  el.className = `toast toast-${tone}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}
function money(n, cur) {
  if (n == null) return "—";
  try { return Number(n).toLocaleString(undefined, { style: "currency", currency: cur || "EUR" }); }
  catch { return `${Number(n).toFixed(2)} ${cur || ""}`.trim(); }
}
function fmtDate(iso) { return iso ? new Date(iso).toLocaleDateString() : "—"; }
function isoDay(v) { return v ? String(v).slice(0, 10) : ""; }

let PROJECTS = [];
let EMPLOYEES = [];
let CATEGORIES = [];
let ROWS = [];
let page = 1;
let total = 0;
const selected = new Set();
let searchDebounce = null;

function setDataSourcePill() {
  const pill = document.getElementById("dataSourcePill");
  pill.textContent = "Live · test environment";
  pill.style.background = "rgba(110,143,90,0.18)";
  pill.style.color = "#4C6B3A";
}

/* ============================== FILTERS =============================== */
function currentScope() {
  return document.querySelector(".exp-scope-btn[aria-selected='true']").dataset.scope || "";
}
function filters() {
  return {
    search: document.getElementById("expSearch").value.trim() || undefined,
    scope: currentScope() || undefined,
    categoryId: document.getElementById("expCategoryFilter").value || undefined,
    startDate: document.getElementById("expStartDate").value || undefined,
    endDate: document.getElementById("expEndDate").value || undefined,
    page,
    limit: Number(document.getElementById("expPageSize").value),
  };
}

function categoryOptions(selectedId, blankLabel) {
  return `<option value="">${blankLabel || "—"}</option>` +
    CATEGORIES.map((c) => `<option value="${c.id}" ${String(c.id) === String(selectedId) ? "selected" : ""}>${escapeHtml(c.name)}</option>`).join("");
}

document.querySelectorAll(".exp-scope-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".exp-scope-btn").forEach((b) => b.setAttribute("aria-selected", "false"));
    btn.setAttribute("aria-selected", "true");
    page = 1; loadExpenses();
  });
});
["expCategoryFilter", "expStartDate", "expEndDate", "expPageSize"].forEach((id) => {
  document.getElementById(id).addEventListener("change", () => { page = 1; loadExpenses(); });
});
document.getElementById("expSearch").addEventListener("input", () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => { page = 1; loadExpenses(); }, 300);
});
document.getElementById("btnExpPrev").addEventListener("click", () => { if (page > 1) { page--; loadExpenses(); } });
document.getElementById("btnExpNext").addEventListener("click", () => {
  if (page < totalPages()) { page++; loadExpenses(); }
});
function totalPages() { return Math.max(1, Math.ceil(total / Number(document.getElementById("expPageSize").value))); }

/* ============================== LOAD / RENDER ======================== */
async function loadExpenses() {
  const tbody = document.getElementById("expTableBody");
  const empty = document.getElementById("expEmpty");
  tbody.innerHTML = `<tr><td colspan="9" class="sub-empty" style="padding:1.5rem;">Loading…</td></tr>`;
  empty.classList.add("hidden");
  try {
    const data = await HITT_API.getExpenses(filters());
    ROWS = data.rows;
    total = data.total;
    renderTable();
    document.getElementById("expPageInfo").textContent = total
      ? `Page ${page} of ${totalPages()} · ${total} expense${total === 1 ? "" : "s"}`
      : "";
    document.getElementById("expSum").textContent = total ? `Filtered total: ${money(data.sum, "EUR")}` : "";
  } catch (err) {
    console.error("[expenses] load failed:", err.message);
    tbody.innerHTML = "";
    empty.textContent = "Could not load expenses.";
    empty.classList.remove("hidden");
  }
  updatePagerButtons();
}
function updatePagerButtons() {
  document.getElementById("btnExpPrev").disabled = page <= 1;
  document.getElementById("btnExpNext").disabled = page >= totalPages();
}

function renderTable() {
  const tbody = document.getElementById("expTableBody");
  const empty = document.getElementById("expEmpty");
  // drop selections for rows no longer visible
  [...selected].forEach((id) => { if (!ROWS.some((r) => String(r.id) === String(id))) selected.delete(id); });

  if (!ROWS.length) {
    tbody.innerHTML = "";
    empty.textContent = "No expenses match these filters.";
    empty.classList.remove("hidden");
    syncBulkBar();
    return;
  }
  empty.classList.add("hidden");
  tbody.innerHTML = ROWS.map((r) => {
    const projCell = r.isInternal
      ? `<span class="exp-internal-tag">Internal</span>`
      : (r.projectCode
        ? `<a href="projects.html?projectId=${encodeURIComponent(r.projectId)}" title="${escapeHtml(r.projectName || "")}">${escapeHtml(r.projectCode)}</a>`
        : "—");
    return `
      <tr data-id="${r.id}" class="${selected.has(String(r.id)) ? "is-selected" : ""}">
        <td class="exp-check-col"><input type="checkbox" class="exp-check" ${selected.has(String(r.id)) ? "checked" : ""} /></td>
        <td style="white-space:nowrap;">${fmtDate(r.expenseDate)}</td>
        <td>${escapeHtml(r.category || "—")}</td>
        <td>${escapeHtml(r.description || "—")}</td>
        <td>${projCell}</td>
        <td>${escapeHtml(r.paidByName || "—")}</td>
        <td class="exp-amount">${money(r.amount, r.currency)}</td>
        <td class="exp-doc-col">${r.hasDocument ? `<a href="#" class="exp-doc-link" data-doc title="View evidence">📎</a>` : ""}</td>
        <td style="text-align:right;"><button class="exp-row-btn" data-edit title="Edit">✎</button></td>
      </tr>`;
  }).join("");

  tbody.querySelectorAll("tr").forEach((tr) => {
    const id = tr.dataset.id;
    tr.querySelector(".exp-check").addEventListener("change", (e) => {
      if (e.target.checked) selected.add(String(id)); else selected.delete(String(id));
      tr.classList.toggle("is-selected", e.target.checked);
      syncBulkBar();
    });
    tr.querySelector("[data-edit]").addEventListener("click", () => openExpenseModal(ROWS.find((r) => String(r.id) === String(id))));
    const doc = tr.querySelector("[data-doc]");
    if (doc) doc.addEventListener("click", (e) => { e.preventDefault(); viewDocument(id); });
  });

  const allChecked = ROWS.every((r) => selected.has(String(r.id)));
  document.getElementById("expCheckAll").checked = allChecked;
  syncBulkBar();
}

document.getElementById("expCheckAll").addEventListener("change", (e) => {
  ROWS.forEach((r) => { if (e.target.checked) selected.add(String(r.id)); else selected.delete(String(r.id)); });
  renderTable();
});

function syncBulkBar() {
  const bar = document.getElementById("expBulkBar");
  bar.classList.toggle("hidden", selected.size === 0);
  document.getElementById("expBulkCount").textContent = `${selected.size} selected`;
}
document.getElementById("btnBulkClear").addEventListener("click", () => { selected.clear(); renderTable(); });

async function viewDocument(id) {
  // Open the tab synchronously (still inside the click gesture) so the
  // popup blocker doesn't kill it while the blob downloads.
  const w = window.open("", "_blank");
  try {
    const blob = await HITT_API.fetchExpenseDocument(id);
    const url = URL.createObjectURL(blob);
    if (w) w.location = url; else window.open(url, "_blank");
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    if (w) w.close();
    toast(err.message || "Could not open the document.", "red");
  }
}

/* ============================== EXPENSE MODAL ======================== */
const expenseOverlay = document.getElementById("expenseOverlay");
let editingId = null;
let editingHasDoc = false;

function projectOptions(selectedId) {
  return `<option value="">— pick a project —</option>` +
    PROJECTS.map((p) => `<option value="${p.id}" ${String(p.id) === String(selectedId) ? "selected" : ""}>${escapeHtml(p.code)} — ${escapeHtml(p.name)}</option>`).join("");
}
function employeeOptions(selectedId) {
  return `<option value="">—</option>` +
    EMPLOYEES.map((e) => `<option value="${e.id}" ${String(e.id) === String(selectedId) ? "selected" : ""}>${escapeHtml(e.name)}</option>`).join("");
}

function syncProjectRow() {
  const internal = document.getElementById("expInternal").checked;
  document.getElementById("expProjectRow").style.display = internal ? "none" : "";
  // "Re-invoiceable" only makes sense for a project expense.
  document.getElementById("expInvoiceableRow").style.display = internal ? "none" : "";
}
document.getElementById("expInternal").addEventListener("change", syncProjectRow);

function openExpenseModal(row) {
  editingId = row ? row.id : null;
  editingHasDoc = !!row?.hasDocument;
  document.getElementById("expModalTitle").textContent = row ? "Edit expense" : "New expense";
  document.getElementById("expDelete").classList.toggle("hidden", !row);

  document.getElementById("expDate").value = isoDay(row?.expenseDate) || new Date().toISOString().slice(0, 10);
  document.getElementById("expCategory").innerHTML = categoryOptions(row?.categoryId, "— none —");
  document.getElementById("expDescription").value = row?.description || "";
  document.getElementById("expAmount").value = row?.amount ?? "";
  document.getElementById("expPaidBy").innerHTML = employeeOptions(row?.paidById);
  document.getElementById("expInternal").checked = !!row?.isInternal;
  document.getElementById("expProject").innerHTML = projectOptions(row?.projectId);
  document.getElementById("expInvoiceable").checked = !!row?.invoiceable;
  syncProjectRow();

  document.getElementById("expDocFile").value = "";
  const cur = document.getElementById("expDocCurrent");
  if (editingHasDoc) {
    document.getElementById("expDocName").textContent = row.documentName || "Evidence file";
    cur.classList.remove("hidden");
  } else {
    cur.classList.add("hidden");
  }

  expenseOverlay.classList.remove("hidden");
  document.body.style.overflow = "hidden";
}
function closeExpenseModal() {
  expenseOverlay.classList.add("hidden");
  document.body.style.overflow = "";
  editingId = null;
}
document.getElementById("btnNewExpense").addEventListener("click", () => openExpenseModal(null));
document.getElementById("expClose").addEventListener("click", closeExpenseModal);
document.getElementById("expCancel").addEventListener("click", closeExpenseModal);
expenseOverlay.addEventListener("click", (e) => { if (e.target === expenseOverlay) closeExpenseModal(); });
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !expenseOverlay.classList.contains("hidden")) closeExpenseModal();
});

document.getElementById("expDocView").addEventListener("click", () => { if (editingId) viewDocument(editingId); });
document.getElementById("expDocRemove").addEventListener("click", async () => {
  if (!editingId || !confirm("Remove the evidence document from this expense?")) return;
  try {
    await HITT_API.deleteExpenseDocument(editingId);
    editingHasDoc = false;
    document.getElementById("expDocCurrent").classList.add("hidden");
    toast("Evidence removed.", "navy");
    loadExpenses();
  } catch (err) { toast(err.message || "Could not remove the document.", "red"); }
});

document.getElementById("expSave").addEventListener("click", async () => {
  const amount = document.getElementById("expAmount").value;
  if (amount === "" || Number.isNaN(Number(amount))) { toast("Enter an amount.", "red"); return; }
  const internal = document.getElementById("expInternal").checked;

  const fields = {
    expenseDate: document.getElementById("expDate").value || "",
    categoryId: document.getElementById("expCategory").value || "",
    description: document.getElementById("expDescription").value.trim(),
    amount,
    isInternal: internal ? "true" : "false",
    projectId: internal ? "" : (document.getElementById("expProject").value || ""),
    paidBy: document.getElementById("expPaidBy").value || "",
    invoiceable: (!internal && document.getElementById("expInvoiceable").checked) ? "true" : "false",
  };
  const file = document.getElementById("expDocFile").files[0];
  // Plain JSON unless there's a file to send — keeps no-file edits working
  // even when server uploads aren't wired up yet.
  let payload;
  if (file) {
    payload = new FormData();
    Object.entries(fields).forEach(([k, v]) => payload.set(k, v));
    payload.set("document", file);
  } else {
    payload = fields;
  }

  const btn = document.getElementById("expSave");
  btn.disabled = true;
  try {
    if (editingId) await HITT_API.updateExpense(editingId, payload);
    else await HITT_API.createExpense(payload);
    toast(editingId ? "Expense saved." : "Expense added.", "green");
    closeExpenseModal();
    loadExpenses();
  } catch (err) {
    toast(err.message || "Could not save the expense.", "red");
  } finally {
    btn.disabled = false;
  }
});

document.getElementById("expDelete").addEventListener("click", async () => {
  if (!editingId || !confirm("Delete this expense? This cannot be undone.")) return;
  try {
    await HITT_API.deleteExpense(editingId);
    toast("Expense deleted.", "navy");
    closeExpenseModal();
    loadExpenses();
  } catch (err) { toast(err.message || "Could not delete the expense.", "red"); }
});

/* ============================== BULK ================================= */
const bulkOverlay = document.getElementById("bulkOverlay");
document.getElementById("btnBulkEdit").addEventListener("click", () => {
  if (!selected.size) return;
  document.getElementById("bulkCategory").innerHTML = categoryOptions("", "— keep —");
  document.getElementById("bulkInvoiceable").value = "";
  document.getElementById("bulkChangeProject").checked = false;
  document.getElementById("bulkInternal").checked = false;
  document.getElementById("bulkProjectWrap").style.display = "none";
  document.getElementById("bulkProject").innerHTML = projectOptions(null);
  bulkOverlay.classList.remove("hidden");
});
function closeBulk() { bulkOverlay.classList.add("hidden"); }
document.getElementById("bulkClose").addEventListener("click", closeBulk);
document.getElementById("bulkCancel").addEventListener("click", closeBulk);
bulkOverlay.addEventListener("click", (e) => { if (e.target === bulkOverlay) closeBulk(); });
document.getElementById("bulkChangeProject").addEventListener("change", (e) => {
  document.getElementById("bulkProjectWrap").style.display = e.target.checked ? "" : "none";
});

document.getElementById("bulkApply").addEventListener("click", async () => {
  const patch = {};
  const cat = document.getElementById("bulkCategory").value;
  if (cat) patch.categoryId = cat;
  const inv = document.getElementById("bulkInvoiceable").value;
  if (inv !== "") patch.invoiceable = inv === "true";
  if (document.getElementById("bulkChangeProject").checked) {
    const internal = document.getElementById("bulkInternal").checked;
    patch.isInternal = internal;
    if (!internal) patch.projectId = document.getElementById("bulkProject").value || null;
  }
  if (!Object.keys(patch).length) { toast("Nothing to change.", "navy"); return; }
  try {
    const r = await HITT_API.bulkExpenses({ action: "update", ids: [...selected], patch });
    toast(`Updated ${r.affected} expense${r.affected === 1 ? "" : "s"}.`, "green");
    closeBulk();
    selected.clear();
    loadExpenses();
  } catch (err) { toast(err.message || "Bulk update failed.", "red"); }
});

document.getElementById("btnBulkDelete").addEventListener("click", async () => {
  if (!selected.size) return;
  if (!confirm(`Delete ${selected.size} selected expense${selected.size === 1 ? "" : "s"}? This cannot be undone.`)) return;
  try {
    const r = await HITT_API.bulkExpenses({ action: "delete", ids: [...selected] });
    toast(`Deleted ${r.affected} expense${r.affected === 1 ? "" : "s"}.`, "navy");
    selected.clear();
    loadExpenses();
  } catch (err) { toast(err.message || "Bulk delete failed.", "red"); }
});

/* ============================== INIT =============================== */
(async () => {
  setDataSourcePill();
  const [cats, emps, projs] = await Promise.allSettled([
    HITT_API.getExpenseCategories(),
    HITT_API.getEmployees(),
    HITT_API.getProjects(),
  ]);
  if (cats.status === "fulfilled") {
    CATEGORIES = cats.value || [];
    document.getElementById("expCategoryFilter").innerHTML =
      `<option value="">Any category</option>` +
      CATEGORIES.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  }
  if (emps.status === "fulfilled") EMPLOYEES = emps.value;
  if (projs.status === "fulfilled") {
    PROJECTS = (projs.value || []).map((p) => ({ id: p.id, code: p.code, name: p.name }))
      .sort((a, b) => String(b.code).localeCompare(String(a.code), undefined, { numeric: true }));
  }
  loadExpenses();
})();
