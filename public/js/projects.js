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

// Resolved once and reused for stage-change calls so
// projectstatushistory.changedby (and lastupdatedby) actually records who
// made the change, instead of always landing NULL — neither
// updateProjectStage nor updateProject passed an employeeId before this.
let currentEmployeeId = null;
HITT_PERMS.get().then((perms) => { currentEmployeeId = perms.employeeId; }).catch(() => {});

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
    // Number(), not the raw row.id: the API serializes it as a string, but
    // PROJECTS[].stage below is coerced to a number, and renderBoard()
    // matches the two with strict equality — a string/number mismatch here
    // made every column filter to empty even with real data loaded.
    return { id: Number(row.id), label: row.label, ...style };
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
let EMPLOYEES = []; // not-deactivated employees — GET /api/employees already filters. Owner + Resources pickers.
let usingDemoData = false;
let currentTab = 'alive';
let searchTerm = '';
let activeProjectId = null;
let activeBusinessPartnerId = null;
let npBusinessPartnerId = null; // draft BP pick for the New Project modal — see assignBusinessPartner()
let idCounter = 1000;

/* ============================== ICONS ================================= */
function iconLead(){ return `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M4 4h16l-6 8v6l-4 2v-8L4 4z"/></svg>`; }
function iconRFP(){ return `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="3" width="16" height="18" rx="1.5"/><path stroke-linecap="round" d="M8 8h8M8 12h8M8 16h5"/></svg>`; }
function iconWon(){ return `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M12 2L4 6v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V6l-8-4z"/></svg>`; }
function iconWIP(){ return `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M10.3 4.3a2 2 0 013.4 0l.4.7a2 2 0 001.6 1l.8-.1a2 2 0 012.2 2.2l-.1.8a2 2 0 001 1.6l.7.4a2 2 0 010 3.4l-.7.4a2 2 0 00-1 1.6l.1.8a2 2 0 01-2.2 2.2l-.8-.1a2 2 0 00-1.6 1l-.4.7a2 2 0 01-3.4 0l-.4-.7a2 2 0 00-1.6-1l-.8.1a2 2 0 01-2.2-2.2l.1-.8a2 2 0 00-1-1.6l-.7-.4a2 2 0 010-3.4l.7-.4a2 2 0 001-1.6l-.1-.8a2 2 0 012.2-2.2l.8.1a2 2 0 001.6-1l.4-.7z"/><circle cx="12" cy="12" r="3"/></svg>`; }
function iconDelivered(){ return `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8l9-5 9 5-9 5-9-5z"/><path stroke-linecap="round" stroke-linejoin="round" d="M3 8v8l9 5 9-5V8M12 13v8"/></svg>`; }
function iconClosed(){ return `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="10" width="16" height="10" rx="1.5"/><path stroke-linecap="round" stroke-linejoin="round" d="M8 10V7a4 4 0 118 0v3"/></svg>`; }
function iconCancelled(){ return `<svg viewBox="0 0 24 24" class="w-4 h-4" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path stroke-linecap="round" d="M8.5 8.5l7 7M15.5 8.5l-7 7"/></svg>`; }

// Kanban card badges — not invoiceable (a definite state, solid+slash),
// missing budget / missing business partner (an absence, dashed outline —
// same "dashed = not set yet" visual language for both).
function iconNotInvoiceable(){
  return `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="1.8">
    <circle cx="12" cy="12" r="9"/>
    <text x="12" y="15.5" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor" stroke="none">€</text>
    <path stroke-linecap="round" d="M5.5 18.5l13-13"/>
  </svg>`;
}
function iconMissingBudget(){
  return `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="1.8">
    <circle cx="12" cy="12" r="9" stroke-dasharray="3 2.3"/>
    <text x="12" y="15.5" text-anchor="middle" font-size="10" font-weight="700" fill="currentColor" stroke="none">€</text>
  </svg>`;
}
function iconMissingBP(){
  return `<svg viewBox="0 0 24 24" class="w-3.5 h-3.5" fill="none" stroke="currentColor" stroke-width="1.8">
    <rect x="4" y="8" width="16" height="12" rx="1.5" stroke-dasharray="3 2.3"/>
    <path d="M9 8V6a3 3 0 016 0v2"/>
  </svg>`;
}
function cardBadgesHtml(p){
  const badges = [];
  if (p.notInvoiceable) badges.push(`<span class="text-hitt-red" title="Not invoiceable">${iconNotInvoiceable()}</span>`);
  if (!p.hasBudget) badges.push(`<span class="text-hitt-amber" title="Missing budget">${iconMissingBudget()}</span>`);
  if (!p.hasBusinessPartner) badges.push(`<span class="text-hitt-amber" title="Missing business partner">${iconMissingBP()}</span>`);
  return badges.length ? `<div class="flex items-center gap-1 shrink-0">${badges.join('')}</div>` : '';
}

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
    try {
      EMPLOYEES = await HITT_API.getEmployees(); // already excludes deactivated
    } catch (empErr) {
      console.warn("Could not load employees (owner/resource pickers):", empErr);
    }
    const data = await HITT_API.getProjects();
    // Expected shape from GET /api/projects: [{ id, code, name, stage, progress }]
    PROJECTS = data.map(p => ({
      id: p.id,
      code: p.code ?? String(p.projectId ?? p.id),
      name: p.name ?? p.projectName ?? "(unnamed project)",
      stage: Number(p.stage ?? p.prjStatusId ?? 0),
      progress: Number(p.progress ?? 0),
      notInvoiceable: !!p.notInvoiceable,
      hasBusinessPartner: !!p.hasBusinessPartner,
      hasBudget: !!p.hasBudget,
      ownerId: p.ownerId ?? null,
      ownerName: p.ownerName ?? null,
    }));
    populateOwnerFilterOptions();
    usingDemoData = false;
  } catch (err) {
    console.warn("Falling back to demo data — could not reach API:", err);
    PROJECTS = structuredClone(DEMO_SEED);
    usingDemoData = true;
  }
  setDataSourcePill();
  renderBoard();
  updateTabCounts();
  loadKanbanInsights();
}

