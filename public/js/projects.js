/**
 * HITT Ops — Projects kanban
 * ---------------------------------------------------------------------------
 * Stage ids/labels mirror PrjStatusId 0-6 as used by the existing Access
 * app (see "Subformulario ProjectPortfolioProgress_dump" / lstStage0..6):
 *   0 Lead · 1 Oferta · 2 Guanyat · 3 WIP · 4 Delivered · 5 Closed · 6 Cancelled
 *
 * Data source: tries the real API first (GET /api/projects against the
 * PostgreSQL test environment). If the API is unreachable — common while
 * the backend/tunnel isn't deployed yet — it falls back to local demo data
 * so the UI is still reviewable, and shows that clearly in the header pill.
 * ---------------------------------------------------------------------------
 */

const session = HITT_AUTH.requireSession("../index.html");
HITT_PERMS.guardModule("projects", "../welcome.html");

// Default/fallback stage list — used until GET /api/projects/statuses
// confirms the real projectstatus rows (id, label, ordinal) from the DB.
// The visual styling (color/icon/alive-vs-closed) is matched onto whatever
// the DB returns by comparing labels case-insensitively, so this stays
// correct even if the real ordinal/id values differ from 0-6.
const STAGE_STYLE_BY_KEY = {
  lead:      { key: 'lead',      set: 'alive',  color: '#5C757C', icon: iconLead() },
  oferta:    { key: 'oferta',    set: 'alive',  color: '#BC9A1C', icon: iconRFP() },
  guanyat:   { key: 'guanyat',   set: 'alive',  color: '#6E8F5A', icon: iconWon() },
  wip:       { key: 'wip',       set: 'alive',  color: '#171717', icon: iconWIP() },
  delivered: { key: 'delivered', set: 'alive',  color: '#211916', icon: iconDelivered() },
  closed:    { key: 'closed',    set: 'closed', color: '#8A8676', icon: iconClosed() },
  cancelled: { key: 'cancelled', set: 'closed', color: '#B24A3A', icon: iconCancelled() },
};
const FALLBACK_STAGE_ORDER = ['lead', 'oferta', 'guanyat', 'wip', 'delivered', 'closed', 'cancelled'];

let STAGES = FALLBACK_STAGE_ORDER.map((key, i) => ({
  id: i,
  label: key.charAt(0).toUpperCase() + key.slice(1),
  ...STAGE_STYLE_BY_KEY[key],
}));
let STAGE_BY_ID = Object.fromEntries(STAGES.map(s => [s.id, s]));

/**
 * Replace STAGES with the real rows from projectstatus (id, label, ordinal),
 * matching each one's visual style by comparing its label text against the
 * known stage keys above (falls back to a neutral grey if a status name
 * doesn't match anything we recognise, rather than dropping it).
 */
function applyRealStatuses(dbStatuses) {
  if (!Array.isArray(dbStatuses) || !dbStatuses.length) return;
  const sorted = [...dbStatuses].sort((a, b) => (a.ordinal ?? a.id) - (b.ordinal ?? b.id));
  STAGES = sorted.map((row) => {
    const normalized = String(row.label || '').trim().toLowerCase();
    const style = STAGE_STYLE_BY_KEY[normalized] || {
      key: normalized || `status-${row.id}`,
      set: /clos|cancel/.test(normalized) ? 'closed' : 'alive',
      color: '#8A8676',
      icon: iconLead(),
    };
    return { id: row.id, label: row.label, ...style };
  });
  STAGE_BY_ID = Object.fromEntries(STAGES.map(s => [s.id, s]));
}

// Demo fallback — only shown when the API can't be reached.
const DEMO_SEED = [
  { id: 1, code: '26018', name: 'Innovation Grant Evaluation', stage: 0, progress: 5 },
  { id: 2, code: '26046', name: 'Training Program Design', stage: 1, progress: 20 },
  { id: 3, code: '26058', name: 'Pediatric Innovation Summit', stage: 2, progress: 35 },
  { id: 4, code: '25096', name: 'EU Research Grant', stage: 3, progress: 55 },
  { id: 5, code: '25009', name: 'Market Access Evaluation', stage: 4, progress: 90 },
  { id: 6, code: '23011', name: 'Legacy Pricing Study', stage: 5, progress: 100 },
  { id: 7, code: '24006', name: 'Budget Freeze Pilot', stage: 6, progress: 10 },
];

let PROJECTS = [];
let LOOKUPS = { entities: [], biotechSpectrums: [], projectTypes: [] };
let usingDemoData = false;
let currentTab = 'alive';
let searchTerm = '';
let activeProjectId = null;
let activeBusinessPartnerId = null;
let idCounter = 1000;

