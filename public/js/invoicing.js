/**
 * HITT Ops — Invoicing
 * ---------------------------------------------------------------------------
 * Mirrors Access's Invoicing_Main.frm (project dashboard) + ProceedToInvoice.frm
 * (release settings) + Invoice-New_Edit.frm (invoice CRUD). See
 * server/routes/invoicing.js for the schema notes and scope limitations
 * (no PDF/document generation, simplified invoice-numbering pooling).
 * ---------------------------------------------------------------------------
 */

const session = HITT_AUTH.requireSession("../index.html");
HITT_PERMS.guardModule("invoicing", "../welcome.html");
document.getElementById("userName").textContent = session.displayName;
document.getElementById("userAvatar").textContent = HITT_AUTH.initials(session);
document.getElementById("btnSignOut").addEventListener("click", () => HITT_AUTH.signOut("../index.html"));
HITT_PERMS.applyRealName();

let currentEmployeeId = null;
HITT_PERMS.get().then((perms) => { currentEmployeeId = perms.employeeId; }).catch(() => {});
let CLOSED_STATUS_ID = null; // resolved from GET /api/projects/statuses

const DEMO_SEED = [
  { id: 1, code: '26018', name: 'Demo Project', entityLabel: 'HiTT', projectStatusLabel: 'WIP', budget: 5000, proceedtoinvoice: true, invoiceCount: 1, invoicedTotal: 2000 },
];

let PROJECTS = [];
let LOOKUPS = { statuses: [], scheduleTypes: [], deliveryMethods: [], vatTypes: [], bankAccounts: [], currencies: [] };
let invLineItems = []; // [{ description, quantity, unitPrice }] for the open invoice modal
let INVOICES = [];
let usingDemoData = false;
let currentBucket = 'all';
let searchTerm = '';
let sortColumn = 'code';
let sortDirection = 'desc';
let lifecycleFilter = 'all'; // 'alive' | 'closed' | 'all'
const projectStatusSel = new Set(); // selected project-status labels; empty = all
let activeProjectId = null;
let activeProjectBpId = null;
let activeInvoiceId = null;
let activeProjectBpTaxCompanies = [];         // the contracting BP's own tax companies
let activeProjectDefaultTc = null;            // { id, taxcompanyname } — project default for new invoices
let invTaxCompanyPrev = '';                   // last real value of the invoice-modal select
let invoicesDefaultTcPrev = '';               // last real value of the Invoices-tab default select

function escapeHtml(s){
  const d = document.createElement('div');
  d.textContent = s ?? "";
  return d.innerHTML;
}
function toast(msg, tone = 'navy'){
  const host = document.getElementById('toastHost');
  const el = document.createElement('div');
  el.className = `toast toast-${tone}`;
  el.innerHTML = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}
function setDataSourcePill(){
  const pill = document.getElementById("dataSourcePill");
  if (usingDemoData) {
    pill.textContent = "Demo data (API unreachable)";
    pill.style.background = "rgba(188,154,28,0.18)";
    pill.style.color = "#8A6E12";
  } else {
    pill.textContent = "Live · test environment";
    pill.style.background = "rgba(110,143,90,0.18)";
    pill.style.color = "#4C6B3A";
  }
}
// Project-status chip colours, kept consistent with the Projects kanban
// columns (see STAGE_STYLE_BY_KEY in js/projects.js) and the Reports
// hours-per-project table. Matched on the lower-cased status label.
const STATUS_CHIP_COLORS = {
  lead: '#5C757C', oferta: '#BC9A1C', guanyat: '#6E8F5A', wip: '#171717',
  delivered: '#211916', closed: '#8A8676', cancelled: '#B24A3A',
};
const CLOSED_STATUSES = new Set(['closed', 'cancelled']);
function isClosedStatus(label){
  return CLOSED_STATUSES.has(String(label || '').trim().toLowerCase());
}
function statusChipHtml(label){
  if (!label) return '—';
  const color = STATUS_CHIP_COLORS[String(label).trim().toLowerCase()] || '#8A8676';
  return `<span class="inv-status-chip" style="background:${color}">${escapeHtml(label)}</span>`;
}

