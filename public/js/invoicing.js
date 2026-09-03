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
const T = (k, v) => (window.HITT_I18N ? HITT_I18N.t(k, v) : k);
HITT_PERMS.guardModule("invoicing", "../welcome.html");
document.getElementById("userName").textContent = session.displayName;
document.getElementById("userAvatar").textContent = HITT_AUTH.initials(session);
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
// Veri*Factu (Spain) — only active when this instance has the feature on.
// VF_STATES: invoiceId → { issuedAt, autosubmit, state, error, verifyUrl }
const VF_ON = !!(window.HITT_CONFIG && window.HITT_CONFIG.FEATURES && window.HITT_CONFIG.FEATURES.verifactu);
let VF_STATES = {};
let usingDemoData = false;
let currentBucket = 'partial';
let searchTerm = '';
let sortColumn = 'code';
let sortDirection = 'desc';
let lifecycleFilter = 'alive'; // 'alive' | 'closed' | 'all'
const projectStatusSel = new Set(); // selected project-status labels; empty = all
let activeProjectId = null;
let activeProjectBpId = null;
let activeInvoiceId = null;
let modalVf = null; // { issuedAt, autosubmit, latest, records } for the open invoice
let activeProjectBpTaxCompanies = [];         // the contracting BP's own tax companies
let activeProjectDefaultTc = null;            // { id, taxcompanyname } — project default for new invoices
let invTaxCompanyPrev = '';                   // last real value of the invoice-modal select
let invoicesDefaultTcPrev = '';               // last real value of the Invoices-tab default select

// "Invoice view" tab — a flat list of every invoice across all projects.
// It's the default landing view (see INIT); the project dashboard sits
// behind the "Project view" tab.
let currentView = 'invoice';                   // 'project' | 'invoice'
let ALL_INVOICES = [];
let ALL_VF_STATES = {}; // invoiceId → verifactu state, for the flat "Invoice view"
let allInvoicesLoaded = false;
const ivStatusSel = new Set();                // selected invoice-status labels; empty = all
let ivSearch = '';
let ivSortColumn = 'updated';                 // default: most recently updated on top
let ivSortDirection = 'desc';

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
    pill.textContent = T('common.demoData');
    pill.style.background = "rgba(188,154,28,0.18)";
    pill.style.color = "#8A6E12";
  } else {
    pill.textContent = T('common.liveData');
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
const BUCKET_LABEL_KEY = { 'not-released': 'inv.bucket.notReleased', 'not-started': 'inv.bucket.notStarted', 'partial': 'inv.bucket.partial', 'total': 'inv.bucket.total' };
const bucketLabel = (b) => T(BUCKET_LABEL_KEY[b] || b);
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
    : `<div class="inv-status-opt inv-status-opt--empty">${T('inv.status.none')}</div>`;
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
  if (projectStatusSel.size === 0) el.textContent = T('inv.status.all');
  else if (projectStatusSel.size === 1) el.textContent = [...projectStatusSel][0];
  else el.textContent = T('inv.status.nSelected', { n: projectStatusSel.size });
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
        <td class="inv-proceed-col">${p.proceedtoinvoice ? `<span class="inv-proceed-icon" title="${T('inv.tip.proceed')}">✔</span>` : ''}</td>
        <td><span style="font-weight:600;">${escapeHtml(p.code)}</span> — ${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.entityLabel || '—')}</td>
        <td>${p.bpName ? escapeHtml(p.bpName) : '—'}</td>
        <td>${statusChipHtml(p.projectStatusLabel)}</td>
        <td style="text-align:right;">${formatMoney(p.budget)}</td>
        <td style="text-align:right;" class="${invoicedAlert ? 'inv-invoiced-alert' : ''}">
          ${formatMoney(p.invoicedTotal)}${pct !== null ? ` <span class="inv-invoiced-pct">(${pct}%)</span>` : ''}
        </td>
        <td style="text-align:right;">${Number(p.invoiceCount) || 0}</td>
        <td><span class="inv-bucket-pill inv-bucket-${bucket}">${bucketLabel(bucket)}</span></td>
        <td class="inv-actions-col">
          <div class="inv-row-actions">
            <a class="inv-row-btn" href="projects.html?projectId=${encodeURIComponent(p.id)}" data-row-action title="${T('inv.tip.openProject')}" aria-label="${T('inv.tip.openProject')}">📁</a>
            ${p.bpId
              ? `<a class="inv-row-btn" href="business-partners.html?open=${encodeURIComponent(p.bpId)}" data-row-action title="${T('inv.tip.openBp')}" aria-label="${T('inv.tip.openBp')}">🤝</a>`
              : `<span class="inv-row-btn" data-row-action aria-disabled="true" title="${T('inv.tip.noBp')}" style="opacity:0.3; cursor:default;">🤝</span>`}
            <button type="button" class="inv-row-btn inv-row-btn--danger" data-close-project data-row-action
              title="${alreadyClosed ? T('inv.tip.alreadyClosed') : T('inv.tip.closeProject')}"
              aria-label="${T('inv.tip.closeProjectAria')}" ${alreadyClosed ? 'disabled' : ''}>⊘</button>
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
  if (usingDemoData) { toast(T('inv.demo.noClose'), 'navy'); return; }
  if (CLOSED_STATUS_ID == null) { toast(T('inv.err.noClosedStatus'), 'red'); return; }
  if (!confirm(T('inv.confirm.closeProject', { code: p.code, name: p.name }))) return;
  try {
    await HITT_API.updateProjectStage(p.id, CLOSED_STATUS_ID, currentEmployeeId);
    toast(T('inv.toast.closed', { code: p.code }), 'green');
    await loadProjects();
  } catch (err) {
    console.error(err);
    toast(T('inv.toast.closeFail'), 'red');
  }
}

function updateSortIndicators(){
  document.querySelectorAll('#paneProjectView .inv-table th[data-sort]').forEach(th => {
    const active = th.dataset.sort === sortColumn;
    th.classList.toggle('sorted', active);
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = active ? (sortDirection === 'asc' ? ' ▲' : ' ▼') : '';
  });
}

