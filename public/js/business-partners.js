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
HITT_PERMS.guardModule("business-partners", "../welcome.html");
document.getElementById("userName").textContent = session.displayName;
document.getElementById("userAvatar").textContent = HITT_AUTH.initials(session);
document.getElementById("btnSignOut").addEventListener("click", () => HITT_AUTH.signOut("../index.html"));
HITT_PERMS.applyRealName();

// Resolved once and reused for create/update calls so
// businesspartners.lastupdatedby actually records who made the change,
// instead of always landing NULL — mirrors projects.js's currentEmployeeId.
let currentEmployeeId = null;
HITT_PERMS.get().then((perms) => { currentEmployeeId = perms.employeeId; }).catch(() => {});

const DEMO_SEED = [
  { id: 1, name: "Demo Pharma Inc", companyTypeLabel: "Pharmaceutical", countryLabel: "United States", webpage: "https://example.com", projectsAlive: 2, projectsDead: 1, projectsTotal: 3 },
  { id: 2, name: "Demo Biotech Spain", companyTypeLabel: "Start Up", countryLabel: "Spain", webpage: "", projectsAlive: 0, projectsDead: 0, projectsTotal: 0 },
];

let PARTNERS = [];
let LOOKUPS = { entities: [], companyTypes: [], countries: [], languages: [] };
let usingDemoData = false;
let searchTerm = "";
let onlyAliveProjects = false;
let activeBpId = null;
let sortColumn = "name";
let sortDirection = "asc"; // 'asc' | 'desc'

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
    const data = await HITT_API.getBusinessPartners();
    // projectsAlive/Dead/Total come back as strings — Postgres COUNT()
    // is bigint, and node-pg serializes bigints as strings to avoid
    // precision loss. Coerce to Number so the "Number of projects" column
    // sorts numerically (10 > 9), not lexicographically ("10" < "9").
    PARTNERS = data.map(p => ({
      ...p,
      projectsAlive: Number(p.projectsAlive ?? 0),
      projectsDead: Number(p.projectsDead ?? 0),
      projectsTotal: Number(p.projectsTotal ?? 0),
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
  return String(p.name || '').toLowerCase().includes(searchTerm.toLowerCase());
}

function matchesFilters(p){
  if (!matchesSearch(p)) return false;
  if (onlyAliveProjects && Number(p.projectsAlive ?? 0) <= 0) return false;
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
  document.getElementById('bpCount').textContent = `${rows.length} of ${PARTNERS.length}`;

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
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.companyTypeLabel || '—')}</td>
      <td>${escapeHtml(p.countryLabel || '—')}</td>
      <td>${p.webpage ? `<a href="${escapeHtml(p.webpage)}" target="_blank" rel="noopener">${escapeHtml(p.webpage.replace(/^https?:\/\//, ''))}</a>` : '—'}</td>
      <td>
        <span title="Alive / Dead (Total)">${p.projectsAlive ?? 0} / ${p.projectsDead ?? 0} (${p.projectsTotal ?? 0})</span>
        ${p.projectsTotal ? `<button data-bp-projects="${p.id}" class="btn-icon-add" style="margin-left:0.4rem; padding:0.1rem 0.5rem; font-size:0.72rem;" title="View projects">⋯</button>` : ''}
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
}

document.getElementById('searchBox').addEventListener('input', (e) => {
  searchTerm = e.target.value.trim();
  renderTable();
});