function formatDateOnly(iso){ return iso ? new Date(iso).toLocaleDateString() : '—'; }
function formatMoney(n, currency){
  if (n === null || n === undefined) return '—';
  const code = (currency || 'EUR').toString().toUpperCase();
  try {
    return Number(n).toLocaleString(undefined, { style: 'currency', currency: code });
  } catch {
    // Non-ISO custom code — fall back to "<symbol><number>".
    const c = (LOOKUPS.currencies || []).find(x => x.code === code);
    const sym = (c && c.symbol) || code;
    return `${sym}${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
}
function invCurCode(){ return document.getElementById('invCurrency').value || 'EUR'; }
function lookupOptionsHtml(rows, selectedId, includeBlank, blankLabel){
  const opts = (includeBlank ? [`<option value="">${blankLabel || '—'}</option>`] : [])
    .concat((rows || []).map(r => `<option value="${r.id}" ${String(r.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(r.label)}</option>`));
  return opts.join('');
}

/* ============================== LOAD DASHBOARD ============================ */
async function loadProjects(){
  if (!window.HITT_CONFIG?.FEATURES?.invoicingLive) {
    PROJECTS = structuredClone(DEMO_SEED);
    usingDemoData = true;
    setDataSourcePill();
    populateProjectStatusOptions();
    renderTable();
    return;
  }
  try {
    LOOKUPS = await HITT_API.getInvoicingLookups();
    PROJECTS = await HITT_API.getInvoicingProjects();
    usingDemoData = false;
    try {
      const statuses = await HITT_API.getProjectStatuses();
      CLOSED_STATUS_ID = statuses.find(s => String(s.label).trim().toLowerCase() === 'closed')?.id ?? null;
    } catch { /* Close-project button just won't work until this resolves */ }
  } catch (err) {
    console.warn('Falling back to demo data — could not reach API:', err);
    PROJECTS = structuredClone(DEMO_SEED);
    usingDemoData = true;
  }
  setDataSourcePill();
  populateProjectStatusOptions();
  renderTable();
}

function computeBucket(row){
  if (!row.proceedtoinvoice) return 'not-released';
  const invoiced = Number(row.invoicedTotal) || 0;
  const budget = Number(row.budget) || 0;
  if (Number(row.invoiceCount) === 0) return 'not-started';
  if (budget > 0 && invoiced >= budget) return 'total';
  return 'partial';
}
const BUCKET_LABEL = { 'not-released': 'Not released', 'not-started': 'Not started', 'partial': 'Partially invoiced', 'total': 'Totally invoiced' };
const BUCKET_ORDER = ['not-released', 'not-started', 'partial', 'total'];

// Count per invoice-status bucket, shown inside each filter chip (e.g.
// "Partially invoiced (23)"). Reflects the lifecycle + project-status
// filters (so the chips describe the set you're looking at) but not the
// search box or the bucket selection itself.
function updateBucketCounts(){
  const scope = PROJECTS.filter(matchesLifecycleStatus);
  const counts = { all: scope.length };
  BUCKET_ORDER.forEach(b => counts[b] = 0);
  scope.forEach(p => { counts[computeBucket(p)]++; });
  document.querySelectorAll('.inv-filter-count').forEach(el => {
    const n = counts[el.dataset.countFor];
    el.textContent = n == null ? '' : `(${n})`;
  });
}

function sortValue(row, col){
  if (col === 'bucket') return BUCKET_ORDER.indexOf(computeBucket(row));
  if (col === 'code') return String(row.code);
  if (col === 'entityLabel') return String(row.entityLabel || '');
  if (col === 'bpName') return String(row.bpName || '');
  if (col === 'projectStatusLabel') return String(row.projectStatusLabel || '');
  return Number(row[col]) || 0;
}

function compareRows(a, b){
  const dir = sortDirection === 'asc' ? 1 : -1;
  const av = sortValue(a, sortColumn), bv = sortValue(b, sortColumn);
  if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
  return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
}

function matchesLifecycleStatus(row){
  if (lifecycleFilter === 'alive' && isClosedStatus(row.projectStatusLabel)) return false;
  if (lifecycleFilter === 'closed' && !isClosedStatus(row.projectStatusLabel)) return false;
  if (projectStatusSel.size && !projectStatusSel.has(String(row.projectStatusLabel || ''))) return false;
  return true;
}

function matchesFilters(row){
  if (!matchesLifecycleStatus(row)) return false;
  if (currentBucket !== 'all' && computeBucket(row) !== currentBucket) return false;
  if (searchTerm) {
    const t = searchTerm.toLowerCase();
    const hay = `${row.code} ${row.name} ${row.bpName || ''}`.toLowerCase();
    if (!hay.includes(t)) return false;
  }
  return true;
}

// Builds the multi-select "Project status" checkbox menu from the statuses
// actually present in the loaded projects, preserving any still-valid
// selection. Called once per data load, not per render.
function populateProjectStatusOptions(){
  const menu = document.getElementById('projectStatusMenu');
  const labels = [...new Set(PROJECTS.map(p => p.projectStatusLabel).filter(Boolean))].sort();
  [...projectStatusSel].forEach(l => { if (!labels.includes(l)) projectStatusSel.delete(l); });
  menu.innerHTML = labels.length
    ? labels.map(l => `
        <label class="inv-status-opt">
          <input type="checkbox" value="${escapeHtml(l)}" ${projectStatusSel.has(l) ? 'checked' : ''} />
          <span>${escapeHtml(l)}</span>
        </label>`).join('')
    : `<div class="inv-status-opt inv-status-opt--empty">No statuses</div>`;
  menu.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) projectStatusSel.add(cb.value);
      else projectStatusSel.delete(cb.value);
      updateProjectStatusLabel();
      renderTable();
    });
  });
  updateProjectStatusLabel();
}

function updateProjectStatusLabel(){
  const el = document.getElementById('projectStatusBtnLabel');
  if (!el) return;
  if (projectStatusSel.size === 0) el.textContent = 'all';
  else if (projectStatusSel.size === 1) el.textContent = [...projectStatusSel][0];
  else el.textContent = `${projectStatusSel.size} selected`;
}

function renderTable(){
  const tbody = document.getElementById('invTableBody');
  const empty = document.getElementById('invEmpty');
  const rows = PROJECTS.filter(matchesFilters).sort(compareRows);

  updateBucketCounts();
  updateSortIndicators();

  if (!rows.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  tbody.innerHTML = rows.map((p, i) => {
    const bucket = computeBucket(p);
    const invoiced = Number(p.invoicedTotal) || 0;
    const budget = Number(p.budget) || 0;
    const pct = budget > 0 ? Math.round((invoiced / budget) * 100) : null;
    // Partially invoiced but nothing actually invoiced → something's off.
    const invoicedAlert = bucket === 'partial' && invoiced === 0;
    const alreadyClosed = isClosedStatus(p.projectStatusLabel);
    return `
      <tr data-i="${i}">
        <td class="inv-proceed-col">${p.proceedtoinvoice ? `<span class="inv-proceed-icon" title="Proceed to invoice">✔</span>` : ''}</td>
        <td><span style="font-weight:600;">${escapeHtml(p.code)}</span> — ${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.entityLabel || '—')}</td>
        <td>${p.bpName ? escapeHtml(p.bpName) : '—'}</td>
        <td>${statusChipHtml(p.projectStatusLabel)}</td>
        <td style="text-align:right;">${formatMoney(p.budget)}</td>
        <td style="text-align:right;" class="${invoicedAlert ? 'inv-invoiced-alert' : ''}">
          ${formatMoney(p.invoicedTotal)}${pct !== null ? ` <span class="inv-invoiced-pct">(${pct}%)</span>` : ''}
        </td>
        <td style="text-align:right;">${Number(p.invoiceCount) || 0}</td>
        <td><span class="inv-bucket-pill inv-bucket-${bucket}">${BUCKET_LABEL[bucket]}</span></td>
        <td class="inv-actions-col">
          <div class="inv-row-actions">
            <a class="inv-row-btn" href="projects.html?projectId=${encodeURIComponent(p.id)}" data-row-action title="Open project page" aria-label="Open project page">↗</a>
            ${p.bpId
              ? `<a class="inv-row-btn" href="business-partners.html?open=${encodeURIComponent(p.bpId)}" data-row-action title="Open business partner page" aria-label="Open business partner page">🤝</a>`
              : `<span class="inv-row-btn" data-row-action aria-disabled="true" title="No business partner assigned" style="opacity:0.3; cursor:default;">🤝</span>`}
            <button type="button" class="inv-row-btn inv-row-btn--danger" data-close-project data-row-action
              title="${alreadyClosed ? 'Project is already closed' : 'Close project (set status to Closed)'}"
              aria-label="Close project" ${alreadyClosed ? 'disabled' : ''}>⊘</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('tr').forEach((tr, i) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-row-action]')) return; // let the button/link handle it
      openProjectModal(rows[i].id);
    });
    tr.querySelector('[data-close-project]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      closeProjectFromList(rows[i]);
    });
  });
}

