/**
 * HITT Ops — Time allocation (project time tracking)
 * ---------------------------------------------------------------------------
 * Mirrors Access's "Project Time Tracking.frm" + "Time tracking.frm"
 * subform: pick a week, log hours per project, save. Deliberately scoped
 * to just this — the separate personal daily-hours log (timeallocationlog)
 * and the time-off request workflow (timeoffrequests) are different
 * tables/forms in Access and are NOT covered here (see INTERNAL.md).
 *
 * Every employee tracks only their own time — the logged-in identity is
 * resolved to an employee record via GET /api/permissions/me (see
 * js/permissions.js), so there's no "log time as someone else" picker.
 * ---------------------------------------------------------------------------
 */

const session = HITT_AUTH.requireSession("../index.html");
HITT_PERMS.guardModule("time-allocation", "../welcome.html");
const T = (k, v) => (window.HITT_I18N ? HITT_I18N.t(k, v) : k);
document.getElementById("userName").textContent = session.displayName;
document.getElementById("userAvatar").textContent = HITT_AUTH.initials(session);
document.getElementById("btnSignOut").addEventListener("click", () => HITT_AUTH.signOut("../index.html"));
HITT_PERMS.applyRealName();

let ALL_PROJECTS = [];
let ROWS = [];
let usingDemoData = false;
let currentEmployeeId = "";

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

/* ============================== EMPLOYEE IDENTITY ========================= */
// Every employee only ever tracks their own time — resolve who that is
// from the signed-in identity, no picker.
async function initEmployee(){
  if (!window.HITT_CONFIG?.FEATURES?.timeAllocationLive) {
    usingDemoData = true;
    currentEmployeeId = '';
  } else {
    try {
      const perms = await HITT_PERMS.get();
      currentEmployeeId = perms.employeeId ? String(perms.employeeId) : '';
      usingDemoData = false;
      if (!currentEmployeeId) {
        toast(T("ta.noSignInEmployee"), 'red');
      }
    } catch (err) {
      console.warn('Could not resolve your employee identity — falling back to demo mode:', err);
      usingDemoData = true;
      currentEmployeeId = '';
    }
  }
  setDataSourcePill();
}

/* ============================== PAGE TABS ================================= */
let currentPageTab = 'tracking';

document.querySelectorAll('[data-ptab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-ptab]').forEach(b => b.setAttribute('aria-selected', 'false'));
    btn.setAttribute('aria-selected', 'true');
    currentPageTab = btn.dataset.ptab;
    document.getElementById('paneTracking').classList.toggle('hidden', currentPageTab !== 'tracking');
    document.getElementById('paneTimeOff').classList.toggle('hidden', currentPageTab !== 'timeoff');
    // Opening the Time off tab counts as "seen" — clears the status-change
    // side of the badge (approvers still see their pending count).
    if (currentPageTab === 'timeoff') HITT_NOTIFY.markTimeOffSeen();
    refreshActiveTab();
  });
});

function refreshActiveTab(){
  renderSideReport();
  if (currentPageTab === 'tracking') loadWeek();
  else loadTimeOff();
}

async function refreshTimeOffBadge(){
  const el = document.getElementById('timeoffTabBadge');
  if (usingDemoData) { HITT_NOTIFY.paint(el, 0); return; }
  HITT_NOTIFY.paint(el, await HITT_NOTIFY.timeOffCount());
}

/* ============================== SIDE REPORTS ============================== */
// Right-hand panel (Project time tracking tab only): hours logged, broken
// down year -> month, each month split into PO (project owner) and RES
// (resource) hours. Current + previous calendar year. Whole panel and each
// year collapse, persisted best-effort in localStorage.
const MONTHS = () => T('common.monthsShort').split('|');
const TA_SIDE_KEY = 'hitt.taSide.collapsed';
const TA_YEARS_KEY = 'hitt.taSide.years';
let taYearState = {};
try { taYearState = JSON.parse(localStorage.getItem(TA_YEARS_KEY) || '{}') || {}; } catch { taYearState = {}; }