document.getElementById('filterAliveProjects').addEventListener('change', (e) => {
  onlyAliveProjects = e.target.checked;
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

// Called with fresh rows (a fetch) or with no argument (re-render after a
// local edit-state change).
function renderContacts(rows){
  if (rows) CONTACTS = rows;
  const list = document.getElementById('mContactsList');
  if (!CONTACTS.length) {
    list.innerHTML = `<div class="sub-empty">No contacts yet</div>`;
    return;
  }
  list.innerHTML = CONTACTS.map(c => `
    <div class="sub-item ${String(editingContactId) === String(c.id) ? 'is-editing' : ''}">
      <div class="sub-item-row">
        <span class="sub-item-title">${escapeHtml(c.contactname)}</span>
        <span style="display:flex; align-items:center; gap:0.35rem;">
          <span class="sub-item-meta">${escapeHtml(c.position || '')}</span>
          <button type="button" data-edit-contact="${c.id}" class="sub-item-btn" title="Edit contact">✎</button>
          <button type="button" data-delete-contact="${c.id}" class="sub-item-btn sub-item-btn--danger" title="Delete contact">✕</button>
        </span>
      </div>
      <div class="sub-item-meta">${escapeHtml(c.emailaddress || '—')}${c.phonenumber ? ' · ' + escapeHtml(c.phonenumber) : ''}</div>
    </div>
  `).join('');
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
  document.getElementById('mAddContact').textContent = 'Save';
  document.getElementById('mCancelEditContact').style.display = '';
  renderContacts();
  f.name.focus();
}

function cancelEditContact(){
  editingContactId = null;
  const f = contactFormInputs();
  [f.name, f.position, f.email, f.phone].forEach(el => { el.value = ''; });
  document.getElementById('mAddContact').textContent = 'Add';
  document.getElementById('mCancelEditContact').style.display = 'none';
  renderContacts();
}

async function deleteContact(id){
  const c = CONTACTS.find(x => String(x.id) === String(id));
  if (!c || !confirm(`Delete contact "${c.contactname || ''}"? This cannot be undone.`)) return;
  try {
    await HITT_API.deleteBusinessPartnerContact(activeBpId, id, currentEmployeeId);
    bpSessionAdds.contacts = bpSessionAdds.contacts.filter(x => String(x) !== String(id));
    const wasEditingThis = String(editingContactId) === String(id);
    CONTACTS = await HITT_API.getBusinessPartnerContacts(activeBpId);
    if (wasEditingThis) cancelEditContact(); // resets the form + re-renders
    else renderContacts();
    toast('Contact deleted', 'navy');
  } catch (err) {
    console.error(err);
    toast('Could not delete the contact.', 'red');
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
    list.innerHTML = `<div class="sub-empty">${NOTES.length ? 'No notes match your search' : 'No notes yet'}</div>`;
    return;
  }
  list.innerHTML = filtered.map(n => `
    <div class="sub-item">
      <div class="sub-item-row">
        <span class="sub-item-title">${escapeHtml(n.authorName || 'Unknown')}</span>
        <span class="sub-item-meta">${formatDateTime(n.commentsts)}</span>
      </div>
      <div style="font-size:0.82rem; white-space:pre-wrap;">${escapeHtml(n.notes)}</div>
    </div>
  `).join('');
}

let TAX_COMPANIES = [];
let editingTcId = null;

function renderTaxCompanies(rows){
  if (rows) TAX_COMPANIES = rows;
  const list = document.getElementById('mTaxCompanyList');
  if (!TAX_COMPANIES.length) {
    list.innerHTML = `<div class="sub-empty">No tax companies yet</div>`;
    return;
  }
  list.innerHTML = TAX_COMPANIES.map(tc => {
    const addrParts = tc.sameAddress
      ? ['Same address as the business partner']
      : [tc.streetname, tc.zipcode, tc.city, tc.state, tc.countryLabel].filter(Boolean);
    return `
      <div class="sub-item ${String(editingTcId) === String(tc.id) ? 'is-editing' : ''}">
        <div class="sub-item-row">
          <span class="sub-item-title">${escapeHtml(tc.taxcompanyname || '—')}</span>
          <span style="display:flex; align-items:center; gap:0.35rem;">
            <span class="sub-item-meta">${escapeHtml(tc.vatnumber || '')}</span>
            <button type="button" data-edit-tc="${tc.id}" class="sub-item-btn" title="Edit tax company">✎</button>
            <button type="button" data-delete-tc="${tc.id}" class="sub-item-btn sub-item-btn--danger" title="Delete tax company">✕</button>
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
  document.getElementById('mTcSave').textContent = 'Add';
  document.getElementById('mTcCancel').style.display = 'none';
  syncTcAddressVisibility();
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
  document.getElementById('mTcSave').textContent = 'Save';
  document.getElementById('mTcCancel').style.display = '';
  syncTcAddressVisibility();
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
  if (!tc || !confirm(`Delete tax company "${tc.taxcompanyname || ''}"? This cannot be undone.`)) return;
  try {
    await HITT_API.deleteBusinessPartnerTaxCompany(activeBpId, id);
    bpSessionAdds.taxCompanies = bpSessionAdds.taxCompanies.filter(x => String(x) !== String(id));
    const wasEditingThis = String(editingTcId) === String(id);
    TAX_COMPANIES = await HITT_API.getBusinessPartnerTaxCompanies(activeBpId);
    if (wasEditingThis) resetTaxCompanyForm();
    renderTaxCompanies();
    toast('Tax company deleted', 'navy');
  } catch (err) {
    console.error(err);
    toast(err.message || 'Could not delete the tax company.', 'red');
  }
}

// businesspartnerchangelog rows — same shape/design as the Projects
// modal's History panel (see renderHistory in projects.js), minus the
// status-history half since business partners have no status field.
function renderHistory(rows){
  const list = document.getElementById('historyList');
  if (!rows || !rows.length) {
    list.innerHTML = `<div class="sub-empty">No history yet</div>`;
    return;
  }
  list.innerHTML = rows.map(h => `
    <div class="history-entry">
      <div class="summary">${escapeHtml(h.summary || '')}</div>
      <div class="meta">
        <span class="who">${escapeHtml(h.changedByName || 'Unknown')}</span>
        <span class="when">${formatDateTime(h.changedAt)}</span>
      </div>
    </div>
  `).join('');
}

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
  CONTACTS = [];
  editingContactId = null;
  resetBpSessionAdds();
  document.getElementById('mNewContactName').value = '';
  document.getElementById('mNewContactPosition').value = '';
  document.getElementById('mNewContactEmail').value = '';
  document.getElementById('mNewContactPhone').value = '';
  document.getElementById('mAddContact').textContent = 'Add';
  document.getElementById('mCancelEditContact').style.display = 'none';
  document.getElementById('mNewNote').value = '';
  document.getElementById('mNotesSearch').value = '';
  notesSearchTerm = '';
  NOTES = [];
  document.getElementById('mLastUpdated').textContent = '—';
  document.getElementById('mLastUpdatedBy').textContent = '—';
  document.getElementById('mChangedBadge').classList.add('hidden');

  const loadingMsg = usingDemoData ? 'Not available in demo data' : 'Loading…';
  document.getElementById('mContactsList').innerHTML = `<div class="sub-empty">${loadingMsg}</div>`;
  document.getElementById('mNotesList').innerHTML = `<div class="sub-empty">${loadingMsg}</div>`;
  document.getElementById('mTaxCompanyList').innerHTML = `<div class="sub-empty">${loadingMsg}</div>`;
  document.getElementById('historyList').innerHTML = `<div class="sub-empty">${loadingMsg}</div>`;
  TAX_COMPANIES = [];
  resetTaxCompanyForm();

  document.querySelectorAll('[data-mtab]').forEach(b => b.setAttribute('aria-selected', b.dataset.mtab === 'general' ? 'true' : 'false'));
  document.getElementById('paneGeneral').classList.remove('hidden');
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
  } catch (err) {
    console.warn(`Could not load contacts/notes/tax companies for business partner ${id}:`, err);
  }

  try {
    const history = await HITT_API.getBusinessPartnerHistory(id);
    if (activeBpId !== id) return;
    renderHistory(history);
  } catch (err) {
    console.warn(`Could not load history for business partner ${id}:`, err);
    document.getElementById('historyList').innerHTML = `<div class="sub-empty">Could not load history</div>`;
  }
}

const BP_MODAL_TRANSIENT_IDS = [
  'mNewContactName', 'mNewContactPosition', 'mNewContactEmail', 'mNewContactPhone',
  'mNewNote',
  'mTcName', 'mTcVat', 'mTcEmail', 'mTcStreet', 'mTcCity', 'mTcState', 'mTcZip', 'mTcPhone1', 'mTcPhone2',
];

// Sub-items (contacts / notes / tax companies) added during the current
// modal session. Each "Add" persists immediately; a confirmed discard
// deletes them again. Reset on open, cleared on Save.
let bpSessionAdds = { contacts: [], notes: [], taxCompanies: [] };
function resetBpSessionAdds(){ bpSessionAdds = { contacts: [], notes: [], taxCompanies: [] }; }
function bpHasSessionAdds(){
  return bpSessionAdds.contacts.length || bpSessionAdds.notes.length || bpSessionAdds.taxCompanies.length;
}
async function discardBpSessionAdds(){
  const bpId = activeBpId;
  if (!bpId) return;
  const jobs = [
    ...bpSessionAdds.contacts.map(cId => HITT_API.deleteBusinessPartnerContact(bpId, cId, currentEmployeeId)),
    ...bpSessionAdds.notes.map(nId => HITT_API.deleteBusinessPartnerNote(bpId, nId)),
    ...bpSessionAdds.taxCompanies.map(tcId => HITT_API.deleteBusinessPartnerTaxCompany(bpId, tcId)),
  ];
  resetBpSessionAdds();
  const results = await Promise.allSettled(jobs);
  const failed = results.filter(r => r.status === 'rejected').length;
  if (failed) toast(`${failed} item${failed === 1 ? '' : 's'} could not be reverted — check the partner.`, 'red');
}

// Unsaved work in the modal: an edited main field ("Data has changed"),
// text sitting in an add row (contact / note / tax company), a contact /
// tax company mid-edit, or a sub-item added this session.
function bpModalHasUnsaved(){
  if (!document.getElementById('mChangedBadge').classList.contains('hidden')) return true;
  if (editingContactId || editingTcId) return true;
  if (bpHasSessionAdds()) return true;
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
  const msg = bpHasSessionAdds()
    ? 'Discard your changes? Items you added (contacts, notes, tax companies) will be removed.'
    : 'Discard your unsaved changes to this business partner?';
  if (!confirm(msg)) return;
  if (bpHasSessionAdds()) await discardBpSessionAdds();
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
    document.getElementById('paneInvoicing').classList.toggle('hidden', btn.dataset.mtab !== 'invoicing');
  });
});

document.getElementById('mSave').addEventListener('click', async () => {
  if (!activeBpId) return;
  const name = document.getElementById('mName').value.trim();
  if (!name) { toast('Name is required', 'red'); return; }
  const languageId = document.getElementById('mLanguage').value;
  if (!languageId) { toast('Language is required', 'red'); return; }
  document.getElementById('mChangedBadge').classList.add('hidden');
  resetBpSessionAdds(); // Save commits everything added this session

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
  };

  if (usingDemoData) {
    const p = PARTNERS.find(x => x.id === activeBpId);
    if (p) p.name = name;
    renderTable();
    closeDetailModal();
    toast('Saved locally (demo data)', 'green');
    return;
  }

  try {
    await HITT_API.updateBusinessPartner(activeBpId, payload);
    const p = PARTNERS.find(x => x.id === activeBpId);
    if (p) p.name = name;
    renderTable();
    closeDetailModal();
    toast('Business partner saved', 'green');
  } catch (err) {
    console.error(err);
    toast('Could not save changes', 'red');
  }
});

document.getElementById('mAddContact').addEventListener('click', async () => {
  const f = contactFormInputs();
  const name = f.name.value.trim();
  if (!name || !activeBpId) return;
  if (usingDemoData) { toast("Contacts aren't available in demo data.", 'navy'); return; }
  const payload = {
    contactname: name,
    position: f.position.value.trim() || null,
    emailaddress: f.email.value.trim() || null,
    phonenumber: f.phone.value.trim() || null,
    employeeId: currentEmployeeId,
  };
  const wasEditing = editingContactId;
  try {
    if (wasEditing) {
      await HITT_API.updateBusinessPartnerContact(activeBpId, wasEditing, payload);
    } else {
      const created = await HITT_API.addBusinessPartnerContact(activeBpId, payload);
      if (created && created.id != null) bpSessionAdds.contacts.push(created.id);
    }
    CONTACTS = await HITT_API.getBusinessPartnerContacts(activeBpId);
    cancelEditContact(); // clears inputs, resets the button, re-renders
    toast(wasEditing ? 'Contact updated' : 'Contact added', 'green');
  } catch (err) {
    console.error(err);
    toast('Could not save the contact.', 'red');
  }
});

document.getElementById('mCancelEditContact').addEventListener('click', cancelEditContact);

document.getElementById('mAddNote').addEventListener('click', async () => {
  const text = document.getElementById('mNewNote').value.trim();
  if (!text || !activeBpId) return;
  if (usingDemoData) { toast("Notes aren't available in demo data.", 'navy'); return; }
  try {
    const created = await HITT_API.addBusinessPartnerNote(activeBpId, { notes: text, employeeId: currentEmployeeId });
    if (created && created.id != null) bpSessionAdds.notes.push(created.id);
    document.getElementById('mNewNote').value = '';
    renderNotes(await HITT_API.getBusinessPartnerNotes(activeBpId));
    toast('Note added', 'green');
  } catch (err) {
    console.error(err);
    toast('Could not save the note.', 'red');
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

document.getElementById('mTcSameAddress').addEventListener('change', syncTcAddressVisibility);
document.getElementById('mTcCancel').addEventListener('click', () => { resetTaxCompanyForm(); renderTaxCompanies(); });

document.getElementById('mTcSave').addEventListener('click', async () => {
  if (!activeBpId) return;
  if (usingDemoData) { toast("Tax companies aren't available in demo data.", 'navy'); return; }
  const payload = taxCompanyPayload();
  if (!payload.taxcompanyname) { toast('Tax company name is required.', 'red'); return; }
  const wasEditing = editingTcId;
  const btn = document.getElementById('mTcSave');
  btn.disabled = true;
  try {
    if (wasEditing) {
      await HITT_API.updateBusinessPartnerTaxCompany(activeBpId, wasEditing, payload);
    } else {
      const created = await HITT_API.addBusinessPartnerTaxCompany(activeBpId, payload);
      if (created && created.id != null) bpSessionAdds.taxCompanies.push(created.id);
    }
    TAX_COMPANIES = await HITT_API.getBusinessPartnerTaxCompanies(activeBpId);
    resetTaxCompanyForm();
    renderTaxCompanies();
    toast(wasEditing ? 'Tax company updated' : 'Tax company added', 'green');
  } catch (err) {
    console.error(err);
    toast(err.message || 'Could not save the tax company.', 'red');
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
    list.innerHTML = `<div class="sub-empty">No contacts added yet</div>`;
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
  document.getElementById('npAddContact').textContent = 'Save';
  document.getElementById('npCancelEditContact').style.display = '';
  renderNpContacts();
  f.name.focus();
}

function cancelEditNpContact(){
  npEditingContactIndex = null;
  const f = npContactFormInputs();
  [f.name, f.position, f.email, f.phone].forEach(el => { el.value = ''; });
  document.getElementById('npAddContact').textContent = 'Add';
  document.getElementById('npCancelEditContact').style.display = 'none';
  renderNpContacts();
}

document.getElementById('npAddContact').addEventListener('click', () => {
  const f = npContactFormInputs();
  const name = f.name.value.trim();
  if (!name) { toast('Contact name is required', 'red'); return; }
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
  if (!name) { toast('Name is required', 'red'); return; }
  const languageId = document.getElementById('npLanguage').value;
  if (!languageId) { toast('Language is required', 'red'); return; }
  const companyTypeId = document.getElementById('npCompanyType').value ? Number(document.getElementById('npCompanyType').value) : null;
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
  };

  if (usingDemoData) {
    const id = Math.max(0, ...PARTNERS.map(p => p.id)) + 1;
    PARTNERS.push({ id, name, companyTypeLabel: '—', countryLabel: '—', webpage: payload.webpage || '' });
    renderTable();
    closeNewBpModal();
    toast('Created locally (demo data)', 'green');
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
        toast(`Business partner created, but ${failed} contact${failed === 1 ? '' : 's'} could not be saved — add them from the partner.`, 'red');
      }
    }
    await loadPartners();
    closeNewBpModal();
    toast('Business partner created', 'green');
    openDetailModal(created.id);
  } catch (err) {
    console.error(err);
    toast('Could not create the business partner.', 'red');
  }
});

/* ============================== BP PROJECTS DRILL-DOWN =================== */
const bpProjectsOverlay = document.getElementById('bpProjectsOverlay');

async function openBpProjectsModal(bpId){
  const bp = PARTNERS.find(p => p.id === bpId);
  document.getElementById('bpProjectsTitle').textContent = bp ? `Projects — ${bp.name}` : 'Projects';
  document.getElementById('bpProjectsList').innerHTML = `<tr><td colspan="3" class="sub-empty">Loading…</td></tr>`;
  bpProjectsOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  try {
    const rows = await HITT_API.getBusinessPartnerProjects(bpId);
    if (!rows.length) {
      document.getElementById('bpProjectsList').innerHTML = `<tr><td colspan="3" class="sub-empty">No projects</td></tr>`;
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
    document.getElementById('bpProjectsList').innerHTML = `<tr><td colspan="3" class="sub-empty">Could not load projects</td></tr>`;
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