async function closeProjectFromList(p){
  if (!p || isClosedStatus(p.projectStatusLabel)) return;
  if (usingDemoData) { toast("Closing a project isn't available in demo data.", 'navy'); return; }
  if (CLOSED_STATUS_ID == null) { toast("Couldn't resolve the \"Closed\" status — try reloading.", 'red'); return; }
  if (!confirm(`Close project ${p.code} — ${p.name}?\nIts status will be set to "Closed".`)) return;
  try {
    await HITT_API.updateProjectStage(p.id, CLOSED_STATUS_ID, currentEmployeeId);
    toast(`${p.code} closed`, 'green');
    await loadProjects();
  } catch (err) {
    console.error(err);
    toast('Could not close the project.', 'red');
  }
}

function updateSortIndicators(){
  document.querySelectorAll('.inv-table th[data-sort]').forEach(th => {
    const active = th.dataset.sort === sortColumn;
    th.classList.toggle('sorted', active);
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = active ? (sortDirection === 'asc' ? ' ▲' : ' ▼') : '';
  });
}

document.querySelectorAll('.inv-table th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    if (sortColumn === col) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      sortColumn = col;
      // Numeric columns read best most-first; text columns A→Z.
      sortDirection = ['budget', 'invoicedTotal', 'invoiceCount', 'bucket'].includes(col) ? 'desc' : 'asc';
    }
    renderTable();
  });
});

document.querySelectorAll('[data-bucket]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-bucket]').forEach(b => b.setAttribute('aria-selected', 'false'));
    btn.setAttribute('aria-selected', 'true');
    currentBucket = btn.dataset.bucket;
    renderTable();
  });
});
document.getElementById('searchBox').addEventListener('input', (e) => {
  searchTerm = e.target.value.trim();
  renderTable();
});

document.querySelectorAll('[data-lifecycle]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-lifecycle]').forEach(b => b.setAttribute('aria-selected', 'false'));
    btn.setAttribute('aria-selected', 'true');
    lifecycleFilter = btn.dataset.lifecycle;
    renderTable();
  });
});

// Project-status multi-select menu open/close.
const projectStatusBtn = document.getElementById('projectStatusBtn');
const projectStatusMenu = document.getElementById('projectStatusMenu');
projectStatusBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = projectStatusMenu.classList.toggle('hidden');
  projectStatusBtn.setAttribute('aria-expanded', String(!open));
});
projectStatusMenu.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => {
  projectStatusMenu.classList.add('hidden');
  projectStatusBtn.setAttribute('aria-expanded', 'false');
});

/* ============================== TAX COMPANY SELECT + PICKER ============== */
function taxCompanyOptionLabel(tc){
  const name = tc.taxcompanyname || '(unnamed)';
  return tc.bpName ? `${name} — ${tc.bpName}` : name;
}

