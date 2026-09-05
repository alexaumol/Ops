/**
 * HITT Ops — Business partners
 * ---------------------------------------------------------------------------
 * Mirrors the Access "BusinessPartner-New_Edit" form (+ Contacts/Notes/
 * TaxCompanies subforms). List loads once and is filtered client-side
 * (same pattern as the Projects kanban search) since the real dataset is
 * small (a few hundred rows). Falls back to on-screen demo data if the API
 * is unreachable, same convention as Projects.
 * ---------------------------------------------------------------------------
 */

const session = HITT_AUTH.requireSession("../index.html");
const T = (k, v) => (window.HITT_I18N ? HITT_I18N.t(k, v) : k);
HITT_PERMS.guardModule("customers-partners", "../welcome.html");
document.getElementById("userName").textContent = session.displayName;
document.getElementById("userAvatar").textContent = HITT_AUTH.initials(session);
HITT_PERMS.applyRealName();

// Resolved once and reused for create/update calls so
// businesspartners.lastupdatedby actually records who made the change,
// instead of always landing NULL — mirrors projects.js's currentEmployeeId.
let currentEmployeeId = null;
HITT_PERMS.get().then((perms) => { currentEmployeeId = perms.employeeId; }).catch(() => {});

const DEMO_SEED = [
  { id: 1, name: "Demo Pharma Inc", companyTypeLabel: "Pharmaceutical", countryLabel: "United States", webpage: "https://example.com", projectsAlive: 2, projectsDead: 1, projectsTotal: 3, taxCompanyCount: 2 },
  { id: 2, name: "Demo Biotech Spain", companyTypeLabel: "Start Up", countryLabel: "Spain", webpage: "", projectsAlive: 0, projectsDead: 0, projectsTotal: 0, taxCompanyCount: 0 },
];

let PARTNERS = [];
let LOOKUPS = { entities: [], companyTypes: [], countries: [], languages: [] };
let EMPLOYEES = []; // CRM Phase C1 — owner picker (reuses the existing /api/employees lookup)
let usingDemoData = false;
let searchTerm = "";
let onlyAliveProjects = false;
let stageFilter = "";
let ownerFilter = "";   // "" | "me" | "none"
let tagFilter = "";
let showArchived = false;
let ALL_TAGS = []; // CRM Phase C4 — { id, label, color }, loaded once at page init
let activeBpId = null;
let sortColumn = "name";
let sortDirection = "asc"; // 'asc' | 'desc'

const STAGE_LABEL_KEYS = {
  new: "bp.stage.new", in_discussion: "bp.stage.inDiscussion", active_partner: "bp.stage.activePartner",
  on_hold: "bp.stage.onHold", closed: "bp.stage.closed", former_partner: "bp.stage.formerPartner",
};
function employeeOptionsHtml(selectedId, includeBlankLabel){
  const opts = [`<option value="">${includeBlankLabel || "—"}</option>`]
    .concat((EMPLOYEES || []).map(e => `<option value="${e.id}" ${String(e.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(e.name || e.username || `#${e.id}`)}</option>`));
  return opts.join('');
}

// CRM Phase C4 — tags. The filter <select> (list toolbar) and the <datalist>
// backing the add-tag input (detail modal) both come from the same
// ALL_TAGS list, refreshed whenever a new tag is created.
function renderTagFilterOptions(){
  const sel = document.getElementById('filterTag');
  const current = sel.value;
  sel.innerHTML = `<option value="">${T('bp.filter.allTags')}</option>` +
    ALL_TAGS.map(t => `<option value="${escapeHtml(t.label)}" ${t.label === current ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('');
}
function renderTagDatalist(){
  document.getElementById('bpTagOptions').innerHTML =
    ALL_TAGS.map(t => `<option value="${escapeHtml(t.label)}"></option>`).join('');
}

function escapeHtml(s){
  const d = document.createElement('div');
  d.textContent = s ?? "";
  return d.innerHTML;
}

function toast(msg, tone = 'navy'){
  const host = document.getElementById('toastHost');
  const el = document.createElement('div');
  el.className = `toast toast-${tone}`;
  el.textContent = msg;
  host.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

function setDataSourcePill(){
  const pill = document.getElementById("dataSourcePill");
  if (usingDemoData) {
    pill.textContent = T("common.demoData");
    pill.style.background = "rgba(188,154,28,0.18)";
    pill.style.color = "#8A6E12";
  } else {
    pill.textContent = T("common.liveData");
    pill.style.background = "rgba(110,143,90,0.18)";
    pill.style.color = "#4C6B3A";
  }
}

/* ============================== LOAD DATA =============================== */
async function loadPartners(){
  if (!window.HITT_CONFIG?.FEATURES?.businessPartnersLive) {
    PARTNERS = structuredClone(DEMO_SEED);
    usingDemoData = true;
    setDataSourcePill();
    renderTable();
    return;
  }
  try {
    try {
      LOOKUPS = await HITT_API.getBusinessPartnerLookups();
    } catch (err) {
      console.warn("Could not load business partner lookups:", err);
    }
    try {
      EMPLOYEES = await HITT_API.getEmployees();
    } catch (err) {
      console.warn("Could not load employees (owner picker):", err);
    }
    try {
      ALL_TAGS = await HITT_API.getAllTags();
      renderTagFilterOptions();
      renderTagDatalist();
    } catch (err) {
      console.warn("Could not load tags:", err);
    }
    // includeArchived: the list loads once and every filter (search, stage,
    // owner, archived...) runs client-side, same as the rest of this page —
    // so "Show archived" just needs the rows already in memory.
    const data = await HITT_API.getBusinessPartners({ includeArchived: true });
    // projectsAlive/Dead/Total come back as strings — Postgres COUNT()
    // is bigint, and node-pg serializes bigints as strings to avoid
    // precision loss. Coerce to Number so the "Number of projects" column
    // sorts numerically (10 > 9), not lexicographically ("10" < "9").
    PARTNERS = data.map(p => ({
      ...p,
      projectsAlive: Number(p.projectsAlive ?? 0),
      projectsDead: Number(p.projectsDead ?? 0),
      projectsTotal: Number(p.projectsTotal ?? 0),
      taxCompanyCount: Number(p.taxCompanyCount ?? 0),
    }));
    usingDemoData = false;
  } catch (err) {
    console.warn("Falling back to demo data — could not reach API:", err);
    PARTNERS = structuredClone(DEMO_SEED);
    usingDemoData = true;
  }
  setDataSourcePill();
  renderTable();
}

/* ============================== TABLE =================================== */
function matchesSearch(p){
  if (!searchTerm) return true;
  const t = searchTerm.toLowerCase();
  return String(p.name || '').toLowerCase().includes(t)
      || String(p.taxCompanyNames || '').toLowerCase().includes(t);
}

function matchesFilters(p){
  if (!matchesSearch(p)) return false;
  if (onlyAliveProjects && Number(p.projectsAlive ?? 0) <= 0) return false;
  if (!showArchived && p.archivedAt) return false;
  if (stageFilter && (p.lifecycleStage || 'new') !== stageFilter) return false;
  if (ownerFilter === 'me' && String(p.ownerEmployeeId ?? '') !== String(currentEmployeeId ?? '')) return false;
  if (ownerFilter === 'none' && p.ownerEmployeeId) return false;
  if (tagFilter && !(p.tags || []).includes(tagFilter)) return false;
  return true;
}

function renderTable(){
  const tbody = document.getElementById('bpTableBody');
  const empty = document.getElementById('bpEmpty');
  const dir = sortDirection === 'asc' ? 1 : -1;
  const rows = PARTNERS.filter(matchesFilters).sort((a, b) => {
    const av = a[sortColumn], bv = b[sortColumn];
    if (typeof av === 'number' || typeof bv === 'number') {
      return ((av ?? 0) - (bv ?? 0)) * dir;
    }
    return String(av ?? '').localeCompare(String(bv ?? '')) * dir;
  });
  document.getElementById('bpCount').textContent = T('common.countOf', { shown: rows.length, total: PARTNERS.length });

  document.querySelectorAll('.bp-table th[data-sort]').forEach(th => {
    const active = th.dataset.sort === sortColumn;
    th.classList.toggle('sorted', active);
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.textContent = active ? (sortDirection === 'asc' ? '▲' : '▼') : '▲';
  });

  if (!rows.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  tbody.innerHTML = rows.map(p => `
    <tr data-id="${p.id}">
      <td>
        ${escapeHtml(p.name)}${p.archivedAt ? ` <span class="stage-pill">${T('bp.archived')}</span>` : ''}
        ${(p.tags || []).length ? `<div class="bp-row-tags">${p.tags.map(t => `<span class="tag-chip">${escapeHtml(t)}</span>`).join('')}</div>` : ''}
      </td>
      <td>
        <span class="stage-pill stage-pill--${p.lifecycleStage || 'new'}">${T(STAGE_LABEL_KEYS[p.lifecycleStage] || STAGE_LABEL_KEYS.new)}</span>
        ${p.temperature ? `<span class="temp-badge">${p.temperature === 'hot' ? '🔥' : '☀️'}</span>` : ''}
        ${p.ownerName ? `<span class="bp-owner-meta">${escapeHtml(p.ownerName)}</span>` : ''}
      </td>
      <td>${escapeHtml(p.companyTypeLabel || '—')}</td>
      <td>${escapeHtml(p.countryLabel || '—')}</td>
      <td>${p.webpage ? `<a href="${escapeHtml(p.webpage)}" target="_blank" rel="noopener">${escapeHtml(p.webpage.replace(/^https?:\/\//, ''))}</a>` : '—'}</td>
      <td>
        <span title="${T('bp.tip.aliveDeadTotal')}">${p.projectsAlive ?? 0} / ${p.projectsDead ?? 0} (${p.projectsTotal ?? 0})</span>
        ${p.projectsTotal ? `<button data-bp-projects="${p.id}" class="btn-icon-add" style="margin-left:0.4rem; padding:0.1rem 0.5rem; font-size:0.72rem;" title="${T("bp.tip.viewProjects")}">⋯</button>` : ''}
      </td>
      <td>
        ${p.taxCompanyCount
          ? `<button data-bp-taxcos="${p.id}" class="bp-count-btn" title="${escapeHtml(p.taxCompanyNames || T("bp.tip.viewTaxCompanies"))}">${p.taxCompanyCount}</button>`
          : `<span class="bp-count-zero">0</span>`}
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr').forEach((tr, i) => {
    tr.addEventListener('click', () => openDetailModal(rows[i].id));
  });
  tbody.querySelectorAll('[data-bp-projects]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't also trigger the row's own openDetailModal
      openBpProjectsModal(btn.dataset.bpProjects);
    });
  });
  tbody.querySelectorAll('[data-bp-taxcos]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openBpTaxCompaniesModal(btn.dataset.bpTaxcos);
    });
  });
}

document.getElementById('searchBox').addEventListener('input', (e) => {
  searchTerm = e.target.value.trim();
  renderTable();
});

document.getElementById('filterAliveProjects').addEventListener('change', (e) => {
  onlyAliveProjects = e.target.checked;
  renderTable();
});

document.getElementById('filterStage').addEventListener('change', (e) => {
  stageFilter = e.target.value;
  renderTable();
});

document.getElementById('filterOwner').addEventListener('change', (e) => {
  ownerFilter = e.target.value;
  renderTable();
});