/* ============================== ICONS ================================= */
function iconLead(){ return `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4h16l-6 8v6l-4 2v-8L4 4z"/></svg>`; }
function iconRFP(){ return `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="3" width="16" height="18" rx="1.5"/><path stroke-linecap="round" d="M8 8h8M8 12h8M8 16h5"/></svg>`; }
function iconWon(){ return `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 2L4 6v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V6l-8-4z"/></svg>`; }
function iconWIP(){ return `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M10.3 4.3a2 2 0 013.4 0l.4.7a2 2 0 001.6 1l.8-.1a2 2 0 012.2 2.2l-.1.8a2 2 0 001 1.6l.7.4a2 2 0 010 3.4l-.7.4a2 2 0 00-1 1.6l.1.8a2 2 0 01-2.2 2.2l-.8-.1a2 2 0 00-1.6 1l-.4.7a2 2 0 01-3.4 0l-.4-.7a2 2 0 00-1.6-1l-.8.1a2 2 0 01-2.2-2.2l.1-.8a2 2 0 00-1-1.6l-.7-.4a2 2 0 010-3.4l.7-.4a2 2 0 001-1.6l-.1-.8a2 2 0 012.2-2.2l.8.1a2 2 0 001.6-1l.4-.7z"/><circle cx="12" cy="12" r="3"/></svg>`; }
function iconDelivered(){ return `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8l9-5 9 5-9 5-9-5z"/><path stroke-linecap="round" stroke-linejoin="round" d="M3 8v8l9 5 9-5V8M12 13v8"/></svg>`; }
function iconClosed(){ return `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="10" width="16" height="10" rx="1.5"/><path stroke-linecap="round" stroke-linejoin="round" d="M8 10V7a4 4 0 118 0v3"/></svg>`; }
function iconCancelled(){ return `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path stroke-linecap="round" d="M8.5 8.5l7 7M15.5 8.5l-7 7"/></svg>`; }

/* ============================== HEADER ================================= */
document.getElementById("userName").textContent = session.displayName;
document.getElementById("userAvatar").textContent = HITT_AUTH.initials(session);
document.getElementById("btnSignOut").addEventListener("click", () => HITT_AUTH.signOut("../index.html"));
HITT_PERMS.applyRealName();

function setDataSourcePill() {
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

/* ============================== LOAD DATA =============================== */
async function loadProjects() {
  if (!window.HITT_CONFIG?.FEATURES?.projectsLive) {
    PROJECTS = structuredClone(DEMO_SEED);
    usingDemoData = true;
    setDataSourcePill();
    renderBoard();
    updateTabCounts();
    return;
  }
  try {
    try {
      const statuses = await HITT_API.getProjectStatuses();
      applyRealStatuses(statuses);
    } catch (statusErr) {
      console.warn("Could not load real project statuses, using fallback stage list:", statusErr);
    }
    try {
      LOOKUPS = await HITT_API.getProjectLookups();
    } catch (lookupErr) {
      console.warn("Could not load entity/biotech-spectrum/project-type lookups:", lookupErr);
    }
    const data = await HITT_API.getProjects();
    // Expected shape from GET /api/projects: [{ id, code, name, stage, progress }]
    PROJECTS = data.map(p => ({
      id: p.id,
      code: p.code ?? String(p.projectId ?? p.id),
      name: p.name ?? p.projectName ?? "(unnamed project)",
      stage: Number(p.stage ?? p.prjStatusId ?? 0),
      progress: Number(p.progress ?? 0),
    }));
    usingDemoData = false;
  } catch (err) {
    console.warn("Falling back to demo data — could not reach API:", err);
    PROJECTS = structuredClone(DEMO_SEED);
    usingDemoData = true;
  }
  setDataSourcePill();
  renderBoard();
  updateTabCounts();
}

/* ============================== TOASTS ================================= */
function toast(msg, tone='navy'){
  const host = document.getElementById('toastHost');
  const colors = { navy: 'bg-hitt-ink', green: 'bg-hitt-green', red: 'bg-hitt-red' };
  const el = document.createElement('div');
  el.className = `toast ${colors[tone]||colors.navy} text-white text-sm font-medium px-4 py-2.5 rounded-lg shadow-lift flex items-center gap-2`;
  el.innerHTML = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

/* ============================== RENDER ================================= */
function matchesSearch(p){
  if (!searchTerm) return true;
  const t = searchTerm.toLowerCase();
  return String(p.code).toLowerCase().includes(t) || p.name.toLowerCase().includes(t);
}

function escapeHtml(s){
  const d = document.createElement('div');
  d.textContent = s ?? "";
  return d.innerHTML;
}

function renderBoard(){
  const board = document.getElementById('board');
  board.innerHTML = '';
  const visibleStages = STAGES.filter(s => s.set === currentTab);

  visibleStages.forEach(stage => {
    const items = PROJECTS.filter(p => p.stage === stage.id && matchesSearch(p))
                           .sort((a,b) => String(a.code+a.name).localeCompare(String(b.code+b.name)));

    const col = document.createElement('div');
    col.className = 'flex flex-col bg-white rounded-xl border border-slate-200 shadow-card h-full overflow-hidden';
    col.dataset.stage = stage.id;

    col.innerHTML = `
      <div class="shrink-0 px-3 pt-3 pb-2.5 border-b border-slate-100" style="border-top:3px solid ${stage.color}">
        <div class="flex items-center justify-between">
          <div class="flex items-center gap-2 min-w-0">
            <span class="w-7 h-7 rounded-md flex items-center justify-center shrink-0 text-white" style="background:${stage.color}">${stage.icon}</span>
            <h2 class="font-semibold text-sm text-hitt-ink truncate">${stage.label}</h2>
          </div>
          <span data-count-for="${stage.id}" class="font-mono text-xs font-bold text-white rounded-full px-2 py-0.5 shrink-0" style="background:${stage.color}">${items.length}</span>
        </div>
      </div>
      <div class="col-body flex-1 overflow-y-auto px-2 py-2 space-y-2 fade-mask" data-stage="${stage.id}" style="min-height:80px"></div>
    `;

    const body = col.querySelector('.col-body');
    if (items.length === 0) {
      body.innerHTML = `<div class="text-xs text-slate-400 text-center py-8 select-none">No projects${searchTerm ? ' match your search' : ' here yet'}</div>`;
    } else {
      items.forEach(p => body.appendChild(renderCard(p, stage)));
    }

    attachDropZone(body);
    board.appendChild(col);
  });
}

function renderCard(p, stage){
  const card = document.createElement('div');
  card.className = 'card pop-in group bg-white border border-slate-200 hover:border-slate-300 rounded-lg shadow-card hover:shadow-cardHover cursor-grab select-none overflow-hidden';
  card.draggable = true;
  card.dataset.id = p.id;
  card.dataset.stage = stage.id;
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-label', `${p.code} ${p.name}, stage ${stage.label}. Press arrow keys to move.`);

  card.innerHTML = `
    <div class="flex">
      <div class="w-1 shrink-0" style="background:${stage.color}" data-rail></div>
      <div class="flex-1 min-w-0 px-2.5 py-2">
        <div class="flex items-start justify-between gap-1.5">
          <span class="font-mono text-[10px] font-bold text-hitt-teal tracking-tight">${escapeHtml(p.code)}</span>
          <span class="text-[10px] font-mono text-slate-400">${p.progress ?? 0}%</span>
        </div>
        <p class="text-[13px] leading-snug font-medium text-hitt-ink mt-0.5 truncate" title="${escapeHtml(p.name)}">${escapeHtml(p.name)}</p>
      </div>
    </div>
  `;

  card.addEventListener('dragstart', (e) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(p.id));
    requestAnimationFrame(() => card.classList.add('dragging'));
  });
  card.addEventListener('dragend', () => {
    card.classList.remove('dragging');
    document.querySelectorAll('.col-body').forEach(b => b.classList.remove('drag-over','drag-invalid'));
  });
  card.addEventListener('dblclick', () => openProjectModal(p.id));
  card.addEventListener('keydown', (e) => {
    const stagesInSet = STAGES.filter(s => s.set === currentTab);
    const idx = stagesInSet.findIndex(s => s.id === p.stage);
    if (e.key === 'ArrowRight' && idx < stagesInSet.length - 1) {
      e.preventDefault();
      moveProject(p.id, stagesInSet[idx+1].id);
    } else if (e.key === 'ArrowLeft' && idx > 0) {
      e.preventDefault();
      moveProject(p.id, stagesInSet[idx-1].id);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      openProjectModal(p.id);
    }
  });

  return card;
}

