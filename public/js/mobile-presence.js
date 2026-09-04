/**
 * HITT Ops — Mobile presence (fichaje / registro de jornada)
 * ---------------------------------------------------------------------------
 * Phone-first single-task screen: one button to clock in / out, plus today's
 * expected / done / remaining hours. A thin client over the same compliant
 * API the desktop "Presence" tab uses (server/routes/presence.js) — the
 * server stamps every event with now() in the company time zone, chains it
 * into the append-only hash chain and audits it. Nothing is edited here;
 * corrections are a desktop-only flow (see docs/presence-register.md).
 *
 * No geolocation: the "Location" field is a self-declared office/remote/client
 * label, never a device position (art. 34.9 ET requires times, not location;
 * see the "no GPS" decision in docs/presence-register.md).
 * ---------------------------------------------------------------------------
 */
const session = HITT_AUTH.requireSession("../index.html");
HITT_PERMS.guardModule("presence", "../mobile.html");
const T = (k, v) => (window.HITT_I18N ? HITT_I18N.t(k, v) : k);
HITT_PERMS.applyRealName();

function esc(s) { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; }
function toast(msg, tone = "navy") {
  const host = document.getElementById("toastHost");
  const elx = document.createElement("div");
  elx.className = `toast toast-${tone}`;
  elx.textContent = msg;
  host.appendChild(elx);
  setTimeout(() => elx.remove(), 3200);
}

const el = {};
[
  "mpCard", "mpDot", "mpState", "mpDayNote", "mpExpected", "mpCommitted", "mpLeft",
  "mpLocWrap", "mpLocation", "mpClockBtn", "mpToday", "mpPrivacyLink",
].forEach((id) => { el[id] = document.getElementById(id); });

let cfg = null;
let state = null;      // GET /api/presence/me/today
let ticker = null;
let busy = false;

