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
  el.mpState.textContent = open
    ? T("ta.pr.stateIn", { since: fmtTime(state.since), elapsed: fmtMins(openMinutes()) })
    : T("ta.pr.stateOut");

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
      segs.map((s) => `<span class="mp-seg">${fmtTime(s.in)}–${fmtTime(s.out)}</span>`).join(" ")
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
    await HITT_API.presenceClock({ kind, location: el.mpLocation.value || undefined });
    toast(kind === "in" ? T("mp.clockedIn") : T("mp.clockedOut"), "green");
    if (kind === "out") el.mpLocation.value = "";
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
  el.mpClockBtn.addEventListener("click", doClock);
  await load();
  // keep the elapsed / done / left figures live while clocked in
  ticker = setInterval(() => { if (state?.open) render(); }, 30000);
})();

window.addEventListener("hitt:langchange", () => { if (state) render(); });