document.getElementById('filterArchived').addEventListener('change', (e) => {
  showArchived = e.target.checked;
  renderTable();
});

document.getElementById('filterTag').addEventListener('change', (e) => {
  tagFilter = e.target.value;
  renderTable();
});

document.querySelectorAll('.bp-table th[data-sort]').forEach(th => {
  th.addEventListener('click', () => {
    const col = th.dataset.sort;
    if (sortColumn === col) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      sortColumn = col;
      sortDirection = 'asc';
    }
    renderTable();
  });
});

/* ============================== LOOKUPS HELPERS ========================== */
function lookupOptionsHtml(rows, selectedId, includeBlank){
  const opts = (includeBlank ? [`<option value="">—</option>`] : [])
    .concat((rows || []).map(r => `<option value="${r.id}" ${String(r.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(r.label)}</option>`));
  return opts.join('');
}

function formatDateOnly(iso){
  return iso ? new Date(iso).toLocaleDateString() : '—';
}

function formatDateTime(iso){
  return iso ? new Date(iso).toLocaleString() : '—';
}

/* ============================== DETAIL MODAL ============================= */
const modalOverlay = document.getElementById('modalOverlay');

let CONTACTS = [];
let editingContactId = null;

const DECISION_ROLE_LABEL_KEYS = {
  decision_maker: 'bp.contact.decisionRole.decisionMaker', influencer: 'bp.contact.decisionRole.influencer',
  gatekeeper: 'bp.contact.decisionRole.gatekeeper', user: 'bp.contact.decisionRole.user', unknown: 'bp.contact.decisionRole.unknown',
};
const STANCE_LABEL_KEYS = {
  champion: 'bp.contact.stance.champion', supportive: 'bp.contact.stance.supportive', neutral: 'bp.contact.stance.neutral',
  skeptical: 'bp.contact.stance.skeptical', detractor: 'bp.contact.stance.detractor',
};

// Populates the "Reports to" picker with every other contact on this
// partner — called after every contacts fetch, since the option list
// depends on who's currently on the partner.
function renderContactReportsToOptions(){
  const sel = document.getElementById('mNewContactReportsTo');
  const current = sel.value;
  const editingId = editingContactId ? String(editingContactId) : null;
  sel.innerHTML = `<option value="">${T('bp.contact.reportsTo.none')}</option>` +
    CONTACTS.filter(c => String(c.id) !== editingId)
      .map(c => `<option value="${c.id}" ${String(c.id) === current ? 'selected' : ''}>${escapeHtml(c.contactname)}</option>`).join('');
}

// Called with fresh rows (a fetch) or with no argument (re-render after a
// local edit-state change).
function renderContacts(rows){
  if (rows) { CONTACTS = rows; renderContactReportsToOptions(); }
  const list = document.getElementById('mContactsList');
  if (!CONTACTS.length) {
    list.innerHTML = `<div class="sub-empty">${T("bp.empty.contacts")}</div>`;
    return;
  }
  list.innerHTML = CONTACTS.map(c => {
    const badges = [
      c.isPrimary ? `<span class="stage-pill stage-pill--active_partner">${T('bp.contact.primary')}</span>` : '',
      c.decisionRole ? `<span class="stage-pill">${T(DECISION_ROLE_LABEL_KEYS[c.decisionRole] || c.decisionRole)}</span>` : '',
      c.stance ? `<span class="stage-pill">${T(STANCE_LABEL_KEYS[c.stance] || c.stance)}</span>` : '',
    ].filter(Boolean).join(' ');
    return `
    <div class="sub-item ${String(editingContactId) === String(c.id) ? 'is-editing' : ''}">
      <div class="sub-item-row">
        <span class="sub-item-title">${escapeHtml(c.contactname)}</span>
        <span style="display:flex; align-items:center; gap:0.35rem;">
          <span class="sub-item-meta">${escapeHtml(c.position || '')}</span>
          <button type="button" data-edit-contact="${c.id}" class="sub-item-btn" title="${T("bp.tip.editContact")}">✎</button>
          <button type="button" data-delete-contact="${c.id}" class="sub-item-btn sub-item-btn--danger" title="${T("bp.tip.deleteContact")}">✕</button>
        </span>
      </div>
      <div class="sub-item-meta">${escapeHtml(c.emailaddress || '—')}${c.phonenumber ? ' · ' + escapeHtml(c.phonenumber) : ''}${c.reportsToName ? ' · ' + T('bp.contact.reportsToLabel', { name: escapeHtml(c.reportsToName) }) : ''}</div>
      ${badges ? `<div style="margin-top:0.3rem;">${badges}</div>` : ''}
    </div>
  `;
  }).join('');
  list.querySelectorAll('[data-edit-contact]').forEach(btn => {
    btn.addEventListener('click', () => startEditContact(btn.dataset.editContact));
  });
  list.querySelectorAll('[data-delete-contact]').forEach(btn => {
    btn.addEventListener('click', () => deleteContact(btn.dataset.deleteContact));
  });
}

function contactFormInputs(){
  return {
    name: document.getElementById('mNewContactName'),
    position: document.getElementById('mNewContactPosition'),
    email: document.getElementById('mNewContactEmail'),
    phone: document.getElementById('mNewContactPhone'),
    decisionRole: document.getElementById('mNewContactDecisionRole'),
    influence: document.getElementById('mNewContactInfluence'),
    stance: document.getElementById('mNewContactStance'),
    reportsTo: document.getElementById('mNewContactReportsTo'),
    primary: document.getElementById('mNewContactPrimary'),
  };
}

function startEditContact(id){
  const c = CONTACTS.find(x => String(x.id) === String(id));
  if (!c) return;
  editingContactId = c.id;
  const f = contactFormInputs();
  f.name.value = c.contactname || '';
  f.position.value = c.position || '';
  f.email.value = c.emailaddress || '';
  f.phone.value = c.phonenumber || '';
  f.decisionRole.value = c.decisionRole || '';
  f.influence.value = c.influence || '';
  f.stance.value = c.stance || '';
  f.primary.checked = !!c.isPrimary;
  renderContactReportsToOptions(); // excludes this contact from its own "reports to" list
  f.reportsTo.value = c.reportsToContactId || '';
  document.getElementById('mAddContact').textContent = T('form.save');
  document.getElementById('mCancelEditContact').style.display = '';
  renderContacts();
  f.name.focus();
}

function cancelEditContact(){
  editingContactId = null;
  const f = contactFormInputs();
  [f.name, f.position, f.email, f.phone].forEach(el => { el.value = ''; });
  f.decisionRole.value = '';
  f.influence.value = '';
  f.stance.value = '';
  f.reportsTo.value = '';
  f.primary.checked = false;
  renderContactReportsToOptions();
  document.getElementById('mAddContact').textContent = T('form.add');
  document.getElementById('mCancelEditContact').style.display = 'none';
  renderContacts();
}

async function deleteContact(id){
  const c = CONTACTS.find(x => String(x.id) === String(id));
  if (!c || !confirm(T("bp.confirm.deleteContact", { name: c.contactname || "" }))) return;
  const wasSessionAdd = bpSessionAdds.contacts.some(x => String(x) === String(id));
  try {
    await HITT_API.deleteBusinessPartnerContact(activeBpId, id, currentEmployeeId);
    bpSessionAdds.contacts = bpSessionAdds.contacts.filter(x => String(x) !== String(id));
    bpEditedContacts.delete(String(id));
    if (!wasSessionAdd && bpOrigContacts.has(String(id))) {
      bpDeletedContacts.push(bpOrigContacts.get(String(id)));
    }
    const wasEditingThis = String(editingContactId) === String(id);
    CONTACTS = await HITT_API.getBusinessPartnerContacts(activeBpId);
    renderContactReportsToOptions(); // the deleted contact must drop out of the picker
    if (wasEditingThis) cancelEditContact(); // resets the form + re-renders
    else renderContacts();
    toast(T('toast.contactDeleted'), 'navy');
  } catch (err) {
    console.error(err);
    toast(T('toast.contactDeleteFail'), 'red');
  }
}

let NOTES = [];
let notesSearchTerm = '';

function matchesNotesSearch(n){
  if (!notesSearchTerm) return true;
  const term = notesSearchTerm.toLowerCase();
  return (n.notes || '').toLowerCase().includes(term) || (n.authorName || '').toLowerCase().includes(term);
}

// Called both with fresh rows (a real fetch — replaces the stored set)
// and with no argument at all (the search box's own input handler).
function renderNotes(rows){
  if (rows) NOTES = rows;
  const list = document.getElementById('mNotesList');
  const filtered = NOTES.filter(matchesNotesSearch);
  if (!filtered.length) {
    list.innerHTML = `<div class="sub-empty">${NOTES.length ? T('bp.empty.notesSearch') : T('bp.empty.notes')}</div>`;
    return;
  }
  list.innerHTML = filtered.map(n => `
    <div class="sub-item">
      <div class="sub-item-row">
        <span class="sub-item-title">${escapeHtml(n.authorName || T('common.unknown'))}</span>
        <span class="sub-item-meta">${formatDateTime(n.commentsts)}</span>
      </div>
      <div style="font-size:0.82rem; white-space:pre-wrap;">${escapeHtml(n.notes)}</div>
    </div>
  `).join('');
}

/* ============================== ACTIVITY TIMELINE (CRM Phase C2) ========= */
let ACTIVITIES = [];

const ACTIVITY_KIND_LABEL_KEYS = {
  call: 'bp.activity.kind.call', meeting: 'bp.activity.kind.meeting', email: 'bp.activity.kind.email',
  note: 'bp.activity.kind.note', site_visit: 'bp.activity.kind.siteVisit', other: 'bp.activity.kind.other',
};
const ACTIVITY_OUTCOME_LABEL_KEYS = {
  positive: 'bp.activity.outcome.positive', neutral: 'bp.activity.outcome.neutral', negative: 'bp.activity.outcome.negative',
};

// Populates the "With contact" picker on the log-activity form from the
// partner's current contact list — called after every contacts fetch.
function renderActivityContactOptions(){
  const sel = document.getElementById('mNewActivityContact');
  sel.innerHTML = `<option value="">${T('bp.activity.withContact.none')}</option>` +
    CONTACTS.map(c => `<option value="${c.id}">${escapeHtml(c.contactname)}</option>`).join('');
}