/* ---------- formatting (always in the company time zone) ---------- */
function fmtTime(iso) {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat("es-ES", { timeZone: cfg.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  } catch { return "—"; }
}
function fmtMins(m) {
  const neg = m < 0;
  const a = Math.abs(Math.round(m));
  return `${neg ? "−" : ""}${Math.floor(a / 60)} h ${String(a % 60).padStart(2, "0")} m`;
}
function locLabel(v) {
  if (!v) return "";
  return ["office", "remote", "client"].includes(v) ? T("ta.pr.loc." + v) : v;
}
// office / remote / client rendered as an icon; free text keeps the word.
const LOC_ICON = {
  office: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 22V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v18"/><path d="M2 22h20M10 6h.01M14 6h.01M10 10h.01M14 10h.01M10 14h.01M14 14h.01M10 18h.01M14 18h.01"/></svg>',
  remote: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M9 21v-6h6v6"/></svg>',
  client: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>',
};
function locIcon(v) { return LOC_ICON[v] || ""; }
function locChip(v) {
  if (!v) return "";
  const lbl = esc(locLabel(v));
  return LOC_ICON[v]
    ? `<span class="mp-loc-ic" role="img" title="${lbl}" aria-label="${lbl}">${LOC_ICON[v]}</span>`
    : `<span class="mp-seg-loc">${lbl}</span>`;
}
let clockLoc = "remote";   // self-declared location for the next clock-in
function setLocPressed(loc) {
  if (!el.mpLocation) return;
  el.mpLocation.querySelectorAll("button[data-loc]").forEach((x) => {
    x.setAttribute("aria-pressed", String(x.dataset.loc === loc));
  });
}
function setupLocPicker() {
  if (!el.mpLocation) return;
  el.mpLocation.querySelectorAll("button[data-loc]").forEach((b) => {
    b.innerHTML = locIcon(b.dataset.loc);
    b.addEventListener("click", () => { clockLoc = b.dataset.loc; setLocPressed(clockLoc); });
  });
}
function openMinutes() {
  if (!state || !state.open || !state.since) return 0;
  return Math.max(0, (Date.now() - new Date(state.since).getTime()) / 60000);
}

/* ---------- render ---------- */
function render() {
  if (!state) return;
  const open = !!state.open;
  const expected = state.expectedMinutes || 0;
  const committed = (state.workedMinutes || 0) + openMinutes();
  const left = expected - committed;

  el.mpDot.className = "mp-dot" + (open ? " is-in" : "");
  const openChip = open ? locChip(state.locationLabel) : "";
  el.mpState.innerHTML = esc(open
    ? T("ta.pr.stateIn", { since: fmtTime(state.since), elapsed: fmtMins(openMinutes()) })
    : T("ta.pr.stateOut")) + (openChip ? ` ${openChip}` : "");

  el.mpClockBtn.textContent = open ? T("ta.pr.clockOut") : T("ta.pr.clockIn");
  el.mpClockBtn.className = "mp-clock-btn" + (open ? " is-out" : "");
  el.mpClockBtn.disabled = busy;
  el.mpLocWrap.classList.toggle("hidden", open);

  el.mpExpected.textContent = expected ? fmtMins(expected) : "—";
  el.mpCommitted.textContent = fmtMins(committed);
  if (!expected) {
    el.mpLeft.textContent = "—";
    el.mpLeft.className = "mp-stat__value";
  } else if (left > 0) {
    el.mpLeft.textContent = fmtMins(left);
    el.mpLeft.className = "mp-stat__value";
  } else {
    el.mpLeft.textContent = left < -1 ? T("mp.overtime", { hours: fmtMins(-left) }) : T("mp.complete");
    el.mpLeft.className = "mp-stat__value is-done";
  }

  // holiday / approved-leave context so a 0-expected day isn't a surprise
  const ctx = state.holiday || state.leave;
  el.mpDayNote.classList.toggle("hidden", !ctx);
  if (ctx) el.mpDayNote.textContent = state.holiday || state.leave;

  const segs = state.segments || [];
  el.mpToday.innerHTML = segs.length
    ? `<span class="mp-today__label">${T("ta.pr.todayLabel")}</span> ` +
      segs.map((s) => {
        const chip = locChip(s.location);
        return `<span class="mp-seg">${fmtTime(s.in)}–${fmtTime(s.out)}${chip ? ` ${chip}` : ""}</span>`;
      }).join(" ")
    : "";
}

async function load() {
  try {
    state = await HITT_API.getPresenceToday();
  } catch (err) {
    el.mpState.textContent = err.message || T("ta.pr.loadFail");
    el.mpClockBtn.disabled = true;
    return;
  }
  el.mpClockBtn.disabled = false;
  render();
}

async function doClock() {
  if (busy || !state) return;
  const kind = state.open ? "out" : "in";
  busy = true;
  el.mpClockBtn.disabled = true;
  try {
    await HITT_API.presenceClock({ kind, location: clockLoc || "remote" });
    toast(kind === "in" ? T("mp.clockedIn") : T("mp.clockedOut"), "green");
    if (kind === "out") { clockLoc = "remote"; setLocPressed("remote"); }
  } catch (err) {
    toast(err.message || T("ta.pr.clockFail"), "red");
  } finally {
    busy = false;
    await load(); // re-sync from the server (also self-heals a 409)
  }
}

/* ---------- init ---------- */
(async () => {
  try {
    cfg = await HITT_API.getPresenceConfig();
  } catch (err) {
    el.mpState.textContent = T("ta.pr.loadFail");
    return;
  }
  if (cfg.privacyNotice) {
    el.mpPrivacyLink.hidden = false;
    el.mpPrivacyLink.addEventListener("click", (e) => { e.preventDefault(); alert(cfg.privacyNotice); });
  }
  setupLocPicker();
  el.mpClockBtn.addEventListener("click", doClock);
  await load();
  // keep the elapsed / done / left figures live while clocked in
  ticker = setInterval(() => { if (state?.open) render(); }, 30000);
})();

window.addEventListener("hitt:langchange", () => { if (state) render(); });