document.querySelectorAll('#paneProjectView .inv-table th[data-sort]').forEach(th => {
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

/* ============================== INVOICE VIEW ============================== */
function switchView(view){
  currentView = view;
  document.querySelectorAll('.inv-view-tab').forEach(b =>
    b.setAttribute('aria-selected', String(b.dataset.view === view)));
  document.getElementById('paneProjectView').classList.toggle('hidden', view !== 'project');
  document.getElementById('paneInvoiceView').classList.toggle('hidden', view !== 'invoice');
  if (view === 'invoice' && !allInvoicesLoaded) loadAllInvoices();
}
document.querySelectorAll('.inv-view-tab').forEach(btn => {
  btn.addEventListener('click', () => switchView(btn.dataset.view));
});

async function loadAllInvoices(){
  const tbody = document.getElementById('ivTableBody');
  const empty = document.getElementById('ivEmpty');
  tbody.innerHTML = `<tr><td colspan="7" class="sub-empty">${T('common.loading')}</td></tr>`;
  empty.classList.add('hidden');
  if (usingDemoData) {
    ALL_INVOICES = [];
    allInvoicesLoaded = true;
    populateIvStatusOptions();
    renderInvoiceViewTable();
    return;
  }
  try {
    ALL_INVOICES = await HITT_API.getAllInvoices();
    allInvoicesLoaded = true;
  } catch (err) {
    console.warn('Could not load the invoice list:', err);
    ALL_INVOICES = [];
    toast(T('inv.toast.invoicesLoadFail'), 'red');
  }
  if (VF_ON) {
    try { ALL_VF_STATES = (await HITT_API.getAllInvoiceVerifactu()).states || {}; }
    catch (err) { console.warn('Could not load Veri*Factu states:', err); ALL_VF_STATES = {}; }
  }
  populateIvStatusOptions();
  renderInvoiceViewTable();
}

// Only reload the flat invoice list if the user has actually opened that
// tab — called after any create / edit / delete so it stays in sync.
function maybeRefreshAllInvoices(){
  if (allInvoicesLoaded) loadAllInvoices();
}

function populateIvStatusOptions(){
  const menu = document.getElementById('ivStatusMenu');
  const labels = [...new Set(ALL_INVOICES.map(x => x.statusLabel).filter(Boolean))].sort();
  [...ivStatusSel].forEach(l => { if (!labels.includes(l)) ivStatusSel.delete(l); });
  menu.innerHTML = labels.length
    ? labels.map(l => `
        <label class="inv-status-opt">
          <input type="checkbox" value="${escapeHtml(l)}" ${ivStatusSel.has(l) ? 'checked' : ''} />
          <span>${escapeHtml(l)}</span>
        </label>`).join('')
    : `<div class="inv-status-opt inv-status-opt--empty">${T('inv.status.none')}</div>`;
  menu.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      if (cb.checked) ivStatusSel.add(cb.value);
      else ivStatusSel.delete(cb.value);
      updateIvStatusLabel();
      renderInvoiceViewTable();
    });
  });
  updateIvStatusLabel();
}

function updateIvStatusLabel(){
  const el = document.getElementById('ivStatusBtnLabel');
  if (!el) return;
  if (ivStatusSel.size === 0) el.textContent = T('inv.status.all');
  else if (ivStatusSel.size === 1) el.textContent = [...ivStatusSel][0];
  else el.textContent = T('inv.status.nSelected', { n: ivStatusSel.size });
}

function ivMatches(inv){
  if (ivStatusSel.size && !ivStatusSel.has(String(inv.statusLabel || ''))) return false;
  if (ivSearch) {
    const t = ivSearch.toLowerCase();
    const desc = String(inv.descriptionservice || '').replace(/<[^>]+>/g, ' ');
    const hay = `${inv.invoicecode || ''} ${desc} ${inv.projectBpName || ''} ${inv.taxCompanyName || ''} ${inv.projectCode || ''} ${inv.projectName || ''} ${inv.entityLabel || ''}`.toLowerCase();
    if (!hay.includes(t)) return false;
  }
  return true;
}

function ivSortValue(inv, col){
  switch (col) {
    case 'code': return String(inv.invoicecode || '');
    case 'entity': return String(inv.entityLabel || '');
    case 'taxco': return String(inv.taxCompanyName || '');
    case 'project': return String(inv.projectCode || '');
    case 'amount': return Number(inv.amount) || 0;
    case 'updated': return inv.updatedAt ? new Date(inv.updatedAt).getTime() : 0;
    default: return '';
  }
}
function ivCompareRows(a, b){
  const dir = ivSortDirection === 'asc' ? 1 : -1;
  const av = ivSortValue(a, ivSortColumn), bv = ivSortValue(b, ivSortColumn);
  if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
  return String(av).localeCompare(String(bv), undefined, { numeric: true }) * dir;
}
function updateIvSortIndicators(){
  document.querySelectorAll('.inv-table--invoices th[data-sort]').forEach(th => {
    const active = th.dataset.sort === ivSortColumn;
    th.classList.toggle('sorted', active);
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = active ? (ivSortDirection === 'asc' ? ' ▲' : ' ▼') : '';
  });
}

function ivFormatUpdated(inv){
  if (!inv.updatedAt) return '—';
  const d = new Date(inv.updatedAt);
  const txt = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
  return inv.updatedByName
    ? `<span title="${escapeHtml(inv.updatedByName)}">${escapeHtml(txt)}</span>`
    : escapeHtml(txt);
}