// Fills a tax-company <select>: the project BP's own tax companies first,
// then any extras (e.g. the current pick from another BP), then a
// "＋ Choose another tax company…" sentinel that opens the picker.
function fillTaxCompanySelect(sel, { bpTaxCompanies = [], extras = [], selectedId, blankLabel } = {}){
  const seen = new Set();
  const opts = [];
  if (blankLabel !== undefined) opts.push(`<option value="">${escapeHtml(blankLabel)}</option>`);
  const add = (tc) => {
    if (!tc || tc.id == null || seen.has(String(tc.id))) return;
    seen.add(String(tc.id));
    opts.push(`<option value="${escapeHtml(String(tc.id))}"${String(tc.id) === String(selectedId) ? ' selected' : ''}>${escapeHtml(taxCompanyOptionLabel(tc))}</option>`);
  };
  bpTaxCompanies.forEach(add);
  extras.forEach(add);
  opts.push(`<option value="__more__">＋ Choose another tax company…</option>`);
  sel.innerHTML = opts.join('');
}

function addTaxCompanyOption(sel, tc){
  if ([...sel.options].some(o => o.value === String(tc.id))) return;
  const opt = document.createElement('option');
  opt.value = String(tc.id);
  opt.textContent = taxCompanyOptionLabel(tc);
  const moreOpt = [...sel.options].find(o => o.value === '__more__');
  sel.insertBefore(opt, moreOpt || null);
}

const tcPickerOverlay = document.getElementById('tcPickerOverlay');
let tcPickerOnPick = null;
let tcPickerDebounce = null;

function openTaxCompanyPicker(onPick){
  tcPickerOnPick = onPick;
  document.getElementById('tcPickerSearch').value = '';
  document.getElementById('tcPickerBody').innerHTML = `<tr><td colspan="4" class="sub-empty">Loading…</td></tr>`;
  document.getElementById('tcPickerEmpty').classList.add('hidden');
  tcPickerOverlay.classList.remove('hidden');
  loadTcPicker('');
  setTimeout(() => document.getElementById('tcPickerSearch').focus(), 50);
}
function closeTaxCompanyPicker(){
  tcPickerOverlay.classList.add('hidden');
  tcPickerOnPick = null;
}
async function loadTcPicker(search){
  const tbody = document.getElementById('tcPickerBody');
  const empty = document.getElementById('tcPickerEmpty');
  try {
    const rows = await HITT_API.getAllTaxCompanies(search);
    if (!rows.length) { tbody.innerHTML = ''; empty.classList.remove('hidden'); return; }
    empty.classList.add('hidden');
    tbody.innerHTML = rows.map((tc, i) => `
      <tr data-i="${i}" style="cursor:pointer;">
        <td>${escapeHtml(tc.taxcompanyname || '(unnamed)')}</td>
        <td>${escapeHtml(tc.vatnumber || '—')}</td>
        <td>${escapeHtml(tc.bpName || '—')}</td>
        <td>${escapeHtml(tc.emailinvoicing || '—')}</td>
      </tr>`).join('');
    tbody.querySelectorAll('tr').forEach((tr, i) => {
      tr.addEventListener('click', () => {
        const cb = tcPickerOnPick;
        closeTaxCompanyPicker();
        if (cb) cb(rows[i]);
      });
    });
  } catch (err) {
    console.warn('Could not load tax companies:', err);
    tbody.innerHTML = `<tr><td colspan="4" class="sub-empty">Could not load tax companies.</td></tr>`;
  }
}
document.getElementById('tcPickerClose').addEventListener('click', closeTaxCompanyPicker);
tcPickerOverlay.addEventListener('click', (e) => { if (e.target === tcPickerOverlay) closeTaxCompanyPicker(); });
document.getElementById('tcPickerSearch').addEventListener('input', (e) => {
  clearTimeout(tcPickerDebounce);
  const v = e.target.value.trim();
  tcPickerDebounce = setTimeout(() => loadTcPicker(v), 250);
});

/* ============================== PROJECT MODAL ============================= */
const modalOverlay = document.getElementById('modalOverlay');

async function openProjectModal(projectId){
  const p = PROJECTS.find(x => x.id === projectId);
  if (!p) return;
  activeProjectId = projectId;
  activeProjectBpId = null;
  activeProjectBpTaxCompanies = [];
  activeProjectDefaultTc = null;
  document.getElementById('invoicesDefaultTaxCompany').innerHTML = `<option value="">Loading…</option>`;

  document.getElementById('mTitle').value = `${p.code} — ${p.name}`;
  document.getElementById('relSchedule').innerHTML = lookupOptionsHtml(LOOKUPS.scheduleTypes, null, true);
  document.getElementById('relDelivery').innerHTML = lookupOptionsHtml(LOOKUPS.deliveryMethods, null, true);
  document.getElementById('relProceed').checked = !!p.proceedtoinvoice;
  document.getElementById('relNumInvoices').value = p.numberofinvoices || '';
  document.getElementById('relFirstDate').value = p.firstdate ? p.firstdate.slice(0, 10) : '';
  document.getElementById('relLastDate').value = p.lastdate ? p.lastdate.slice(0, 10) : '';
  document.getElementById('relSchedule').value = p.scheduletypeid || '';
  document.getElementById('relDelivery').value = p.invpaymethodid || '';

  document.querySelectorAll('[data-mtab]').forEach(b => b.setAttribute('aria-selected', b.dataset.mtab === 'release' ? 'true' : 'false'));
  document.getElementById('paneRelease').classList.remove('hidden');
  document.getElementById('paneInvoices').classList.add('hidden');

  modalOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  if (usingDemoData) return;

  try {
    const detail = await HITT_API.getProject(projectId);
    activeProjectBpId = detail.busspartnerid || null;
    if (detail.busspartnertoinvoiceid) {
      activeProjectDefaultTc = { id: detail.busspartnertoinvoiceid, taxcompanyname: detail.invoicingPartnerLabel || '(tax company)' };
    }
  } catch (err) {
    console.warn('Could not load project detail for tax-company context:', err);
  }

  if (activeProjectBpId) {
    try { activeProjectBpTaxCompanies = await HITT_API.getBusinessPartnerTaxCompanies(activeProjectBpId); }
    catch { activeProjectBpTaxCompanies = []; }
  }
  populateInvoicesDefaultTcSelect();

  await loadInvoices();
}