function attachDropZone(body){
  body.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    body.classList.add('drag-over');
  });
  body.addEventListener('dragleave', () => body.classList.remove('drag-over'));
  body.addEventListener('drop', (e) => {
    e.preventDefault();
    body.classList.remove('drag-over');
    const id = Number(e.dataTransfer.getData('text/plain'));
    const targetStage = Number(body.dataset.stage);
    if (id) moveProject(id, targetStage);
  });
}

async function moveProject(id, targetStageId){
  const p = PROJECTS.find(x => x.id === id);
  if (!p || p.stage === targetStageId) return;
  const from = STAGE_BY_ID[p.stage];
  const to = STAGE_BY_ID[targetStageId];
  const previousStage = p.stage;
  p.stage = targetStageId;

  renderBoard();

  const countEl = document.querySelector(`[data-count-for="${targetStageId}"]`);
  if (countEl){ countEl.classList.remove('count-pulse'); void countEl.offsetWidth; countEl.classList.add('count-pulse'); }

  updateTabCounts();
  toast(`<span class="font-mono text-xs opacity-80">${escapeHtml(p.code)}</span> moved ${from.label} → <b>${to.label}</b>`, to.id === 6 ? 'red' : 'green');

  if (!usingDemoData) {
    try {
      await HITT_API.updateProjectStage(id, targetStageId);
    } catch (err) {
      console.error("Failed to persist stage change:", err);
      p.stage = previousStage; // rollback
      renderBoard();
      updateTabCounts();
      toast(`Could not save the move for <span class="font-mono text-xs">${escapeHtml(p.code)}</span> — reverted.`, 'red');
    }
  }
}

function updateTabCounts(){
  const aliveIds = STAGES.filter(s => s.set === 'alive').map(s => s.id);
  const closedIds = STAGES.filter(s => s.set === 'closed').map(s => s.id);
  const alive = PROJECTS.filter(p => aliveIds.includes(p.stage) && matchesSearch(p)).length;
  const closed = PROJECTS.filter(p => closedIds.includes(p.stage) && matchesSearch(p)).length;
  document.getElementById('countAlive').textContent = `(${alive})`;
  document.getElementById('countClosed').textContent = `(${closed})`;
}