(function initSidePanelCollapse(){
  const layout = document.querySelector('.ta-layout');
  const toggle = document.getElementById('taSideToggle');
  const reopen = document.getElementById('taSideReopen');
  if (!layout || !toggle || !reopen) return;
  let collapsed = false;
  try { collapsed = localStorage.getItem(TA_SIDE_KEY) === '1'; } catch { /* storage blocked */ }
  const apply = () => {
    layout.classList.toggle('ta-side-collapsed', collapsed);
    toggle.setAttribute('aria-expanded', String(!collapsed));
  };
  const set = (v) => {
    collapsed = v; apply();
    try { localStorage.setItem(TA_SIDE_KEY, v ? '1' : '0'); } catch { /* storage blocked */ }
  };
  apply();
  toggle.addEventListener('click', () => set(true));
  reopen.addEventListener('click', () => set(false));
})();

const taNum = (n) => Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 1 });

function taYearRow(year, totalText, bodyHtml){
  const key = `tracking:${year}`;
  const collapsed = !!taYearState[key]; // default: expanded
  return `
    <div class="ta-year ${collapsed ? 'is-collapsed' : ''}" data-key="${key}">
      <button type="button" class="ta-year-head" aria-expanded="${!collapsed}">
        <span class="ta-year-chevron" aria-hidden="true">▾</span>
        <span class="ta-year-label">${year}</span>
        <span class="ta-year-total">${totalText}</span>
      </button>
      <div class="ta-year-body">${bodyHtml}</div>
    </div>`;
}

function taMonthBlock(year, month, totalText, weekRows){
  const key = `tracking:m:${year}-${month}`;
  const collapsed = key in taYearState ? taYearState[key] : true; // default: collapsed
  return `
    <div class="ta-month ${collapsed ? 'is-collapsed' : ''}" data-key="${key}">
      <button type="button" class="ta-month-head" aria-expanded="${!collapsed}">
        <span class="ta-month-chevron" aria-hidden="true">▾</span>
        <span class="ta-month-label">${MONTHS()[month - 1] || month}</span>
        <span class="ta-month-total">${totalText}</span>
      </button>
      <div class="ta-month-body">${weekRows}</div>
    </div>`;
}

// One handler for both the year and the month collapse rows.
function wireCollapseToggles(){
  document.querySelectorAll('#taSideBody .ta-year-head, #taSideBody .ta-month-head').forEach(head => {
    head.addEventListener('click', () => {
      const wrap = head.closest('.ta-year, .ta-month');
      const nowCollapsed = wrap.classList.toggle('is-collapsed');
      head.setAttribute('aria-expanded', String(!nowCollapsed));
      taYearState[wrap.dataset.key] = nowCollapsed;
      try { localStorage.setItem(TA_YEARS_KEY, JSON.stringify(taYearState)); } catch { /* storage blocked */ }
    });
  });
}

// Monday ISO date -> "5–11 Aug" (or "29 Jul – 4 Aug" across a month boundary).
function taWeekLabel(iso){
  const mon = new Date(`${iso}T00:00:00`);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  const dm = (d) => `${d.getDate()} ${MONTHS()[d.getMonth()]}`;
  return mon.getMonth() === sun.getMonth()
    ? `${mon.getDate()}–${dm(sun)}`
    : `${dm(mon)} – ${dm(sun)}`;
}