function populateInvoicesDefaultTcSelect(){
  const sel = document.getElementById('invoicesDefaultTaxCompany');
  fillTaxCompanySelect(sel, {
    bpTaxCompanies: activeProjectBpTaxCompanies,
    extras: activeProjectDefaultTc ? [activeProjectDefaultTc] : [],
    selectedId: activeProjectDefaultTc?.id,
    blankLabel: '— none set —',
  });
  invoicesDefaultTcPrev = sel.value;
}

async function saveProjectDefaultTaxCompany(tcId){
  if (usingDemoData) { toast("Not available in demo data.", 'navy'); return; }
  try {
    await HITT_API.assignProjectInvoicingPartner(activeProjectId, tcId, currentEmployeeId);
    invoicesDefaultTcPrev = String(tcId);
    const sel = document.getElementById('invoicesDefaultTaxCompany');
    const label = [...sel.options].find(o => o.value === String(tcId))?.textContent || '(tax company)';
    activeProjectDefaultTc = { id: tcId, taxcompanyname: label };
    const proj = PROJECTS.find(x => x.id === activeProjectId);
    if (proj) proj.busspartnertoinvoiceid = tcId;
    toast('Default tax company saved', 'green');
  } catch (err) {
    console.error(err);
    toast('Could not save the default tax company.', 'red');
    populateInvoicesDefaultTcSelect();
  }
}

document.getElementById('invoicesDefaultTaxCompany').addEventListener('change', (e) => {
  const el = e.target;
  if (el.value === '__more__') {
    el.value = invoicesDefaultTcPrev || '';
    openTaxCompanyPicker((tc) => {
      addTaxCompanyOption(el, tc);
      el.value = String(tc.id);
      saveProjectDefaultTaxCompany(String(tc.id));
    });
    return;
  }
  if (!el.value) return; // don't unset via "— none set —"
  saveProjectDefaultTaxCompany(el.value);
});

function closeProjectModal(){
  modalOverlay.classList.add('hidden');
  document.body.style.overflow = '';
  activeProjectId = null;
}
document.getElementById('mClose').addEventListener('click', closeProjectModal);
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeProjectModal(); });

document.querySelectorAll('[data-mtab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-mtab]').forEach(b => b.setAttribute('aria-selected', 'false'));
    btn.setAttribute('aria-selected', 'true');
    document.getElementById('paneRelease').classList.toggle('hidden', btn.dataset.mtab !== 'release');
    document.getElementById('paneInvoices').classList.toggle('hidden', btn.dataset.mtab !== 'invoices');
  });
});

document.getElementById('relSave').addEventListener('click', async () => {
  if (!activeProjectId || usingDemoData) { if (usingDemoData) toast("Not available in demo data.", 'navy'); return; }
  try {
    await HITT_API.saveProjectRelease(activeProjectId, {
      proceedToInvoice: document.getElementById('relProceed').checked,
      scheduleTypeId: document.getElementById('relSchedule').value || null,
      invPayMethodId: document.getElementById('relDelivery').value || null,
      numberOfInvoices: document.getElementById('relNumInvoices').value || null,
      firstDate: document.getElementById('relFirstDate').value || null,
      lastDate: document.getElementById('relLastDate').value || null,
    });
    toast('Proceed-to-invoice settings saved', 'green');
    await loadProjects();
  } catch (err) {
    console.error(err);
    toast('Could not save settings.', 'red');
  }
});

/* ============================== INVOICES LIST ============================= */
async function loadInvoices(){
  const tbody = document.getElementById('invoicesTableBody');
  tbody.innerHTML = `<tr><td colspan="7" class="sub-empty">Loading…</td></tr>`;
  try {
    INVOICES = await HITT_API.getProjectInvoices(activeProjectId);
  } catch (err) {
    console.warn('Could not load invoices:', err);
    INVOICES = [];
    toast('Could not load invoices.', 'red');
  }
  renderInvoicesTable();
}