/* ============================== KANBAN INSIGHTS ========================= */
function kiMoney(n){
  if (n === null || n === undefined) return '—';
  return Number(n).toLocaleString(undefined, { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 });
}

async function loadKanbanInsights(){
  const readyHost = document.getElementById('kiReadyToClose');
  const staleHost = document.getElementById('kiStale');
  if (!readyHost || !staleHost) return;
  if (usingDemoData) {
    readyHost.innerHTML = staleHost.innerHTML = `<div class="ki-empty">Not available in demo data</div>`;
    return;
  }
  readyHost.innerHTML = staleHost.innerHTML = `<div class="ki-empty">Loading…</div>`;
  let data;
  try {
    data = await HITT_API.getProjectAttention();
  } catch (err) {
    console.warn('Could not load kanban insights:', err);
    readyHost.innerHTML = staleHost.innerHTML = `<div class="ki-empty">Could not load</div>`;
    ['kiReadyCount', 'kiStaleCount'].forEach(id => { const el = document.getElementById(id); if (el) el.textContent = ''; });
    return;
  }
  renderKiList(readyHost, data.readyToClose, (p) =>
    `${kiMoney(p.invoicedTotal)} invoiced / ${kiMoney(p.budget)} budget`, document.getElementById('kiReadyCount'));
  renderKiList(staleHost, data.stale, (p) => {
    const opened = p.entryDate ? new Date(p.entryDate).toLocaleDateString() : '—';
    const changed = p.lastStatusChangeAt
      ? `last change ${new Date(p.lastStatusChangeAt).toLocaleDateString()}`
      : 'no status change logged';
    return `${escapeHtml(p.statusLabel || '')} · opened ${opened} · ${changed}`;
  }, document.getElementById('kiStaleCount'));
}

function renderKiList(host, rows, metaFn, countEl){
  if (countEl) countEl.textContent = `(${rows ? rows.length : 0})`;
  if (!rows || !rows.length) {
    host.innerHTML = `<div class="ki-empty">Nothing right now</div>`;
    return;
  }
  host.innerHTML = rows.map(p => `
    <button class="ki-item" data-project-id="${escapeHtml(String(p.id))}">
      <span class="ki-item-code">${escapeHtml(p.code || '')}</span>
      <span class="ki-item-name">${escapeHtml(p.name || '(unnamed)')}</span>
      <span class="ki-item-meta">${metaFn(p)}</span>
    </button>
  `).join('');
  host.querySelectorAll('.ki-item').forEach(btn => {
    btn.addEventListener('click', () => openProjectModal(btn.dataset.projectId));
  });
}