function renderInvoiceViewTable(){
  const tbody = document.getElementById('ivTableBody');
  const empty = document.getElementById('ivEmpty');
  const rows = ALL_INVOICES.filter(ivMatches).sort(ivCompareRows);

  updateIvSortIndicators();

  if (!rows.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');

  tbody.innerHTML = rows.map((inv, i) => {
    const statusPill = `<span class="inv-status-pill inv-status-${inv.invoicestatusid}">${escapeHtml(inv.statusLabel || '—')}</span>`;
    const sent = inv.emailedAt
      ? `<span class="inv-sent-badge" title="${escapeHtml(sentBadgeTitle(inv))}">${T('inv.sent.badge')}</span>`
      : '';
    const corrective = (inv.iscorrective && inv.sourceInvoiceCode)
      ? `<i class="inv-corrective-src" title="${escapeHtml(T('inv.iv.correctiveTip', { code: inv.sourceInvoiceCode }))}">(<a href="#" data-open-src>${escapeHtml(inv.sourceInvoiceCode)}</a>)</i>`
      : '';
    const tcCell = inv.taxCompanyName
      ? (inv.taxCompanyBpId
        ? `<a href="business-partners.html?open=${encodeURIComponent(inv.taxCompanyBpId)}" data-link>${escapeHtml(inv.taxCompanyName)}</a>`
        : escapeHtml(inv.taxCompanyName))
      : '—';
    const projCell = inv.projectId
      ? `<a href="projects.html?projectId=${encodeURIComponent(inv.projectId)}" data-link><span style="font-weight:600;">${escapeHtml(inv.projectCode || '')}</span> — ${escapeHtml(inv.projectName || '')}</a>`
      : '—';
    return `
      <tr data-i="${i}">
        <td>
          <div class="inv-iv-code"><a href="#" data-open>${escapeHtml(inv.invoicecode || T('inv.draft'))}</a>${corrective}</div>
          <div class="inv-iv-sub">${statusPill}${sent}${vfChipHtmlFlat(inv.id)}</div>
        </td>
        <td>${escapeHtml(inv.entityLabel || '—')}</td>
        <td>${tcCell}</td>
        <td>${projCell}</td>
        <td style="text-align:right;" class="inv-money${Number(inv.amount) < 0 ? ' inv-money--neg' : ''}">${formatMoney(inv.amount, inv.currency)}</td>
        <td class="inv-iv-updated">${ivFormatUpdated(inv)}</td>
        <td class="inv-actions-col">
          <div class="inv-row-actions">
            <button type="button" class="inv-row-btn" data-open title="${T('inv.iv.openRecord')}" aria-label="${T('inv.iv.openRecord')}">✎</button>
            <button type="button" class="inv-row-btn" data-pdf title="${T('inv.tip.viewPdf')}" aria-label="${T('inv.tip.viewPdf')}">📄</button>
          </div>
        </td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('tr').forEach((tr, i) => {
    const inv = rows[i];
    tr.querySelectorAll('[data-open]').forEach(el => {
      el.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openInvoiceFromList(inv); });
    });
    tr.querySelector('[data-open-src]')?.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openInvoiceFromList({ id: inv.sourceInvoiceId, projectId: inv.sourceProjectId });
    });
    tr.querySelector('[data-pdf]')?.addEventListener('click', (e) => {
      e.stopPropagation();
      openInvoicePdf(inv.id);
    });
    tr.addEventListener('click', (e) => {
      if (e.target.closest('a[data-link], [data-open], [data-open-src], [data-pdf]')) return;
      openInvoiceFromList(inv);
    });
  });
}

// Open the New/Edit invoice modal for an invoice picked from the flat list.
// The modal expects the owning project's invoicing context (default tax
// company, the BP's tax companies, that project's invoice list for the
// corrective-source dropdown), so load it first — same as openProjectModal.
async function openInvoiceFromList(inv){
  if (usingDemoData) { toast(T('common.notAvailableDemo'), 'navy'); return; }
  if (!inv.projectId) { toast(T('inv.toast.invoicesLoadFail'), 'red'); return; }
  activeProjectId = inv.projectId;
  activeProjectBpId = null;
  activeProjectBpTaxCompanies = [];
  activeProjectDefaultTc = null;
  try {
    const detail = await HITT_API.getProject(inv.projectId);
    activeProjectBpId = detail.busspartnerid || null;
    if (detail.busspartnertoinvoiceid) {
      activeProjectDefaultTc = { id: detail.busspartnertoinvoiceid, taxcompanyname: detail.invoicingPartnerLabel || T('inv.tc.generic') };
    }
  } catch (err) {
    console.warn('Could not load project context for the invoice:', err);
  }
  if (activeProjectBpId) {
    try { activeProjectBpTaxCompanies = await HITT_API.getBusinessPartnerTaxCompanies(activeProjectBpId); }
    catch { activeProjectBpTaxCompanies = []; }
  }
  try { INVOICES = await HITT_API.getProjectInvoices(inv.projectId); }
  catch { INVOICES = []; }
  await loadVerifactuStates();
  openInvoiceModal(inv.id);
}

const ivStatusBtn = document.getElementById('ivStatusBtn');
const ivStatusMenu = document.getElementById('ivStatusMenu');
ivStatusBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  const open = ivStatusMenu.classList.toggle('hidden');
  ivStatusBtn.setAttribute('aria-expanded', String(!open));
});
ivStatusMenu.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => {
  ivStatusMenu.classList.add('hidden');
  ivStatusBtn.setAttribute('aria-expanded', 'false');
});
document.getElementById('ivSearchBox').addEventListener('input', (e) => {
  ivSearch = e.target.value.trim();
  renderInvoiceViewTable();
});

document.querySelectorAll('.inv-table--invoices th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    if (ivSortColumn === col) {
      ivSortDirection = ivSortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      ivSortColumn = col;
      // Amount + last-updated read best most-first; text columns A→Z.
      ivSortDirection = (col === 'amount' || col === 'updated') ? 'desc' : 'asc';
    }
    renderInvoiceViewTable();
  });
});

/* ============================== TAX COMPANY SELECT + PICKER ============== */
function taxCompanyOptionLabel(tc){
  const name = tc.taxcompanyname || T('common.unnamed');
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
  opts.push(`<option value="__more__">${T('inv.tc.chooseAnother')}</option>`);
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
  document.getElementById('tcPickerBody').innerHTML = `<tr><td colspan="4" class="sub-empty">${T('common.loading')}</td></tr>`;
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
        <td>${escapeHtml(tc.taxcompanyname || T('common.unnamed'))}</td>
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
    tbody.innerHTML = `<tr><td colspan="4" class="sub-empty">${T('inv.tc.loadFail')}</td></tr>`;
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
  document.getElementById('invoicesDefaultTaxCompany').innerHTML = `<option value="">${T('common.loading')}</option>`;

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
      activeProjectDefaultTc = { id: detail.busspartnertoinvoiceid, taxcompanyname: detail.invoicingPartnerLabel || T('inv.tc.generic') };
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
    blankLabel: T('inv.tc.noneSet'),
  });
  invoicesDefaultTcPrev = sel.value;
}

async function saveProjectDefaultTaxCompany(tcId){
  if (usingDemoData) { toast(T('common.notAvailableDemo'), 'navy'); return; }
  try {
    await HITT_API.assignProjectInvoicingPartner(activeProjectId, tcId, currentEmployeeId);
    invoicesDefaultTcPrev = String(tcId);
    const sel = document.getElementById('invoicesDefaultTaxCompany');
    const label = [...sel.options].find(o => o.value === String(tcId))?.textContent || T('inv.tc.generic');
    activeProjectDefaultTc = { id: tcId, taxcompanyname: label };
    const proj = PROJECTS.find(x => x.id === activeProjectId);
    if (proj) proj.busspartnertoinvoiceid = tcId;
    toast(T('inv.toast.defaultTcSaved'), 'green');
  } catch (err) {
    console.error(err);
    toast(T('inv.toast.defaultTcFail'), 'red');
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
  if (!activeProjectId || usingDemoData) { if (usingDemoData) toast(T('common.notAvailableDemo'), 'navy'); return; }
  try {
    await HITT_API.saveProjectRelease(activeProjectId, {
      proceedToInvoice: document.getElementById('relProceed').checked,
      scheduleTypeId: document.getElementById('relSchedule').value || null,
      invPayMethodId: document.getElementById('relDelivery').value || null,
      numberOfInvoices: document.getElementById('relNumInvoices').value || null,
      firstDate: document.getElementById('relFirstDate').value || null,
      lastDate: document.getElementById('relLastDate').value || null,
    });
    toast(T('inv.toast.releaseSaved'), 'green');
    await loadProjects();
  } catch (err) {
    console.error(err);
    toast(T('inv.toast.settingsFail'), 'red');
  }
});

/* ============================== INVOICES LIST ============================= */
async function loadInvoices(){
  const tbody = document.getElementById('invoicesTableBody');
  tbody.innerHTML = `<tr><td colspan="7" class="sub-empty">${T('common.loading')}</td></tr>`;
  try {
    INVOICES = await HITT_API.getProjectInvoices(activeProjectId);
  } catch (err) {
    console.warn('Could not load invoices:', err);
    INVOICES = [];
    toast(T('inv.toast.invoicesLoadFail'), 'red');
  }
  await loadVerifactuStates();
  renderInvoicesTable();
}

// Draft/issued + AEAT state per invoice, for the list badges. Best-effort:
// a failure (or the feature being off) just leaves the badges hidden.
async function loadVerifactuStates(){
  if (!VF_ON || !activeProjectId) { VF_STATES = {}; return; }
  try {
    const { states } = await HITT_API.getProjectInvoiceVerifactu(activeProjectId);
    VF_STATES = states || {};
  } catch (err) {
    console.warn('Could not load Veri*Factu states:', err);
    VF_STATES = {};
  }
}

// Chip for an invoice's Veri*Factu lifecycle, from its VF_STATES entry.
// '' when the feature is off or the invoice is still an unissued draft with
// nothing to show.
function vfChipFrom(s){
  if (!VF_ON || !s || !s.issuedAt) return '';
  if (s.cancelState === 'sent')    return `<span class="inv-vf-chip inv-vf-chip--issued">${escapeHtml(T('inv.vf.state.cancelled'))}</span>`;
  if (s.cancelState === 'pending') return `<span class="inv-vf-chip inv-vf-chip--pending">${escapeHtml(T('inv.vf.state.cancelPending'))}</span>`;
  const map = {
    sent:    ['sent',    T('inv.vf.state.sent')],
    pending: ['pending', T('inv.vf.state.pending')],
    error:   ['error',   T('inv.vf.state.error')],
  };
  const [cls, label] = map[s.state] || ['issued', T('inv.vf.state.issued')];
  const title = s.state === 'error' && s.error ? ` title="${escapeHtml(s.error)}"` : '';
  return `<span class="inv-vf-chip inv-vf-chip--${cls}"${title}>${escapeHtml(label)}</span>`;
}
function vfChipHtml(invId){ return vfChipFrom(VF_STATES[invId]); }
function vfChipHtmlFlat(invId){ return vfChipFrom(ALL_VF_STATES[invId]); }
function vfIsDraft(invId){ return VF_ON && !(VF_STATES[invId] && VF_STATES[invId].issuedAt); }

// A one-line summary of an issue/retry result for a toast.
function vfResultTone(r){
  const st = (r && (r.verifactu?.state || r.state)) || null;
  if (st === 'error') return 'red';
  if (st === 'pending' || st === 'skipped') return 'navy';
  return 'green';
}
function vfResultMsg(r){
  const v = (r && (r.verifactu || r)) || {};
  if (v.state === 'sent')    return T('inv.toast.vf.sent');
  if (v.state === 'pending') return T('inv.toast.vf.pending');
  if (v.state === 'error')   return T('inv.toast.vf.error', { msg: v.message || '' });
  if (v.state === 'skipped') return T('inv.toast.issued');
  return T('inv.toast.issued');
}

async function issueInvoiceFlow(invoiceId, { autosubmit } = {}){
  const inv = INVOICES.find(x => x.id === invoiceId);
  const code = inv?.invoicecode || T('inv.draft');
  if (!confirm(T('inv.vf.confirmIssue', { code }))) return;
  try {
    const payload = typeof autosubmit === 'boolean' ? { autosubmit } : {};
    const r = await HITT_API.issueInvoice(invoiceId, payload);
    toast(vfResultMsg(r), vfResultTone(r));
    await refreshAfterInvoiceChange();
  } catch (err) {
    console.error(err);
    toast(err.message || T('inv.toast.issueFail'), 'red');
  }
}

async function retryVerifactuFlow(invoiceId){
  try {
    const r = await HITT_API.retryInvoiceVerifactu(invoiceId);
    toast(vfResultMsg(r), vfResultTone(r));
    await refreshAfterInvoiceChange();
  } catch (err) {
    console.error(err);
    toast(err.message || T('inv.toast.vf.retryFail'), 'red');
  }
}

async function refreshVerifactuFlow(invoiceId){
  try {
    const r = await HITT_API.refreshInvoiceVerifactu(invoiceId);
    const st = r && r.state;
    toast(st === 'sent' ? T('inv.toast.vf.sent')
        : st === 'error' ? T('inv.toast.vf.error', { msg: '' })
        : T('inv.toast.vf.stillPending'),
        st === 'error' ? 'red' : st === 'sent' ? 'green' : 'navy');
    await refreshAfterInvoiceChange();
  } catch (err) {
    console.error(err);
    toast(err.message || T('inv.toast.vf.refreshFail'), 'red');
  }
}

async function cancelInvoiceFlow(invoiceId){
  const inv = INVOICES.find(x => x.id === invoiceId);
  const code = inv?.invoicecode || T('inv.draft');
  if (!confirm(T('inv.vf.confirmCancel', { code }))) return;
  try {
    const r = await HITT_API.cancelInvoice(invoiceId);
    if (r.cancelled === false) {
      toast(T('inv.vf.cancelBlocked', { msg: (r.verifactu && r.verifactu.message) || '' }), 'red');
    } else {
      const st = r.verifactu && r.verifactu.state;
      toast(st === 'pending' ? T('inv.toast.vf.cancelPending') : T('inv.toast.cancelled'),
            st === 'pending' ? 'navy' : 'green');
    }
    await refreshAfterInvoiceChange();
  } catch (err) {
    console.error(err);
    toast(err.message || T('inv.toast.cancelFail'), 'red');
  }
}

async function refreshAfterInvoiceChange(){
  await loadInvoices();
  await loadProjects();
  maybeRefreshAllInvoices();
}

function sentBadgeTitle(inv){
  const when = inv.emailedAt ? new Date(inv.emailedAt).toLocaleString() : '';
  const bits = [when ? T('inv.sent.emailedOn', { when }) : T('inv.sent.emailed')];
  if (inv.emailedTo) bits.push(T('inv.sent.to', { to: inv.emailedTo }));
  if (inv.emailedByName) bits.push(T('inv.sent.by', { by: inv.emailedByName }));
  if (Number(inv.emailedCount) > 1) bits.push(T('inv.sent.times', { n: inv.emailedCount }));
  return bits.join(' ');
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
  tbody.innerHTML = INVOICES.map((inv, i) => {
    const draft = vfIsDraft(inv.id);
    const errored = VF_ON && VF_STATES[inv.id] && VF_STATES[inv.id].state === 'error';
    return `
    <tr data-i="${i}" style="cursor:pointer;">
      <td>${escapeHtml(inv.invoicecode || T('inv.draft'))}</td>
      <td>
        <span class="inv-status-pill inv-status-${inv.invoicestatusid}">${escapeHtml(inv.statusLabel || '—')}</span>
        ${inv.emailedAt ? `<span class="inv-sent-badge" title="${escapeHtml(sentBadgeTitle(inv))}">${T('inv.sent.badge')}</span>` : ''}
        ${vfChipHtml(inv.id)}
      </td>
      <td style="text-align:right;" class="${Number(inv.amount) < 0 ? 'inv-money inv-money--neg' : 'inv-money'}">${formatMoney(inv.amount, inv.currency)}</td>
      <td style="text-align:right;">${formatMoney(inv.vatamount, inv.currency)}</td>
      <td>${formatDateOnly(inv.invoicedate)}</td>
      <td>${escapeHtml(inv.invoicingPartnerLabel || '—')}</td>
      <td style="white-space:nowrap;">
        ${draft ? `<button class="inv-issue-btn" data-issue title="${T('inv.vf.issueTip')}">${T('inv.vf.issue')}</button>` : ''}
        ${errored ? `<button class="inv-retry-btn" data-retry title="${T('inv.vf.retryTip')}">${T('inv.vf.retry')}</button>` : ''}
        <button class="ta-remove-btn" data-pdf title="${T('inv.tip.viewPdf')}">📄</button>
        <button class="ta-remove-btn" data-email title="${T('inv.tip.email')}">📧</button>
      </td>
      <td>${VF_ON && !draft ? '' : `<button class="ta-remove-btn" data-delete title="${T('inv.tip.delete')}">✕</button>`}</td>
    </tr>
  `;
  }).join('');

  tbody.querySelectorAll('tr').forEach((tr, i) => {
    tr.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete], [data-pdf], [data-email], [data-issue], [data-retry]')) return;
      openInvoiceModal(INVOICES[i].id);
    });
  });
  tbody.querySelectorAll('[data-issue]').forEach((btn, i) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); issueInvoiceFlow(INVOICES[i].id); });
  });
  tbody.querySelectorAll('[data-retry]').forEach((btn, i) => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); retryVerifactuFlow(INVOICES[i].id); });
  });
  tbody.querySelectorAll('[data-pdf]').forEach((btn, i) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openInvoicePdf(INVOICES[i].id);
    });
  });
  tbody.querySelectorAll('[data-email]').forEach((btn, i) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openInvoiceEmailModal(INVOICES[i].id);
    });
  });
  tbody.querySelectorAll('[data-delete]').forEach((btn, i) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(T('inv.confirm.deleteInvoice', { code: INVOICES[i].invoicecode || T('inv.draft') }))) return;
      try {
        await HITT_API.deleteInvoice(INVOICES[i].id);
        toast(T('inv.toast.invoiceDeleted'), 'navy');
        await loadInvoices();
        await loadProjects();
        maybeRefreshAllInvoices();
      } catch (err) {
        console.error(err);
        toast(T('inv.toast.invoiceDeleteFail'), 'red');
      }
    });
  });
}

document.getElementById('btnNewInvoice').addEventListener('click', () => openInvoiceModal(null));

// Open the invoice PDF in a new tab. Fetched as a blob so the auth header
// rides along (a bare window.open(url) can't send it, and the route is guarded).
async function openInvoicePdf(invoiceId){
  const w = window.open('', '_blank');
  try {
    const blob = await HITT_API.fetchInvoicePdf(invoiceId);
    const url = URL.createObjectURL(blob);
    if (w) w.location = url; else window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (err) {
    console.error(err);
    if (w) w.close();
    toast(T('inv.toast.pdfFail'), 'red');
  }
}
document.getElementById('invViewPdf').addEventListener('click', () => {
  if (activeInvoiceId) openInvoicePdf(activeInvoiceId);
});
document.getElementById('invEmail').addEventListener('click', () => {
  if (activeInvoiceId) openInvoiceEmailModal(activeInvoiceId);
});

/* ============================== EMAIL INVOICE MODAL ===================== */
const invoiceEmailOverlay = document.getElementById('invoiceEmailOverlay');
let emailInvoiceId = null;
const LANG_NAME = () => ({ 1: T('lang.en'), 2: T('lang.es'), 3: T('lang.ca') });

function closeInvoiceEmailModal(){
  invoiceEmailOverlay.classList.add('hidden');
  emailInvoiceId = null;
}

async function openInvoiceEmailModal(invoiceId){
  emailInvoiceId = invoiceId;
  const err = document.getElementById('invEmailError');
  err.textContent = '';
  ['invEmailFrom', 'invEmailTo', 'invEmailCc', 'invEmailSubject'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('invEmailBody').value = '';
  document.getElementById('invEmailLangHint').textContent = T('common.loading');
  document.getElementById('invEmailSend').disabled = true;
  invoiceEmailOverlay.classList.remove('hidden');

  try {
    const d = await HITT_API.getInvoiceEmailDefaults(invoiceId);
    if (emailInvoiceId !== invoiceId) return; // modal changed while loading
    document.getElementById('invEmailTitle').textContent =
      d.invoiceCode ? `${T('inv.emailInvoice')} ${d.invoiceCode}` : T('inv.emailInvoice');
    document.getElementById('invEmailFrom').value = d.from || '';
    document.getElementById('invEmailTo').value = d.to || '';
    document.getElementById('invEmailSubject').value = d.subject || '';
    document.getElementById('invEmailBody').value = d.body || '';
    const lang = LANG_NAME()[d.languageId] || T('lang.en');
    let hint = T('inv.email.langHint', { lang });
    if (d.emailedAt) {
      hint += T('inv.email.alreadyEmailed', { when: new Date(d.emailedAt).toLocaleString() }) +
        (Number(d.emailedCount) > 1 ? T('inv.email.alreadyEmailedTimes', { n: d.emailedCount }) : '') + '.';
    }
    document.getElementById('invEmailLangHint').textContent = hint;
    if (d.mailConfigured === false) {
      err.textContent = d.channel === 'smtp'
        ? T('inv.email.smtpNotConfigured')
        : T('inv.email.notConfigured');
    }
    document.getElementById('invEmailSend').disabled = false;
  } catch (e) {
    console.error(e);
    document.getElementById('invEmailLangHint').textContent = '';
    err.textContent = e.message || T('inv.email.loadFail');
  }
}

document.getElementById('invEmailClose').addEventListener('click', closeInvoiceEmailModal);
document.getElementById('invEmailCancel').addEventListener('click', closeInvoiceEmailModal);
invoiceEmailOverlay.addEventListener('click', (e) => {
  if (e.target === invoiceEmailOverlay) closeInvoiceEmailModal();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !invoiceEmailOverlay.classList.contains('hidden')) closeInvoiceEmailModal();
});

document.getElementById('invEmailSend').addEventListener('click', async () => {
  if (!emailInvoiceId) return;
  const to = document.getElementById('invEmailTo').value.trim();
  const cc = document.getElementById('invEmailCc').value.trim();
  const subject = document.getElementById('invEmailSubject').value.trim();
  const body = document.getElementById('invEmailBody').value.trim();
  const err = document.getElementById('invEmailError');
  err.textContent = '';
  if (!to) { err.textContent = T('inv.email.needRecipient'); return; }
  if (!confirm(cc ? T('inv.email.confirmSendCc', { to, cc }) : T('inv.email.confirmSend', { to }))) return;

  const btn = document.getElementById('invEmailSend');
  btn.disabled = true;
  btn.textContent = T('inv.email.sending');
  try {
    const r = await HITT_API.sendInvoiceEmail(emailInvoiceId, { to, cc, subject, body });
    toast(T('inv.toast.emailed', { to: r.to.join(', ') }), 'green');
    closeInvoiceEmailModal();
    if (activeProjectId) loadInvoices(); // refresh so the "Sent" badge shows
  } catch (e) {
    console.error(e);
    err.textContent = e.message || T('inv.email.sendFail');
  } finally {
    btn.disabled = false;
    btn.textContent = T('inv.email.send');
  }
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
  if (!d && !s && !dep) { id = 2; label = T('inv.status.notGenerated'); }
  else if (d && !s && !dep) { id = 3; label = T('inv.status.toBeSent'); }
  else if (d && s && !dep) { id = 4; label = T('inv.status.sentToCustomer'); }
  else if (d && s && dep) { id = 5; label = T('inv.status.collected'); }
  else { id = 1; label = T('inv.status.pendingPo'); }
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
    tbody.innerHTML = `<tr class="inv-items-none"><td colspan="5">${T('inv.items.none')}</td></tr>`;
  } else {
    tbody.innerHTML = invLineItems.map((li, i) => `
      <tr data-i="${i}">
        <td><textarea class="field-input inv-item-desc" rows="1" data-li-desc placeholder="${T('inv.items.descPlaceholder')}">${escapeHtml(li.description || '')}</textarea></td>
        <td><input type="number" class="field-input" step="1" min="0" data-li-qty value="${li.quantity ?? ''}" /></td>
        <td><input type="number" class="field-input" step="0.01" min="0" data-li-price value="${li.unitPrice ?? ''}" /></td>
        <td class="inv-items-sub" data-li-sub>${formatMoney(invItemSubtotal(li), invCurCode())}</td>
        <td><button type="button" class="ta-remove-btn" data-li-del title="${T('inv.tip.removeItem')}">✕</button></td>
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
      candidates.map(inv => ({ id: inv.id, label: `${inv.invoicecode || T('inv.draft')} — ${formatMoney(inv.amount)}` })),
      null, true
    );
  }
});