function renderInvoicesTable(){
  const tbody = document.getElementById('invoicesTableBody');
  const empty = document.getElementById('invoicesEmpty');
  if (!INVOICES.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  tbody.innerHTML = INVOICES.map((inv, i) => `
    <tr data-i="${i}" style="cursor:pointer;">
      <td>${escapeHtml(inv.invoicecode || '(draft)')}</td>
      <td><span class="inv-status-pill inv-status-${inv.invoicestatusid}">${escapeHtml(inv.statusLabel || '—')}</span></td>
      <td style="text-align:right;" class="${Number(inv.amount) < 0 ? 'inv-money inv-money--neg' : 'inv-money'}">${formatMoney(inv.amount, inv.currency)}</td>
      <td style="text-align:right;">${formatMoney(inv.vatamount, inv.currency)}</td>
      <td>${formatDateOnly(inv.invoicedate)}</td>
      <td>${escapeHtml(inv.invoicingPartnerLabel || '—')}</td>
      <td><button class="ta-remove-btn" data-pdf title="View PDF">📄</button></td>
      <td><button class="ta-remove-btn" data-delete title="Delete this invoice">✕</button></td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr').forEach((tr, i) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete], [data-pdf]')) return;
      openInvoiceModal(INVOICES[i].id);
    });
  });
  tbody.querySelectorAll('[data-pdf]').forEach((btn, i) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(invoicePdfUrl(INVOICES[i].id), '_blank');
    });
  });
  tbody.querySelectorAll('[data-delete]').forEach((btn, i) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete invoice ${INVOICES[i].invoicecode || '(draft)'}? This cannot be undone.`)) return;
      try {
        await HITT_API.deleteInvoice(INVOICES[i].id);
        toast('Invoice deleted', 'navy');
        await loadInvoices();
        await loadProjects();
      } catch (err) {
        console.error(err);
        toast('Could not delete the invoice.', 'red');
      }
    });
  });
}

document.getElementById('btnNewInvoice').addEventListener('click', () => openInvoiceModal(null));

function invoicePdfUrl(invoiceId){
  const base = (window.HITT_CONFIG?.API_BASE_URL || '').replace(/\/$/, '');
  return `${base}/api/invoicing/invoices/${invoiceId}/pdf`;
}
document.getElementById('invViewPdf').addEventListener('click', () => {
  if (activeInvoiceId) window.open(invoicePdfUrl(activeInvoiceId), '_blank');
});

/* ============================== INVOICE MODAL ============================= */
const invoiceOverlay = document.getElementById('invoiceOverlay');

// Any real edit to a field flips on the "Data has changed" badge (cleared
// again each time the modal opens). Programmatic .value assignments in
// openInvoiceModal() don't fire 'input', so only user edits count.
invoiceOverlay.addEventListener('input', () => {
  document.getElementById('invChangedBadge').classList.remove('hidden');
});

function clientSideStatusPreview(){
  const d = document.getElementById('invDate').value;
  const s = document.getElementById('invSentDate').value;
  const dep = document.getElementById('invDipositDate').value;
  let id, label;
  if (!d && !s && !dep) { id = 2; label = 'Not generated'; }
  else if (d && !s && !dep) { id = 3; label = 'To be sent'; }
  else if (d && s && !dep) { id = 4; label = 'Sent to customer'; }
  else if (d && s && dep) { id = 5; label = 'Collected'; }
  else { id = 1; label = 'Pending PO'; }
  const el = document.getElementById('invStatusPreview');
  el.textContent = label;
  el.className = `inv-status-pill inv-status-${id}`;
}
['invDate', 'invSentDate', 'invDipositDate'].forEach(id => {
  document.getElementById(id).addEventListener('change', clientSideStatusPreview);
});

function updateVatPreview(){
  const amount = Number(document.getElementById('invAmount').value) || 0;
  const vatId = document.getElementById('invVatType').value;
  const vt = LOOKUPS.vatTypes.find(v => String(v.id) === String(vatId));
  const pct = vt ? Number(vt.percentage) : 0;
  const vatAmount = Math.round(amount * (pct / 100) * 100) / 100;
  document.getElementById('invVatAmountPreview').textContent = `${formatMoney(vatAmount, invCurCode())} (${pct}%)`;
}
document.getElementById('invVatType').addEventListener('change', updateVatPreview);
document.getElementById('invCurrency').addEventListener('change', () => { renderInvItems(); });

/* ---------- Invoiceable line items ---------- */
function invItemSubtotal(li){ return (Number(li.quantity) || 0) * (Number(li.unitPrice) || 0); }

function recalcInvTotal(){
  const total = invLineItems.reduce((s, li) => s + invItemSubtotal(li), 0);
  document.getElementById('invItemsTotal').textContent = formatMoney(total, invCurCode());
  document.getElementById('invAmount').value = total ? total.toFixed(2) : '';
  updateVatPreview();
}

function renderInvItems(){
  const tbody = document.getElementById('invItemsBody');
  if (!invLineItems.length) {
    tbody.innerHTML = `<tr class="inv-items-none"><td colspan="5">No items yet — “+ Add item” to start.</td></tr>`;
  } else {
    tbody.innerHTML = invLineItems.map((li, i) => `
      <tr data-i="${i}">
        <td><input type="text" class="field-input" data-li-desc value="${escapeHtml(li.description || '')}" placeholder="What is being invoiced" /></td>
        <td><input type="number" class="field-input" step="1" min="0" data-li-qty value="${li.quantity ?? ''}" /></td>
        <td><input type="number" class="field-input" step="0.01" min="0" data-li-price value="${li.unitPrice ?? ''}" /></td>
        <td class="inv-items-sub" data-li-sub>${formatMoney(invItemSubtotal(li), invCurCode())}</td>
        <td><button type="button" class="ta-remove-btn" data-li-del title="Remove item">✕</button></td>
      </tr>`).join('');
  }
  tbody.querySelectorAll('tr[data-i]').forEach(tr => {
    const i = Number(tr.dataset.i);
    const sync = () => {
      invLineItems[i].description = tr.querySelector('[data-li-desc]').value;
      invLineItems[i].quantity = tr.querySelector('[data-li-qty]').value;
      invLineItems[i].unitPrice = tr.querySelector('[data-li-price]').value;
      tr.querySelector('[data-li-sub]').textContent = formatMoney(invItemSubtotal(invLineItems[i]), invCurCode());
      recalcInvTotal();
    };
    tr.querySelector('[data-li-desc]').addEventListener('input', sync);
    tr.querySelector('[data-li-qty]').addEventListener('input', sync);
    tr.querySelector('[data-li-price]').addEventListener('input', sync);
    tr.querySelector('[data-li-del]').addEventListener('click', () => {
      invLineItems.splice(i, 1);
      renderInvItems();
    });
  });
  recalcInvTotal();
}

