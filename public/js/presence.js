/**
 * HITT Ops — Presence tab (registro de jornada legal, RDL 8/2019).
 * ---------------------------------------------------------------------------
 * Loaded on time-allocation.html before time-allocation.js, which calls
 * HITT_PRESENCE.init() when the "Presence" tab opens and .onLangChange() on
 * hitt:langchange (same hook style as report-builder.js).
 *
 * All times are rendered in the ORG timezone (config.timezone), never the
 * viewer's browser zone — the register is a Spanish legal document.
 * ---------------------------------------------------------------------------
 */
window.HITT_PRESENCE = (function () {
  "use strict";

  const T = (k, v) => (window.HITT_I18N ? HITT_I18N.t(k, v) : k);
  function esc(s) { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; }
  function toast(msg, tone = "navy") {
    const host = document.getElementById("toastHost");
    if (!host) return;
    const el = document.createElement("div");
    el.className = `toast toast-${tone}`;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }
  function downloadBlob(name, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  let started = false;
  let cfg = null;
  let month = null;                 // { year, month }
  let viewingEmployee = null;       // null = own; else employee id (viewer/admin)
  let register = null;              // GET /me | /employees/:id payload
  let todayState = null;            // GET /me/today
  let monthly = null;
  let ticker = null;
  const el = {};

  function fmtTime(iso) {
    if (!iso) return "—";
    try {
      return new Intl.DateTimeFormat("es-ES", { timeZone: cfg.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
    } catch { return "—"; }
  }
  function fmtMins(m) {
    const neg = m < 0; const a = Math.abs(Math.round(m));
    return `${neg ? "−" : ""}${Math.floor(a / 60)} h ${String(a % 60).padStart(2, "0")} m`;
  }
  // office/remote/client -> localised; free text stays as-is; null -> ""
  function locLabel(v) {
    if (!v) return "";
    return ["office", "remote", "client"].includes(v) ? T("ta.pr.loc." + v) : v;
  }
  function fmtElapsed(sinceIso) {
    const s = Math.max(0, Math.floor((Date.now() - new Date(sinceIso)) / 1000));
    return `${Math.floor(s / 3600)} h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")} m`;
  }
  function weekdayLabel(dateStr) {
    try {
      return new Intl.DateTimeFormat("es-ES", { timeZone: "UTC", weekday: "short" }).format(new Date(dateStr + "T12:00:00Z"));
    } catch { return ""; }
  }
  function todayInTz() {
    return new Intl.DateTimeFormat("en-CA", { timeZone: cfg.timezone }).format(new Date()); // YYYY-MM-DD
  }

  async function init() {
    if (started) { renderAll(); return; }
    started = true;
    [
      "prClockCard", "prDot", "prClockState", "prClockBtn", "prLocation", "prToday",
      "prMonthLabel", "prSummary", "prTableBody", "prEmpWrap", "prEmployee", "prOverview",
      "prPrevMonth", "prNextMonth", "prThisMonth", "prAddEntry", "prExportCsv", "prExportPdf",
      "prPrivacyLink",
      "prEntryOverlay", "prEntryTitle", "prEntryDate", "prEntryRows", "prEntryAddRow",
      "prEntryNote", "prEntryHint", "prEntryClose", "prEntryCancel", "prEntrySubmit",
      "prEntryCorrectNote", "prEntryRowsSection",
    ].forEach((id) => { el[id] = document.getElementById(id); });

    try {
      cfg = await HITT_API.getPresenceConfig();
    } catch (err) {
      el.prClockState.textContent = T("ta.pr.loadFail");
      return;
    }
    const now = todayInTz();
    month = { year: Number(now.slice(0, 4)), month: Number(now.slice(5, 7)) };

    if (cfg.privacyNotice) {
      el.prPrivacyLink.hidden = false;
      el.prPrivacyLink.addEventListener("click", (e) => { e.preventDefault(); alert(cfg.privacyNotice); });
    }
    if (cfg.isPresenceViewer) {
      el.prEmpWrap.hidden = false;
      await loadEmployeeOptions();
      el.prEmployee.addEventListener("change", () => {
        viewingEmployee = el.prEmployee.value || null;
        el.prClockCard.classList.toggle("hidden", !!viewingEmployee);
        loadRegister();
        loadOverview();
      });
    }

    el.prClockBtn.addEventListener("click", doClock);
    el.prPrevMonth.addEventListener("click", () => shiftMonth(-1));
    el.prNextMonth.addEventListener("click", () => shiftMonth(1));
    el.prThisMonth.addEventListener("click", () => { const t = todayInTz(); month = { year: +t.slice(0, 4), month: +t.slice(5, 7) }; loadRegister(); });
    el.prAddEntry.addEventListener("click", () => openEntry(null));
    el.prExportCsv.addEventListener("click", () => exportRegister("csv"));
    el.prExportPdf.addEventListener("click", () => exportRegister("pdf"));

    el.prEntryClose.addEventListener("click", closeEntry);
    el.prEntryCancel.addEventListener("click", closeEntry);
    el.prEntryOverlay.addEventListener("click", (e) => { if (e.target === el.prEntryOverlay) closeEntry(); });
    el.prEntryAddRow.addEventListener("click", () => addEntryRow());
    el.prEntryNote.addEventListener("input", () => el.prEntryHint.classList.add("hidden"));
    el.prEntrySubmit.addEventListener("click", submitEntry);

    el.prTableBody.addEventListener("click", (e) => {
      const btn = e.target.closest("[data-day-action]");
      if (btn) openEntry(btn.dataset.day, btn.dataset.correct || null);
    });

    ticker = setInterval(tick, 30000);
    await Promise.all([loadToday(), loadRegister(), loadOverview()]);
  }

  function onLangChange() {
    if (!started) return;
    renderAll();
  }

  function renderAll() {
    renderClock();
    renderRegister();
    renderOverview();
  }

  function tick() {
    if (document.getElementById("panePresence")?.classList.contains("hidden")) return;
    if (todayState?.open) renderClock();
  }

  /* ---------- employee picker (viewer/admin) ---------- */
  async function loadEmployeeOptions() {
    try {
      const ov = await HITT_API.getPresenceOverview();
      el.prEmployee.innerHTML =
        `<option value="">${esc(T("ta.pr.mine"))}</option>` +
        ov.rows.map((r) => `<option value="${r.employeeId}">${esc(r.name)}</option>`).join("");
    } catch { /* leave as-is */ }
  }

  /* ---------- clock ---------- */
  async function loadToday() {
    if (viewingEmployee) return;
    try { todayState = await HITT_API.getPresenceToday(); } catch { todayState = null; }
    renderClock();
  }

  function renderClock() {
    if (viewingEmployee || !todayState) { el.prClockCard.classList.toggle("hidden", !!viewingEmployee); return; }
    el.prClockCard.classList.remove("hidden");
    const open = todayState.open;
    el.prDot.className = "ta-pr-clock-dot" + (open ? " is-in" : "");
    el.prClockBtn.textContent = open ? T("ta.pr.clockOut") : T("ta.pr.clockIn");
    el.prClockBtn.className = "btn " + (open ? "btn-secondary" : "btn-primary");
    el.prLocation.parentElement.style.display = open ? "none" : "";
    el.prClockState.textContent = open
      ? T("ta.pr.stateIn", { since: fmtTime(todayState.since), elapsed: fmtElapsed(todayState.since) })
      : T("ta.pr.stateOut");
    const segs = todayState.segments || [];
    el.prToday.innerHTML = segs.length
      ? `<span class="ta-pr-today-label">${esc(T("ta.pr.todayLabel"))}</span> ` +
        segs.map((s) => {
          const loc = locLabel(s.location);
          return `<span class="ta-pr-seg">${fmtTime(s.in)}–${fmtTime(s.out)}${loc ? ` <span class="ta-pr-seg-loc">${esc(loc)}</span>` : ""}</span>`;
        }).join(" ") +
        ` · <strong>${fmtMins(todayState.workedMinutes)}</strong>`
      : "";
  }

  async function doClock() {
    const kind = todayState?.open ? "out" : "in";
    try {
      await HITT_API.presenceClock({ kind, location: el.prLocation.value || undefined });
      await loadToday();
      await loadRegister();
    } catch (err) {
      toast(err.message || T("ta.pr.clockFail"), "red");
    }
  }

  /* ---------- month register ---------- */
  function shiftMonth(delta) {
    let m = month.month + delta, y = month.year;
    if (m < 1) { m = 12; y--; } else if (m > 12) { m = 1; y++; }
    month = { year: y, month: m };
    loadRegister();
  }

  function monthBounds() {
    const from = `${month.year}-${String(month.month).padStart(2, "0")}-01`;
    const last = new Date(Date.UTC(month.year, month.month, 0)).getUTCDate();
    const to = `${month.year}-${String(month.month).padStart(2, "0")}-${String(last).padStart(2, "0")}`;
    return { from, to };
  }

  async function loadRegister() {
    const { from, to } = monthBounds();
    el.prTableBody.innerHTML = `<tr><td colspan="8" class="sub-empty">${esc(T("common.loading"))}</td></tr>`;
    try {
      register = await HITT_API.getPresenceRegister(from, to, viewingEmployee || undefined);
      monthly = await HITT_API.getPresenceMonthly(month.year, month.month, viewingEmployee || undefined).catch(() => null);
    } catch (err) {
      el.prTableBody.innerHTML = `<tr><td colspan="8" class="sub-empty">${esc(err.message || T("ta.pr.loadFail"))}</td></tr>`;
      return;
    }
    renderRegister();
  }

  function renderRegister() {
    if (!register) return;
    el.prMonthLabel.textContent = new Intl.DateTimeFormat("es-ES", { timeZone: "UTC", month: "long", year: "numeric" })
      .format(new Date(register.from + "T12:00:00Z"));
    const canEdit = !viewingEmployee || cfg.isPresenceAdmin;
    const today = todayInTz();
    const supMap = {};
    (register.events || []).forEach((e) => { if (e.supersedesId) supMap[e.supersedesId] = true; });

    el.prTableBody.innerHTML = (register.days || []).map((d) => {
      const badge = d.holiday ? `<span class="ta-pr-badge is-holiday">${esc(d.holiday)}</span>`
        : d.leave ? `<span class="ta-pr-badge is-leave">${esc(d.leave)}</span>` : "";
      const workedCell = d.open
        ? `<span class="ta-pr-open">${esc(T("ta.pr.inProgress"))}</span>`
        : (d.workedMinutes ? fmtMins(d.workedMinutes) : (badge || "—"));
      const balClass = d.balanceMinutes < 0 ? ' style="color:var(--danger);"' : "";
      const segs = d.segments
        .map((s) => { const l = locLabel(s.location); return `${fmtTime(s.in)}–${fmtTime(s.out)}${l ? ` · ${l}` : ""}`; })
        .join("   ");
      const future = d.date > today;
      return `<tr${d.date === today ? ' class="ta-pr-row-today"' : ""}>
        <td>${esc(weekdayLabel(d.date))} ${esc(d.date.slice(8))}${d.hasManual ? ` <span class="ta-pr-m" title="${esc(T('ta.pr.manualTip'))}">M</span>` : ""}</td>
        <td>${fmtTime(d.firstIn)}</td>
        <td>${d.open ? "—" : fmtTime(d.lastOut)}</td>
        <td class="ta-pr-segcell">${esc(segs)}</td>
        <td style="text-align:right;">${workedCell}</td>
        <td style="text-align:right; color:var(--text-secondary);">${d.expectedMinutes ? fmtMins(d.expectedMinutes) : "—"}</td>
        <td style="text-align:right;"${balClass}>${d.workedMinutes || d.expectedMinutes ? fmtMins(d.balanceMinutes) : "—"}</td>
        <td style="text-align:right;">${canEdit && !future ? `<button class="ta-remove-btn" data-day-action data-day="${d.date}">${esc(T("ta.pr.fix"))}</button>` : ""}</td>
      </tr>`;
    }).join("");

    renderSummary();
    // month nav only forward to the current month
    const t = todayInTz();
    el.prNextMonth.disabled = (month.year > +t.slice(0, 4)) || (month.year === +t.slice(0, 4) && month.month >= +t.slice(5, 7));
  }

  function renderSummary() {
    if (!register) { el.prSummary.innerHTML = ""; return; }
    const tot = register.totals;
    let ack = "";
    if (monthly && !viewingEmployee) {
      ack = monthly.acknowledged_at
        ? `<span class="ta-pr-ack-done">${esc(T("ta.pr.ackDone"))}</span>`
        : `<button class="btn btn-secondary" id="prAckBtn">${esc(T("ta.pr.ack"))}</button>`;
    }
    el.prSummary.innerHTML =
      `<strong>${esc(el.prMonthLabel.textContent)}</strong> · ` +
      `${esc(T("ta.pr.sum.worked"))} <strong>${fmtMins(tot.workedMinutes)}</strong> · ` +
      `${esc(T("ta.pr.sum.expected"))} ${fmtMins(tot.expectedMinutes)} · ` +
      `${esc(T("ta.pr.sum.balance"))} <strong style="color:${tot.balanceMinutes < 0 ? "var(--danger)" : "inherit"}">${fmtMins(tot.balanceMinutes)}</strong>` +
      (ack ? ` &nbsp; ${ack}` : "");
    const b = document.getElementById("prAckBtn");
    if (b) b.addEventListener("click", async () => {
      try { await HITT_API.acknowledgePresenceMonthly(monthly.id); monthly.acknowledged_at = new Date().toISOString(); renderSummary(); toast(T("ta.pr.ackOk"), "green"); }
      catch (err) { toast(err.message, "red"); }
    });
  }

  /* ---------- add / correct modal ---------- */
  function addEntryRow(kind = "in", time = "") {
    const row = document.createElement("div");
    row.className = "ta-pr-entry-row";
    row.innerHTML =
      `<select class="field-input ta-pr-entry-kind"><option value="in"${kind === "in" ? " selected" : ""}>${esc(T("ta.pr.in"))}</option><option value="out"${kind === "out" ? " selected" : ""}>${esc(T("ta.pr.out"))}</option></select>` +
      `<input type="time" class="field-input ta-pr-entry-time" value="${esc(time)}" />` +
      `<button type="button" class="ta-remove-btn ta-pr-entry-del">✕</button>`;
    row.querySelector(".ta-pr-entry-del").addEventListener("click", () => row.remove());
    el.prEntryRows.appendChild(row);
  }

  let correctingId = null;
  let entryReplacesDay = false;
  function openEntry(day, correctId) {
    correctingId = correctId || null;
    entryReplacesDay = false;
    el.prEntryRows.innerHTML = "";
    el.prEntryNote.value = "";
    el.prEntryHint.classList.add("hidden");
    el.prEntryDate.value = day || todayInTz();
    el.prEntryDate.disabled = !!day;
    const onBehalf = viewingEmployee && cfg.isPresenceAdmin;

    if (correctId) {
      const ev = (register.events || []).find((e) => String(e.id) === String(correctId));
      el.prEntryTitle.textContent = T("ta.pr.entry.correctTitle");
      el.prEntryRowsSection.querySelector(".field-label").textContent = T("ta.pr.entry.newTime");
      el.prEntryAddRow.hidden = true;
      el.prEntryCorrectNote.textContent = T("ta.pr.entry.correcting", { kind: ev ? T(ev.kind === "in" ? "ta.pr.in" : "ta.pr.out") : "", time: ev ? fmtTime(ev.eventAt) : "" });
      el.prEntryCorrectNote.classList.remove("hidden");
      addEntryRow(ev ? ev.kind : "in", ev ? new Intl.DateTimeFormat("en-GB", { timeZone: cfg.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(ev.eventAt)) : "");
    } else {
      el.prEntryTitle.textContent = onBehalf ? T("ta.pr.entry.behalfTitle", { name: el.prEmployee.selectedOptions[0]?.textContent || "" }) : T("ta.pr.entry.title");
      el.prEntryRowsSection.querySelector(".field-label").textContent = T("ta.pr.entry.times");
      el.prEntryAddRow.hidden = false;
      el.prEntryCorrectNote.classList.add("hidden");
      // prefill from that day's existing effective clock events, else a blank pair
      const dEvents = (register.events || []).filter((e) => e.localDate === day && e.effective && e.kind !== "void");
      if (dEvents.length) {
        entryReplacesDay = true;
        el.prEntryCorrectNote.textContent = T("ta.pr.entry.replaces");
        el.prEntryCorrectNote.classList.remove("hidden");
        dEvents.forEach((e) => addEntryRow(e.kind, new Intl.DateTimeFormat("en-GB", { timeZone: cfg.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date(e.eventAt))));
      } else { addEntryRow("in"); addEntryRow("out"); }
    }
    el.prEntryOverlay.classList.remove("hidden");
    setTimeout(() => el.prEntryNote.focus(), 50);
  }
  function closeEntry() { el.prEntryOverlay.classList.add("hidden"); correctingId = null; }

  async function submitEntry() {
    const note = el.prEntryNote.value.trim();
    if (!note) { el.prEntryHint.classList.remove("hidden"); el.prEntryNote.focus(); return; }
    const localDate = el.prEntryDate.value;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) { toast(T("ta.pr.entry.badDate"), "red"); return; }
    const rows = [...el.prEntryRows.querySelectorAll(".ta-pr-entry-row")].map((r) => ({
      kind: r.querySelector(".ta-pr-entry-kind").value,
      time: r.querySelector(".ta-pr-entry-time").value,
    })).filter((r) => r.time);
    if (!rows.length) { toast(T("ta.pr.entry.needTime"), "red"); return; }
    const onBehalfOf = viewingEmployee && cfg.isPresenceAdmin ? viewingEmployee : undefined;
    try {
      if (correctingId) {
        await HITT_API.presenceManual({ supersedesId: correctingId, kind: rows[0].kind, localDate, time: rows[0].time, note, onBehalfOf });
      } else {
        await HITT_API.presenceManual({ localDate, entries: rows, note, onBehalfOf, replaceDay: entryReplacesDay });
      }
      closeEntry();
      toast(T("ta.pr.entry.saved"), "green");
      await Promise.all([loadToday(), loadRegister()]);
    } catch (err) {
      toast(err.message || T("ta.pr.entry.saveFail"), "red");
    }
  }

  /* ---------- export ---------- */
  async function exportRegister(format) {
    const { from, to } = monthBounds();
    try {
      const blob = await HITT_API.fetchPresenceExport(from, to, format, viewingEmployee || undefined);
      const who = viewingEmployee ? (el.prEmployee.selectedOptions[0]?.textContent || "empleado") : "mi-jornada";
      downloadBlob(`registro-jornada_${who.replace(/[^\w-]+/g, "_")}_${from}_${to}.${format === "pdf" ? "pdf" : "csv"}`, blob);
    } catch (err) {
      toast(err.message || T("ta.pr.exportFail"), "red");
    }
  }

  /* ---------- HR overview panel ---------- */
  async function loadOverview() {
    if (!cfg?.isPresenceViewer) return;
    try {
      const ov = await HITT_API.getPresenceOverview(todayInTz());
      el._overview = ov;
      renderOverview();
    } catch { /* ignore */ }
  }
  function renderOverview() {
    if (!cfg?.isPresenceViewer || !el._overview) return;
    el.prOverview.hidden = false;
    const rows = el._overview.rows;
    const inCount = rows.filter((r) => r.clockedIn).length;
    const missing = rows.filter((r) => !r.clockedIn && !r.onLeave);
    el.prOverview.innerHTML =
      `<h3 class="ta-pr-ov-title">${esc(T("ta.pr.ov.title", { date: el._overview.date }))}</h3>` +
      `<p class="ta-pr-ov-sum">${esc(T("ta.pr.ov.summary", { in: inCount, total: rows.length, missing: missing.length }))}</p>` +
      (missing.length
        ? `<div class="ta-pr-ov-list">${missing.map((r) => `<button class="ta-pr-ov-chip" data-ov-emp="${r.employeeId}">${esc(r.name)}</button>`).join("")}</div>`
        : `<p class="ta-pr-ov-ok">${esc(T("ta.pr.ov.allIn"))}</p>`);
    el.prOverview.querySelectorAll("[data-ov-emp]").forEach((b) => b.addEventListener("click", () => {
      el.prEmployee.value = b.dataset.ovEmp;
      el.prEmployee.dispatchEvent(new Event("change"));
    }));
  }

  return { init, onLangChange };
})();