// Collapsible insight sections — state persisted per section in
// localStorage (best-effort; a private window / blocked storage just
// means sections always start expanded).
(function initKiCollapse(){
  const aside = document.getElementById('kanbanInsights');
  if (!aside) return;
  const KEY = 'hitt.kanbanInsights.collapsed';
  let stored = {};
  try { stored = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { stored = {}; }
  aside.querySelectorAll('.ki-section').forEach(sec => {
    if (stored[sec.dataset.kiKey]) {
      sec.classList.add('is-collapsed');
      sec.querySelector('.ki-head')?.setAttribute('aria-expanded', 'false');
    }
  });
  aside.addEventListener('click', (e) => {
    const head = e.target.closest('.ki-head');
    if (!head) return;
    const sec = head.closest('.ki-section');
    const collapsed = sec.classList.toggle('is-collapsed');
    head.setAttribute('aria-expanded', String(!collapsed));
    try {
      stored[sec.dataset.kiKey] = collapsed;
      localStorage.setItem(KEY, JSON.stringify(stored));
    } catch { /* storage unavailable — collapse still works for this session */ }
  });
})();

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

// Filters panel state (search stays separate — the search box already has
// its own always-visible input). ownerId filters against p.ownerId once
// that's wired in (see the Project Owner follow-up).
const FILTERS = { ownerId: '', notInvoiceable: false, noBudget: false, progressMin: null, progressMax: null };

function matchesFilters(p){
  if (!matchesSearch(p)) return false;
  if (FILTERS.ownerId && String(p.ownerId ?? '') !== FILTERS.ownerId) return false;
  if (FILTERS.notInvoiceable && !p.notInvoiceable) return false;
  if (FILTERS.noBudget && p.hasBudget) return false;
  const progress = p.progress ?? 0;
  if (FILTERS.progressMin != null && progress < FILTERS.progressMin) return false;
  if (FILTERS.progressMax != null && progress > FILTERS.progressMax) return false;
  return true;
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
    const items = PROJECTS.filter(p => p.stage === stage.id && matchesFilters(p))
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
          <div class="flex items-center gap-1 min-w-0">
            <span class="font-mono text-[10px] font-bold text-hitt-teal tracking-tight">${escapeHtml(p.code)}</span>
            ${cardBadgesHtml(p)}
          </div>
          <div class="flex flex-col items-center gap-0.5 shrink-0">
            <span class="text-[10px] font-mono text-slate-400">${p.progress ?? 0}%</span>
            ${p.ownerName ? `<span class="w-5 h-5 rounded-full flex items-center justify-center text-white font-bold" style="background:${ownerColor(p.ownerId)}; font-size:8px; line-height:1;" title="${escapeHtml(p.ownerName)}">${ownerInitials(p.ownerName)}</span>` : ''}
          </div>
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
    // Not Number(): PROJECTS[].id is deliberately kept as the raw
    // stringified-bigint the API returns (see the INIT deep-link comment
    // below), and moveProject()'s PROJECTS.find(x => x.id === id) needs
    // the same type — Number() here made every drop silently no-op.
    const id = e.dataTransfer.getData('text/plain');
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
      await HITT_API.updateProjectStage(id, targetStageId, currentEmployeeId);
      loadKanbanInsights();
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
  const alive = PROJECTS.filter(p => aliveIds.includes(p.stage) && matchesFilters(p)).length;
  const closed = PROJECTS.filter(p => closedIds.includes(p.stage) && matchesFilters(p)).length;
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

// EMPLOYEES rows are { id, username, emailid, name } (GET /api/employees,
// already excludes deactivated) — reused for both the Owner picker and
// the Resources tab's employee picker.
function employeeOptionsHtml(selectedId, includeBlank){
  const opts = (includeBlank ? [`<option value="">—</option>`] : [])
    .concat(EMPLOYEES.map(e => `<option value="${e.id}" ${String(e.id)===String(selectedId)?'selected':''}>${escapeHtml(e.name)}</option>`));
  return opts.join('');
}

function populateOwnerFilterOptions(){
  const sel = document.getElementById('filterOwner');
  const current = sel.value;
  const owners = new Map();
  PROJECTS.forEach(p => { if (p.ownerId) owners.set(String(p.ownerId), p.ownerName || `#${p.ownerId}`); });
  const sorted = [...owners.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  sel.innerHTML = `<option value="">Any owner</option>` +
    sorted.map(([id, name]) => `<option value="${id}">${escapeHtml(name)}</option>`).join('');
  if ([...owners.keys()].includes(current)) sel.value = current;
}

// Initials for the kanban card badge — "Oriol Solà" -> "OS". Matches
// HITT_AUTH.initials()'s approach (first letter of up to the first two
// words) so this app has one consistent initials convention.
function ownerInitials(name){
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  return parts.slice(0, 2).map(p => p[0]?.toUpperCase() ?? '').join('');
}

// Deterministic colour per owner (same id always gets the same colour),
// picked from a small fixed palette so it stays legible with white text
// rather than a fully random hue.
const OWNER_COLORS = ['#5C757C', '#BC9A1C', '#6E8F5A', '#B24A3A', '#7C5C9C', '#3D7A8C', '#9C6E3D', '#4A6B8A'];
function ownerColor(id){
  if (!id) return '#8A8676';
  let hash = 0;
  for (const ch of String(id)) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return OWNER_COLORS[hash % OWNER_COLORS.length];
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
  document.getElementById('mTitle').value = p.name;
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
  document.getElementById('mOwner').innerHTML = employeeOptionsHtml(p.ownerId, true);
  document.getElementById('mNewResourceEmployee').innerHTML = employeeOptionsHtml(null, true);
  document.getElementById('mNewResourceAmount').value = 50;
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
    `<tr><td colspan="4" class="px-2.5 py-4 text-center text-slate-400 text-xs">${usingDemoData ? 'Not available in demo data' : 'Loading…'}</td></tr>`;
  document.getElementById('mQuotations').innerHTML =
    `<tr><td colspan="5" class="px-2.5 py-4 text-center text-slate-400 text-xs">${usingDemoData ? 'Not available in demo data' : 'Loading…'}</td></tr>`;
  document.getElementById('mNotesList').innerHTML =
    `<div class="text-xs text-slate-400 text-center py-6">${usingDemoData ? 'Not available in demo data' : 'Loading…'}</div>`;
  document.getElementById('historyList').innerHTML =
    `<div class="text-xs text-slate-400 text-center py-6">${usingDemoData ? 'Not available in demo data' : 'Loading…'}</div>`;
  document.getElementById('mResources').innerHTML =
    `<tr><td colspan="3" class="px-2.5 py-4 text-center text-slate-400 text-xs">${usingDemoData ? 'Not available in demo data' : 'Loading…'}</td></tr>`;
  cancelEditDeliverable(); // clears the deliverable form + edit state from any previous project
  ['mNewQuotationDate', 'mNewQuotationAmount', 'mNewQuotationDiscount', 'mNewQuotationExpenses', 'mNewQuotationFinal']
    .forEach(id2 => document.getElementById(id2).value = '');
  document.getElementById('mNewNote').value = '';
  document.getElementById('mNotesSearch').value = '';
  notesSearchTerm = '';
  NOTES = [];

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
      document.getElementById('mOwner').innerHTML = employeeOptionsHtml(detail.ownerId, true);
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

    try {
      const history = await HITT_API.getProjectHistory(id);
      if (activeProjectId !== id) return;
      renderHistory(history);
    } catch (err) {
      console.warn(`Could not load history for project ${id}:`, err);
      document.getElementById('historyList').innerHTML = `<div class="text-xs text-slate-400 text-center py-6">Could not load history</div>`;
    }

    try {
      const resources = await HITT_API.getProjectResources(id);
      if (activeProjectId !== id) return;
      renderResources(resources);
    } catch (err) {
      console.warn(`Could not load resources for project ${id}:`, err);
      document.getElementById('mResources').innerHTML = `<tr><td colspan="3" class="px-2.5 py-4 text-center text-slate-400 text-xs">Could not load resources</td></tr>`;
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
// Which UI assignBusinessPartner() below should update: the open project
// modal (persists immediately via the API, like before), or the New
// Project modal's own draft state (no project exists yet to assign to —
// just remembers the pick locally until npSave creates the project).
let bpPickerTarget = 'project';

function openBpPicker(target){
  bpPickerTarget = target || 'project';
  if (bpPickerTarget === 'project' && !activeProjectId) return;
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
  if (bpPickerTarget === 'newProject') {
    npBusinessPartnerId = bpId;
    document.getElementById('npBusinessPartner').textContent = bpName || '—';
    closeBpPicker();
    toast(`<span class="font-mono text-xs opacity-80">${escapeHtml(bpName || '')}</span> will be assigned once the project is created`, 'green');
    return;
  }
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

document.getElementById('mBPSearch').addEventListener('click', () => openBpPicker('project'));
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

function formatDateTime(iso){
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

let DELIVERABLES = [];
let editingDeliverableId = null;

function startEditDeliverable(id){
  const d = DELIVERABLES.find(x => x.id === id);
  if (!d) return;
  editingDeliverableId = id;
  document.getElementById('mNewDeliverableExpected').value = d.deliverydate ? d.deliverydate.slice(0, 10) : '';
  document.getElementById('mNewDeliverableEffective').value = d.effectivedd ? d.effectivedd.slice(0, 10) : '';
  document.getElementById('mNewDeliverableName').value = d.deliverablename || '';
  document.getElementById('mAddDeliverable').textContent = 'Save';
  document.getElementById('mNewDeliverableName').focus();
}

function cancelEditDeliverable(){
  editingDeliverableId = null;
  document.getElementById('mNewDeliverableExpected').value = '';
  document.getElementById('mNewDeliverableEffective').value = '';
  document.getElementById('mNewDeliverableName').value = '';
  document.getElementById('mAddDeliverable').textContent = 'Add';
}

async function deleteDeliverable(id){
  const d = DELIVERABLES.find(x => x.id === id);
  if (!d || !confirm(`Delete deliverable "${d.deliverablename || '(unnamed)'}"? This cannot be undone.`)) return;
  try {
    await HITT_API.deleteProjectDeliverable(activeProjectId, id);
    if (editingDeliverableId === id) cancelEditDeliverable();
    const deliverables = await HITT_API.getProjectDeliverables(activeProjectId);
    renderDeliverables(deliverables);
    toast('Deliverable deleted', 'navy');
  } catch (err) {
    console.error(err);
    toast('Could not delete the deliverable.', 'red');
  }
}

function renderDeliverables(rows){
  DELIVERABLES = rows || [];
  const tbody = document.getElementById('mDeliverables');
  if (!rows || !rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="px-2.5 py-4 text-center text-slate-400 text-xs">No deliverables yet</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(d => `
    <tr class="grid-row border-t border-slate-100">
      <td class="px-2.5 py-1.5 font-mono">${formatDateOnly(d.deliverydate)}</td>
      <td class="px-2.5 py-1.5 font-mono">${formatDateOnly(d.effectivedd)}</td>
      <td class="px-2.5 py-1.5">${escapeHtml(d.deliverablename || '(unnamed)')}</td>
      <td class="px-2.5 py-1.5 text-right whitespace-nowrap">
        <button data-edit-deliverable="${d.id}" title="Edit this deliverable" class="w-6 h-6 rounded hover:bg-hitt-mist text-hitt-teal inline-flex items-center justify-center">✎</button>
        <button data-delete-deliverable="${d.id}" title="Delete this deliverable" class="w-6 h-6 rounded hover:bg-hitt-mist text-hitt-red inline-flex items-center justify-center">✕</button>
      </td>
    </tr>
  `).join('');
  tbody.querySelectorAll('[data-edit-deliverable]').forEach(btn => {
    btn.addEventListener('click', () => startEditDeliverable(btn.dataset.editDeliverable));
  });
  tbody.querySelectorAll('[data-delete-deliverable]').forEach(btn => {
    btn.addEventListener('click', () => deleteDeliverable(btn.dataset.deleteDeliverable));
  });
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

function renderResources(rows){
  const tbody = document.getElementById('mResources');
  if (!rows || !rows.length) {
    tbody.innerHTML = `<tr><td colspan="3" class="px-2.5 py-4 text-center text-slate-400 text-xs">No resources assigned yet</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr class="grid-row border-t border-slate-100">
      <td class="px-2.5 py-1.5">${escapeHtml(r.employeeName || '—')}</td>
      <td class="px-2.5 py-1.5 text-right">
        <input type="number" min="0" max="100" value="${r.amount ?? 50}" data-resource-amount="${r.id}"
          class="field-input" style="width:5rem; text-align:right; display:inline-block; padding-top:0.3rem; padding-bottom:0.3rem;" />
      </td>
      <td class="px-2.5 py-1.5 text-right">
        <button data-delete-resource="${r.id}" title="Remove this resource" class="w-6 h-6 rounded hover:bg-hitt-mist text-hitt-red inline-flex items-center justify-center">✕</button>
      </td>
    </tr>
  `).join('');
  tbody.querySelectorAll('[data-resource-amount]').forEach(input => {
    let original = input.value;
    input.addEventListener('focus', () => { original = input.value; });
    input.addEventListener('change', async () => {
      const rowId = input.dataset.resourceAmount;
      const amount = input.value;
      if (amount === original) return;
      try {
        await HITT_API.updateProjectResource(activeProjectId, rowId, { amount, employeeId: currentEmployeeId });
        original = amount;
        renderHistory(await HITT_API.getProjectHistory(activeProjectId));
        toast('Workload updated', 'green');
      } catch (err) {
        console.error(err);
        input.value = original;
        toast('Could not update the workload.', 'red');
      }
    });
  });
  tbody.querySelectorAll('[data-delete-resource]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const rowId = btn.dataset.deleteResource;
      if (!confirm('Remove this resource from the project?')) return;
      try {
        await HITT_API.deleteProjectResource(activeProjectId, rowId, currentEmployeeId);
        renderResources(await HITT_API.getProjectResources(activeProjectId));
        renderHistory(await HITT_API.getProjectHistory(activeProjectId));
        toast('Resource removed', 'navy');
      } catch (err) {
        console.error(err);
        toast('Could not remove the resource.', 'red');
      }
    });
  });
}

document.getElementById('mAddResource').addEventListener('click', async () => {
  if (!activeProjectId) return;
  if (usingDemoData) {
    toast('Resources aren\'t available in demo data.', 'navy');
    return;
  }
  const employeeSel = document.getElementById('mNewResourceEmployee');
  const amountInput = document.getElementById('mNewResourceAmount');
  const resourceId = employeeSel.value;
  if (!resourceId) {
    toast('Pick an employee first.', 'red');
    return;
  }
  try {
    await HITT_API.addProjectResource(activeProjectId, {
      resourceId, amount: amountInput.value || 50, employeeId: currentEmployeeId,
    });
    employeeSel.value = '';
    amountInput.value = 50;
    renderResources(await HITT_API.getProjectResources(activeProjectId));
    renderHistory(await HITT_API.getProjectHistory(activeProjectId));
    toast('Resource added', 'green');
  } catch (err) {
    console.error(err);
    toast('Could not add the resource.', 'red');
  }
});

let NOTES = [];
let notesSearchTerm = '';

function matchesNotesSearch(n){
  if (!notesSearchTerm) return true;
  const term = notesSearchTerm.toLowerCase();
  return (n.notes || '').toLowerCase().includes(term) || (n.authorName || '').toLowerCase().includes(term);
}

// Called both with fresh rows (a real fetch — replaces the stored set)
// and with no argument at all (the search box's own input handler —
// just re-filters/re-renders whatever's already loaded).
function renderNotes(rows){
  if (rows) NOTES = rows;
  const list = document.getElementById('mNotesList');
  const filtered = NOTES.filter(matchesNotesSearch);
  if (!filtered.length) {
    list.innerHTML = `<div class="text-xs text-slate-400 text-center py-6">${NOTES.length ? 'No notes match your search' : 'No notes yet'}</div>`;
    return;
  }
  list.innerHTML = filtered.map(n => `
    <div class="border border-slate-100 rounded-md p-2 bg-hitt-canvas">
      <div class="flex items-center justify-between gap-2 mb-1">
        <span class="text-[11px] font-semibold text-hitt-teal">${escapeHtml(n.authorName || 'Unknown')}</span>
        <span class="text-[10px] text-slate-400 font-mono">${formatDateTime(n.commentsts)}</span>
      </div>
      <div class="text-xs text-hitt-ink whitespace-pre-wrap">${escapeHtml(n.notes)}</div>
    </div>
  `).join('');
}

// GET /api/projects/:id/history returns two row shapes, merged: type
// 'status' (from projectstatushistory — oldStatusId == null is a
// defensive fallback, not something the current data model produces) and
// type 'change' (from projectchangelog — every other field edit, already
// a human-readable summary built server-side in the PATCH handlers).
function renderHistory(rows){
  const list = document.getElementById('historyList');
  if (!rows || !rows.length) {
    list.innerHTML = `<div class="text-xs text-slate-400 text-center py-6">No history yet</div>`;
    return;
  }
  list.innerHTML = rows.map(h => `
    <div class="border border-slate-100 rounded-md p-2 bg-hitt-canvas">
      <div class="text-xs text-hitt-ink">
        ${h.type === 'status'
          ? (h.oldStatusId == null
              ? `Created${h.newStatusLabel ? ` as <b>${escapeHtml(h.newStatusLabel)}</b>` : ''}`
              : `<b>${escapeHtml(h.oldStatusLabel || '—')}</b> → <b>${escapeHtml(h.newStatusLabel || '—')}</b>`)
          : escapeHtml(h.summary || '')}
      </div>
      <div class="flex items-center justify-between gap-2 mt-1">
        <span class="text-[10px] font-semibold text-hitt-teal">${escapeHtml(h.changedByName || 'Unknown')}</span>
        <span class="text-[10px] text-slate-400 font-mono">${formatDateTime(h.changedAt)}</span>
      </div>
    </div>
  `).join('');
}

const historyPanel = document.getElementById('historyPanel');
const historyCollapseBtn = document.getElementById('historyCollapse');
let historyCollapsed = false;
// Direct inline-style toggle rather than a CSS class + !important — the
// class approach toggled correctly (button icon flipped) but visually
// failed to collapse for at least one real user despite testing clean in
// isolation, so this sidesteps whatever cascade/caching quirk was in the
// way instead of chasing it further.
historyCollapseBtn.addEventListener('click', () => {
  historyCollapsed = !historyCollapsed;
  historyPanel.style.width = historyCollapsed ? '0px' : '300px';
  historyPanel.style.borderLeft = historyCollapsed ? 'none' : '';
  historyCollapseBtn.textContent = historyCollapsed ? '«' : '»';
  historyCollapseBtn.title = historyCollapsed ? 'Expand history' : 'Collapse history';
});

function closeProjectModal(){
  modalOverlay.classList.add('hidden');
  document.body.style.overflow = '';
  activeProjectId = null;
  cancelEditDeliverable();
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
  const newName = document.getElementById('mTitle').value.trim();
  if (!newName) {
    toast(`Missing required data: <b>Project name</b>`, 'red');
    return;
  }
  const entityVal = document.getElementById('mEntity').value;
  if (!entityVal) {
    toast(`Missing required data: <b>Entity</b>`, 'red');
    return;
  }
  const newStatus = Number(document.getElementById('mStatus').value);
  const newProgress = Number(document.getElementById('mProgress').value) || 0;
  const statusChanged = newStatus !== p.stage;
  p.name = newName;
  p.stage = newStatus;
  p.progress = newProgress;

  const projectTypeVal = document.getElementById('mProjectType').value;
  const bioSpectrumVal = document.getElementById('mBioSpectrum').value;
  const ownerVal = document.getElementById('mOwner').value;
  const extraFields = {
    name: newName,
    entityId: entityVal ? Number(entityVal) : null,
    projectTypeId: projectTypeVal ? Number(projectTypeVal) : null,
    biospectrumId: bioSpectrumVal ? Number(bioSpectrumVal) : null,
    bpRunningName: document.getElementById('mBPRunningName').value || null,
    notInvoiceable: document.getElementById('mNotInvoiceable').checked,
    ownerId: ownerVal ? Number(ownerVal) : null,
  };
  p.ownerId = extraFields.ownerId;
  p.ownerName = ownerVal ? (EMPLOYEES.find(e => String(e.id) === ownerVal)?.name ?? null) : null;
  // Keep the card badges in sync without a full reload — the "not
  // invoiceable" badge otherwise only appeared after F5.
  p.notInvoiceable = extraFields.notInvoiceable;

  document.getElementById('mChangedBadge').classList.add('hidden');
  renderBoard();
  updateTabCounts();
  populateOwnerFilterOptions();
  closeProjectModal();

  if (!usingDemoData) {
    try {
      await HITT_API.updateProject(p.id, { stage: newStatus, progress: newProgress, employeeId: currentEmployeeId, ...extraFields });
      loadKanbanInsights();
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
    document.getElementById('paneResources').classList.toggle('hidden', btn.dataset.mtab !== 'resources');
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
    await HITT_API.addProjectNote(activeProjectId, { notes: text, employeeId: currentEmployeeId });
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
document.getElementById('mNotesSearch').addEventListener('input', (e) => {
  notesSearchTerm = e.target.value.trim();
  renderNotes();
});
document.getElementById('mNewDeliverableName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('mAddDeliverable').click();
  if (e.key === 'Escape' && editingDeliverableId) cancelEditDeliverable();
});

document.getElementById('mAddDeliverable').addEventListener('click', async () => {
  const nameInput = document.getElementById('mNewDeliverableName');
  const dateInput = document.getElementById('mNewDeliverableExpected');
  const effectiveInput = document.getElementById('mNewDeliverableEffective');
  const name = nameInput.value.trim();
  if (!name || !activeProjectId) return;
  if (usingDemoData) {
    toast('Deliverables aren\'t available in demo data.', 'navy');
    return;
  }
  const editingId = editingDeliverableId;
  try {
    if (editingId) {
      await HITT_API.updateProjectDeliverable(activeProjectId, editingId, {
        deliverablename: name,
        deliverydate: dateInput.value || null,
        effectivedd: effectiveInput.value || null,
      });
    } else {
      await HITT_API.addProjectDeliverable(activeProjectId, {
        deliverablename: name,
        deliverydate: dateInput.value || null,
        effectivedd: effectiveInput.value || null,
      });
    }
    cancelEditDeliverable(); // also clears the inputs
    const deliverables = await HITT_API.getProjectDeliverables(activeProjectId);
    renderDeliverables(deliverables);
    toast(editingId ? 'Deliverable updated' : 'Deliverable added', 'green');
  } catch (err) {
    console.error(err);
    toast(`Could not ${editingId ? 'update' : 'save'} the deliverable.`, 'red');
  }
});

document.getElementById('mAddQuotation').addEventListener('click', async () => {
  if (!activeProjectId) return;
  if (usingDemoData) {
    toast('Quotations aren\'t available in demo data.', 'navy');
    return;
  }
  const amount = document.getElementById('mNewQuotationAmount').value;
  const date = document.getElementById('mNewQuotationDate').value;
  if (!amount && !date) {
    toast('Enter at least a date or an amount for the quotation.', 'red');
    return;
  }
  try {
    await HITT_API.addProjectQuotation(activeProjectId, {
      quotationdate: date || null,
      amountquoted: amount || null,
      discountnegotiation: document.getElementById('mNewQuotationDiscount').value || null,
      expenses: document.getElementById('mNewQuotationExpenses').value || null,
      finalquotation: document.getElementById('mNewQuotationFinal').value || null,
      employeeId: currentEmployeeId,
    });
    ['mNewQuotationDate', 'mNewQuotationAmount', 'mNewQuotationDiscount', 'mNewQuotationExpenses', 'mNewQuotationFinal']
      .forEach(id2 => document.getElementById(id2).value = '');
    renderQuotations(await HITT_API.getProjectQuotations(activeProjectId));
    toast('Quotation added', 'green');
  } catch (err) {
    console.error(err);
    toast('Could not save the quotation.', 'red');
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

  document.getElementById('npEntity').innerHTML = lookupOptionsHtml(LOOKUPS.entities, null, true);
  document.getElementById('npProjectType').innerHTML = lookupOptionsHtml(LOOKUPS.projectTypes, null, true);
  document.getElementById('npBioSpectrum').innerHTML = lookupOptionsHtml(LOOKUPS.biotechSpectrums, null, true);
  document.getElementById('npOwner').innerHTML = employeeOptionsHtml(null, true);
  npBusinessPartnerId = null;
  document.getElementById('npBusinessPartner').textContent = '—';

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
document.getElementById('npBPSearch').addEventListener('click', () => openBpPicker('newProject'));
newProjectOverlay.addEventListener('click', (e) => { if (e.target === newProjectOverlay) closeNewProjectModal(); });

document.getElementById('npSave').addEventListener('click', async () => {
  const name = document.getElementById('npName').value.trim();
  const status = Number(document.getElementById('npStatus').value);
  const progress = Number(document.getElementById('npProgress').value) || 0;
  const entityVal = document.getElementById('npEntity').value;
  const projectTypeVal = document.getElementById('npProjectType').value;
  const bioSpectrumVal = document.getElementById('npBioSpectrum').value;
  const ownerVal = document.getElementById('npOwner').value;

  if (!name || name === NP_PLACEHOLDER) {
    toast(`Missing required data: <b>Project name</b>`, 'red');
    return;
  }
  if (!entityVal) {
    toast(`Missing required data: <b>Entity</b>`, 'red');
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
    const created = await HITT_API.createProject({
      code, name, stage: status, progress,
      employeeId: currentEmployeeId,
      entityId: entityVal ? Number(entityVal) : null,
      projectTypeId: projectTypeVal ? Number(projectTypeVal) : null,
      biospectrumId: bioSpectrumVal ? Number(bioSpectrumVal) : null,
      ownerId: ownerVal ? Number(ownerVal) : null,
    });
    if (npBusinessPartnerId) {
      try {
        await HITT_API.assignProjectBusinessPartner(created.id, npBusinessPartnerId);
      } catch (bpErr) {
        console.error(bpErr);
        toast('Project created, but could not assign the business partner — assign it from the project card.', 'red');
      }
    }
    PROJECTS.push({
      id: created.id ?? idCounter++,
      code: created.code ?? code,
      name: created.name ?? name,
      stage: Number(created.stage ?? status),
      progress: Number(created.progress ?? progress),
      ownerId: ownerVal ? Number(ownerVal) : null,
      ownerName: ownerVal ? (EMPLOYEES.find(e => String(e.id) === ownerVal)?.name ?? null) : null,
    });
    renderBoard();
    updateTabCounts();
    populateOwnerFilterOptions();
    toast(`<span class="font-mono text-xs opacity-80">${code}</span> project <b>created</b>`, 'green');
    if (created.oneDriveFolder?.created === false) {
      toast('Project created, but the OneDrive folder could not be created — create it by hand.', 'red');
    } else if (created.oneDriveFolder === null && entityVal === '') {
      toast('No entity selected — OneDrive folder not created (folder naming needs it). Set the entity, then create the folder by hand.', 'navy');
    }
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

/* ---------- Filters panel ---------- */
const filterPanel = document.getElementById('filterPanel');
const btnFilters = document.getElementById('btnFilters');

// Reparent to <body> once, up front — the panel started life nested
// inside the toolbar, which has backdrop-blur (backdrop-filter). Per the
// CSS spec, backdrop-filter (like transform/filter/perspective) on an
// ancestor creates a new containing block for position:fixed descendants,
// silently turning "fixed" into "fixed relative to that ancestor" instead
// of the viewport — which is exactly what made the earlier viewport-
// clamped positioning still land the panel in the wrong place/stacking
// order. Moving it out from under that ancestor entirely (a standard
// "portal" pattern) sidesteps the problem instead of fighting it.
document.body.appendChild(filterPanel);

// position:fixed, computed here rather than via CSS right:0 — this
// panel's trigger button sits at different horizontal positions depending
// on viewport width (the toolbar's own responsive wrapping), and a fixed
// CSS anchor point overflowed off the left edge of the viewport once the
// button wasn't near the page's right edge. Clamping against the actual
// viewport width here is correct at any width, not just the one it was
// eyeballed at.
function positionFilterPanel(){
  const rect = btnFilters.getBoundingClientRect();
  const panelWidth = filterPanel.offsetWidth || 256;
  let left = rect.right - panelWidth;
  left = Math.max(8, Math.min(left, window.innerWidth - panelWidth - 8));
  filterPanel.style.left = `${left}px`;
  filterPanel.style.top = `${rect.bottom + 6}px`;
}

btnFilters.addEventListener('click', (e) => {
  e.stopPropagation();
  const opening = filterPanel.classList.contains('hidden');
  if (opening) positionFilterPanel();
  filterPanel.classList.toggle('hidden');
});
filterPanel.addEventListener('click', (e) => e.stopPropagation());
document.addEventListener('click', () => filterPanel.classList.add('hidden'));
window.addEventListener('resize', () => {
  if (!filterPanel.classList.contains('hidden')) positionFilterPanel();
});

function updateFilterCount(){
  const active = [
    FILTERS.ownerId, FILTERS.notInvoiceable, FILTERS.noBudget,
    FILTERS.progressMin != null, FILTERS.progressMax != null,
  ].filter(Boolean).length;
  const badge = document.getElementById('filterCount');
  badge.textContent = active || '';
  badge.classList.toggle('hidden', !active);
}

function applyFilters(){
  updateFilterCount();
  renderBoard();
  updateTabCounts();
}

document.getElementById('filterOwner').addEventListener('change', (e) => {
  FILTERS.ownerId = e.target.value;
  applyFilters();
});
document.getElementById('filterNotInvoiceable').addEventListener('change', (e) => {
  FILTERS.notInvoiceable = e.target.checked;
  applyFilters();
});
document.getElementById('filterNoBudget').addEventListener('change', (e) => {
  FILTERS.noBudget = e.target.checked;
  applyFilters();
});
document.getElementById('filterProgressMin').addEventListener('input', (e) => {
  FILTERS.progressMin = e.target.value === '' ? null : Number(e.target.value);
  applyFilters();
});
document.getElementById('filterProgressMax').addEventListener('input', (e) => {
  FILTERS.progressMax = e.target.value === '' ? null : Number(e.target.value);
  applyFilters();
});
document.getElementById('btnClearFilters').addEventListener('click', () => {
  FILTERS.ownerId = '';
  FILTERS.notInvoiceable = false;
  FILTERS.noBudget = false;
  FILTERS.progressMin = null;
  FILTERS.progressMax = null;
  document.getElementById('filterOwner').value = '';
  document.getElementById('filterNotInvoiceable').checked = false;
  document.getElementById('filterNoBudget').checked = false;
  document.getElementById('filterProgressMin').value = '';
  document.getElementById('filterProgressMax').value = '';
  applyFilters();
});

document.getElementById('btnRefresh').addEventListener('click', () => {
  toast('Refreshing…', 'navy');
  loadProjects();
});

/* ============================== INIT ==================================== */
loadProjects().then(() => {
  // Deep link from Reports (project timeline rows, month-detail drill-down)
  // — ?projectId=X opens that project's modal directly. PROJECTS[].id
  // comes straight off the API response (a stringified bigint), so this
  // deliberately doesn't Number()-convert id — the strict equality in
  // openProjectModal's PROJECTS.find(x => x.id === id) needs the same type.
  const projectId = new URLSearchParams(window.location.search).get('projectId');
  if (projectId) openProjectModal(projectId);
});