// Called with fresh rows (a fetch) or with no argument (a language change).
function renderActivities(rows){
  if (rows) ACTIVITIES = rows;
  const list = document.getElementById('mActivityList');
  if (!ACTIVITIES.length) {
    list.innerHTML = `<div class="sub-empty">${T("bp.empty.activities")}</div>`;
    return;
  }
  list.innerHTML = ACTIVITIES.map(a => {
    const who = [a.contactName, ...(a.participantContactNames || []), ...(a.participantEmployeeNames || [])]
      .filter(Boolean).map(escapeHtml).join(', ');
    return `
    <div class="sub-item">
      <div class="sub-item-row">
        <span class="sub-item-title">${T(ACTIVITY_KIND_LABEL_KEYS[a.kind] || a.kind)}</span>
        <span style="display:flex; align-items:center; gap:0.35rem;">
          ${a.outcome ? `<span class="stage-pill">${T(ACTIVITY_OUTCOME_LABEL_KEYS[a.outcome] || a.outcome)}</span>` : ''}
          <span class="sub-item-meta">${formatDateTime(a.occurredAt)}</span>
          <button type="button" data-delete-activity="${a.id}" class="sub-item-btn sub-item-btn--danger" title="${T("bp.tip.deleteActivity")}">✕</button>
        </span>
      </div>
      <div style="font-size:0.82rem; white-space:pre-wrap;">${escapeHtml(a.summary)}</div>
      <div class="sub-item-meta">
        ${a.loggedByName ? T('bp.activity.loggedBy', { name: escapeHtml(a.loggedByName) }) : ''}
        ${who ? ' · ' + T('bp.activity.withLabel', { names: who }) : ''}
      </div>
      ${a.agreedNextStep ? `<div class="sub-item-meta">${T('bp.activity.nextStepLabel', { text: escapeHtml(a.agreedNextStep) })}</div>` : ''}
    </div>
  `;
  }).join('');
  list.querySelectorAll('[data-delete-activity]').forEach(btn => {
    btn.addEventListener('click', () => deleteActivity(btn.dataset.deleteActivity));
  });
}

async function deleteActivity(id){
  if (!confirm(T('bp.confirm.deleteActivity'))) return;
  try {
    await HITT_API.deleteBusinessPartnerActivity(activeBpId, id);
    renderActivities(await HITT_API.getBusinessPartnerActivities(activeBpId));
    toast(T('toast.activityDeleted'), 'navy');
  } catch (err) {
    console.error(err);
    toast(T('toast.activityDeleteFail'), 'red');
  }
}

/* ============================== NEXT ACTIONS — TASKS (CRM Phase C2) ====== */
let BP_TASKS = [];

function formatDueMeta(task){
  if (!task.dueDate) return '';
  const isOverdue = task.status === 'open' && new Date(task.dueDate) < new Date(new Date().toDateString());
  return `<span class="task-meta ${isOverdue ? 'is-overdue' : ''}">${T('bp.task.due', { date: formatDateOnly(task.dueDate) })}</span>`;
}

function renderBpTasks(rows){
  if (rows) BP_TASKS = rows;
  const list = document.getElementById('mTaskList');
  if (!BP_TASKS.length) {
    list.innerHTML = `<div class="sub-empty">${T("bp.empty.tasks")}</div>`;
    return;
  }
  list.innerHTML = BP_TASKS.map(t => `
    <div class="sub-item task-item ${t.status === 'done' ? 'is-done' : ''}">
      <input type="checkbox" data-toggle-task="${t.id}" ${t.status === 'done' ? 'checked' : ''} title="${T('bp.task.toggle')}" />
      <div style="flex:1; min-width:0;">
        <div class="task-title">${escapeHtml(t.title)}</div>
        <div class="sub-item-meta">
          ${t.ownerName ? escapeHtml(t.ownerName) : T('bp.task.unassigned')}
          ${formatDueMeta(t)}
        </div>
      </div>
      <button type="button" data-delete-task="${t.id}" class="sub-item-btn sub-item-btn--danger" title="${T("form.delete")}">✕</button>
    </div>
  `).join('');
  list.querySelectorAll('[data-toggle-task]').forEach(cb => {
    cb.addEventListener('change', () => toggleBpTask(cb.dataset.toggleTask, cb.checked));
  });
  list.querySelectorAll('[data-delete-task]').forEach(btn => {
    btn.addEventListener('click', () => deleteBpTask(btn.dataset.deleteTask));
  });
}

async function toggleBpTask(id, done){
  try {
    await HITT_API.updateTask(id, { status: done ? 'done' : 'open' });
    renderBpTasks(await HITT_API.getTasks({ entityType: 'customer_partner', entityId: activeBpId }));
  } catch (err) {
    console.error(err);
    toast(T('toast.taskSaveFail'), 'red');
    renderBpTasks(); // revert the checkbox to the last known state
  }
}

async function deleteBpTask(id){
  const t = BP_TASKS.find(x => String(x.id) === String(id));
  if (!t || !confirm(T('bp.confirm.deleteTask', { title: t.title || '' }))) return;
  try {
    await HITT_API.deleteTask(id);
    renderBpTasks(await HITT_API.getTasks({ entityType: 'customer_partner', entityId: activeBpId }));
    toast(T('toast.taskDeleted'), 'navy');
  } catch (err) {
    console.error(err);
    toast(T('toast.taskDeleteFail'), 'red');
  }
}

/* ============================== OPPORTUNITIES (CRM Phase C3) ============= */
let OPPORTUNITIES = [];

// Stages an opportunity can still move between — 'converted'/'lost' are
// terminal and reached only via the dedicated convert/mark-lost actions,
// never picked from this select.
const OPPORTUNITY_OPEN_STAGES = ['identified', 'qualifying', 'proposal_pending'];
const OPPORTUNITY_STAGE_LABEL_KEYS = {
  identified: 'bp.opportunity.stage.identified', qualifying: 'bp.opportunity.stage.qualifying',
  proposal_pending: 'bp.opportunity.stage.proposalPending', converted: 'bp.opportunity.stage.converted',
  lost: 'bp.opportunity.stage.lost',
};

function formatMoney(value, currencyCode){
  if (value == null) return '';
  const formatted = Number(value).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currencyCode ? `${formatted} ${escapeHtml(currencyCode)}` : formatted;
}

// Populates the currency/owner pickers on the add-opportunity form — called
// once on modal open (they don't depend on anything fetched per-partner).
function renderOpportunityPickers(){
  document.getElementById('mNewOppCurrency').innerHTML =
    `<option value="">—</option>` + (LOOKUPS.currencies || []).map(c => `<option value="${c.id}">${escapeHtml(c.code)}</option>`).join('');
  document.getElementById('mNewOppOwner').innerHTML = employeeOptionsHtml(currentEmployeeId, T('bp.opportunity.ownerPlaceholder'));
}

function renderOpportunities(rows){
  if (rows) OPPORTUNITIES = rows;
  const list = document.getElementById('mOpportunityList');
  if (!OPPORTUNITIES.length) {
    list.innerHTML = `<div class="sub-empty">${T("bp.empty.opportunities")}</div>`;
    return;
  }
  list.innerHTML = OPPORTUNITIES.map(o => {
    const isOpen = OPPORTUNITY_OPEN_STAGES.includes(o.stage);
    const metaParts = [
      o.estimatedValue != null ? formatMoney(o.estimatedValue, o.currencyCode) : '',
      o.ownerName ? escapeHtml(o.ownerName) : '',
      o.expectedClose ? T('bp.opportunity.expectedCloseLabel', { date: formatDateOnly(o.expectedClose) }) : '',
      o.source ? escapeHtml(o.source) : '',
    ].filter(Boolean);
    const stageOptions = OPPORTUNITY_OPEN_STAGES
      .map(s => `<option value="${s}" ${s === o.stage ? 'selected' : ''}>${T(OPPORTUNITY_STAGE_LABEL_KEYS[s])}</option>`).join('');
    return `
    <div class="sub-item">
      <div class="sub-item-row">
        <span class="sub-item-title">${escapeHtml(o.name)}</span>
        <span style="display:flex; align-items:center; gap:0.35rem;">
          <span class="stage-pill stage-pill--${o.stage}">${T(OPPORTUNITY_STAGE_LABEL_KEYS[o.stage] || o.stage)}</span>
          ${isOpen ? `<button type="button" data-delete-opp="${o.id}" class="sub-item-btn sub-item-btn--danger" title="${T('form.delete')}">✕</button>` : ''}
        </span>
      </div>
      ${metaParts.length ? `<div class="sub-item-meta">${metaParts.join(' · ')}</div>` : ''}
      ${o.stage === 'converted' ? `<div class="sub-item-meta">${T('bp.opportunity.convertedTo', { code: escapeHtml(o.projectCode || `#${o.projectId}`) })}</div>` : ''}
      ${o.stage === 'lost' && o.lostReason ? `<div class="sub-item-meta">${T('bp.opportunity.lostReasonLabel', { reason: escapeHtml(o.lostReason) })}</div>` : ''}
      ${isOpen ? `
        <div class="opp-actions">
          <select class="field-input opp-stage-select" data-stage-opp="${o.id}">${stageOptions}</select>
          <button type="button" data-convert-opp="${o.id}" class="btn-icon-add">${T('bp.opportunity.convert')}</button>
          <button type="button" data-lost-opp="${o.id}" class="btn-icon-add" style="background:var(--text-secondary);">${T('bp.opportunity.markLost')}</button>
        </div>
      ` : ''}
    </div>
  `;
  }).join('');
  list.querySelectorAll('[data-stage-opp]').forEach(sel => {
    sel.addEventListener('change', () => changeOpportunityStage(sel.dataset.stageOpp, sel.value));
  });
  list.querySelectorAll('[data-convert-opp]').forEach(btn => {
    btn.addEventListener('click', () => convertOpportunity(btn.dataset.convertOpp));
  });
  list.querySelectorAll('[data-lost-opp]').forEach(btn => {
    btn.addEventListener('click', () => markOpportunityLost(btn.dataset.lostOpp));
  });
  list.querySelectorAll('[data-delete-opp]').forEach(btn => {
    btn.addEventListener('click', () => deleteOpportunity(btn.dataset.deleteOpp));
  });
}

async function changeOpportunityStage(id, stage){
  try {
    await HITT_API.updateBusinessPartnerOpportunity(activeBpId, id, { stage });
    renderOpportunities(await HITT_API.getBusinessPartnerOpportunities(activeBpId));
    toast(T('toast.opportunitySaved'), 'green');
  } catch (err) {
    console.error(err);
    toast(err.message || T('toast.opportunitySaveFail'), 'red');
    renderOpportunities(); // revert the select to the last known stage
  }
}

async function convertOpportunity(id){
  const opp = OPPORTUNITIES.find(x => String(x.id) === String(id));
  if (!opp || !confirm(T('bp.opportunity.convertConfirm', { name: opp.name || '' }))) return;
  try {
    const result = await HITT_API.convertBusinessPartnerOpportunity(activeBpId, id, {});
    renderOpportunities(await HITT_API.getBusinessPartnerOpportunities(activeBpId));
    toast(T('toast.opportunityConverted', { code: result?.project?.code || `#${result?.project?.id}` }), 'green');
  } catch (err) {
    console.error(err);
    toast(err.message || T('toast.opportunityConvertFail'), 'red');
  }
}

async function markOpportunityLost(id){
  const reason = window.prompt(T('bp.opportunity.lostReasonPrompt'));
  if (reason === null) return; // cancelled — leave the opportunity untouched
  try {
    await HITT_API.updateBusinessPartnerOpportunity(activeBpId, id, { stage: 'lost', lostReason: reason || null });
    renderOpportunities(await HITT_API.getBusinessPartnerOpportunities(activeBpId));
    toast(T('toast.opportunityLost'), 'navy');
  } catch (err) {
    console.error(err);
    toast(err.message || T('toast.opportunitySaveFail'), 'red');
  }
}

async function deleteOpportunity(id){
  const opp = OPPORTUNITIES.find(x => String(x.id) === String(id));
  if (!opp || !confirm(T('bp.confirm.deleteOpportunity', { name: opp.name || '' }))) return;
  try {
    await HITT_API.deleteBusinessPartnerOpportunity(activeBpId, id);
    renderOpportunities(await HITT_API.getBusinessPartnerOpportunities(activeBpId));
    toast(T('toast.opportunityDeleted'), 'navy');
  } catch (err) {
    console.error(err);
    toast(err.message || T('toast.opportunityDeleteFail'), 'red');
  }
}

