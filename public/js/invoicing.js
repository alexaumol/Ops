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

const DEMO_SEED = [
  { id: 1, code: '26018', name: 'Demo Project', entityLabel: 'HiTT', budget: 5000, proceedtoinvoice: true, invoiceCount: 1, invoicedTotal: 2000 },
];

let PROJECTS = [];
let LOOKUPS = { statuses: [], scheduleTypes: [], deliveryMethods: [], vatTypes: [], bankAccounts: [] };
let INVOICES = [];
let usingDemoData = false;
let currentBucket = 'all';
let searchTerm = '';
let activeProjectId = null;
let activeProjectBpId = null;
let activeInvoiceId = null;

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
function formatDateOnly(iso){ return iso ? new Date(iso).toLocaleDateString() : '—'; }
function formatMoney(n){
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString(undefined, { style: 'currency', currency: 'EUR' });
}
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
    renderTable();
    return;
  }
  try {
    LOOKUPS = await HITT_API.getInvoicingLookups();
    PROJECTS = await HITT_API.getInvoicingProjects();
    usingDemoData = false;
  } catch (err) {
    console.warn('Falling back to demo data — could not reach API:', err);
    PROJECTS = structuredClone(DEMO_SEED);
    usingDemoData = true;
  }
  setDataSourcePill();
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

function matchesFilters(row){
  if (currentBucket !== 'all' && computeBucket(row) !== currentBucket) return false;
  if (searchTerm) {
    const t = searchTerm.toLowerCase();
    if (!String(row.code).toLowerCase().includes(t) && !String(row.name).toLowerCase().includes(t)) return false;
  }
  return true;
}

function renderTable(){
  const tbody = document.getElementById('invTableBody');
  const empty = document.getElementById('invEmpty');
  const rows = PROJECTS.filter(matchesFilters).sort((a, b) => String(b.code).localeCompare(String(a.code)));

  if (!rows.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  tbody.innerHTML = rows.map((p, i) => {
    const bucket = computeBucket(p);
    return `
      <tr data-i="${i}">
        <td><span style="font-weight:600;">${escapeHtml(p.code)}</span> — ${escapeHtml(p.name)}</td>
        <td>${escapeHtml(p.entityLabel || '—')}</td>
        <td style="text-align:right;">${formatMoney(p.budget)}</td>
        <td style="text-align:right;">${formatMoney(p.invoicedTotal)}</td>
        <td><span class="inv-bucket-pill inv-bucket-${bucket}">${BUCKET_LABEL[bucket]}</span></td>
      </tr>
    `;
  }).join('');

  tbody.querySelectorAll('tr').forEach((tr, i) => {
    tr.addEventListener('click', () => openProjectModal(rows[i].id));
  });
}

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

/* ============================== PROJECT MODAL ============================= */
const modalOverlay = document.getElementById('modalOverlay');

async function openProjectModal(projectId){
  const p = PROJECTS.find(x => x.id === projectId);
  if (!p) return;
  activeProjectId = projectId;
  activeProjectBpId = null;

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
  } catch (err) {
    console.warn('Could not load project detail for tax-company context:', err);
  }

  await loadInvoices();
}

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
      <td style="text-align:right;" class="${Number(inv.amount) < 0 ? 'inv-money inv-money--neg' : 'inv-money'}">${formatMoney(inv.amount)}</td>
      <td style="text-align:right;">${formatMoney(inv.vatamount)}</td>
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
  document.getElementById('invVatAmountPreview').textContent = `${formatMoney(vatAmount)} (${pct}%)`;
}
document.getElementById('invAmount').addEventListener('input', updateVatPreview);
document.getElementById('invVatType').addEventListener('change', updateVatPreview);

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

  document.getElementById('invIsCorrective').checked = !!inv?.iscorrective;
  document.getElementById('invIsCorrective').disabled = !!inv; // corrective flag is fixed at creation time
  document.getElementById('invSourceRow').classList.add('hidden');

  document.getElementById('invDate').value = inv?.invoicedate ? inv.invoicedate.slice(0, 10) : '';
  document.getElementById('invDueDate').value = inv?.invoiceduedate ? inv.invoiceduedate.slice(0, 10) : '';
  document.getElementById('invSentDate').value = inv?.invoicesentdate ? inv.invoicesentdate.slice(0, 10) : '';
  document.getElementById('invDipositDate').value = inv?.invoicedipositdate ? inv.invoicedipositdate.slice(0, 10) : '';
  clientSideStatusPreview();

  document.getElementById('invAmount').value = inv?.amount ?? '';
  document.getElementById('invVatType').innerHTML = lookupOptionsHtml(LOOKUPS.vatTypes, inv?.vatid ?? 4, false);
  updateVatPreview();

  document.getElementById('invDepositAccount').innerHTML = lookupOptionsHtml(LOOKUPS.bankAccounts, inv?.dipositaccountid, true);
  document.getElementById('invNumOcClient').value = inv?.numocclient || '';
  document.getElementById('invPurchaseOrder').value = inv?.purchaseorder || '';
  document.getElementById('invDescription').value = inv?.descriptionservice || '';
  document.getElementById('invComments').value = inv?.invoicecomments || '';

  document.getElementById('invTaxCompany').innerHTML = `<option value="">Loading…</option>`;
  invoiceOverlay.classList.remove('hidden');

  if (activeProjectBpId) {
    try {
      const taxCompanies = await HITT_API.getBusinessPartnerTaxCompanies(activeProjectBpId);
      document.getElementById('invTaxCompany').innerHTML = lookupOptionsHtml(
        taxCompanies.map(tc => ({ id: tc.id, label: tc.taxcompanyname })),
        inv?.busspartnertoinvoiceid, true
      );
    } catch (err) {
      console.warn('Could not load tax companies:', err);
      document.getElementById('invTaxCompany').innerHTML = `<option value="">—</option>`;
    }
  } else {
    document.getElementById('invTaxCompany').innerHTML = `<option value="">No Contracting Business Partner assigned to this project</option>`;
  }
}

function closeInvoiceModal(){
  invoiceOverlay.classList.add('hidden');
  activeInvoiceId = null;
}
document.getElementById('invClose').addEventListener('click', closeInvoiceModal);
document.getElementById('invCancel').addEventListener('click', closeInvoiceModal);
invoiceOverlay.addEventListener('click', (e) => { if (e.target === invoiceOverlay) closeInvoiceModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !invoiceOverlay.classList.contains('hidden')) closeInvoiceModal();
  else if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) closeProjectModal();
});

function invoicePayload(){
  return {
    invoiceDate: document.getElementById('invDate').value || null,
    invoiceDueDate: document.getElementById('invDueDate').value || null,
    invoiceSentDate: document.getElementById('invSentDate').value || null,
    invoiceDipositDate: document.getElementById('invDipositDate').value || null,
    amount: document.getElementById('invAmount').value ? Number(document.getElementById('invAmount').value) : null,
    vatId: document.getElementById('invVatType').value || 4,
    numOcClient: document.getElementById('invNumOcClient').value || null,
    purchaseOrder: document.getElementById('invPurchaseOrder').value || null,
    descriptionService: document.getElementById('invDescription').value || null,
    invoiceComments: document.getElementById('invComments').value || null,
    taxCompanyId: document.getElementById('invTaxCompany').value || null,
    dipositAccountId: document.getElementById('invDepositAccount').value || null,
  };
}

document.getElementById('invSave').addEventListener('click', async () => {
  if (!activeProjectId) return;
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
