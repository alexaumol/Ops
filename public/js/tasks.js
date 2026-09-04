/**
 * HITT Ops — Tasks (CRM Phase C2, platform-wide task manager)
 * ---------------------------------------------------------------------------
 * Not gated by a module permission — every authenticated employee manages
 * their own tasks (see server/routes/tasks.js). guardModule("tasks", …) is
 * still called for the deactivated-user redirect it does regardless of the
 * module key; "tasks" will never appear in anyone's restrictedModules since
 * there's no UI to restrict it.
 *
 * List view only for this first pass — Kanban/Calendar views are a later
 * increment (see docs/customers-crm-roadmap.md Phase C2).
 * ---------------------------------------------------------------------------
 */
const session = HITT_AUTH.requireSession("../index.html");
const T = (k, v) => (window.HITT_I18N ? HITT_I18N.t(k, v) : k);
document.getElementById("userName").textContent = session.displayName;
document.getElementById("userAvatar").textContent = HITT_AUTH.initials(session);
HITT_PERMS.applyRealName();

let currentEmployeeId = null;
HITT_PERMS.get().then((perms) => { currentEmployeeId = perms.employeeId; }).catch(() => {});

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

function formatDateOnly(iso){
  return iso ? new Date(iso).toLocaleDateString() : '—';
}
function isOverdue(task){
  return task.status === 'open' && task.dueDate && new Date(task.dueDate) < new Date(new Date().toDateString());
}

const PRIORITY_LABEL_KEYS = { low: 'tasks.priority.low', medium: 'tasks.priority.medium', high: 'tasks.priority.high' };
const ENTITY_LABEL_KEYS = {
  customer_partner: 'tasks.entity.customerPartner', contact: 'tasks.entity.contact', project: 'tasks.entity.project',
};
// Where "linked to" navigates for each entity type that has a page today.
const ENTITY_LINK = {
  customer_partner: (id) => `business-partners.html?open=${encodeURIComponent(id)}`,
};

let TASKS = [];
let EMPLOYEES = [];
let mineOnly = true;
let showDone = false;