/* ============================== TAGS (CRM Phase C4) ======================= */
let TAGS = [];

function renderTags(rows){
  if (rows) TAGS = rows;
  const list = document.getElementById('mTagList');
  list.innerHTML = TAGS.map(t => `
    <span class="tag-chip">${escapeHtml(t.label)}
      <button type="button" data-remove-tag="${t.id}" title="${T('bp.tag.remove')}">✕</button>
    </span>
  `).join('');
  list.querySelectorAll('[data-remove-tag]').forEach(btn => {
    btn.addEventListener('click', () => removeTag(btn.dataset.removeTag));
  });
}

// Keeps the list-view row's tag chips in sync without a full reload —
// same idea as mSave's Object.assign onto the PARTNERS row.
function syncPartnerTagsInList(){
  const p = PARTNERS.find(x => x.id === activeBpId);
  if (p) { p.tags = TAGS.map(t => t.label); renderTable(); }
}

async function removeTag(tagId){
  try {
    await HITT_API.removeBusinessPartnerTag(activeBpId, tagId);
    renderTags(await HITT_API.getBusinessPartnerTags(activeBpId));
    syncPartnerTagsInList();
  } catch (err) {
    console.error(err);
    toast(T('toast.tagSaveFail'), 'red');
  }
}

let TAX_COMPANIES = [];
let editingTcId = null;

// Veri*Factu recipient-identification fields on the tax-company form —
// shown only when this instance has the feature on.
const VF_ON = !!(window.HITT_CONFIG && window.HITT_CONFIG.FEATURES && window.HITT_CONFIG.FEATURES.verifactu);
if (VF_ON) document.getElementById('mTcFiscalRow')?.classList.remove('hidden');

function syncTcFiscalCountry(){
  const type = document.getElementById('mTcFiscalIdType');
  const country = document.getElementById('mTcFiscalCountry');
  if (!type || !country) return;
  const foreign = type.value && type.value !== 'nif';
  country.disabled = !foreign;
  country.placeholder = foreign ? 'IT' : 'ES';
}

function renderTaxCompanies(rows){
  if (rows) TAX_COMPANIES = rows;
  const list = document.getElementById('mTaxCompanyList');
  if (!TAX_COMPANIES.length) {
    list.innerHTML = `<div class="sub-empty">${T("bp.empty.taxCompanies")}</div>`;
    return;
  }
  list.innerHTML = TAX_COMPANIES.map(tc => {
    const addrParts = tc.sameAddress
      ? ['Same address as the customer/partner']
      : [tc.streetname, tc.zipcode, tc.city, tc.state, tc.countryLabel].filter(Boolean);
    return `
      <div class="sub-item ${String(editingTcId) === String(tc.id) ? 'is-editing' : ''}">
        <div class="sub-item-row">
          <span class="sub-item-title">${escapeHtml(tc.taxcompanyname || '—')}</span>
          <span style="display:flex; align-items:center; gap:0.35rem;">
            <span class="sub-item-meta">${escapeHtml(tc.vatnumber || '')}</span>
            <button type="button" data-edit-tc="${tc.id}" class="sub-item-btn" title="${T("bp.tip.editTc")}">✎</button>
            <button type="button" data-delete-tc="${tc.id}" class="sub-item-btn sub-item-btn--danger" title="${T("bp.tip.deleteTc")}">✕</button>
          </span>
        </div>
        <div class="sub-item-meta">${escapeHtml(tc.emailinvoicing || '—')}</div>
        <div class="sub-item-meta">${escapeHtml(addrParts.join(', ') || '—')}</div>
      </div>
    `;
  }).join('');
  list.querySelectorAll('[data-edit-tc]').forEach(btn => {
    btn.addEventListener('click', () => startEditTaxCompany(btn.dataset.editTc));
  });
  list.querySelectorAll('[data-delete-tc]').forEach(btn => {
    btn.addEventListener('click', () => deleteTaxCompany(btn.dataset.deleteTc));
  });
}

function tcFormInputs(){
  return {
    name: document.getElementById('mTcName'),
    vat: document.getElementById('mTcVat'),
    email: document.getElementById('mTcEmail'),
    same: document.getElementById('mTcSameAddress'),
    street: document.getElementById('mTcStreet'),
    city: document.getElementById('mTcCity'),
    state: document.getElementById('mTcState'),
    zip: document.getElementById('mTcZip'),
    country: document.getElementById('mTcCountry'),
    phone1: document.getElementById('mTcPhone1'),
    phone2: document.getElementById('mTcPhone2'),
    fiscalIdType: document.getElementById('mTcFiscalIdType'),
    fiscalCountry: document.getElementById('mTcFiscalCountry'),
  };
}

function syncTcAddressVisibility(){
  const same = document.getElementById('mTcSameAddress').checked;
  document.getElementById('mTcAddressFields').classList.toggle('hidden', same);
}

function resetTaxCompanyForm(){
  editingTcId = null;
  const f = tcFormInputs();
  [f.name, f.vat, f.email, f.street, f.city, f.state, f.zip, f.phone1, f.phone2].forEach(el => { el.value = ''; });
  f.same.checked = true;
  f.country.innerHTML = lookupOptionsHtml(LOOKUPS.countries, null, true);
  if (f.fiscalIdType) f.fiscalIdType.value = 'nif';
  if (f.fiscalCountry) f.fiscalCountry.value = '';
  document.getElementById('mTcSave').textContent = T('form.add');
  document.getElementById('mTcCancel').style.display = 'none';
  syncTcAddressVisibility();
  syncTcFiscalCountry();
}

function startEditTaxCompany(id){
  const tc = TAX_COMPANIES.find(x => String(x.id) === String(id));
  if (!tc) return;
  editingTcId = tc.id;
  const f = tcFormInputs();
  f.name.value = tc.taxcompanyname || '';
  f.vat.value = tc.vatnumber || '';
  f.email.value = tc.emailinvoicing || '';
  f.same.checked = !!tc.sameAddress;
  f.street.value = tc.streetname || '';
  f.city.value = tc.city || '';
  f.state.value = tc.state || '';
  f.zip.value = tc.zipcode || '';
  f.phone1.value = tc.phonenumber || '';
  f.phone2.value = tc.phonenumber2 || '';
  f.country.innerHTML = lookupOptionsHtml(LOOKUPS.countries, tc.countryid, true);
  if (f.fiscalIdType) f.fiscalIdType.value = tc.fiscalidtype || 'nif';
  if (f.fiscalCountry) f.fiscalCountry.value = tc.fiscalcountry || '';
  document.getElementById('mTcSave').textContent = T('form.save');
  document.getElementById('mTcCancel').style.display = '';
  syncTcAddressVisibility();
  syncTcFiscalCountry();
  renderTaxCompanies();
  f.name.focus();
}

function taxCompanyPayload(){
  const f = tcFormInputs();
  const same = f.same.checked;
  return {
    taxcompanyname: f.name.value.trim(),
    vatnumber: f.vat.value.trim() || null,
    emailinvoicing: f.email.value.trim() || null,
    fiscalIdType: f.fiscalIdType ? f.fiscalIdType.value : 'nif',
    fiscalCountry: f.fiscalCountry ? f.fiscalCountry.value.trim().toUpperCase() : null,
    sameAddress: same,
    address: same ? null : {
      streetname: f.street.value.trim() || null,
      city: f.city.value.trim() || null,
      state: f.state.value.trim() || null,
      zipcode: f.zip.value.trim() || null,
      phonenumber: f.phone1.value.trim() || null,
      phonenumber2: f.phone2.value.trim() || null,
      countryid: f.country.value ? Number(f.country.value) : null,
    },
  };
}

async function deleteTaxCompany(id){
  const tc = TAX_COMPANIES.find(x => String(x.id) === String(id));
  if (!tc || !confirm(T("bp.confirm.deleteTc", { name: tc.taxcompanyname || "" }))) return;
  const wasSessionAdd = bpSessionAdds.taxCompanies.some(x => String(x) === String(id));
  try {
    await HITT_API.deleteBusinessPartnerTaxCompany(activeBpId, id);
    bpSessionAdds.taxCompanies = bpSessionAdds.taxCompanies.filter(x => String(x) !== String(id));
    bpEditedTaxCompanies.delete(String(id));
    if (!wasSessionAdd && bpOrigTaxCompanies.has(String(id))) {
      bpDeletedTaxCompanies.push(bpOrigTaxCompanies.get(String(id)));
    }
    const wasEditingThis = String(editingTcId) === String(id);
    TAX_COMPANIES = await HITT_API.getBusinessPartnerTaxCompanies(activeBpId);
    if (wasEditingThis) resetTaxCompanyForm();
    renderTaxCompanies();
    toast(T('toast.tcDeleted'), 'navy');
  } catch (err) {
    console.error(err);
    toast(err.message || T('toast.tcDeleteFail'), 'red');
  }
}

// businesspartnerchangelog rows — same shape/design as the Projects
// modal's History panel (see renderHistory in projects.js), minus the
// status-history half since business partners have no status field.
function renderHistory(rows){
  const list = document.getElementById('historyList');
  if (!rows || !rows.length) {
    list.innerHTML = `<div class="sub-empty">${T("bp.empty.history")}</div>`;
    return;
  }
  list.innerHTML = rows.map(h => `
    <div class="history-entry">
      <div class="summary">${escapeHtml(h.summary || '')}</div>
      <div class="meta">
        <span class="who">${escapeHtml(h.changedByName || T('common.unknown'))}</span>
        <span class="when">${formatDateTime(h.changedAt)}</span>
      </div>
    </div>
  `).join('');
}

// CRM Phase C1 — Account section behaviour ----------------------------------
// The stage this record loaded at, so the "reason for the change" field only
// appears once the Stage select actually differs from it.
let loadedLifecycleStage = 'new';

function syncStageFields(){
  const stage = document.getElementById('mStage').value;
  const inDiscussion = stage === 'in_discussion';
  document.getElementById('mTemperatureField').classList.toggle('hidden', !inDiscussion);
  if (!inDiscussion) document.getElementById('mTemperature').value = '';
  const changed = stage !== loadedLifecycleStage;
  document.getElementById('mStageReasonField').classList.toggle('hidden', !changed);
  if (!changed) document.getElementById('mStageReason').value = '';
}
document.getElementById('mStage').addEventListener('change', syncStageFields);

function updateArchiveButtonUI(archivedAt){
  const badge = document.getElementById('mArchivedBadge');
  const btn = document.getElementById('mArchiveToggle');
  badge.classList.toggle('hidden', !archivedAt);
  const label = T(archivedAt ? 'bp.unarchive' : 'bp.archive');
  btn.textContent = label;
  btn.title = label;
  btn.dataset.archived = archivedAt ? '1' : '';
}