async function renderSideReport(){
  const side = document.getElementById('taSide');
  const body = document.getElementById('taSideBody');
  const title = document.getElementById('taSideTitle');
  if (!side || !body) return;

  // The panel is Project time tracking only — nothing on the Time off tab.
  const show = currentPageTab === 'tracking';
  side.classList.toggle('hidden', !show);
  if (!show) return;

  title.textContent = T('ta.side.hoursLogged');

  if (usingDemoData || !currentEmployeeId) {
    body.innerHTML = `<p class="ta-side-empty">${usingDemoData
      ? T('common.notAvailableDemo')
      : T('ta.noEmployeeShort')}</p>`;
    return;
  }

  body.innerHTML = `<p class="ta-side-empty">${T('common.loading')}</p>`;
  try {
    const rows = await HITT_API.getTimeTrackingSummary(currentEmployeeId);
    if (currentPageTab !== 'tracking') return;
    if (!rows.length) { body.innerHTML = `<p class="ta-side-empty">${T('ta.side.noHours')}</p>`; return; }

    // year -> month -> [week rows]
    const tree = new Map();
    rows.forEach(r => {
      if (!tree.has(r.year)) tree.set(r.year, new Map());
      const months = tree.get(r.year);
      if (!months.has(r.month)) months.set(r.month, []);
      months.get(r.month).push(r);
    });
    const hrs = (n) => `${taNum(n)}h`;

    body.innerHTML = [...tree.keys()].sort((a, b) => b - a).map(year => {
      const months = tree.get(year);
      let yPo = 0, yRes = 0;
      const monthBlocks = [...months.keys()].sort((a, b) => b - a).map(month => {
        const weeks = months.get(month).sort((a, b) => (a.weekStart < b.weekStart ? 1 : -1));
        const mPo = weeks.reduce((s, w) => s + w.poHours, 0);
        const mRes = weeks.reduce((s, w) => s + w.resHours, 0);
        yPo += mPo; yRes += mRes;
        const weekRows = weeks.map(w => `
          <div class="ta-week-row">
            <span class="ta-week-label">${taWeekLabel(w.weekStart)}</span>
            <span class="ta-week-hours"><em>PO</em> ${hrs(w.poHours)}</span>
            <span class="ta-week-hours"><em>RES</em> ${hrs(w.resHours)}</span>
          </div>`).join('');
        return taMonthBlock(year, month, `PO ${hrs(mPo)} · RES ${hrs(mRes)}`, weekRows);
      }).join('');
      return taYearRow(year, `PO ${hrs(yPo)} · RES ${hrs(yRes)}`, monthBlocks);
    }).join('');
    wireCollapseToggles();
  } catch (err) {
    console.warn('Could not load the side report:', err);
    body.innerHTML = `<p class="ta-side-empty">${T('ta.side.loadFail')}</p>`;
  }
}

/* ============================== LOAD / RENDER WEEK ========================= */
async function loadWeek(){
  const tbody = document.getElementById('taTableBody');
  const empty = document.getElementById('taEmpty');

  if (!currentEmployeeId) {
    ROWS = [];
    tbody.innerHTML = '';
    empty.textContent = usingDemoData
      ? T('common.notAvailableDemo')
      : T('ta.noEmployeeContact');
    empty.classList.remove('hidden');
    updateWeekTotal();
    return;
  }

  if (usingDemoData) {
    ROWS = [];
    renderTable();
    return;
  }

  tbody.innerHTML = `<tr><td colspan="6" class="sub-empty">${T('common.loading')}</td></tr>`;
  empty.classList.add('hidden');
  try {
    ROWS = await HITT_API.getTimeTracking(currentEmployeeId, weekStartDateString(weekPicker.value));
  } catch (err) {
    console.warn('Could not load time tracking rows:', err);
    ROWS = [];
    toast(T('ta.toast.weekLoadFail'), 'red');
  }
  renderTable();
}

function formatDateTime(iso){
  return iso ? new Date(iso).toLocaleString() : '—';
}

function updateWeekTotal(){
  const total = ROWS.reduce((sum, r) => sum + (Number(r.hours) || 0), 0);
  document.getElementById('weekTotal').textContent = T('ta.weekTotal', { hours: total });
}