/* ============================== MODAL =================================== */
const modalOverlay = document.getElementById('modalOverlay');
const modalPanel = document.getElementById('modalPanel');

function lookupOptionsHtml(rows, selectedId, includeBlank){
  const opts = (includeBlank ? [`<option value="">—</option>`] : [])
    .concat((rows || []).map(r => `<option value="${r.id}" ${String(r.id)===String(selectedId)?'selected':''}>${escapeHtml(r.label)}</option>`));
  return opts.join('');
}

function setBPEditLink(businessPartnerId){
  const link = document.getElementById('mBPEdit');
  if (businessPartnerId) {
    link.href = `business-partners.html?open=${encodeURIComponent(businessPartnerId)}`;
    link.classList.remove('hidden');
  } else {
    link.classList.add('hidden');
  }
}

// Populates "Business Partner to invoice" with the tax companies that
// belong to the project's assigned Contracting Business Partner (Access's
// cmbTaxCompanies combo, scoped the same way). Disabled until a BP is
// assigned, since a project can only invoice one of ITS BP's entities.
async function refreshInvoicingPartnerOptions(businessPartnerId, selectedTaxCompanyId){
  activeBusinessPartnerId = businessPartnerId || null;
  const select = document.getElementById('mInvoicingPartner');
  const addBtn = document.getElementById('mInvoicingPartnerAdd');
  const hint = document.getElementById('mInvoicingPartnerHint');

  if (!businessPartnerId) {
    select.innerHTML = '';
    select.disabled = true;
    addBtn.disabled = true;
    hint.textContent = 'Assign a Contracting Business Partner first to pick who gets invoiced.';
    return;
  }

  select.disabled = true;
  addBtn.disabled = false;
  select.innerHTML = `<option value="">Loading…</option>`;
  try {
    const taxCompanies = await HITT_API.getBusinessPartnerTaxCompanies(businessPartnerId);
    select.innerHTML = lookupOptionsHtml(
      taxCompanies.map(tc => ({ id: tc.id, label: tc.taxcompanyname })),
      selectedTaxCompanyId, true
    );
    select.disabled = false;
    hint.textContent = taxCompanies.length
      ? ''
      : 'No tax companies yet for this business partner — use "+" to add one.';
  } catch (err) {
    console.warn('Could not load tax companies for invoicing partner:', err);
    select.innerHTML = `<option value="">—</option>`;
    hint.textContent = 'Could not load tax companies.';
  }
}

document.getElementById('mInvoicingPartner').addEventListener('change', async (e) => {
  if (!activeProjectId) return;
  const taxCompanyId = e.target.value;
  if (!taxCompanyId) return;
  try {
    await HITT_API.assignProjectInvoicingPartner(activeProjectId, taxCompanyId);
    toast('Invoicing partner updated', 'green');
  } catch (err) {
    console.error(err);
    toast('Could not update the invoicing partner.', 'red');
  }
});

/* ============================== TAX COMPANY MODAL ========================= */
const taxCompanyOverlay = document.getElementById('taxCompanyOverlay');

function openTaxCompanyModal(){
  if (!activeBusinessPartnerId) return;
  document.getElementById('tcName').value = '';
  document.getElementById('tcVat').value = '';
  document.getElementById('tcEmail').value = '';
  document.getElementById('tcSameAddress').checked = true;
  taxCompanyOverlay.classList.remove('hidden');
  setTimeout(() => document.getElementById('tcName').focus(), 50);
}
function closeTaxCompanyModal(){
  taxCompanyOverlay.classList.add('hidden');
}

document.getElementById('mInvoicingPartnerAdd').addEventListener('click', openTaxCompanyModal);
document.getElementById('taxCompanyClose').addEventListener('click', closeTaxCompanyModal);
document.getElementById('taxCompanyCancel').addEventListener('click', closeTaxCompanyModal);
taxCompanyOverlay.addEventListener('click', (e) => { if (e.target === taxCompanyOverlay) closeTaxCompanyModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !taxCompanyOverlay.classList.contains('hidden')) closeTaxCompanyModal();
});

document.getElementById('taxCompanySave').addEventListener('click', async () => {
  const name = document.getElementById('tcName').value.trim();
  if (!name || !activeBusinessPartnerId || !activeProjectId) return;
  try {
    const created = await HITT_API.addBusinessPartnerTaxCompany(activeBusinessPartnerId, {
      taxcompanyname: name,
      vatnumber: document.getElementById('tcVat').value || null,
      emailinvoicing: document.getElementById('tcEmail').value || null,
      sameAddress: document.getElementById('tcSameAddress').checked,
    });
    await refreshInvoicingPartnerOptions(activeBusinessPartnerId, created.id);
    await HITT_API.assignProjectInvoicingPartner(activeProjectId, created.id);
    document.getElementById('mInvoicingPartner').value = String(created.id);
    closeTaxCompanyModal();
    toast(`<span class="font-mono text-xs opacity-80">${escapeHtml(name)}</span> created and assigned`, 'green');
  } catch (err) {
    console.error(err);
    toast('Could not create the tax company.', 'red');
  }
});