document.getElementById('mArchiveToggle').addEventListener('click', async () => {
  if (!activeBpId) return;
  if (usingDemoData) { toast(T('bp.demo.notAvailable'), 'navy'); return; }
  const btn = document.getElementById('mArchiveToggle');
  const wasArchived = !!btn.dataset.archived;
  if (!wasArchived && !confirm(T('bp.confirm.archive'))) return;
  btn.disabled = true;
  try {
    if (wasArchived) {
      await HITT_API.unarchiveBusinessPartner(activeBpId);
      updateArchiveButtonUI(null);
      toast(T('toast.bpUnarchived'), 'green');
    } else {
      const reason = window.prompt(T('bp.archiveReasonPrompt')) || undefined;
      await HITT_API.archiveBusinessPartner(activeBpId, reason);
      updateArchiveButtonUI(new Date().toISOString());
      toast(T('toast.bpArchived'), 'green');
    }
    const p = PARTNERS.find(x => x.id === activeBpId);
    if (p) p.archivedAt = wasArchived ? null : new Date().toISOString();
    renderTable();
    renderHistory(await HITT_API.getBusinessPartnerHistory(activeBpId));
  } catch (err) {
    console.error(err);
    toast(err.message || T('toast.bpArchiveFail'), 'red');
  } finally {
    btn.disabled = false;
  }
});

async function openDetailModal(id){
  const p = PARTNERS.find(x => x.id === id);
  if (!p) return;
  activeBpId = id;

  document.getElementById('mName').value = p.name || '';
  document.getElementById('mCompanyType').innerHTML = lookupOptionsHtml(LOOKUPS.companyTypes, null, true);
  document.getElementById('mLanguage').innerHTML = lookupOptionsHtml(LOOKUPS.languages, null, true);
  document.getElementById('mCountry').innerHTML = lookupOptionsHtml(LOOKUPS.countries, null, true);
  document.getElementById('mWebpage').value = '';
  ['mStreetName', 'mCity', 'mState', 'mZipCode', 'mPhone1', 'mPhone2'].forEach(id2 => document.getElementById(id2).value = '');

  // CRM Phase C1 — Account section
  document.getElementById('mCategory').value = '';
  document.getElementById('mOwner').innerHTML = employeeOptionsHtml(null, '—');
  document.getElementById('mLeadSource').value = '';
  document.getElementById('mGeoScope').value = '';
  document.querySelectorAll('#mRoles input[type="checkbox"]').forEach(cb => { cb.checked = false; });
  document.getElementById('mStage').value = 'new';
  loadedLifecycleStage = 'new';
  document.getElementById('mStageReason').value = '';
  document.getElementById('mTemperature').value = '';
  syncStageFields();
  updateArchiveButtonUI(null);

  CONTACTS = [];
  editingContactId = null;
  resetBpSessionAdds();
  document.getElementById('mNewContactName').value = '';
  document.getElementById('mNewContactPosition').value = '';
  document.getElementById('mNewContactEmail').value = '';
  document.getElementById('mNewContactPhone').value = '';
  document.getElementById('mNewContactDecisionRole').value = '';
  document.getElementById('mNewContactInfluence').value = '';
  document.getElementById('mNewContactStance').value = '';
  document.getElementById('mNewContactPrimary').checked = false;
  renderContactReportsToOptions();
  document.getElementById('mAddContact').textContent = T('form.add');
  document.getElementById('mCancelEditContact').style.display = 'none';
  document.getElementById('mNewNote').value = '';
  document.getElementById('mNotesSearch').value = '';
  notesSearchTerm = '';
  NOTES = [];
  document.getElementById('mLastUpdated').textContent = '—';
  document.getElementById('mLastUpdatedBy').textContent = '—';
  document.getElementById('mChangedBadge').classList.add('hidden');

  // CRM Phase C2 — activity timeline + next-actions tasks
  ACTIVITIES = [];
  document.getElementById('mNewActivityKind').value = 'call';
  document.getElementById('mNewActivityOutcome').value = '';
  document.getElementById('mNewActivityContact').innerHTML = '';
  document.getElementById('mNewActivitySummary').value = '';
  document.getElementById('mNewActivityNextStep').value = '';
  BP_TASKS = [];
  document.getElementById('mNewTaskTitle').value = '';
  document.getElementById('mNewTaskDue').value = '';

  // CRM Phase C3 — opportunities
  OPPORTUNITIES = [];
  document.getElementById('mNewOppName').value = '';
  document.getElementById('mNewOppValue').value = '';
  document.getElementById('mNewOppExpectedClose').value = '';
  document.getElementById('mNewOppSource').value = '';
  renderOpportunityPickers();

  // CRM Phase C4 — tags
  TAGS = [];
  document.getElementById('mTagList').innerHTML = '';
  document.getElementById('mNewTagLabel').value = '';

  const loadingMsg = usingDemoData ? T('bp.demo.notAvailable') : T('common.loading');
  document.getElementById('mContactsList').innerHTML = `<div class="sub-empty">${loadingMsg}</div>`;
  document.getElementById('mNotesList').innerHTML = `<div class="sub-empty">${loadingMsg}</div>`;
  document.getElementById('mTaxCompanyList').innerHTML = `<div class="sub-empty">${loadingMsg}</div>`;
  document.getElementById('mActivityList').innerHTML = `<div class="sub-empty">${loadingMsg}</div>`;
  document.getElementById('mTaskList').innerHTML = `<div class="sub-empty">${loadingMsg}</div>`;
  document.getElementById('mOpportunityList').innerHTML = `<div class="sub-empty">${loadingMsg}</div>`;
  document.getElementById('historyList').innerHTML = `<div class="sub-empty">${loadingMsg}</div>`;
  TAX_COMPANIES = [];
  resetTaxCompanyForm();

  document.querySelectorAll('[data-mtab]').forEach(b => b.setAttribute('aria-selected', b.dataset.mtab === 'general' ? 'true' : 'false'));
  document.getElementById('paneGeneral').classList.remove('hidden');
  document.getElementById('paneTimeline').classList.add('hidden');
  document.getElementById('paneOpportunities').classList.add('hidden');
  document.getElementById('paneInvoicing').classList.add('hidden');

  // "Data has changed" badge — same pattern as the Projects modal: attach a
  // once-only input listener to every field, right before showing the
  // modal, so programmatic value-setting above doesn't itself trigger it.
  document.querySelectorAll('#modalOverlay input, #modalOverlay select').forEach(el => {
    el.addEventListener('input', () => document.getElementById('mChangedBadge').classList.remove('hidden'), { once: true });
  });

  modalOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';

  if (usingDemoData) return;

  try {
    const detail = await HITT_API.getBusinessPartner(id);
    if (activeBpId !== id) return;
    document.getElementById('mName').value = detail.name || '';
    document.getElementById('mCompanyType').innerHTML = lookupOptionsHtml(LOOKUPS.companyTypes, detail.companytypeid, true);
    document.getElementById('mLanguage').innerHTML = lookupOptionsHtml(LOOKUPS.languages, detail.languageid, true);
    document.getElementById('mCountry').innerHTML = lookupOptionsHtml(LOOKUPS.countries, detail.countryid, true);
    document.getElementById('mWebpage').value = detail.webpage || '';
    document.getElementById('mStreetName').value = detail.streetname || '';
    document.getElementById('mCity').value = detail.city || '';
    document.getElementById('mState').value = detail.state || '';
    document.getElementById('mZipCode').value = detail.zipcode || '';
    document.getElementById('mPhone1').value = detail.phonenumber || '';
    document.getElementById('mPhone2').value = detail.phonenumber2 || '';
    // lastupdated/lastUpdatedByName aren't in the schema yet (businesspartners
    // has no lastupdated/lastupdatedby columns, unlike projects) — this is
    // ready for whenever that migration lands; shows '—' until then.
    document.getElementById('mLastUpdated').textContent = detail.lastupdated
      ? new Date(detail.lastupdated).toLocaleString() : '—';
    document.getElementById('mLastUpdatedBy').textContent = detail.lastUpdatedByName || '—';

    document.getElementById('mCategory').value = detail.category || '';
    document.getElementById('mOwner').innerHTML = employeeOptionsHtml(detail.ownerEmployeeId, '—');
    document.getElementById('mLeadSource').value = detail.leadSource || '';
    document.getElementById('mGeoScope').value = detail.geoScope || '';
    document.querySelectorAll('#mRoles input[type="checkbox"]').forEach(cb => {
      cb.checked = Array.isArray(detail.roles) && detail.roles.includes(cb.value);
    });
    document.getElementById('mStage').value = detail.lifecycleStage || 'new';
    loadedLifecycleStage = detail.lifecycleStage || 'new';
    document.getElementById('mTemperature').value = detail.temperature || '';
    syncStageFields();
    updateArchiveButtonUI(detail.archivedAt);
  } catch (err) {
    console.warn(`Could not load full detail for business partner ${id}:`, err);
  }

  try {
    const [contacts, notes, taxCompanies] = await Promise.all([
      HITT_API.getBusinessPartnerContacts(id),
      HITT_API.getBusinessPartnerNotes(id),
      HITT_API.getBusinessPartnerTaxCompanies(id),
    ]);
    if (activeBpId !== id) return;
    renderContacts(contacts);
    renderNotes(notes);
    renderTaxCompanies(taxCompanies);
    renderActivityContactOptions(); // depends on the contacts list just loaded
    snapshotBpSubitems(contacts, taxCompanies); // baseline for discard-revert
  } catch (err) {
    console.warn(`Could not load contacts/notes/tax companies for business partner ${id}:`, err);
  }

  try {
    const [activities, tasks] = await Promise.all([
      HITT_API.getBusinessPartnerActivities(id),
      HITT_API.getTasks({ entityType: 'customer_partner', entityId: id }),
    ]);
    if (activeBpId !== id) return;
    renderActivities(activities);
    renderBpTasks(tasks);
  } catch (err) {
    console.warn(`Could not load activities/tasks for business partner ${id}:`, err);
  }

  try {
    const opportunities = await HITT_API.getBusinessPartnerOpportunities(id);
    if (activeBpId !== id) return;
    renderOpportunities(opportunities);
  } catch (err) {
    console.warn(`Could not load opportunities for business partner ${id}:`, err);
  }

  try {
    const tags = await HITT_API.getBusinessPartnerTags(id);
    if (activeBpId !== id) return;
    renderTags(tags);
  } catch (err) {
    console.warn(`Could not load tags for business partner ${id}:`, err);
  }

  try {
    const history = await HITT_API.getBusinessPartnerHistory(id);
    if (activeBpId !== id) return;
    renderHistory(history);
  } catch (err) {
    console.warn(`Could not load history for business partner ${id}:`, err);
    document.getElementById('historyList').innerHTML = `<div class="sub-empty">${T("common.couldNotLoad")}</div>`;
  }
}

const BP_MODAL_TRANSIENT_IDS = [
  'mNewContactName', 'mNewContactPosition', 'mNewContactEmail', 'mNewContactPhone',
  'mNewContactDecisionRole', 'mNewContactInfluence', 'mNewContactStance', 'mNewContactReportsTo',
  'mNewNote',
  'mTcName', 'mTcVat', 'mTcEmail', 'mTcStreet', 'mTcCity', 'mTcState', 'mTcZip', 'mTcPhone1', 'mTcPhone2',
  'mNewActivitySummary', 'mNewActivityNextStep', 'mNewTaskTitle',
  'mNewOppName', 'mNewOppValue', 'mNewOppSource',
  'mNewTagLabel',
];