async function openInvoiceModal(invoiceId){
  activeInvoiceId = invoiceId;
  const inv = invoiceId ? INVOICES.find(x => x.id === invoiceId) : null;

  document.getElementById('invModalTitle').textContent = inv
    ? `${T('inv.modal.edit')} ${inv.invoicecode || T('inv.draft')}`
    : T('inv.modal.new');
  document.getElementById('invDelete').classList.toggle('hidden', !inv);
  document.getElementById('invViewPdf').classList.toggle('hidden', !inv);
  document.getElementById('invEmail').classList.toggle('hidden', !inv);

  // Veri*Factu: paint from the list state we already have (so an issued
  // invoice opens locked, no flash of editable fields), then confirm with a
  // fresh fetch. No-op unless FEATURES.verifactu is on.
  modalVf = (VF_ON && inv && VF_STATES[inv.id]) ? { ...VF_STATES[inv.id] } : null;
  applyVerifactuToModal(modalVf, !!inv);
  if (VF_ON && inv) {
    HITT_API.getInvoiceVerifactu(inv.id).then((vf) => {
      if (activeInvoiceId !== invoiceId) return;
      const a = vf.alta || vf.latest || null;
      modalVf = {
        issuedAt: vf.issuedAt || null,
        autosubmit: vf.autosubmit == null ? true : !!vf.autosubmit,
        state: a ? a.state : null,
        error: a ? a.errorText : null,
        verifyUrl: a ? a.verifyUrl : null,
        queueId: a ? a.queueId : null,
        cancelState: vf.anulacion ? vf.anulacion.state : null,
        cancelError: vf.anulacion ? vf.anulacion.errorText : null,
      };
      applyVerifactuToModal(modalVf, true);
    }).catch((err) => console.warn('Could not load invoice Veri*Factu state:', err));
  }

  // Reset the unsaved-edits badge; show "last updated by" when we have it.
  document.getElementById('invChangedBadge').classList.add('hidden');
  const updatedInfo = document.getElementById('invUpdatedInfo');
  if (inv && inv.updatedAt) {
    const who = inv.updatedByName || (inv.updatedById ? `#${inv.updatedById}` : T('inv.someone'));
    updatedInfo.innerHTML = T('inv.lastUpdatedBy', { who: escapeHtml(who), when: escapeHtml(new Date(inv.updatedAt).toLocaleString()) });
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
  document.getElementById('invTaxCompanyHint').textContent = T('inv.f.taxCompanyHint');
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
    blankLabel: T('inv.tc.none'),
  });
  invTaxCompanyPrev = taxSel.value;

  invoiceOverlay.classList.remove('hidden');
}