async function openProjectModal(id){
  const p = PROJECTS.find(x => x.id === id);
  if (!p) return;
  activeProjectId = id;

  document.getElementById('mYear').textContent = '20' + String(p.code).slice(0, 2).padStart(2, '0');
  document.getElementById('mCode').textContent = p.code;
  document.getElementById('mTitle').textContent = p.name;
  document.getElementById('mLastUpdated').textContent = '—';
  document.getElementById('mLastUpdatedBy').textContent = '—';
  document.getElementById('mChangedBadge').classList.add('hidden');

  const statusSel = document.getElementById('mStatus');
  statusSel.innerHTML = STAGES.map(s => `<option value="${s.id}" ${s.id===p.stage?'selected':''}>${s.label}</option>`).join('');
  document.getElementById('mProgress').value = p.progress ?? 0;

  // Entity/biotech-spectrum/project-type + business partner fields come
  // from the full detail record (GET /api/projects/:id), not the list
  // endpoint — populate selects with the lookup options now, values once
  // the detail fetch resolves below.
  document.getElementById('mEntity').innerHTML = lookupOptionsHtml(LOOKUPS.entities, null, true);
  document.getElementById('mProjectType').innerHTML = lookupOptionsHtml(LOOKUPS.projectTypes, null, true);
  document.getElementById('mBioSpectrum').innerHTML = lookupOptionsHtml(LOOKUPS.biotechSpectrums, null, true);
  document.getElementById('mBusinessPartner').textContent = '—';
  setBPEditLink(null);
  activeBusinessPartnerId = null;
  document.getElementById('mInvoicingPartner').innerHTML = '';
  document.getElementById('mInvoicingPartner').disabled = true;
  document.getElementById('mInvoicingPartnerAdd').disabled = true;
  document.getElementById('mInvoicingPartnerHint').textContent = 'Assign a Contracting Business Partner first to pick who gets invoiced.';
  document.getElementById('mBPRunningName').value = '';
  document.getElementById('mNotInvoiceable').checked = false;

  document.getElementById('mDeliverables').innerHTML =
    `<tr><td colspan="3" class="px-2.5 py-4 text-center text-slate-400 text-xs">${usingDemoData ? 'Not available in demo data' : 'Loading…'}</td></tr>`;
  document.getElementById('mQuotations').innerHTML =
    `<tr><td colspan="5" class="px-2.5 py-4 text-center text-slate-400 text-xs">${usingDemoData ? 'Not available in demo data' : 'Loading…'}</td></tr>`;
  document.getElementById('mNotesList').innerHTML =
    `<div class="text-xs text-slate-400 text-center py-6">${usingDemoData ? 'Not available in demo data' : 'Loading…'}</div>`;
  document.getElementById('mNewDeliverableName').value = '';
  document.getElementById('mNewDeliverableExpected').value = '';
  document.getElementById('mNewNote').value = '';

  document.querySelectorAll('[data-mtab]').forEach(b => b.setAttribute('aria-selected', b.dataset.mtab === 'general' ? 'true' : 'false'));
  document.getElementById('paneGeneral').classList.remove('hidden');
  document.getElementById('paneBudget').classList.add('hidden');

  modalPanel.querySelectorAll('input, select').forEach(el => {
    el.addEventListener('input', () => document.getElementById('mChangedBadge').classList.remove('hidden'), { once: true });
  });

  modalOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  if (!usingDemoData) {
    try {
      const detail = await HITT_API.getProject(id);
      if (activeProjectId !== id) return; // modal was closed/reopened while this was in flight
      document.getElementById('mEntity').innerHTML = lookupOptionsHtml(LOOKUPS.entities, detail.entityid, true);
      document.getElementById('mProjectType').innerHTML = lookupOptionsHtml(LOOKUPS.projectTypes, detail.projecttypeid, true);
      document.getElementById('mBioSpectrum').innerHTML = lookupOptionsHtml(LOOKUPS.biotechSpectrums, detail.biospectrumid, true);
      document.getElementById('mBusinessPartner').textContent = detail.businessPartnerLabel || '—';
      setBPEditLink(detail.busspartnerid);
      await refreshInvoicingPartnerOptions(detail.busspartnerid, detail.busspartnertoinvoiceid);
      document.getElementById('mBPRunningName').value = detail.bprunningname || '';
      document.getElementById('mNotInvoiceable').checked = !!detail.notinvoiceable;
      document.getElementById('mLastUpdated').textContent = detail.lastupdated
        ? new Date(detail.lastupdated).toLocaleString() : '—';
      document.getElementById('mLastUpdatedBy').textContent = detail.lastUpdatedByName || detail.lastupdatedby || '—';
    } catch (err) {
      console.warn(`Could not load full detail for project ${id}:`, err);
    }

    try {
      const [deliverables, notes, quotations] = await Promise.all([
        HITT_API.getProjectDeliverables(id),
        HITT_API.getProjectNotes(id),
        HITT_API.getProjectQuotations(id),
      ]);
      if (activeProjectId !== id) return;
      renderDeliverables(deliverables);
      renderNotes(notes);
      renderQuotations(quotations);
    } catch (err) {
      console.warn(`Could not load deliverables/notes/quotations for project ${id}:`, err);
    }
  }
}