// Sub-item changes made during the current modal session. Each "Add" /
// "Save" / delete on a sub-row persists immediately, so a confirmed
// discard undoes them: session-added rows are deleted, edited pre-existing
// rows are PATCHed back to how they loaded, deleted pre-existing rows are
// re-created. Reset on open, cleared on Save.
let bpSessionAdds = { contacts: [], notes: [], taxCompanies: [] };
let bpOrigContacts = new Map();        // String(id) -> row as loaded
let bpOrigTaxCompanies = new Map();
let bpEditedContacts = new Set();      // String(id) of pre-existing rows edited this session
let bpEditedTaxCompanies = new Set();
let bpDeletedContacts = [];            // original rows of pre-existing contacts deleted this session
let bpDeletedTaxCompanies = [];

function resetBpSessionAdds(){
  bpSessionAdds = { contacts: [], notes: [], taxCompanies: [] };
  bpEditedContacts = new Set();
  bpEditedTaxCompanies = new Set();
  bpDeletedContacts = [];
  bpDeletedTaxCompanies = [];
  bpOrigContacts = new Map();          // repopulated by snapshotBpSubitems on load
  bpOrigTaxCompanies = new Map();
}
function snapshotBpSubitems(contacts, taxCompanies){
  bpOrigContacts = new Map((contacts || []).map(c => [String(c.id), { ...c }]));
  bpOrigTaxCompanies = new Map((taxCompanies || []).map(tc => [String(tc.id), { ...tc }]));
}
function bpHasSessionAdds(){
  return bpSessionAdds.contacts.length || bpSessionAdds.notes.length || bpSessionAdds.taxCompanies.length;
}
function bpHasSessionChanges(){
  return bpHasSessionAdds()
    || bpEditedContacts.size > 0 || bpEditedTaxCompanies.size > 0
    || bpDeletedContacts.length > 0 || bpDeletedTaxCompanies.length > 0;
}
function contactRevertPayload(o){
  return {
    contactname: o.contactname || '',
    position: o.position || null,
    emailaddress: o.emailaddress || null,
    phonenumber: o.phonenumber || null,
    employeeId: currentEmployeeId,
    decisionRole: o.decisionRole || null,
    influence: o.influence || null,
    stance: o.stance || null,
    reportsToContactId: o.reportsToContactId || null,
    isPrimary: !!o.isPrimary,
  };
}
function tcRevertPayload(o){
  return {
    taxcompanyname: o.taxcompanyname || '',
    vatnumber: o.vatnumber || null,
    emailinvoicing: o.emailinvoicing || null,
    sameAddress: !!o.sameAddress,
    address: o.sameAddress ? null : {
      streetname: o.streetname || null,
      city: o.city || null,
      state: o.state || null,
      zipcode: o.zipcode || null,
      phonenumber: o.phonenumber || null,
      phonenumber2: o.phonenumber2 || null,
      countryid: o.countryid != null ? Number(o.countryid) : null,
    },
  };
}
async function discardBpSessionChanges(){
  const bpId = activeBpId;
  if (!bpId) return;
  const jobs = [
    ...bpSessionAdds.contacts.map(cId => HITT_API.deleteBusinessPartnerContact(bpId, cId, currentEmployeeId)),
    ...bpSessionAdds.notes.map(nId => HITT_API.deleteBusinessPartnerNote(bpId, nId)),
    ...bpSessionAdds.taxCompanies.map(tcId => HITT_API.deleteBusinessPartnerTaxCompany(bpId, tcId)),
    ...[...bpEditedContacts].map(cId => {
      const o = bpOrigContacts.get(String(cId));
      return o ? HITT_API.updateBusinessPartnerContact(bpId, cId, contactRevertPayload(o)) : Promise.resolve();
    }),
    ...[...bpEditedTaxCompanies].map(tcId => {
      const o = bpOrigTaxCompanies.get(String(tcId));
      return o ? HITT_API.updateBusinessPartnerTaxCompany(bpId, tcId, tcRevertPayload(o)) : Promise.resolve();
    }),
    ...bpDeletedContacts.map(o => HITT_API.addBusinessPartnerContact(bpId, contactRevertPayload(o))),
    ...bpDeletedTaxCompanies.map(o => HITT_API.addBusinessPartnerTaxCompany(bpId, tcRevertPayload(o))),
  ];
  resetBpSessionAdds();
  const results = await Promise.allSettled(jobs);
  const failed = results.filter(r => r.status === 'rejected').length;
  if (failed) toast(T('bp.revertFailed', { count: failed }), 'red');
}

// Unsaved work in the modal: an edited main field ("Data has changed"),
// text sitting in an add row (contact / note / tax company), a contact /
// tax company mid-edit, or a sub-item added this session.
function bpModalHasUnsaved(){
  if (!document.getElementById('mChangedBadge').classList.contains('hidden')) return true;
  if (editingContactId || editingTcId) return true;
  if (bpHasSessionChanges()) return true;
  return BP_MODAL_TRANSIENT_IDS.some(id => String(document.getElementById(id)?.value || '').trim() !== '');
}

function clearBpModalTransient(){
  BP_MODAL_TRANSIENT_IDS.forEach(id => { const el = document.getElementById(id); if (el) el.value = ''; });
  document.getElementById('mChangedBadge').classList.add('hidden');
  editingContactId = null;
  resetTaxCompanyForm();
}

function closeDetailModal(){
  modalOverlay.classList.add('hidden');
  document.body.style.overflow = '';
  activeBpId = null;
}

// Cancel (✕ / click-outside / Esc): confirm before dropping unsaved edits.
// Confirming also deletes any contacts / notes / tax companies added this
// session (each "Add" persisted immediately).
async function requestCloseDetailModal(){
  if (!bpModalHasUnsaved()) { closeDetailModal(); return; }
  const msg = bpHasSessionChanges()
    ? 'Discard your changes? Contacts, notes and tax companies you added, edited or deleted will be reverted.'
    : 'Discard your unsaved changes to this customer/partner?';
  if (!confirm(msg)) return;
  if (bpHasSessionChanges()) await discardBpSessionChanges();
  clearBpModalTransient();
  closeDetailModal();
}

const historyPanel = document.getElementById('historyPanel');
const historyCollapseBtn = document.getElementById('historyCollapse');
let historyCollapsed = false;
// Direct inline-style toggle, not a CSS class — see projects.js's
// identical fix for why (a class + !important toggled fine but failed to
// visually collapse for a real user).
historyCollapseBtn.addEventListener('click', () => {
  historyCollapsed = !historyCollapsed;
  historyPanel.style.width = historyCollapsed ? '0px' : '300px';
  historyPanel.style.borderLeft = historyCollapsed ? 'none' : '';
  historyCollapseBtn.textContent = historyCollapsed ? '«' : '»';
  historyCollapseBtn.title = historyCollapsed ? 'Expand history' : 'Collapse history';
});

document.getElementById('mClose').addEventListener('click', requestCloseDetailModal);
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) requestCloseDetailModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) requestCloseDetailModal();
  if (e.key === 'Escape' && !newBpOverlay.classList.contains('hidden')) closeNewBpModal();
});

document.querySelectorAll('[data-mtab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-mtab]').forEach(b => b.setAttribute('aria-selected', 'false'));
    btn.setAttribute('aria-selected', 'true');
    document.getElementById('paneGeneral').classList.toggle('hidden', btn.dataset.mtab !== 'general');
    document.getElementById('paneTimeline').classList.toggle('hidden', btn.dataset.mtab !== 'timeline');
    document.getElementById('paneOpportunities').classList.toggle('hidden', btn.dataset.mtab !== 'opportunities');
    document.getElementById('paneInvoicing').classList.toggle('hidden', btn.dataset.mtab !== 'invoicing');
  });
});

document.getElementById('mSave').addEventListener('click', async () => {
  if (!activeBpId) return;
  const name = document.getElementById('mName').value.trim();
  if (!name) { toast(T('common.nameRequired'), 'red'); return; }
  const languageId = document.getElementById('mLanguage').value;
  if (!languageId) { toast(T('bp.langRequired'), 'red'); return; }
  document.getElementById('mChangedBadge').classList.add('hidden');
  resetBpSessionAdds(); // Save commits everything added this session

  const ownerEmployeeId = document.getElementById('mOwner').value;
  const roles = [...document.querySelectorAll('#mRoles input[type="checkbox"]:checked')].map(cb => cb.value);

  const payload = {
    name,
    employeeId: currentEmployeeId,
    companyTypeId: document.getElementById('mCompanyType').value ? Number(document.getElementById('mCompanyType').value) : null,
    languageId: Number(languageId),
    webpage: document.getElementById('mWebpage').value || null,
    address: {
      streetname: document.getElementById('mStreetName').value || null,
      city: document.getElementById('mCity').value || null,
      state: document.getElementById('mState').value || null,
      zipcode: document.getElementById('mZipCode').value || null,
      phonenumber: document.getElementById('mPhone1').value || null,
      phonenumber2: document.getElementById('mPhone2').value || null,
      countryid: document.getElementById('mCountry').value ? Number(document.getElementById('mCountry').value) : null,
    },
    category: document.getElementById('mCategory').value.trim() || null,
    roles,
    ownerEmployeeId: ownerEmployeeId ? Number(ownerEmployeeId) : null,
    leadSource: document.getElementById('mLeadSource').value.trim() || null,
    geoScope: document.getElementById('mGeoScope').value || null,
    lifecycleStage: document.getElementById('mStage').value,
    stageReason: document.getElementById('mStageReason').value.trim() || null,
    temperature: document.getElementById('mTemperature').value || null,
  };

  if (usingDemoData) {
    const p = PARTNERS.find(x => x.id === activeBpId);
    if (p) p.name = name;
    renderTable();
    closeDetailModal();
    toast(T('bp.demo.saved'), 'green');
    return;
  }

  try {
    await HITT_API.updateBusinessPartner(activeBpId, payload);
    const p = PARTNERS.find(x => x.id === activeBpId);
    if (p) {
      Object.assign(p, {
        name, category: payload.category, roles: payload.roles,
        lifecycleStage: payload.lifecycleStage, temperature: payload.temperature,
        ownerEmployeeId: payload.ownerEmployeeId,
        ownerName: (EMPLOYEES.find(e => String(e.id) === String(payload.ownerEmployeeId)) || {}).name || null,
        leadSource: payload.leadSource, geoScope: payload.geoScope,
      });
    }
    renderTable();
    closeDetailModal();
    toast(T('toast.bpSaved'), 'green');
  } catch (err) {
    console.error(err);
    toast(T('common.couldNotSave'), 'red');
  }
});

document.getElementById('mAddContact').addEventListener('click', async () => {
  const f = contactFormInputs();
  const name = f.name.value.trim();
  if (!name || !activeBpId) return;
  if (usingDemoData) { toast(T('bp.demo.noContacts'), 'navy'); return; }
  const payload = {
    contactname: name,
    position: f.position.value.trim() || null,
    emailaddress: f.email.value.trim() || null,
    phonenumber: f.phone.value.trim() || null,
    employeeId: currentEmployeeId,
    decisionRole: f.decisionRole.value || null,
    influence: f.influence.value || null,
    stance: f.stance.value || null,
    reportsToContactId: f.reportsTo.value ? Number(f.reportsTo.value) : null,
    isPrimary: f.primary.checked,
  };
  const wasEditing = editingContactId;
  try {
    if (wasEditing) {
      await HITT_API.updateBusinessPartnerContact(activeBpId, wasEditing, payload);
      if (bpOrigContacts.has(String(wasEditing)) &&
          !bpSessionAdds.contacts.some(x => String(x) === String(wasEditing))) {
        bpEditedContacts.add(String(wasEditing));
      }
    } else {
      const created = await HITT_API.addBusinessPartnerContact(activeBpId, payload);
      if (created && created.id != null) bpSessionAdds.contacts.push(created.id);
    }
    CONTACTS = await HITT_API.getBusinessPartnerContacts(activeBpId);
    cancelEditContact(); // clears inputs, resets the button, re-renders
    toast(T(wasEditing ? 'toast.contactUpdated' : 'toast.contactAdded'), 'green');
  } catch (err) {
    console.error(err);
    toast(T('toast.contactSaveFail'), 'red');
  }
});