document.getElementById('invAddItem').addEventListener('click', () => {
  invLineItems.push({ description: '', quantity: 1, unitPrice: '' });
  renderInvItems();
  const inputs = document.querySelectorAll('#invItemsBody [data-li-desc]');
  inputs[inputs.length - 1]?.focus();
});

document.getElementById('invIsCorrective').addEventListener('change', (e) => {
  document.getElementById('invSourceRow').classList.toggle('hidden', !e.target.checked);
  if (e.target.checked) {
    const candidates = INVOICES.filter(inv => !inv.iscorrective && inv.invoicestatusid !== 6);
    document.getElementById('invSourceInvoice').innerHTML = lookupOptionsHtml(
      candidates.map(inv => ({ id: inv.id, label: `${inv.invoicecode || '(draft)'} — ${formatMoney(inv.amount)}` })),
      null, true
    );
  }
});

async function openInvoiceModal(invoiceId){
  activeInvoiceId = invoiceId;
  const inv = invoiceId ? INVOICES.find(x => x.id === invoiceId) : null;

  document.getElementById('invModalTitle').textContent = inv ? `Edit invoice ${inv.invoicecode || '(draft)'}` : 'New invoice';
  document.getElementById('invDelete').classList.toggle('hidden', !inv);
  document.getElementById('invViewPdf').classList.toggle('hidden', !inv);

  // Reset the unsaved-edits badge; show "last updated by" when we have it.
  document.getElementById('invChangedBadge').classList.add('hidden');
  const updatedInfo = document.getElementById('invUpdatedInfo');
  if (inv && inv.updatedAt) {
    const who = inv.updatedByName || (inv.updatedById ? `#${inv.updatedById}` : 'someone');
    updatedInfo.innerHTML = `Last updated by <strong>${escapeHtml(who)}</strong> on ${escapeHtml(new Date(inv.updatedAt).toLocaleString())}`;
    updatedInfo.classList.remove('hidden');
  } else {
    updatedInfo.classList.add('hidden');
  }

  document.getElementById('invIsCorrective').checked = !!inv?.iscorrective;
  document.getElementById('invIsCorrective').disabled = !!inv; // corrective flag is fixed at creation time
  document.getElementById('invSourceRow').classList.add('hidden');

  document.getElementById('invDate').value = inv?.invoicedate ? inv.invoicedate.slice(0, 10) : '';
  document.getElementById('invDueDate').value = inv?.invoiceduedate ? inv.invoiceduedate.slice(0, 10) : '';
  document.getElementById('invSentDate').value = inv?.invoicesentdate ? inv.invoicesentdate.slice(0, 10) : '';
  document.getElementById('invDipositDate').value = inv?.invoicedipositdate ? inv.invoicedipositdate.slice(0, 10) : '';
  clientSideStatusPreview();

  // Currency select from the Settings-managed list; default EUR.
  const currencies = LOOKUPS.currencies && LOOKUPS.currencies.length
    ? LOOKUPS.currencies
    : [{ code: 'EUR', symbol: '€', label: 'Euro' }];
  document.getElementById('invCurrency').innerHTML = currencies.map(c =>
    `<option value="${escapeHtml(c.code)}" ${String(c.code) === String(inv?.currency || 'EUR') ? 'selected' : ''}>${escapeHtml(c.code)}${c.symbol && c.symbol !== c.code ? ` (${escapeHtml(c.symbol)})` : ''}</option>`
  ).join('');

  // Line items: real ones, or a single synthetic row from a legacy invoice's
  // flat amount + free-text description; one empty row for a brand-new invoice.
  if (inv && Array.isArray(inv.lineItems) && inv.lineItems.length) {
    invLineItems = inv.lineItems.map(li => ({
      description: li.description || '', quantity: li.quantity, unitPrice: li.unitPrice,
    }));
  } else if (inv && inv.amount != null) {
    invLineItems = [{
      description: (inv.descriptionservice || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      quantity: 1, unitPrice: Number(inv.amount),
    }];
  } else {
    invLineItems = [{ description: '', quantity: 1, unitPrice: '' }];
  }

  document.getElementById('invVatType').innerHTML = lookupOptionsHtml(LOOKUPS.vatTypes, inv?.vatid ?? 4, false);
  renderInvItems(); // sets #invAmount + VAT preview

  document.getElementById('invDepositAccount').innerHTML = lookupOptionsHtml(LOOKUPS.bankAccounts, inv?.dipositaccountid, true);
  document.getElementById('invNumOcClient').value = inv?.numocclient || '';
  document.getElementById('invPurchaseOrder').value = inv?.purchaseorder || '';
  document.getElementById('invComments').value = inv?.invoicecomments || '';

  // Tax company: locked to the invoice's own value (edit) or the project
  // default (new) until the user clicks "Change".
  const taxSel = document.getElementById('invTaxCompany');
  taxSel.disabled = true;
  document.getElementById('invTaxCompanyChange').style.display = '';
  document.getElementById('invTaxCompanyHint').textContent =
    'Defaults to the project’s tax company. “Change” overrides it for this invoice only.';
  const currentTcId = inv?.busspartnertoinvoiceid || activeProjectDefaultTc?.id || null;
  const extras = [];
  if (inv?.busspartnertoinvoiceid) {
    extras.push({ id: inv.busspartnertoinvoiceid, taxcompanyname: inv.invoicingPartnerLabel || '(tax company)' });
  } else if (activeProjectDefaultTc) {
    extras.push(activeProjectDefaultTc);
  }
  fillTaxCompanySelect(taxSel, {
    bpTaxCompanies: activeProjectBpTaxCompanies,
    extras,
    selectedId: currentTcId,
    blankLabel: '— none —',
  });
  invTaxCompanyPrev = taxSel.value;

  invoiceOverlay.classList.remove('hidden');
}

document.getElementById('invTaxCompanyChange').addEventListener('click', () => {
  const sel = document.getElementById('invTaxCompany');
  sel.disabled = false;
  document.getElementById('invTaxCompanyChange').style.display = 'none';
  document.getElementById('invTaxCompanyHint').textContent = 'Overriding for this invoice only.';
  sel.focus();
});
document.getElementById('invTaxCompany').addEventListener('change', (e) => {
  if (e.target.value === '__more__') {
    e.target.value = invTaxCompanyPrev || '';
    openTaxCompanyPicker((tc) => {
      addTaxCompanyOption(e.target, tc);
      e.target.value = String(tc.id);
      invTaxCompanyPrev = String(tc.id);
    });
  } else {
    invTaxCompanyPrev = e.target.value;
  }
});

function closeInvoiceModal(){
  invoiceOverlay.classList.add('hidden');
  activeInvoiceId = null;
}
document.getElementById('invClose').addEventListener('click', closeInvoiceModal);
document.getElementById('invCancel').addEventListener('click', closeInvoiceModal);
invoiceOverlay.addEventListener('click', (e) => { if (e.target === invoiceOverlay) closeInvoiceModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!tcPickerOverlay.classList.contains('hidden')) { closeTaxCompanyPicker(); return; }
  if (!invoiceOverlay.classList.contains('hidden')) { closeInvoiceModal(); return; }
  if (!modalOverlay.classList.contains('hidden')) { closeProjectModal(); return; }
});

