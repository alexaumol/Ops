/**
 * HITT Ops — Time allocation (project time tracking)
 * ---------------------------------------------------------------------------
 * Mirrors Access's "Project Time Tracking.frm" + "Time tracking.frm"
 * subform: pick a week, log hours per project, save. Deliberately scoped
 * to just this — the separate personal daily-hours log (timeallocationlog)
 * and the time-off request workflow (timeoffrequests) are different
 * tables/forms in Access and are NOT covered here (see INTERNAL.md).
 *
 * There's no real employee identity yet (MSAL/Entra ID sign-in isn't
 * wired up — see js/auth.js), so this asks the user which employee
 * record they are and remembers the choice in sessionStorage for the
 * rest of the tab's session.
 * ---------------------------------------------------------------------------
 */

const session = HITT_AUTH.requireSession("../index.html");
document.getElementById("userName").textContent = session.displayName;
document.getElementById("userAvatar").textContent = HITT_AUTH.initials(session);
document.getElementById("btnSignOut").addEventListener("click", () => HITT_AUTH.signOut("../index.html"));

const EMPLOYEE_KEY = "hitt.timeTrackingEmployeeId";

let EMPLOYEES = [];
let ALL_PROJECTS = [];
let ROWS = [];
let usingDemoData = false;
let currentEmployeeId = sessionStorage.getItem(EMPLOYEE_KEY) || "";

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