document.getElementById('mCancelEditContact').addEventListener('click', cancelEditContact);

document.getElementById('mAddNote').addEventListener('click', async () => {
  const text = document.getElementById('mNewNote').value.trim();
  if (!text || !activeBpId) return;
  if (usingDemoData) { toast(T('bp.demo.noNotes'), 'navy'); return; }
  try {
    const created = await HITT_API.addBusinessPartnerNote(activeBpId, { notes: text, employeeId: currentEmployeeId });
    if (created && created.id != null) bpSessionAdds.notes.push(created.id);
    document.getElementById('mNewNote').value = '';
    renderNotes(await HITT_API.getBusinessPartnerNotes(activeBpId));
    toast(T('toast.noteAdded'), 'green');
  } catch (err) {
    console.error(err);
    toast(T('toast.noteSaveFail'), 'red');
  }
});

document.getElementById('mNewNote').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('mAddNote').click();
});
document.getElementById('mNewContactName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('mAddContact').click();
  if (e.key === 'Escape' && editingContactId) { e.stopPropagation(); cancelEditContact(); }
});
document.getElementById('mNotesSearch').addEventListener('input', (e) => {
  notesSearchTerm = e.target.value.trim();
  renderNotes();
});

// Unlike contacts/notes/tax companies, a logged activity or a created task
// is NOT reverted by "discard changes" on modal cancel — an activity is a
// record that something really happened (a call, a meeting), and a task
// can be platform-wide, so cancelling this modal shouldn't un-log either.
// The unsaved-text guard (BP_MODAL_TRANSIENT_IDS) still stops a half-typed
// activity/task from silently vanishing on close.
document.getElementById('mAddActivity').addEventListener('click', async () => {
  const summary = document.getElementById('mNewActivitySummary').value.trim();
  if (!summary || !activeBpId) { if (!summary) toast(T('bp.activity.summaryRequired'), 'red'); return; }
  if (usingDemoData) { toast(T('bp.demo.notAvailable'), 'navy'); return; }
  const contactId = document.getElementById('mNewActivityContact').value;
  const payload = {
    kind: document.getElementById('mNewActivityKind').value,
    outcome: document.getElementById('mNewActivityOutcome').value || null,
    contactId: contactId ? Number(contactId) : null,
    summary,
    agreedNextStep: document.getElementById('mNewActivityNextStep').value.trim() || null,
  };
  const btn = document.getElementById('mAddActivity');
  btn.disabled = true;
  try {
    await HITT_API.addBusinessPartnerActivity(activeBpId, payload);
    document.getElementById('mNewActivitySummary').value = '';
    document.getElementById('mNewActivityNextStep').value = '';
    document.getElementById('mNewActivityOutcome').value = '';
    document.getElementById('mNewActivityContact').value = '';
    renderActivities(await HITT_API.getBusinessPartnerActivities(activeBpId));
    toast(T('toast.activityAdded'), 'green');
  } catch (err) {
    console.error(err);
    toast(T('toast.activitySaveFail'), 'red');
  } finally {
    btn.disabled = false;
  }
});

document.getElementById('mAddTask').addEventListener('click', async () => {
  const title = document.getElementById('mNewTaskTitle').value.trim();
  if (!title) { toast(T('bp.task.titleRequired'), 'red'); return; }
  if (!activeBpId || usingDemoData) { if (usingDemoData) toast(T('bp.demo.notAvailable'), 'navy'); return; }
  const dueDate = document.getElementById('mNewTaskDue').value || null;
  const btn = document.getElementById('mAddTask');
  btn.disabled = true;
  try {
    await HITT_API.createTask({
      title, dueDate, ownerEmployeeId: currentEmployeeId,
      entityType: 'customer_partner', entityId: activeBpId,
    });
    document.getElementById('mNewTaskTitle').value = '';
    document.getElementById('mNewTaskDue').value = '';
    renderBpTasks(await HITT_API.getTasks({ entityType: 'customer_partner', entityId: activeBpId }));
    toast(T('toast.taskAdded'), 'green');
  } catch (err) {
    console.error(err);
    toast(T('toast.taskSaveFail'), 'red');
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('mNewTaskTitle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('mAddTask').click();
});

// Same discard-behavior decision as activities/tasks (see the comment
// above mAddActivity): an opportunity created or moved from this modal is
// NOT reverted by "discard changes" on cancel.
document.getElementById('mAddOpportunity').addEventListener('click', async () => {
  const name = document.getElementById('mNewOppName').value.trim();
  if (!name) { toast(T('bp.opportunity.nameRequired'), 'red'); return; }
  if (!activeBpId || usingDemoData) { if (usingDemoData) toast(T('bp.demo.notAvailable'), 'navy'); return; }
  const currencyId = document.getElementById('mNewOppCurrency').value;
  const ownerEmployeeId = document.getElementById('mNewOppOwner').value;
  const value = document.getElementById('mNewOppValue').value;
  const payload = {
    name,
    estimatedValue: value ? Number(value) : null,
    currencyId: currencyId ? Number(currencyId) : null,
    ownerEmployeeId: ownerEmployeeId ? Number(ownerEmployeeId) : null,
    expectedClose: document.getElementById('mNewOppExpectedClose').value || null,
    source: document.getElementById('mNewOppSource').value.trim() || null,
  };
  const btn = document.getElementById('mAddOpportunity');
  btn.disabled = true;
  try {
    await HITT_API.addBusinessPartnerOpportunity(activeBpId, payload);
    document.getElementById('mNewOppName').value = '';
    document.getElementById('mNewOppValue').value = '';
    document.getElementById('mNewOppExpectedClose').value = '';
    document.getElementById('mNewOppSource').value = '';
    renderOpportunities(await HITT_API.getBusinessPartnerOpportunities(activeBpId));
    toast(T('toast.opportunityAdded'), 'green');
  } catch (err) {
    console.error(err);
    toast(err.message || T('toast.opportunitySaveFail'), 'red');
  } finally {
    btn.disabled = false;
  }
});
document.getElementById('mNewOppName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('mAddOpportunity').click();
});

document.getElementById('mAddTag').addEventListener('click', async () => {
  const label = document.getElementById('mNewTagLabel').value.trim();
  if (!label || !activeBpId) return;
  if (usingDemoData) { toast(T('bp.demo.notAvailable'), 'navy'); return; }
  try {
    const tag = await HITT_API.addBusinessPartnerTag(activeBpId, label);
    document.getElementById('mNewTagLabel').value = '';
    renderTags(await HITT_API.getBusinessPartnerTags(activeBpId));
    syncPartnerTagsInList();
    if (!ALL_TAGS.some(t => t.id === tag.id)) {
      ALL_TAGS.push(tag);
      renderTagFilterOptions();
      renderTagDatalist();
    }
    toast(T('toast.tagAdded'), 'green');
  } catch (err) {
    console.error(err);
    toast(err.message || T('toast.tagSaveFail'), 'red');
  }
});
document.getElementById('mNewTagLabel').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('mAddTag').click(); }
});

document.getElementById('mTcSameAddress').addEventListener('change', syncTcAddressVisibility);
document.getElementById('mTcFiscalIdType')?.addEventListener('change', syncTcFiscalCountry);
document.getElementById('mTcCancel').addEventListener('click', () => { resetTaxCompanyForm(); renderTaxCompanies(); });

document.getElementById('mTcSave').addEventListener('click', async () => {
  if (!activeBpId) return;
  if (usingDemoData) { toast(T('bp.demo.noTaxCompanies'), 'navy'); return; }
  const payload = taxCompanyPayload();
  if (!payload.taxcompanyname) { toast(T('bp.tcNameRequired'), 'red'); return; }
  if (VF_ON && payload.fiscalIdType && payload.fiscalIdType !== 'nif' && !/^[A-Z]{2}$/.test(payload.fiscalCountry || '')) {
    toast(T('bp.tc.fiscalCountryRequired'), 'red'); return;
  }
  const wasEditing = editingTcId;
  const btn = document.getElementById('mTcSave');
  btn.disabled = true;
  try {
    if (wasEditing) {
      await HITT_API.updateBusinessPartnerTaxCompany(activeBpId, wasEditing, payload);
      if (bpOrigTaxCompanies.has(String(wasEditing)) &&
          !bpSessionAdds.taxCompanies.some(x => String(x) === String(wasEditing))) {
        bpEditedTaxCompanies.add(String(wasEditing));
      }
    } else {
      const created = await HITT_API.addBusinessPartnerTaxCompany(activeBpId, payload);
      if (created && created.id != null) bpSessionAdds.taxCompanies.push(created.id);
    }
    TAX_COMPANIES = await HITT_API.getBusinessPartnerTaxCompanies(activeBpId);
    resetTaxCompanyForm();
    renderTaxCompanies();
    toast(T(wasEditing ? 'toast.tcUpdated' : 'toast.tcAdded'), 'green');
  } catch (err) {
    console.error(err);
    toast(err.message || T('toast.tcSaveFail'), 'red');
  } finally {
    btn.disabled = false;
  }
});

/* ============================== NEW BP MODAL ============================= */
const newBpOverlay = document.getElementById('newBpOverlay');

// Contacts entered on the New BP form are collected here and POSTed one by
// one right after the partner is created (a contact row needs a bpid to
// attach to, so it can't be saved until then).
let npContacts = [];
let npEditingContactIndex = null;

function npContactFormInputs(){
  return {
    name: document.getElementById('npNewContactName'),
    position: document.getElementById('npNewContactPosition'),
    email: document.getElementById('npNewContactEmail'),
    phone: document.getElementById('npNewContactPhone'),
  };
}

function renderNpContacts(){
  const list = document.getElementById('npContactsList');
  if (!npContacts.length) {
    list.innerHTML = `<div class="sub-empty">${T("bp.empty.contactsNew")}</div>`;
    return;
  }
  list.innerHTML = npContacts.map((c, i) => `
    <div class="sub-item ${npEditingContactIndex === i ? 'is-editing' : ''}">
      <div class="sub-item-row">
        <span class="sub-item-title">${escapeHtml(c.contactname)}</span>
        <span style="display:flex; align-items:center; gap:0.35rem;">
          <span class="sub-item-meta">${escapeHtml(c.position || '')}</span>
          <button type="button" data-edit-np-contact="${i}" class="sub-item-btn" title="Edit">✎</button>
          <button type="button" data-remove-np-contact="${i}" class="sub-item-btn sub-item-btn--danger" title="Remove">✕</button>
        </span>
      </div>
      <div class="sub-item-meta">${escapeHtml(c.emailaddress || '—')}${c.phonenumber ? ' · ' + escapeHtml(c.phonenumber) : ''}</div>
    </div>
  `).join('');
  list.querySelectorAll('[data-edit-np-contact]').forEach(btn => {
    btn.addEventListener('click', () => startEditNpContact(Number(btn.dataset.editNpContact)));
  });
  list.querySelectorAll('[data-remove-np-contact]').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = Number(btn.dataset.removeNpContact);
      npContacts.splice(i, 1);
      if (npEditingContactIndex === i) cancelEditNpContact();
      else { if (npEditingContactIndex > i) npEditingContactIndex--; renderNpContacts(); }
    });
  });
}