function renderTable(){
  const tbody = document.getElementById('taTableBody');
  const empty = document.getElementById('taEmpty');

  if (!ROWS.length) {
    tbody.innerHTML = '';
    empty.textContent = T('ta.empty.tracking');
    empty.classList.remove('hidden');
    updateWeekTotal();
    return;
  }
  empty.classList.add('hidden');

  tbody.innerHTML = ROWS.map((r, i) => `
    <tr data-i="${i}">
      <td><span class="font-mono" style="font-family:inherit; font-weight:600;">${escapeHtml(r.code || '')}</span> — ${escapeHtml(r.name || T('ta.unknownProject'))}</td>
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
      <td style="font-size:0.78rem; color:var(--text-secondary);"><span data-lastupdated>${formatDateTime(r.lastUpdated)}</span><span class="ta-saved-flash hidden" data-flash>${T('ta.saved')}</span></td>
      <td><button class="ta-remove-btn" title="${T('ta.tip.removeProject')}">✕</button></td>
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
        renderSideReport();
      } catch (err) {
        console.error(err);
        toast(T('ta.toast.rowSaveFail'), 'red');
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
        toast(T('ta.toast.removed'), 'navy');
        renderSideReport();
      } catch (err) {
        console.error(err);
        toast(T('ta.toast.rowRemoveFail'), 'red');
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
    // Alive projects only — you can't log hours on a Closed/Cancelled one.
    ALL_PROJECTS = await HITT_API.getProjects({ scope: 'alive' });
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
    host.innerHTML = `<div class="sub-empty">${T('ta.picker.typeTwo')}</div>`;
    return;
  }
  if (!matches.length) {
    host.innerHTML = `<div class="sub-empty">${T('ta.picker.noMatches')}</div>`;
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
  if (!currentEmployeeId) { toast(T("ta.noEmployeeContact"), 'red'); return; }
  if (usingDemoData) { toast(T("ta.demo.noAddProject"), 'navy'); return; }
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

/* ============================== TIME OFF REQUESTS ==========================
 * Self-service submit/view/withdraw only — mirrors the "Enter your time
 * off requests" + balance-summary parts of Access's TimeOffRequests.frm.
 * Approve/reject is deliberately NOT built: that workflow needs a
 * manager-relationship concept this app doesn't have anywhere yet.
 * ========================================================================== */
let TIME_OFF_REQUESTS = [];

const balanceYearSelect = document.getElementById('balanceYear');
(function populateYearOptions(){
  const current = new Date().getFullYear();
  const years = [current + 1, current, current - 1, current - 2];
  balanceYearSelect.innerHTML = years.map(y => `<option value="${y}" ${y === current ? 'selected' : ''}>${y}</option>`).join('');
})();
balanceYearSelect.addEventListener('change', () => loadBalance());

function formatDateOnly(iso){
  return iso ? new Date(iso).toLocaleDateString() : '—';
}

async function loadBalance(){
  if (!currentEmployeeId || usingDemoData) {
    ['statTotal', 'statApproved', 'statPending', 'statAvailable'].forEach(id => document.getElementById(id).textContent = '—');
    return;
  }
  const hint = document.getElementById('balanceHint');
  hint.classList.add('hidden');
  try {
    const balance = await HITT_API.getTimeOffBalance(currentEmployeeId, balanceYearSelect.value);
    document.getElementById('statTotal').textContent = balance.totalDays ?? '—';
    document.getElementById('statApproved').textContent = balance.approvedDays;
    document.getElementById('statPending').textContent = balance.pendingDays;
    document.getElementById('statAvailable').textContent = balance.availableDays ?? '—';
    if (balance.totalDays === null) {
      hint.textContent = T('ta.balanceHint', { year: balanceYearSelect.value });
      hint.classList.remove('hidden');
    }
  } catch (err) {
    console.warn('Could not load time-off balance:', err);
  }
}

function statusPillClass(statusLabel){
  const key = (statusLabel || '').toLowerCase().replace(/\s+/g, '-');
  return `to-status-pill to-status-${key.includes('pending') ? 'pending' : key}`;
}

function canWithdraw(req){
  return !['Rejected', 'Withdrawn', 'Cancelled'].includes(req.statusLabel);
}

function renderTimeOffTable(){
  const tbody = document.getElementById('toTableBody');
  const empty = document.getElementById('toEmpty');
  if (!TIME_OFF_REQUESTS.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  tbody.innerHTML = TIME_OFF_REQUESTS.map((r, i) => `
    <tr data-i="${i}">
      <td>${formatDateOnly(r.startdate)} – ${formatDateOnly(r.enddate)}</td>
      <td style="text-align:right;">${r.daysrequested}</td>
      <td><span class="${statusPillClass(r.statusLabel)}">${r.statusLabel || T('common.unknown')}</span></td>
      <td style="font-size:0.78rem; color:var(--text-secondary);">${formatDateOnly(r.submittedat)}</td>
      <td>${canWithdraw(r) ? `<button class="ta-remove-btn" data-withdraw title="${T('ta.tip.withdraw')}">${T('ta.withdraw')}</button>` : ''}</td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-withdraw]').forEach((btn, i) => {
    btn.addEventListener('click', async () => {
      const req = TIME_OFF_REQUESTS[i];
      try {
        await HITT_API.withdrawTimeOffRequest(req.id);
        toast(T('ta.toast.withdrawn'), 'navy');
        await loadTimeOff();
        renderSideReport();
      } catch (err) {
        console.error(err);
        toast(T('ta.toast.withdrawFail'), 'red');
      }
    });
  });
}