/* ============================== WEEK HELPERS ============================= */
function isoWeekStringFor(date){
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, '0')}`;
}

function mondayOfIsoWeek(year, week){
  const simple = new Date(Date.UTC(year, 0, 1 + (week - 1) * 7));
  const dow = simple.getUTCDay();
  const monday = new Date(simple);
  if (dow <= 4) monday.setUTCDate(simple.getUTCDate() - dow + 1);
  else monday.setUTCDate(simple.getUTCDate() + 8 - dow);
  return monday;
}

function parseWeekInput(value){
  // "2026-W02" -> { year, week }
  const [y, w] = value.split('-W').map(Number);
  return { year: y, week: w };
}

function weekStartDateString(value){
  const { year, week } = parseWeekInput(value);
  return mondayOfIsoWeek(year, week).toISOString().slice(0, 10);
}

const weekPicker = document.getElementById('weekPicker');
weekPicker.value = isoWeekStringFor(new Date());

document.getElementById('btnWeekBack').addEventListener('click', () => shiftWeek(-7));
document.getElementById('btnWeekForward').addEventListener('click', () => shiftWeek(7));
function shiftWeek(days){
  const { year, week } = parseWeekInput(weekPicker.value);
  const monday = mondayOfIsoWeek(year, week);
  monday.setUTCDate(monday.getUTCDate() + days);
  weekPicker.value = isoWeekStringFor(monday);
  loadWeek();
}
weekPicker.addEventListener('change', loadWeek);

/* ============================== EMPLOYEE PICKER =========================== */
async function loadEmployees(){
  const select = document.getElementById('employeeSelect');
  if (!window.HITT_CONFIG?.FEATURES?.timeAllocationLive) {
    EMPLOYEES = [{ id: 'demo', name: 'Demo Employee' }];
    usingDemoData = true;
  } else {
    try {
      EMPLOYEES = await HITT_API.getEmployees();
      usingDemoData = false;
    } catch (err) {
      console.warn('Falling back to demo data — could not reach API:', err);
      EMPLOYEES = [{ id: 'demo', name: 'Demo Employee' }];
      usingDemoData = true;
    }
  }
  setDataSourcePill();

  select.innerHTML = `<option value="">Select your name…</option>` +
    EMPLOYEES.map(e => `<option value="${e.id}" ${String(e.id) === String(currentEmployeeId) ? 'selected' : ''}>${escapeHtml(e.name)}</option>`).join('');

  if (!EMPLOYEES.some(e => String(e.id) === String(currentEmployeeId))) {
    currentEmployeeId = '';
  }
}

document.getElementById('employeeSelect').addEventListener('change', (e) => {
  currentEmployeeId = e.target.value;
  sessionStorage.setItem(EMPLOYEE_KEY, currentEmployeeId);
  loadWeek();
});

/* ============================== LOAD / RENDER WEEK ========================= */
async function loadWeek(){
  const tbody = document.getElementById('taTableBody');
  const empty = document.getElementById('taEmpty');

  if (!currentEmployeeId) {
    ROWS = [];
    tbody.innerHTML = '';
    empty.textContent = 'Pick your name above to see and log your time.';
    empty.classList.remove('hidden');
    updateWeekTotal();
    return;
  }

  if (usingDemoData) {
    ROWS = [];
    renderTable();
    return;
  }

  tbody.innerHTML = `<tr><td colspan="6" class="sub-empty">Loading…</td></tr>`;
  empty.classList.add('hidden');
  try {
    ROWS = await HITT_API.getTimeTracking(currentEmployeeId, weekStartDateString(weekPicker.value));
  } catch (err) {
    console.warn('Could not load time tracking rows:', err);
    ROWS = [];
    toast('Could not load time tracking for this week.', 'red');
  }
  renderTable();
}

function formatDateTime(iso){
  return iso ? new Date(iso).toLocaleString() : '—';
}

function updateWeekTotal(){
  const total = ROWS.reduce((sum, r) => sum + (Number(r.hours) || 0), 0);
  document.getElementById('weekTotal').textContent = `${total}h logged`;
}

function renderTable(){
  const tbody = document.getElementById('taTableBody');
  const empty = document.getElementById('taEmpty');

  if (!ROWS.length) {
    tbody.innerHTML = '';
    empty.textContent = 'No projects logged for this week yet.';
    empty.classList.remove('hidden');
    updateWeekTotal();
    return;
  }
  empty.classList.add('hidden');

  tbody.innerHTML = ROWS.map((r, i) => `
    <tr data-i="${i}">
      <td><span class="font-mono" style="font-family:inherit; font-weight:600;">${escapeHtml(r.code || '')}</span> — ${escapeHtml(r.name || '(unknown project)')}</td>
      <td>${r.statusLabel ? `<span class="ta-status-pill">${escapeHtml(r.statusLabel)}</span>` : '—'}</td>
      <td>
        <select class="ta-res-select" data-field="poRes">
          <option value="RES" ${r.poRes === 'RES' ? 'selected' : ''}>RES</option>
          <option value="PO" ${r.poRes === 'PO' ? 'selected' : ''}>PO</option>
        </select>
      </td>
      <td style="text-align:right;">
        <input type="number" min="0" max="80" step="0.5" class="ta-hours-input" data-field="hours" value="${r.hours ?? 0}" />
      </td>
      <td style="font-size:0.78rem; color:var(--text-secondary);"><span data-lastupdated>${formatDateTime(r.lastUpdated)}</span><span class="ta-saved-flash hidden" data-flash>Saved</span></td>
      <td><button class="ta-remove-btn" title="Remove this project from the week">✕</button></td>
    </tr>
  `).join('');

  tbody.querySelectorAll('tr').forEach((tr, i) => {
    const row = ROWS[i];
    const hoursInput = tr.querySelector('[data-field="hours"]');
    const resSelect = tr.querySelector('[data-field="poRes"]');
    const flash = tr.querySelector('[data-flash]');
    const lastUpdatedEl = tr.querySelector('[data-lastupdated]');
    const removeBtn = tr.querySelector('.ta-remove-btn');

    const save = async () => {
      const hours = Number(hoursInput.value) || 0;
      const poRes = resSelect.value;
      try {
        const saved = await HITT_API.saveTimeTracking({
          userId: currentEmployeeId,
          projectId: row.projectid,
          week: parseWeekInput(weekPicker.value).week,
          weekStart: weekStartDateString(weekPicker.value),
          hours,
          poRes,
        });
        row.id = saved.id;
        row.hours = saved.hours;
        row.poRes = saved.poRes;
        row.lastUpdated = saved.lastUpdated;
        lastUpdatedEl.textContent = formatDateTime(row.lastUpdated);
        flash.classList.remove('hidden');
        setTimeout(() => flash.classList.add('hidden'), 1500);
        updateWeekTotal();
      } catch (err) {
        console.error(err);
        toast('Could not save that row.', 'red');
      }
    };

    hoursInput.addEventListener('change', save);
    resSelect.addEventListener('change', save);

    removeBtn.addEventListener('click', async () => {
      if (!row.id) {
        ROWS.splice(i, 1);
        renderTable();
        return;
      }
      try {
        await HITT_API.deleteTimeTracking(row.id);
        ROWS.splice(i, 1);
        renderTable();
        toast('Removed.', 'navy');
      } catch (err) {
        console.error(err);
        toast('Could not remove that row.', 'red');
      }
    });
  });

  updateWeekTotal();
}

/* ============================== PROJECT PICKER ============================ */
const projectPickerOverlay = document.getElementById('projectPickerOverlay');

async function ensureProjectsLoaded(){
  if (ALL_PROJECTS.length || usingDemoData) return;
  try {
    ALL_PROJECTS = await HITT_API.getProjects();
  } catch (err) {
    console.warn('Could not load projects for the picker:', err);
  }
}

function renderProjectPickerResults(term){
  const host = document.getElementById('projectPickerResults');
  const t = term.trim().toLowerCase();
  const alreadyAdded = new Set(ROWS.map(r => String(r.projectid)));
  const matches = (t.length < 2 ? [] : ALL_PROJECTS.filter(p =>
    !alreadyAdded.has(String(p.id)) &&
    (String(p.code).toLowerCase().includes(t) || String(p.name).toLowerCase().includes(t))
  )).slice(0, 30);

  if (t.length < 2) {
    host.innerHTML = `<div class="sub-empty">Type at least two characters to search</div>`;
    return;
  }
  if (!matches.length) {
    host.innerHTML = `<div class="sub-empty">No matches</div>`;
    return;
  }
  host.innerHTML = matches.map((p, i) => `
    <div data-i="${i}" class="sub-item" style="cursor:pointer;">
      <div class="sub-item-title">${escapeHtml(p.code)} — ${escapeHtml(p.name)}</div>
    </div>
  `).join('');
  host.querySelectorAll('[data-i]').forEach(el => {
    el.addEventListener('click', () => {
      const p = matches[Number(el.dataset.i)];
      ROWS.push({ id: null, projectid: p.id, code: p.code, name: p.name, statusLabel: null, hours: 0, poRes: 'RES', lastUpdated: null });
      renderTable();
      closeProjectPicker();
    });
  });
}

async function openProjectPicker(){
  if (!currentEmployeeId) { toast('Pick your name first.', 'navy'); return; }
  if (usingDemoData) { toast("Adding projects isn't available in demo data.", 'navy'); return; }
  await ensureProjectsLoaded();
  document.getElementById('projectPickerSearch').value = '';
  renderProjectPickerResults('');
  projectPickerOverlay.classList.remove('hidden');
  setTimeout(() => document.getElementById('projectPickerSearch').focus(), 50);
}
function closeProjectPicker(){
  projectPickerOverlay.classList.add('hidden');
}

document.getElementById('btnAddProject').addEventListener('click', openProjectPicker);
document.getElementById('projectPickerClose').addEventListener('click', closeProjectPicker);
projectPickerOverlay.addEventListener('click', (e) => { if (e.target === projectPickerOverlay) closeProjectPicker(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !projectPickerOverlay.classList.contains('hidden')) closeProjectPicker();
});
document.getElementById('projectPickerSearch').addEventListener('input', (e) => renderProjectPickerResults(e.target.value));

/* ============================== INIT ==================================== */
(async () => {
  await loadEmployees();
  await loadWeek();
})();