function startEditNpContact(i){
  const c = npContacts[i];
  if (!c) return;
  npEditingContactIndex = i;
  const f = npContactFormInputs();
  f.name.value = c.contactname || '';
  f.position.value = c.position || '';
  f.email.value = c.emailaddress || '';
  f.phone.value = c.phonenumber || '';
  document.getElementById('npAddContact').textContent = T('form.save');
  document.getElementById('npCancelEditContact').style.display = '';
  renderNpContacts();
  f.name.focus();
}

function cancelEditNpContact(){
  npEditingContactIndex = null;
  const f = npContactFormInputs();
  [f.name, f.position, f.email, f.phone].forEach(el => { el.value = ''; });
  document.getElementById('npAddContact').textContent = T('form.add');
  document.getElementById('npCancelEditContact').style.display = 'none';
  renderNpContacts();
}

document.getElementById('npAddContact').addEventListener('click', () => {
  const f = npContactFormInputs();
  const name = f.name.value.trim();
  if (!name) { toast(T('bp.contactNameRequired'), 'red'); return; }
  const contact = {
    contactname: name,
    position: f.position.value.trim() || null,
    emailaddress: f.email.value.trim() || null,
    phonenumber: f.phone.value.trim() || null,
  };
  if (npEditingContactIndex != null) npContacts[npEditingContactIndex] = contact;
  else npContacts.push(contact);
  cancelEditNpContact(); // clears inputs, resets button, re-renders
  f.name.focus();
});
document.getElementById('npCancelEditContact').addEventListener('click', cancelEditNpContact);
document.getElementById('npNewContactName').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('npAddContact').click(); }
  if (e.key === 'Escape' && npEditingContactIndex != null) { e.stopPropagation(); cancelEditNpContact(); }
});

function openNewBpModal(){
  document.getElementById('npName').value = '';
  document.getElementById('npCompanyType').innerHTML = lookupOptionsHtml(LOOKUPS.companyTypes, null, true);
  document.getElementById('npLanguage').innerHTML = lookupOptionsHtml(LOOKUPS.languages, null, true);
  document.getElementById('npCountry').innerHTML = lookupOptionsHtml(LOOKUPS.countries, null, true);
  document.getElementById('npWebpage').value = '';
  ['npStreetName', 'npCity', 'npState', 'npZipCode', 'npPhone1', 'npPhone2'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('npCategory').value = '';
  document.getElementById('npOwner').innerHTML = employeeOptionsHtml(null, '—');
  document.getElementById('npLeadSource').value = '';
  document.getElementById('npGeoScope').value = '';
  document.querySelectorAll('#npRoles input[type="checkbox"]').forEach(cb => { cb.checked = false; });
  npContacts = [];
  cancelEditNpContact(); // clears the contact inputs, button state, and re-renders the (now empty) list
  newBpOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('npName').focus(), 50);
}

function closeNewBpModal(){
  newBpOverlay.classList.add('hidden');
  document.body.style.overflow = '';
}

document.getElementById('btnNewBp').addEventListener('click', openNewBpModal);
document.getElementById('npClose').addEventListener('click', closeNewBpModal);
document.getElementById('npCancel').addEventListener('click', closeNewBpModal);
newBpOverlay.addEventListener('click', (e) => { if (e.target === newBpOverlay) closeNewBpModal(); });

document.getElementById('npSave').addEventListener('click', async () => {
  const name = document.getElementById('npName').value.trim();
  if (!name) { toast(T('common.nameRequired'), 'red'); return; }
  const languageId = document.getElementById('npLanguage').value;
  if (!languageId) { toast(T('bp.langRequired'), 'red'); return; }
  const companyTypeId = document.getElementById('npCompanyType').value ? Number(document.getElementById('npCompanyType').value) : null;
  const npOwnerEmployeeId = document.getElementById('npOwner').value;
  const payload = {
    name,
    employeeId: currentEmployeeId,
    companyTypeId,
    languageId: Number(languageId),
    webpage: document.getElementById('npWebpage').value || null,
    address: {
      streetname: document.getElementById('npStreetName').value || null,
      city: document.getElementById('npCity').value || null,
      state: document.getElementById('npState').value || null,
      zipcode: document.getElementById('npZipCode').value || null,
      phonenumber: document.getElementById('npPhone1').value || null,
      phonenumber2: document.getElementById('npPhone2').value || null,
      countryid: document.getElementById('npCountry').value ? Number(document.getElementById('npCountry').value) : null,
    },
    category: document.getElementById('npCategory').value.trim() || null,
    roles: [...document.querySelectorAll('#npRoles input[type="checkbox"]:checked')].map(cb => cb.value),
    ownerEmployeeId: npOwnerEmployeeId ? Number(npOwnerEmployeeId) : null,
    leadSource: document.getElementById('npLeadSource').value.trim() || null,
    geoScope: document.getElementById('npGeoScope').value || null,
  };

  if (usingDemoData) {
    const id = Math.max(0, ...PARTNERS.map(p => p.id)) + 1;
    PARTNERS.push({ id, name, companyTypeLabel: '—', countryLabel: '—', webpage: payload.webpage || '' });
    renderTable();
    closeNewBpModal();
    toast(T('bp.demo.created'), 'green');
    return;
  }

  try {
    const created = await HITT_API.createBusinessPartner(payload);
    if (npContacts.length) {
      const results = await Promise.allSettled(
        npContacts.map(c => HITT_API.addBusinessPartnerContact(created.id, c))
      );
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed) {
        toast(T('bp.createdContactsFailed', { count: failed }), 'red');
      }
    }
    await loadPartners();
    closeNewBpModal();
    toast(T('toast.bpCreated'), 'green');
    openDetailModal(created.id);
  } catch (err) {
    console.error(err);
    toast(T('toast.bpCreateFail'), 'red');
  }
});

/* ============================== BP PROJECTS DRILL-DOWN =================== */
const bpProjectsOverlay = document.getElementById('bpProjectsOverlay');

async function openBpProjectsModal(bpId){
  const bp = PARTNERS.find(p => p.id === bpId);
  document.getElementById('bpProjectsTitle').textContent = bp ? `Projects — ${bp.name}` : 'Projects';
  document.getElementById('bpProjectsList').innerHTML = `<tr><td colspan="3" class="sub-empty">${T("common.loading")}</td></tr>`;
  bpProjectsOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  try {
    const rows = await HITT_API.getBusinessPartnerProjects(bpId);
    if (!rows.length) {
      document.getElementById('bpProjectsList').innerHTML = `<tr><td colspan="3" class="sub-empty">${T("bp.drill.noProjects")}</td></tr>`;
      return;
    }
    document.getElementById('bpProjectsList').innerHTML = rows.map(p => `
      <tr>
        <td><a href="projects.html?projectId=${encodeURIComponent(p.id)}">${escapeHtml(p.code || '—')}</a></td>
        <td><a href="projects.html?projectId=${encodeURIComponent(p.id)}">${escapeHtml(p.name || '—')}</a></td>
        <td>${escapeHtml(p.statusLabel || '—')}</td>
      </tr>
    `).join('');
  } catch (err) {
    console.error(err);
    document.getElementById('bpProjectsList').innerHTML = `<tr><td colspan="3" class="sub-empty">${T("common.couldNotLoad")}</td></tr>`;
  }
}

function closeBpProjectsModal(){
  bpProjectsOverlay.classList.add('hidden');
  document.body.style.overflow = '';
}

document.getElementById('bpProjectsClose').addEventListener('click', closeBpProjectsModal);
bpProjectsOverlay.addEventListener('click', (e) => { if (e.target === bpProjectsOverlay) closeBpProjectsModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !bpProjectsOverlay.classList.contains('hidden')) closeBpProjectsModal();
});

/* ============================== BP TAX COMPANIES DRILL-DOWN ============= */
const bpTaxCompaniesOverlay = document.getElementById('bpTaxCompaniesOverlay');

async function openBpTaxCompaniesModal(bpId){
  const bp = PARTNERS.find(p => p.id === bpId);
  document.getElementById('bpTaxCompaniesTitle').textContent = bp ? `Tax companies — ${bp.name}` : 'Tax companies';
  document.getElementById('bpTaxCompaniesList').innerHTML = `<tr><td colspan="3" class="sub-empty">${T("common.loading")}</td></tr>`;
  bpTaxCompaniesOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  try {
    const rows = await HITT_API.getBusinessPartnerTaxCompanies(bpId);
    document.getElementById('bpTaxCompaniesList').innerHTML = rows.length
      ? rows.map(tc => `
        <tr>
          <td>${escapeHtml(tc.taxcompanyname || '(unnamed)')}</td>
          <td>${escapeHtml(tc.vatnumber || '—')}</td>
          <td>${escapeHtml(tc.emailinvoicing || '—')}</td>
        </tr>`).join('')
      : `<tr><td colspan="3" class="sub-empty">${T("bp.drill.noTaxCompanies")}</td></tr>`;
  } catch (err) {
    console.error(err);
    document.getElementById('bpTaxCompaniesList').innerHTML = `<tr><td colspan="3" class="sub-empty">${T("common.couldNotLoad")}</td></tr>`;
  }
}

function closeBpTaxCompaniesModal(){
  bpTaxCompaniesOverlay.classList.add('hidden');
  document.body.style.overflow = '';
}

document.getElementById('bpTaxCompaniesClose').addEventListener('click', closeBpTaxCompaniesModal);
bpTaxCompaniesOverlay.addEventListener('click', (e) => { if (e.target === bpTaxCompaniesOverlay) closeBpTaxCompaniesModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !bpTaxCompaniesOverlay.classList.contains('hidden')) closeBpTaxCompaniesModal();
});

/* ============================== INIT ==================================== */
loadPartners().then(() => {
  // Deep link from the Projects modal's "Edit this business partner" button
  // (business-partners.html?open=<id>).
  const openId = new URLSearchParams(window.location.search).get('open');
  if (openId) {
    const target = PARTNERS.find(p => String(p.id) === openId);
    if (target) openDetailModal(target.id);
  }
});

/* Re-render dynamic content when the UI language changes. */
window.addEventListener('hitt:langchange', () => {
  if (typeof renderTable === 'function') renderTable();
  const detailOpen = !document.getElementById('modalOverlay').classList.contains('hidden');
  if (detailOpen) {
    renderContacts();
    renderNotes();
    renderTaxCompanies();
    renderActivities();
    renderBpTasks();
    renderOpportunities();
    renderOpportunityPickers();
    renderTags();
    updateArchiveButtonUI(document.getElementById('mArchiveToggle').dataset.archived ? new Date().toISOString() : null);
  }
  renderTagFilterOptions();
});
