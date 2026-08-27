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

const DEMO_SEED = [
  { id: 1, name: "Demo Pharma Inc", companyTypeLabel: "Pharmaceutical", countryLabel: "United States", webpage: "https://example.com" },
  { id: 2, name: "Demo Biotech Spain", companyTypeLabel: "Start Up", countryLabel: "Spain", webpage: "" },
];

let PARTNERS = [];
let LOOKUPS = { entities: [], companyTypes: [], countries: [], languages: [] };
let usingDemoData = false;
let searchTerm = "";
let activeBpId = null;

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
    PARTNERS = await HITT_API.getBusinessPartners();
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

function renderTable(){
  const tbody = document.getElementById('bpTableBody');
  const empty = document.getElementById('bpEmpty');
  const rows = PARTNERS.filter(matchesSearch).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  document.getElementById('bpCount').textContent = `${rows.length} of ${PARTNERS.length}`;

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
    </tr>
  `).join('');

  tbody.querySelectorAll('tr').forEach((tr, i) => {
    tr.addEventListener('click', () => openDetailModal(rows[i].id));
  });
}

document.getElementById('searchBox').addEventListener('input', (e) => {
  searchTerm = e.target.value.trim();
  renderTable();
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

/* ============================== DETAIL MODAL ============================= */
const modalOverlay = document.getElementById('modalOverlay');

function renderContacts(rows){
  const list = document.getElementById('mContactsList');
  if (!rows || !rows.length) {
    list.innerHTML = `<div class="sub-empty">No contacts yet</div>`;
    return;
  }
  list.innerHTML = rows.map(c => `
    <div class="sub-item">
      <div class="sub-item-row">
        <span class="sub-item-title">${escapeHtml(c.contactname)}</span>
        <span class="sub-item-meta">${escapeHtml(c.position || '')}</span>
      </div>
      <div class="sub-item-meta">${escapeHtml(c.emailaddress || '—')}${c.phonenumber ? ' · ' + escapeHtml(c.phonenumber) : ''}</div>
    </div>
  `).join('');
}

function renderNotes(rows){
  const list = document.getElementById('mNotesList');
  if (!rows || !rows.length) {
    list.innerHTML = `<div class="sub-empty">No notes yet</div>`;
    return;
  }
  list.innerHTML = rows.map(n => `
    <div class="sub-item">
      <div class="sub-item-row">
        <span class="sub-item-title">${escapeHtml(n.authorName || 'Unknown')}</span>
        <span class="sub-item-meta">${formatDateOnly(n.commentsts)}</span>
      </div>
      <div style="font-size:0.82rem; white-space:pre-wrap;">${escapeHtml(n.notes)}</div>
    </div>
  `).join('');
}

function renderTaxCompanies(rows){
  const tbody = document.getElementById('mTaxCompanies');
  if (!rows || !rows.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="sub-empty">No tax companies yet</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(tc => {
    const addr = [tc.streetname, tc.city, tc.countryLabel].filter(Boolean).join(', ');
    return `
      <tr>
        <td>${escapeHtml(tc.taxcompanyname || '—')}</td>
        <td>${escapeHtml(tc.vatnumber || '—')}</td>
        <td>${escapeHtml(tc.emailinvoicing || '—')}</td>
        <td>${escapeHtml(addr || '—')}</td>
      </tr>
    `;
  }).join('');
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
  document.getElementById('mNewContactName').value = '';
  document.getElementById('mNewContactPosition').value = '';
  document.getElementById('mNewContactEmail').value = '';
  document.getElementById('mNewNote').value = '';

  const loadingMsg = usingDemoData ? 'Not available in demo data' : 'Loading…';
  document.getElementById('mContactsList').innerHTML = `<div class="sub-empty">${loadingMsg}</div>`;
  document.getElementById('mNotesList').innerHTML = `<div class="sub-empty">${loadingMsg}</div>`;
  document.getElementById('mTaxCompanies').innerHTML = `<tr><td colspan="4" class="sub-empty">${loadingMsg}</td></tr>`;

  document.querySelectorAll('[data-mtab]').forEach(b => b.setAttribute('aria-selected', b.dataset.mtab === 'general' ? 'true' : 'false'));
  document.getElementById('paneGeneral').classList.remove('hidden');
  document.getElementById('paneInvoicing').classList.add('hidden');

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
}

function closeDetailModal(){
  modalOverlay.classList.add('hidden');
  document.body.style.overflow = '';
  activeBpId = null;
}

document.getElementById('mClose').addEventListener('click', closeDetailModal);
modalOverlay.addEventListener('click', (e) => { if (e.target === modalOverlay) closeDetailModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modalOverlay.classList.contains('hidden')) closeDetailModal();
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

  const payload = {
    name,
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
  const name = document.getElementById('mNewContactName').value.trim();
  if (!name || !activeBpId) return;
  if (usingDemoData) { toast("Contacts aren't available in demo data.", 'navy'); return; }
  try {
    await HITT_API.addBusinessPartnerContact(activeBpId, {
      contactname: name,
      position: document.getElementById('mNewContactPosition').value || null,
      emailaddress: document.getElementById('mNewContactEmail').value || null,
    });
    document.getElementById('mNewContactName').value = '';
    document.getElementById('mNewContactPosition').value = '';
    document.getElementById('mNewContactEmail').value = '';
    renderContacts(await HITT_API.getBusinessPartnerContacts(activeBpId));
    toast('Contact added', 'green');
  } catch (err) {
    console.error(err);
    toast('Could not save the contact.', 'red');
  }
});

document.getElementById('mAddNote').addEventListener('click', async () => {
  const text = document.getElementById('mNewNote').value.trim();
  if (!text || !activeBpId) return;
  if (usingDemoData) { toast("Notes aren't available in demo data.", 'navy'); return; }
  try {
    await HITT_API.addBusinessPartnerNote(activeBpId, { notes: text });
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
});

document.getElementById('mAddTaxCompany').addEventListener('click', async () => {
  const name = document.getElementById('mNewTcName').value.trim();
  if (!name || !activeBpId) return;
  if (usingDemoData) { toast("Tax companies aren't available in demo data.", 'navy'); return; }
  try {
    await HITT_API.addBusinessPartnerTaxCompany(activeBpId, {
      taxcompanyname: name,
      vatnumber: document.getElementById('mNewTcVat').value || null,
      emailinvoicing: document.getElementById('mNewTcEmail').value || null,
      sameAddress: document.getElementById('mNewTcSameAddress').checked,
    });
    document.getElementById('mNewTcName').value = '';
    document.getElementById('mNewTcVat').value = '';
    document.getElementById('mNewTcEmail').value = '';
    document.getElementById('mNewTcSameAddress').checked = true;
    renderTaxCompanies(await HITT_API.getBusinessPartnerTaxCompanies(activeBpId));
    toast('Tax company added', 'green');
  } catch (err) {
    console.error(err);
    toast('Could not save the tax company.', 'red');
  }
});

/* ============================== NEW BP MODAL ============================= */
const newBpOverlay = document.getElementById('newBpOverlay');

function openNewBpModal(){
  document.getElementById('npName').value = '';
  document.getElementById('npCompanyType').innerHTML = lookupOptionsHtml(LOOKUPS.companyTypes, null, true);
  document.getElementById('npLanguage').innerHTML = lookupOptionsHtml(LOOKUPS.languages, null, true);
  document.getElementById('npCountry').innerHTML = lookupOptionsHtml(LOOKUPS.countries, null, true);
  document.getElementById('npWebpage').value = '';
  ['npStreetName', 'npCity', 'npState', 'npZipCode', 'npPhone1', 'npPhone2'].forEach(id => document.getElementById(id).value = '');
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
    await loadPartners();
    closeNewBpModal();
    toast('Business partner created', 'green');
    openDetailModal(created.id);
  } catch (err) {
    console.error(err);
    toast('Could not create the business partner.', 'red');
  }
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