async function loadTimeOff(){
  const tbody = document.getElementById('toTableBody');
  const empty = document.getElementById('toEmpty');

  // Approving others' requests doesn't depend on who you're "logging time
  // as" above, so it loads independently of the early returns below.
  await loadApprovals();
  refreshTimeOffBadge();

  if (!currentEmployeeId) {
    TIME_OFF_REQUESTS = [];
    tbody.innerHTML = '';
    empty.textContent = usingDemoData
      ? T('common.notAvailableDemo')
      : T('ta.noEmployeeContact');
    empty.classList.remove('hidden');
    return;
  }
  if (usingDemoData) {
    TIME_OFF_REQUESTS = [];
    tbody.innerHTML = '';
    empty.textContent = T('common.notAvailableDemo');
    empty.classList.remove('hidden');
    return;
  }

  tbody.innerHTML = `<tr><td colspan="5" class="sub-empty">${T('common.loading')}</td></tr>`;
  empty.classList.add('hidden');
  try {
    TIME_OFF_REQUESTS = await HITT_API.getTimeOffRequests(currentEmployeeId);
  } catch (err) {
    console.warn('Could not load time-off requests:', err);
    TIME_OFF_REQUESTS = [];
    toast(T('ta.toast.reqLoadFail'), 'red');
  }
  renderTimeOffTable();
  await loadBalance();
}

/* ---------- Pending approvals (approver-only) ---------- */
let isApprover = null; // null = not checked yet, avoids a render flash while HITT_PERMS resolves

async function loadApprovals(){
  const section = document.getElementById('approvalsSection');
  if (usingDemoData) { section.classList.add('hidden'); return; }

  if (isApprover === null) {
    try {
      const perms = await HITT_PERMS.get();
      isApprover = !!perms.isTimeOffApprover;
    } catch (err) {
      console.warn('Could not resolve approver status:', err);
      isApprover = false;
    }
  }
  if (!isApprover) { section.classList.add('hidden'); return; }
  section.classList.remove('hidden');

  const tbody = document.getElementById('approvalsTableBody');
  const empty = document.getElementById('approvalsEmpty');
  tbody.innerHTML = `<tr><td colspan="5" class="sub-empty">${T('common.loading')}</td></tr>`;
  empty.classList.add('hidden');

  let pending = [];
  try {
    pending = await HITT_API.getPendingTimeOffRequests();
  } catch (err) {
    console.warn('Could not load pending approvals:', err);
    toast(T('ta.toast.approvalsLoadFail'), 'red');
  }
  renderApprovalsTable(pending);
}