/* ============================== BP PICKER ================================
 * Mirrors Access's SearchBusinessPartners.frm: search box (2+ chars),
 * double-click a result to assign it as the open project's Contracting
 * Business Partner. "+ Create & assign" covers the cmdAddNewBP "+" button
 * next to it on EditProject.frm — quick-create then assign immediately.
 * ========================================================================== */
const bpPickerOverlay = document.getElementById('bpPickerOverlay');
let bpSearchDebounce = null;

function openBpPicker(){
  if (!activeProjectId) return;
  document.getElementById('bpPickerSearch').value = '';
  document.getElementById('bpPickerNewName').value = '';
  document.getElementById('bpPickerResults').innerHTML =
    `<div class="text-xs text-slate-400 text-center py-6">Type at least two characters to start searching</div>`;
  bpPickerOverlay.classList.remove('hidden');
  setTimeout(() => document.getElementById('bpPickerSearch').focus(), 50);
}

function closeBpPicker(){
  bpPickerOverlay.classList.add('hidden');
}

async function assignBusinessPartner(bpId, bpName){
  if (!activeProjectId) return;
  try {
    await HITT_API.assignProjectBusinessPartner(activeProjectId, bpId);
    document.getElementById('mBusinessPartner').textContent = bpName || '—';
    setBPEditLink(bpId);
    await refreshInvoicingPartnerOptions(bpId, null); // new BP -> old invoicing pick no longer applies
    closeBpPicker();
    toast(`<span class="font-mono text-xs opacity-80">${escapeHtml(bpName || '')}</span> assigned as the contracting business partner`, 'green');
  } catch (err) {
    console.error(err);
    toast('Could not assign the business partner.', 'red');
  }
}

function renderBpPickerResults(rows){
  const host = document.getElementById('bpPickerResults');
  if (!rows.length) {
    host.innerHTML = `<div class="text-xs text-slate-400 text-center py-6">No matches</div>`;
    return;
  }
  host.innerHTML = rows.map((bp, i) => `
    <div data-i="${i}" class="px-2.5 py-2 rounded-md hover:bg-hitt-mist cursor-pointer select-none">
      <div class="text-sm font-medium text-hitt-ink">${escapeHtml(bp.name)}</div>
      <div class="text-[11px] text-slate-400">${escapeHtml([bp.entityLabel, bp.companyTypeLabel, bp.countryLabel].filter(Boolean).join(' · ') || '—')}</div>
    </div>
  `).join('');
  host.querySelectorAll('[data-i]').forEach(el => {
    el.addEventListener('dblclick', () => {
      const bp = rows[Number(el.dataset.i)];
      assignBusinessPartner(bp.id, bp.name);
    });
  });
}

document.getElementById('mBPSearch').addEventListener('click', openBpPicker);
document.getElementById('bpPickerClose').addEventListener('click', closeBpPicker);
bpPickerOverlay.addEventListener('click', (e) => { if (e.target === bpPickerOverlay) closeBpPicker(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !bpPickerOverlay.classList.contains('hidden')) closeBpPicker();
});

document.getElementById('bpPickerSearch').addEventListener('input', (e) => {
  const term = e.target.value.trim();
  clearTimeout(bpSearchDebounce);
  if (term.length < 2) {
    document.getElementById('bpPickerResults').innerHTML =
      `<div class="text-xs text-slate-400 text-center py-6">Type at least two characters to start searching</div>`;
    return;
  }
  bpSearchDebounce = setTimeout(async () => {
    document.getElementById('bpPickerResults').innerHTML =
      `<div class="text-xs text-slate-400 text-center py-6">Searching…</div>`;
    try {
      const rows = await HITT_API.getBusinessPartners(term);
      renderBpPickerResults(rows);
    } catch (err) {
      console.error(err);
      document.getElementById('bpPickerResults').innerHTML =
        `<div class="text-xs text-hitt-red text-center py-6">Search failed — is the API reachable?</div>`;
    }
  }, 300);
});

document.getElementById('bpPickerAddNew').addEventListener('click', async () => {
  const name = document.getElementById('bpPickerNewName').value.trim();
  if (!name) return;
  try {
    const created = await HITT_API.createBusinessPartner({ name });
    await assignBusinessPartner(created.id, created.name || name);
  } catch (err) {
    console.error(err);
    toast('Could not create the business partner.', 'red');
  }
});

function formatDateOnly(iso){
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString();
}