function employeeOptionsHtml(selectedId, includeBlankLabel){
  const opts = [`<option value="">${includeBlankLabel || "—"}</option>`]
    .concat((EMPLOYEES || []).map(e => `<option value="${e.id}" ${String(e.id) === String(selectedId) ? 'selected' : ''}>${escapeHtml(e.name || e.username || `#${e.id}`)}</option>`));
  return opts.join('');
}

async function loadTasks(){
  try {
    EMPLOYEES = await HITT_API.getEmployees();
  } catch (err) {
    console.warn("Could not load employees:", err);
  }
  await refreshTasks();
}

async function refreshTasks(){
  const opts = {};
  if (mineOnly) opts.owner = 'me';
  if (!showDone) opts.status = 'open';
  try {
    TASKS = await HITT_API.getTasks(opts);
  } catch (err) {
    console.error(err);
    toast(T('tasks.loadFail'), 'red');
    TASKS = [];
  }
  renderTasks();
}

function renderTasks(){
  const tbody = document.getElementById('taskTableBody');
  const empty = document.getElementById('taskEmpty');
  document.getElementById('taskCount').textContent = T('common.countOf', { shown: TASKS.length, total: TASKS.length });

  if (!TASKS.length) {
    tbody.innerHTML = '';
    empty.classList.remove('hidden');
    return;
  }
  empty.classList.add('hidden');
  tbody.innerHTML = TASKS.map(t => {
    const linkFn = t.entityType && ENTITY_LINK[t.entityType];
    const entityLabel = t.entityType ? T(ENTITY_LABEL_KEYS[t.entityType] || t.entityType) : '';
    const entityCell = t.entityType
      ? (linkFn
          ? `<a href="${linkFn(t.entityId)}"><span class="stage-pill">${escapeHtml(entityLabel)}</span></a>`
          : `<span class="stage-pill">${escapeHtml(entityLabel)}</span>`)
      : '—';
    return `
    <tr data-id="${t.id}">
      <td><input type="checkbox" data-toggle-task="${t.id}" ${t.status === 'done' ? 'checked' : ''} title="${T('bp.task.toggle')}" /></td>
      <td class="task-title ${t.status === 'done' ? 'is-done' : ''}">${escapeHtml(t.title)}</td>
      <td>${entityCell}</td>
      <td>${escapeHtml(t.ownerName || T('bp.task.unassigned'))}</td>
      <td class="${isOverdue(t) ? 'task-meta is-overdue' : ''}">${formatDateOnly(t.dueDate)}</td>
      <td>${t.priority ? `<span class="stage-pill">${T(PRIORITY_LABEL_KEYS[t.priority] || t.priority)}</span>` : '—'}</td>
      <td><button type="button" data-delete-task="${t.id}" class="sub-item-btn sub-item-btn--danger" title="${T('form.delete')}">✕</button></td>
    </tr>`;
  }).join('');

  tbody.querySelectorAll('[data-toggle-task]').forEach(cb => {
    cb.addEventListener('change', () => toggleTask(cb.dataset.toggleTask, cb.checked));
  });
  tbody.querySelectorAll('[data-delete-task]').forEach(btn => {
    btn.addEventListener('click', () => deleteTaskRow(btn.dataset.deleteTask));
  });
}

async function toggleTask(id, done){
  try {
    await HITT_API.updateTask(id, { status: done ? 'done' : 'open' });
    if (!showDone && done) {
      // it just dropped out of the "open only" filter — reload instead of
      // patching one row so the count/empty-state stay correct
      await refreshTasks();
    } else {
      const t = TASKS.find(x => String(x.id) === String(id));
      if (t) { t.status = done ? 'done' : 'open'; }
      renderTasks();
    }
  } catch (err) {
    console.error(err);
    toast(T('toast.taskSaveFail'), 'red');
    renderTasks(); // revert the checkbox
  }
}

async function deleteTaskRow(id){
  const t = TASKS.find(x => String(x.id) === String(id));
  if (!t || !confirm(T('bp.confirm.deleteTask', { title: t.title || '' }))) return;
  try {
    await HITT_API.deleteTask(id);
    await refreshTasks();
    toast(T('toast.taskDeleted'), 'navy');
  } catch (err) {
    console.error(err);
    toast(T('toast.taskDeleteFail'), 'red');
  }
}

document.getElementById('filterMineOnly').addEventListener('change', (e) => {
  mineOnly = e.target.checked;
  refreshTasks();
});
document.getElementById('filterShowDone').addEventListener('change', (e) => {
  showDone = e.target.checked;
  refreshTasks();
});

/* ============================== NEW TASK MODAL ============================ */
const newTaskOverlay = document.getElementById('newTaskOverlay');

function openNewTaskModal(){
  document.getElementById('ntTitle').value = '';
  document.getElementById('ntDescription').value = '';
  document.getElementById('ntOwner').innerHTML = employeeOptionsHtml(currentEmployeeId, '—');
  document.getElementById('ntPriority').value = '';
  document.getElementById('ntDueDate').value = '';
  newTaskOverlay.classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  setTimeout(() => document.getElementById('ntTitle').focus(), 50);
}
function closeNewTaskModal(){
  newTaskOverlay.classList.add('hidden');
  document.body.style.overflow = '';
}

document.getElementById('btnNewTask').addEventListener('click', openNewTaskModal);
document.getElementById('ntClose').addEventListener('click', closeNewTaskModal);
document.getElementById('ntCancel').addEventListener('click', closeNewTaskModal);
newTaskOverlay.addEventListener('click', (e) => { if (e.target === newTaskOverlay) closeNewTaskModal(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !newTaskOverlay.classList.contains('hidden')) closeNewTaskModal();
});
document.getElementById('ntTitle').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); document.getElementById('ntSave').click(); }
});

document.getElementById('ntSave').addEventListener('click', async () => {
  const title = document.getElementById('ntTitle').value.trim();
  if (!title) { toast(T('bp.task.titleRequired'), 'red'); return; }
  const ownerEmployeeId = document.getElementById('ntOwner').value;
  const payload = {
    title,
    description: document.getElementById('ntDescription').value.trim() || null,
    ownerEmployeeId: ownerEmployeeId ? Number(ownerEmployeeId) : null,
    priority: document.getElementById('ntPriority').value || null,
    dueDate: document.getElementById('ntDueDate').value || null,
  };
  const btn = document.getElementById('ntSave');
  btn.disabled = true;
  try {
    await HITT_API.createTask(payload);
    closeNewTaskModal();
    await refreshTasks();
    toast(T('toast.taskAdded'), 'green');
  } catch (err) {
    console.error(err);
    toast(T('toast.taskSaveFail'), 'red');
  } finally {
    btn.disabled = false;
  }
});

/* ============================== INIT ==================================== */
// Fire-and-forget, same convention as every other module page: the
// deactivated-user redirect (the only thing this can actually trigger,
// since "tasks" never appears in anyone's restrictedModules) resolves
// independently of the data load below.
HITT_PERMS.guardModule("tasks", "../welcome.html");
loadTasks();

window.addEventListener('hitt:langchange', () => {
  renderTasks();
});