function renderApprovalsTable(pending){
  const tbody = document.getElementById('approvalsTableBody');
  const empty = document.getElementById('approvalsEmpty');
  if (!pending.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  tbody.innerHTML = pending.map((r, i) => `
    <tr data-i="${i}">
      <td>${r.employeeName || `#${r.empid}`}</td>
      <td>${formatDateOnly(r.startdate)} – ${formatDateOnly(r.enddate)}</td>
      <td style="text-align:right;">${r.daysrequested}</td>
      <td style="font-size:0.78rem; color:var(--text-secondary);">${formatDateOnly(r.submittedat)}</td>
      <td style="display:flex; gap:0.4rem;">
        <button class="btn btn-primary" style="padding:0.3rem 0.65rem; font-size:0.78rem;" data-approve>${T('ta.approve')}</button>
        <button class="btn btn-secondary" style="padding:0.3rem 0.65rem; font-size:0.78rem;" data-reject>${T('ta.reject')}</button>
      </td>
    </tr>
  `).join('');

  tbody.querySelectorAll('[data-approve]').forEach((btn, i) => {
    btn.addEventListener('click', async () => {
      try {
        await HITT_API.approveTimeOffRequest(pending[i].id);
        toast(T('ta.toast.approved', { name: pending[i].employeeName }), 'green');
        await loadApprovals();
        refreshTimeOffBadge();
      } catch (err) {
        console.error(err);
        toast(T('ta.toast.approveFail'), 'red');
      }
    });
  });
  tbody.querySelectorAll('[data-reject]').forEach((btn, i) => {
    btn.addEventListener('click', async () => {
      try {
        await HITT_API.rejectTimeOffRequest(pending[i].id);
        toast(T('ta.toast.rejected', { name: pending[i].employeeName }), 'navy');
        await loadApprovals();
        refreshTimeOffBadge();
      } catch (err) {
        console.error(err);
        toast(T('ta.toast.rejectFail'), 'red');
      }
    });
  });
}

/* ---------- New request modal ---------- */
const timeOffOverlay = document.getElementById('timeOffOverlay');

function openTimeOffModal(){
  if (!currentEmployeeId) { toast(T("ta.noEmployeeContact"), 'red'); return; }
  if (usingDemoData) { toast(T("ta.demo.noTimeOff"), 'navy'); return; }
  document.getElementById('toStartDate').value = '';
  document.getElementById('toEndDate').value = '';
  document.getElementById('toDaysRequested').value = '';
  timeOffOverlay.classList.remove('hidden');
  setTimeout(() => document.getElementById('toStartDate').focus(), 50);
}
function closeTimeOffModal(){
  timeOffOverlay.classList.add('hidden');
}

function suggestDaysRequested(){
  const start = document.getElementById('toStartDate').value;
  const end = document.getElementById('toEndDate').value;
  if (!start || !end) return;
  const days = Math.round((new Date(end) - new Date(start)) / 86400000) + 1;
  if (days > 0) document.getElementById('toDaysRequested').value = days;
}
document.getElementById('toStartDate').addEventListener('change', suggestDaysRequested);
document.getElementById('toEndDate').addEventListener('change', suggestDaysRequested);

document.getElementById('btnNewTimeOff').addEventListener('click', openTimeOffModal);
document.getElementById('timeOffClose').addEventListener('click', closeTimeOffModal);
document.getElementById('timeOffCancel').addEventListener('click', closeTimeOffModal);
timeOffOverlay.addEventListener('click', (e) => { if (e.target === timeOffOverlay) closeTimeOffModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !timeOffOverlay.classList.contains('hidden')) closeTimeOffModal();
});

document.getElementById('timeOffSubmit').addEventListener('click', async () => {
  const startDate = document.getElementById('toStartDate').value;
  const endDate = document.getElementById('toEndDate').value;
  const daysRequested = Number(document.getElementById('toDaysRequested').value);
  if (!startDate || !endDate || !daysRequested) {
    toast(T('ta.toast.reqFieldsRequired'), 'red');
    return;
  }
  try {
    await HITT_API.createTimeOffRequest({ empId: currentEmployeeId, startDate, endDate, daysRequested });
    closeTimeOffModal();
    toast(T('ta.toast.submitted'), 'green');
    await loadTimeOff();
    renderSideReport();
  } catch (err) {
    console.error(err);
    toast(T('ta.toast.submitFail'), 'red');
  }
});

/* ============================== INIT ==================================== */
(async () => {
  await initEmployee();
  await loadWeek();
  refreshTimeOffBadge();
  renderSideReport();
})();


/* Re-render dynamic content when the UI language changes. */
window.addEventListener("hitt:langchange", () => {
  if (typeof setDataSourcePill === "function") setDataSourcePill();
  if (typeof refreshActiveTab === "function") refreshActiveTab();
});