function renderDeliverables(rows){
  const tbody = document.getElementById('mDeliverables');
  if (!rows || !rows.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="px-2.5 py-4 text-center text-slate-400 text-xs">No deliverables yet</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(d => `
    <tr class="grid-row border-t border-slate-100">
      <td class="px-2.5 py-1.5 font-mono">${formatDateOnly(d.deliverydate)}</td>
      <td class="px-2.5 py-1.5 font-mono">${formatDateOnly(d.effectivedd)}</td>
      <td class="px-2.5 py-1.5">${escapeHtml(d.deliverablename || '(unnamed)')}</td>
    </tr>
  `).join('');
}

function renderQuotations(rows){
  const tbody = document.getElementById('mQuotations');
  if (!rows || !rows.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="px-2.5 py-4 text-center text-slate-400 text-xs">No quotations yet</td></tr>`;
    return;
  }
  const money = (n) => n == null ? '—' : Number(n).toLocaleString(undefined, { style: 'currency', currency: 'EUR' });
  tbody.innerHTML = rows.map(q => `
    <tr class="grid-row border-t border-slate-100">
      <td class="px-2.5 py-1.5 font-mono">${formatDateOnly(q.quotationdate)}</td>
      <td class="px-2.5 py-1.5 text-right font-mono">${money(q.amountquoted)}</td>
      <td class="px-2.5 py-1.5 text-right font-mono">${money(q.discountnegotiation)}</td>
      <td class="px-2.5 py-1.5 text-right font-mono">${money(q.expenses)}</td>
      <td class="px-2.5 py-1.5 text-right font-mono font-semibold">${money(q.finalquotation)}</td>
    </tr>
  `).join('');
}

function renderNotes(rows){
  const list = document.getElementById('mNotesList');
  if (!rows || !rows.length) {
    list.innerHTML = `<div class="text-xs text-slate-400 text-center py-6">No notes yet</div>`;
    return;
  }
  list.innerHTML = rows.map(n => `
    <div class="border border-slate-100 rounded-md p-2 bg-hitt-canvas">
      <div class="flex items-center justify-between gap-2 mb-1">
        <span class="text-[11px] font-semibold text-hitt-teal">${escapeHtml(n.authorName || 'Unknown')}</span>
        <span class="text-[10px] text-slate-400 font-mono">${formatDateOnly(n.commentsts)}</span>
      </div>
      <div class="text-xs text-hitt-ink whitespace-pre-wrap">${escapeHtml(n.notes)}</div>
    </div>
  `).join('');
}

function closeProjectModal(){
  modalOverlay.classList.add('hidden');
  document.body.style.overflow = '';
  activeProjectId = null;
}

document.getElementById('mClose').addEventListener('click', closeProjectModal);
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeProjectModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) closeProjectModal();
  if (e.key === 'Escape' && !newProjectOverlay.classList.contains('hidden')) closeNewProjectModal();
});

document.getElementById('mSave').addEventListener('click', async () => {
  const p = PROJECTS.find(x => x.id === activeProjectId);
  if (!p) return;
  const newStatus = Number(document.getElementById('mStatus').value);
  const newProgress = Number(document.getElementById('mProgress').value) || 0;
  const statusChanged = newStatus !== p.stage;
  p.stage = newStatus;
  p.progress = newProgress;

  const entityVal = document.getElementById('mEntity').value;
  const projectTypeVal = document.getElementById('mProjectType').value;
  const bioSpectrumVal = document.getElementById('mBioSpectrum').value;
  const extraFields = {
    entityId: entityVal ? Number(entityVal) : null,
    projectTypeId: projectTypeVal ? Number(projectTypeVal) : null,
    biospectrumId: bioSpectrumVal ? Number(bioSpectrumVal) : null,
    bpRunningName: document.getElementById('mBPRunningName').value || null,
    notInvoiceable: document.getElementById('mNotInvoiceable').checked,
  };

  document.getElementById('mChangedBadge').classList.add('hidden');
  renderBoard();
  updateTabCounts();
  closeProjectModal();

  if (!usingDemoData) {
    try {
      await HITT_API.updateProject(p.id, { stage: newStatus, progress: newProgress, ...extraFields });
      toast(`<span class="font-mono text-xs opacity-80">${escapeHtml(p.code)}</span> saved${statusChanged ? ' · status updated' : ''}`, 'green');
    } catch (err) {
      console.error(err);
      toast(`Could not save changes for <span class="font-mono text-xs">${escapeHtml(p.code)}</span>`, 'red');
    }
  } else {
    toast(`<span class="font-mono text-xs opacity-80">${escapeHtml(p.code)}</span> saved locally (demo data)`, 'green');
  }
});

document.querySelectorAll('[data-mtab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-mtab]').forEach(b => b.setAttribute('aria-selected', 'false'));
    btn.setAttribute('aria-selected', 'true');
    document.getElementById('paneGeneral').classList.toggle('hidden', btn.dataset.mtab !== 'general');
    document.getElementById('paneBudget').classList.toggle('hidden', btn.dataset.mtab !== 'budget');
  });
});

document.getElementById('mAddNote').addEventListener('click', async () => {
  const input = document.getElementById('mNewNote');
  const text = input.value.trim();
  if (!text || !activeProjectId) return;
  if (usingDemoData) {
    toast('Notes aren\'t available in demo data.', 'navy');
    return;
  }
  try {
    await HITT_API.addProjectNote(activeProjectId, { notes: text });
    input.value = '';
    const notes = await HITT_API.getProjectNotes(activeProjectId);
    renderNotes(notes);
    toast('Note added', 'green');
  } catch (err) {
    console.error(err);
    toast('Could not save the note.', 'red');
  }
});

document.getElementById('mNewNote').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('mAddNote').click();
});
document.getElementById('mNewDeliverableName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('mAddDeliverable').click();
});

document.getElementById('mAddDeliverable').addEventListener('click', async () => {
  const nameInput = document.getElementById('mNewDeliverableName');
  const dateInput = document.getElementById('mNewDeliverableExpected');
  const name = nameInput.value.trim();
  if (!name || !activeProjectId) return;
  if (usingDemoData) {
    toast('Deliverables aren\'t available in demo data.', 'navy');
    return;
  }
  try {
    await HITT_API.addProjectDeliverable(activeProjectId, {
      deliverablename: name,
      deliverydate: dateInput.value || null,
    });
    nameInput.value = '';
    dateInput.value = '';
    const deliverables = await HITT_API.getProjectDeliverables(activeProjectId);
    renderDeliverables(deliverables);
    toast('Deliverable added', 'green');
  } catch (err) {
    console.error(err);
    toast('Could not save the deliverable.', 'red');
  }
});

/* ============================== NEW PROJECT MODAL ======================= */
const newProjectOverlay = document.getElementById('newProjectOverlay');
const NP_PLACEHOLDER = 'Type here the name…';

function nextProjectNumber(){
  const year = new Date().getFullYear();
  const yy = String(year).slice(2);
  const codes = PROJECTS.map(p => parseInt(p.code, 10)).filter(n => !isNaN(n) && String(n).startsWith(yy));
  const max = codes.length ? Math.max(...codes) : Number(yy) * 1000;
  return max + 1;
}

function openNewProjectModal(){
  document.getElementById('npName').value = NP_PLACEHOLDER;
  document.getElementById('npYear').textContent = new Date().getFullYear();
  document.getElementById('npNumber').textContent = nextProjectNumber();
  document.getElementById('npProgress').value = 0;

  const statusSel = document.getElementById('npStatus');
  statusSel.innerHTML = STAGES.filter(s => s.set === 'alive')
    .map(s => `<option value="${s.id}" ${s.id===0?'selected':''}>${s.label}</option>`).join('');

  const nameInput = document.getElementById('npName');
  nameInput.addEventListener('focus', function selectPlaceholder(){
    if (this.value === NP_PLACEHOLDER) this.select();
  }, { once: true });

  newProjectOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  setTimeout(() => nameInput.focus(), 50);
}

function closeNewProjectModal(){
  newProjectOverlay.classList.add('hidden');
  document.body.style.overflow = '';
}

document.getElementById('btnNewProject').addEventListener('click', openNewProjectModal);
document.getElementById('npClose').addEventListener('click', closeNewProjectModal);
document.getElementById('npCancel').addEventListener('click', closeNewProjectModal);
newProjectOverlay.addEventListener('click', (e) => { if (e.target === newProjectOverlay) closeNewProjectModal(); });

document.getElementById('npSave').addEventListener('click', async () => {
  const name = document.getElementById('npName').value.trim();
  const status = Number(document.getElementById('npStatus').value);
  const progress = Number(document.getElementById('npProgress').value) || 0;

  if (!name || name === NP_PLACEHOLDER) {
    toast(`Missing required data: <b>Project name</b>`, 'red');
    return;
  }

  const code = String(document.getElementById('npNumber').textContent);

  if (usingDemoData) {
    PROJECTS.push({ id: idCounter++, code, name, stage: status, progress });
    renderBoard();
    updateTabCounts();
    toast(`<span class="font-mono text-xs opacity-80">${code}</span> project <b>created</b> (demo data)`, 'green');
    closeNewProjectModal();
    return;
  }

  try {
    const created = await HITT_API.createProject({ code, name, stage: status, progress });
    PROJECTS.push({
      id: created.id ?? idCounter++,
      code: created.code ?? code,
      name: created.name ?? name,
      stage: Number(created.stage ?? status),
      progress: Number(created.progress ?? progress),
    });
    renderBoard();
    updateTabCounts();
    toast(`<span class="font-mono text-xs opacity-80">${code}</span> project <b>created</b>`, 'green');
    closeNewProjectModal();
  } catch (err) {
    console.error(err);
    toast('Could not create the project on the server.', 'red');
  }
});

/* ============================== EVENTS ================================= */
document.querySelectorAll('[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach(b => b.setAttribute('aria-selected', 'false'));
    btn.setAttribute('aria-selected', 'true');
    currentTab = btn.dataset.tab;
    renderBoard();
  });
});

const searchBox = document.getElementById('searchBox');
const clearBtn = document.getElementById('clearSearch');
searchBox.addEventListener('input', () => {
  searchTerm = searchBox.value.trim();
  clearBtn.classList.toggle('hidden', searchTerm.length === 0);
  renderBoard();
  updateTabCounts();
});
clearBtn.addEventListener('click', () => {
  searchBox.value = '';
  searchTerm = '';
  clearBtn.classList.add('hidden');
  renderBoard();
  updateTabCounts();
  searchBox.focus();
});

document.getElementById('btnRefresh').addEventListener('click', () => {
  toast('Refreshing…', 'navy');
  loadProjects();
});

/* ============================== INIT ==================================== */
loadProjects();