document.getElementById('invTaxCompanyChange').addEventListener('click', () => {
  const sel = document.getElementById('invTaxCompany');
  sel.disabled = false;
  document.getElementById('invTaxCompanyChange').style.display = 'none';
  document.getElementById('invTaxCompanyHint').textContent = T('inv.f.taxCompanyOverride');
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
  modalVf = null;
  setModalLocked(false);
}

/* ── Veri*Factu in the invoice modal ─────────────────────────────────── */

// Lock (issued invoice) / unlock the modal body. Only touches fields this
// function itself disabled — marked with data-vf-locked — so it never fights
// the corrective-flag / tax-company-select disabled states openInvoiceModal
// manages.
function setModalLocked(locked){
  const body = document.querySelector('#invoiceOverlay .modal-body');
  if (!body) return;
  if (locked) {
    body.querySelectorAll('input, select, textarea, button').forEach((el) => {
      if (el.id === 'invAutosubmit') return;
      if (!el.disabled) { el.disabled = true; el.dataset.vfLocked = '1'; }
    });
  } else {
    body.querySelectorAll('[data-vf-locked]').forEach((el) => {
      el.disabled = false;
      delete el.dataset.vfLocked;
    });
  }
}

// vf: normalised { issuedAt, autosubmit, state, error, verifyUrl, queueId } | null
function applyVerifactuToModal(vf, isExisting){
  const box = document.getElementById('invVerifactuBox');
  const autoRow = document.getElementById('invAutosubmitRow');
  const issueBtn = document.getElementById('invIssue');
  const retryBtn = document.getElementById('invRetryVf');
  const refreshBtn = document.getElementById('invRefreshVf');
  const checkBtn = document.getElementById('invCheckRecipient');
  const cancelBtn = document.getElementById('invCancelInv');
  const saveBtn = document.getElementById('invSave');
  const delBtn = document.getElementById('invDelete');

  if (!VF_ON) {
    box.classList.add('hidden');
    autoRow.classList.add('hidden');
    issueBtn.classList.add('hidden');
    retryBtn.classList.add('hidden');
    refreshBtn.classList.add('hidden');
    checkBtn.classList.add('hidden');
    cancelBtn.classList.add('hidden');
    return;
  }

  const issued = !!(vf && vf.issuedAt);
  const isDraftExisting = isExisting && !issued;
  const cancelled = issued && vf && vf.cancelState === 'sent';
  const cancelPending = issued && vf && vf.cancelState === 'pending';

  autoRow.classList.toggle('hidden', !isDraftExisting);
  document.getElementById('invAutosubmit').checked = vf ? vf.autosubmit !== false : true;

  issueBtn.classList.toggle('hidden', !isDraftExisting);
  issueBtn.disabled = false;
  retryBtn.disabled = false;
  refreshBtn.disabled = false;
  checkBtn.disabled = false;
  cancelBtn.disabled = false;
  saveBtn.classList.toggle('hidden', issued);
  delBtn.classList.toggle('hidden', issued || !isExisting);
  // Retry: an alta error, or a failed cancel. Refresh: a queued alta or cancel
  // (poll the AEAT for the outcome). Check recipient: a draft, pre-issue.
  retryBtn.classList.toggle('hidden', !(issued && vf && (vf.state === 'error' || vf.cancelState === 'error')));
  refreshBtn.classList.toggle('hidden', !(issued && vf && (vf.state === 'pending' || cancelPending)));
  checkBtn.classList.toggle('hidden', !isDraftExisting);
  cancelBtn.classList.toggle('hidden', !(issued && !cancelled && !cancelPending));

  setModalLocked(issued);

  if (!issued) { box.classList.add('hidden'); box.innerHTML = ''; return; }

  const stateKey = cancelled ? 'cancelled' : (cancelPending ? 'cancelPending' : (vf.state || 'issued'));
  const stateLabel = ({
    sent: T('inv.vf.state.sent'), pending: T('inv.vf.state.pending'),
    error: T('inv.vf.state.error'), issued: T('inv.vf.state.issued'),
    cancelled: T('inv.vf.state.cancelled'), cancelPending: T('inv.vf.state.cancelPending'),
  })[stateKey] || stateKey;
  const errClass = stateKey === 'error' || (vf.cancelState === 'error');
  box.classList.toggle('inv-vf-box--error', errClass);
  const chipCls = stateKey === 'error' ? 'error' : (stateKey === 'sent' ? 'sent' : 'issued');
  box.innerHTML = `
    <h4>${T('inv.vf.boxTitle')}</h4>
    <div><strong>${escapeHtml(stateLabel)}</strong>${vf.queueId ? ` · <span class="inv-vf-chip inv-vf-chip--${chipCls}">#${escapeHtml(String(vf.queueId))}</span>` : ''}</div>
    ${vf.verifyUrl ? `<div style="margin-top:0.3rem;"><a href="${escapeHtml(vf.verifyUrl)}" target="_blank" rel="noopener">${T('inv.vf.verifyLink')}</a></div>` : ''}
    ${!cancelled && !cancelPending && vf.state === 'error' && vf.error ? `<div class="inv-vf-err">${escapeHtml(vf.error)}</div>` : ''}
    ${!cancelled && !cancelPending && vf.state === 'pending' ? `<div style="margin-top:0.3rem; color:var(--text-secondary);">${T('inv.vf.pendingHint')}</div>` : ''}
    ${cancelPending ? `<div style="margin-top:0.3rem; color:var(--text-secondary);">${T('inv.vf.cancelPendingHint')}</div>` : ''}
    ${vf.cancelState === 'error' && vf.cancelError ? `<div class="inv-vf-err">${escapeHtml(vf.cancelError)}</div>` : ''}
  `;
  box.classList.remove('hidden');
}

document.getElementById('invIssue').addEventListener('click', async () => {
  if (!activeInvoiceId) return;
  const autosubmit = document.getElementById('invAutosubmit').checked;
  document.getElementById('invIssue').disabled = true;
  await issueInvoiceFlow(activeInvoiceId, { autosubmit });
  closeInvoiceModal();
});

document.getElementById('invRetryVf').addEventListener('click', async () => {
  if (!activeInvoiceId) return;
  document.getElementById('invRetryVf').disabled = true;
  const id = activeInvoiceId;
  await retryVerifactuFlow(id);
  // reopen so the refreshed status shows
  if (INVOICES.find((x) => x.id === id)) openInvoiceModal(id); else closeInvoiceModal();
});

document.getElementById('invCancelInv').addEventListener('click', async () => {
  if (!activeInvoiceId) return;
  document.getElementById('invCancelInv').disabled = true;
  const id = activeInvoiceId;
  await cancelInvoiceFlow(id);
  if (INVOICES.find((x) => x.id === id)) openInvoiceModal(id); else closeInvoiceModal();
});

document.getElementById('invRefreshVf').addEventListener('click', async () => {
  if (!activeInvoiceId) return;
  document.getElementById('invRefreshVf').disabled = true;
  const id = activeInvoiceId;
  await refreshVerifactuFlow(id);
  if (INVOICES.find((x) => x.id === id)) openInvoiceModal(id); else closeInvoiceModal();
});

document.getElementById('invCheckRecipient').addEventListener('click', async () => {
  if (!activeInvoiceId) return;
  const btn = document.getElementById('invCheckRecipient');
  btn.disabled = true;
  try {
    const r = await HITT_API.checkInvoiceRecipient(activeInvoiceId);
    if (r.valid === true) toast(r.message || T('inv.vf.checkOk'), 'green');
    else if (r.valid === false) toast(r.message || T('inv.vf.checkBad'), 'red');
    else toast(r.message || T('inv.vf.checkNa'), 'navy');
  } catch (err) {
    console.error(err);
    toast(err.message || T('inv.vf.checkFail'), 'red');
  } finally {
    btn.disabled = false;
  }
});
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
    toast(T('inv.toast.needItem'), 'red');
    return;
  }
  try {
    if (activeInvoiceId) {
      await HITT_API.updateInvoice(activeInvoiceId, invoicePayload());
      toast(T('inv.toast.saved'), 'green');
    } else {
      const isCorrective = document.getElementById('invIsCorrective').checked;
      const sourceInvoiceId = document.getElementById('invSourceInvoice').value || null;
      if (isCorrective && !sourceInvoiceId) {
        toast(T('inv.toast.needSource'), 'red');
        return;
      }
      await HITT_API.createInvoice(activeProjectId, { ...invoicePayload(), isCorrective, sourceInvoiceId });
      toast(T('inv.toast.created'), 'green');
    }
    closeInvoiceModal();
    await loadInvoices();
    await loadProjects();
    maybeRefreshAllInvoices();
  } catch (err) {
    console.error(err);
    toast(T('inv.toast.saveFail'), 'red');
  }
});

document.getElementById('invDelete').addEventListener('click', async () => {
  if (!activeInvoiceId) return;
  const inv = INVOICES.find(x => x.id === activeInvoiceId);
  if (!confirm(T('inv.confirm.deleteInvoice', { code: inv?.invoicecode || T('inv.draft') }))) return;
  try {
    await HITT_API.deleteInvoice(activeInvoiceId);
    toast(T('inv.toast.invoiceDeleted'), 'navy');
    closeInvoiceModal();
    await loadInvoices();
    await loadProjects();
    maybeRefreshAllInvoices();
  } catch (err) {
    console.error(err);
    toast(T('inv.toast.invoiceDeleteFail'), 'red');
  }
});

/* ============================== INIT ==================================== */
// loadProjects() resolves usingDemoData, the data-source pill and the
// lookups the invoice modal needs; it also fills the (hidden) Project
// view so switching to it is instant. Then load the default Invoice view.
loadProjects().then(() => switchView('invoice'));


/* Re-render dynamic content when the UI language changes. */
window.addEventListener('hitt:langchange', () => {
  if (typeof setDataSourcePill === 'function') setDataSourcePill();
  if (typeof updateProjectStatusLabel === 'function') updateProjectStatusLabel();
  if (typeof updateIvStatusLabel === 'function') updateIvStatusLabel();
  if (typeof renderTable === 'function') renderTable();
  if (allInvoicesLoaded && typeof renderInvoiceViewTable === 'function') renderInvoiceViewTable();
  const mo = document.getElementById('modalOverlay');
  if (mo && !mo.classList.contains('hidden') && typeof renderInvoicesTable === 'function') renderInvoicesTable();
});