function invoiceLineItemsPayload(){
  return invLineItems
    .map(li => ({
      description: (li.description || '').trim(),
      quantity: Number(li.quantity) || 0,
      unitPrice: Number(li.unitPrice) || 0,
    }))
    .filter(li => li.description || li.quantity || li.unitPrice);
}

function invoicePayload(){
  return {
    invoiceDate: document.getElementById('invDate').value || null,
    invoiceDueDate: document.getElementById('invDueDate').value || null,
    invoiceSentDate: document.getElementById('invSentDate').value || null,
    invoiceDipositDate: document.getElementById('invDipositDate').value || null,
    currency: invCurCode(),
    lineItems: invoiceLineItemsPayload(),
    vatId: document.getElementById('invVatType').value || 4,
    numOcClient: document.getElementById('invNumOcClient').value || null,
    purchaseOrder: document.getElementById('invPurchaseOrder').value || null,
    invoiceComments: document.getElementById('invComments').value || null,
    taxCompanyId: (() => { const v = document.getElementById('invTaxCompany').value; return v && v !== '__more__' ? v : null; })(),
    dipositAccountId: document.getElementById('invDepositAccount').value || null,
  };
}

document.getElementById('invSave').addEventListener('click', async () => {
  if (!activeProjectId) return;
  if (!invoiceLineItemsPayload().length) {
    toast('Add at least one invoiceable item.', 'red');
    return;
  }
  try {
    if (activeInvoiceId) {
      await HITT_API.updateInvoice(activeInvoiceId, invoicePayload());
      toast('Invoice saved', 'green');
    } else {
      const isCorrective = document.getElementById('invIsCorrective').checked;
      const sourceInvoiceId = document.getElementById('invSourceInvoice').value || null;
      if (isCorrective && !sourceInvoiceId) {
        toast('Pick which invoice this corrective invoice replaces.', 'red');
        return;
      }
      await HITT_API.createInvoice(activeProjectId, { ...invoicePayload(), isCorrective, sourceInvoiceId });
      toast('Invoice created', 'green');
    }
    closeInvoiceModal();
    await loadInvoices();
    await loadProjects();
  } catch (err) {
    console.error(err);
    toast('Could not save the invoice.', 'red');
  }
});

document.getElementById('invDelete').addEventListener('click', async () => {
  if (!activeInvoiceId) return;
  const inv = INVOICES.find(x => x.id === activeInvoiceId);
  if (!confirm(`Delete invoice ${inv?.invoicecode || '(draft)'}? This cannot be undone.`)) return;
  try {
    await HITT_API.deleteInvoice(activeInvoiceId);
    toast('Invoice deleted', 'navy');
    closeInvoiceModal();
    await loadInvoices();
    await loadProjects();
  } catch (err) {
    console.error(err);
    toast('Could not delete the invoice.', 'red');
  }
});

/* ============================== INIT ==================================== */
loadProjects();
