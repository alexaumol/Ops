/**
 * HITT Ops — Report builder ("My reports" tab on the Reports page).
 * ---------------------------------------------------------------------------
 * Drag fields from a curated catalogue into Rows / Values / Filters zones,
 * pick a viz (table / bar / line), and the server turns the config into one
 * parameterised SELECT against a curated `rpt_*` view. Save per user, share
 * (public), export CSV, capture a PNG screenshot.
 *
 * Loaded after reports.js on reports.html. reports.js calls
 * HITT_REPORT_BUILDER.init() when the "My reports" tab is first opened and
 * HITT_REPORT_BUILDER.onLangChange() on hitt:langchange.
 *
 * The small helpers (T / escapeHtml / toast / csv / number formatting) are
 * duplicated from reports.js on purpose — those are script-scoped there, not
 * global, and time-allocation.js keeps its own copies for the same reason.
 * ---------------------------------------------------------------------------
 */
window.HITT_REPORT_BUILDER = (function () {
  "use strict";

  const T = (k, v) => (window.HITT_I18N ? HITT_I18N.t(k, v) : k);
  const DICT = () => window.HITT_I18N_DICT || { en: {} };
  const LANG = () => (window.HITT_I18N ? HITT_I18N.lang : "en");

  function escapeHtml(s) {
    const d = document.createElement("div");
    d.textContent = s ?? "";
    return d.innerHTML;
  }
  function toast(msg, tone = "navy") {
    const host = document.getElementById("toastHost");
    if (!host) return;
    const el = document.createElement("div");
    el.className = `toast toast-${tone}`;
    el.textContent = msg;
    host.appendChild(el);
    setTimeout(() => el.remove(), 3000);
  }
  function csvEscape(value) {
    const s = String(value ?? "");
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }
  function downloadBlob(filename, blob) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  function downloadCsv(filename, headers, rows) {
    const lines = [headers.map(csvEscape).join(","), ...rows.map((r) => r.map(csvEscape).join(","))];
    downloadBlob(filename, new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" }));
  }
  const num = (n) => Number(n || 0);
  function fmtNum(n) {
    const v = num(n);
    return Number.isInteger(v) ? v.toLocaleString() : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  function fmtCompact(n) {
    const v = num(n);
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + "M";
    if (Math.abs(v) >= 1e3) return Math.round(v / 1e3) + "k";
    return String(Math.round(v * 100) / 100);
  }
  function niceMax(max) {
    if (max <= 0) return 1;
    const mag = Math.pow(10, Math.floor(Math.log10(max)));
    const r = max / mag;
    const step = r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10;
    return step * mag;
  }

  const AGGS = ["sum", "avg", "min", "max", "count"];
  const OPS_BY_TYPE = {
    text: ["eq", "neq", "in", "not_in", "contains"],
    number: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in"],
    date: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
  };
  const CHART_PALETTE = ["#5C757C", "#BC9A1C", "#6E8F5A", "#A6791F", "#7A9E9F", "#9A8C5A", "#B24A3A"];

  // --- module state --------------------------------------------------------
  let started = false;
  let catalog = []; // [{ id, label, fields:[{id,label,role,type,defaultAgg}] }]
  let savedReports = []; // rows from GET /api/reports/saved
  let lastResult = null; // { columns, rows }
  let runTimer = null;
  let els = {};

  const state = {
    savedId: null,
    name: "",
    ispublic: false,
    dataset: null,
    dimensions: [], // field ids (rows / group-by / category+series)
    measures: [], // { field, agg }
    filters: [], // { field, op, value }
    vizType: "table",
    sort: null, // { field, dir }
  };

  // --- catalogue lookups --------------------------------------------------
  const datasetMeta = (id) => catalog.find((d) => d.id === id) || null;
  function fieldMeta(datasetId, fieldId) {
    const ds = datasetMeta(datasetId);
    return ds ? ds.fields.find((f) => f.id === fieldId) || null : null;
  }
  function dictLabel(key, fallback) {
    const d = DICT();
    if ((d[LANG()] && d[LANG()][key]) || (d.en && d.en[key])) return T(key);
    return fallback;
  }
  const fieldLabel = (f) => dictLabel("rpt.rf." + f.id, f.label);
  const datasetLabel = (d) => dictLabel("rpt.rds." + d.id, d.label);
  const aggLabel = (a) => dictLabel("rpt.rb.agg." + a, a);
  const opLabel = (o) => dictLabel("rpt.rb.op." + o, o);

  // --- init -------------------------------------------------------------
  async function init() {
    if (started) return;
    started = true;
    els = {
      dataset: document.getElementById("rbDataset"),
      dimFields: document.getElementById("rbDimFields"),
      measureFields: document.getElementById("rbMeasureFields"),
      zoneDimensions: document.getElementById("rbZoneDimensions"),
      zoneMeasures: document.getElementById("rbZoneMeasures"),
      zoneFilters: document.getElementById("rbZoneFilters"),
      zoneDimLabel: document.getElementById("rbZoneDimLabel"),
      zoneMeasureLabel: document.getElementById("rbZoneMeasureLabel"),
      hint: document.getElementById("rbHint"),
      result: document.getElementById("rbResult"),
      empty: document.getElementById("rbEmpty"),
      savedSelect: document.getElementById("rbSavedSelect"),
      nameInput: document.getElementById("rbName"),
      vizToggle: document.getElementById("rbVizToggle"),
      publicChk: document.getElementById("rbPublic"),
    };

    try {
      const [ds, saved] = await Promise.all([HITT_API.getReportDatasets(), HITT_API.getSavedReports()]);
      catalog = ds.datasets || [];
      savedReports = saved.rows || [];
    } catch (err) {
      console.error("[report-builder] failed to load catalogue:", err.message);
      els.empty.textContent = T("rpt.rb.loadFail");
      return;
    }

    // dataset select
    els.dataset.innerHTML = catalog
      .map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(datasetLabel(d))}</option>`)
      .join("");
    state.dataset = catalog[0] ? catalog[0].id : null;

    renderSavedSelect();
    renderRailFields();
    renderZones();

    els.dataset.addEventListener("change", () => {
      state.dataset = els.dataset.value;
      state.dimensions = [];
      state.measures = [];
      state.filters = [];
      state.sort = null;
      markDirty();
      renderRailFields();
      renderZones();
      run();
    });
    els.savedSelect.addEventListener("change", () => loadSaved(els.savedSelect.value));
    els.nameInput.addEventListener("input", () => { state.name = els.nameInput.value; });
    els.publicChk.addEventListener("change", () => { state.ispublic = els.publicChk.checked; markDirty(); });
    els.vizToggle.querySelectorAll("[data-viz]").forEach((b) => {
      b.addEventListener("click", () => setViz(b.dataset.viz));
    });
    document.getElementById("rbSave").addEventListener("click", () => save(false));
    document.getElementById("rbSaveAs").addEventListener("click", () => save(true));
    document.getElementById("rbDelete").addEventListener("click", deleteSaved);
    document.getElementById("rbExportCsv").addEventListener("click", exportCsv);
    document.getElementById("rbScreenshot").addEventListener("click", screenshot);

    wireDropzones();
    updateVizUi();
    run();
  }

  function onLangChange() {
    if (!started) return;
    els.dataset.innerHTML = catalog
      .map((d) => `<option value="${escapeHtml(d.id)}"${d.id === state.dataset ? " selected" : ""}>${escapeHtml(datasetLabel(d))}</option>`)
      .join("");
    renderSavedSelect();
    renderRailFields();
    renderZones();
    updateVizUi();
    render();
  }

  // --- saved reports select --------------------------------------------
  function renderSavedSelect() {
    const mine = savedReports.filter((r) => r.mine);
    const shared = savedReports.filter((r) => !r.mine);
    let html = `<option value="">${escapeHtml(T("rpt.rb.newReport"))}</option>`;
    if (mine.length) {
      html += `<optgroup label="${escapeHtml(T("rpt.rb.mine"))}">` +
        mine.map((r) => `<option value="${r.id}"${r.id == state.savedId ? " selected" : ""}>${escapeHtml(r.name)}</option>`).join("") +
        `</optgroup>`;
    }
    if (shared.length) {
      html += `<optgroup label="${escapeHtml(T("rpt.rb.shared"))}">` +
        shared.map((r) => `<option value="${r.id}"${r.id == state.savedId ? " selected" : ""}>${escapeHtml(r.name)} · ${escapeHtml(r.ownerName)}</option>`).join("") +
        `</optgroup>`;
    }
    els.savedSelect.innerHTML = html;
  }

  function loadSaved(id) {
    if (!id) {
      Object.assign(state, { savedId: null, name: "", ispublic: false, dimensions: [], measures: [], filters: [], sort: null });
      els.publicChk.checked = false;
      els.nameInput.value = "";
      renderRailFields();
      renderZones();
      updateVizUi();
      run();
      return;
    }
    const row = savedReports.find((r) => String(r.id) === String(id));
    if (!row) return;
    const cfg = row.config || {};
    Object.assign(state, {
      savedId: row.id,
      name: row.name,
      ispublic: !!row.ispublic,
      dataset: cfg.dataset || state.dataset,
      dimensions: Array.isArray(cfg.dimensions) ? cfg.dimensions.slice() : [],
      measures: Array.isArray(cfg.measures) ? cfg.measures.map((m) => ({ field: m.field, agg: m.agg })) : [],
      filters: Array.isArray(cfg.filters) ? cfg.filters.map((f) => ({ field: f.field, op: f.op, value: f.value })) : [],
      vizType: ["table", "bar", "line"].includes(cfg.vizType) ? cfg.vizType : "table",
      sort: cfg.sort || null,
    });
    els.dataset.value = state.dataset;
    els.publicChk.checked = state.ispublic;
    els.nameInput.value = state.name;
    renderRailFields();
    renderZones();
    updateVizUi();
    run();
  }

  function markDirty() {
    /* saved-vs-unsaved is implicit; kept as a hook for a future "unsaved" badge */
  }

  // --- rail (draggable source chips) ----------------------------------
  function renderRailFields() {
    const ds = datasetMeta(state.dataset);
    if (!ds) return;
    const chip = (f) =>
      `<button type="button" class="rpt-chip" draggable="true" data-field="${escapeHtml(f.id)}" data-role="${f.role}">${escapeHtml(fieldLabel(f))}</button>`;
    els.dimFields.innerHTML = ds.fields.filter((f) => f.role === "dimension").map(chip).join("");
    els.measureFields.innerHTML = ds.fields.filter((f) => f.role === "measure").map(chip).join("");
    [els.dimFields, els.measureFields].forEach((host) => {
      host.querySelectorAll(".rpt-chip").forEach((c) => {
        c.addEventListener("dragstart", (e) => {
          e.dataTransfer.setData("text/plain", JSON.stringify({ field: c.dataset.field }));
          e.dataTransfer.effectAllowed = "copy";
        });
        c.addEventListener("click", () => addField(c.dataset.field, c.dataset.role === "measure" ? "measures" : "dimensions"));
      });
    });
  }

  // --- zones -----------------------------------------------------------
  function addField(fieldId, zone) {
    const f = fieldMeta(state.dataset, fieldId);
    if (!f) return;
    if (zone === "dimensions") {
      if (!state.dimensions.includes(fieldId)) state.dimensions.push(fieldId);
    } else if (zone === "measures") {
      if (!state.measures.some((m) => m.field === fieldId)) {
        state.measures.push({ field: fieldId, agg: f.role === "dimension" ? "count" : (f.defaultAgg || "sum") });
      }
    } else if (zone === "filters") {
      state.filters.push({ field: fieldId, op: OPS_BY_TYPE[f.type][0], value: "" });
    }
    markDirty();
    renderZones();
    run();
  }

  function pill(inner, onRemove) {
    const el = document.createElement("span");
    el.className = "rpt-zone-pill";
    el.innerHTML = inner;
    const x = document.createElement("button");
    x.type = "button";
    x.className = "rpt-zone-pill__x";
    x.textContent = "✕";
    x.addEventListener("click", onRemove);
    el.appendChild(x);
    return el;
  }

  function renderZones() {
    // dimensions
    els.zoneDimensions.innerHTML = "";
    state.dimensions.forEach((fid, i) => {
      const f = fieldMeta(state.dataset, fid);
      const role = state.vizType !== "table" ? (i === 0 ? T("rpt.rb.role.category") : i === 1 ? T("rpt.rb.role.series") : "") : "";
      els.zoneDimensions.appendChild(
        pill(`<span>${escapeHtml(f ? fieldLabel(f) : fid)}</span>${role ? `<em class="rpt-zone-pill__role">${escapeHtml(role)}</em>` : ""}`, () => {
          state.dimensions.splice(i, 1);
          renderZones();
          run();
        })
      );
    });

    // measures
    els.zoneMeasures.innerHTML = "";
    state.measures.forEach((m, i) => {
      const f = fieldMeta(state.dataset, m.field);
      const opts = (f && f.role === "dimension" ? ["count"] : AGGS)
        .map((a) => `<option value="${a}"${a === m.agg ? " selected" : ""}>${escapeHtml(aggLabel(a))}</option>`)
        .join("");
      const p = pill(
        `<select class="rpt-zone-pill__agg">${opts}</select><span>${escapeHtml(f ? fieldLabel(f) : m.field)}</span>`,
        () => { state.measures.splice(i, 1); renderZones(); run(); }
      );
      p.querySelector("select").addEventListener("change", (e) => {
        state.measures[i].agg = e.target.value;
        run();
      });
      els.zoneMeasures.appendChild(p);
    });

    // filters
    els.zoneFilters.innerHTML = "";
    state.filters.forEach((flt, i) => {
      const f = fieldMeta(state.dataset, flt.field);
      const type = f ? f.type : "text";
      const opOpts = OPS_BY_TYPE[type]
        .map((o) => `<option value="${o}"${o === flt.op ? " selected" : ""}>${escapeHtml(opLabel(o))}</option>`)
        .join("");
      const inputType = type === "date" ? "date" : type === "number" ? "number" : "text";
      const val = Array.isArray(flt.value) ? flt.value.join(flt.op === "between" ? " … " : ", ") : (flt.value ?? "");
      const p = pill(
        `<span>${escapeHtml(f ? fieldLabel(f) : flt.field)}</span>` +
          `<select class="rpt-zone-pill__op">${opOpts}</select>` +
          `<input class="rpt-zone-pill__val" type="${inputType === "date" && flt.op === "between" ? "text" : inputType}" value="${escapeHtml(val)}" placeholder="${escapeHtml(filterPlaceholder(flt.op, type))}" />`,
        () => { state.filters.splice(i, 1); renderZones(); run(); }
      );
      p.querySelector(".rpt-zone-pill__op").addEventListener("change", (e) => {
        state.filters[i].op = e.target.value;
        state.filters[i].value = "";
        renderZones();
        run();
      });
      p.querySelector(".rpt-zone-pill__val").addEventListener("change", (e) => {
        state.filters[i].value = parseFilterValue(e.target.value, state.filters[i].op);
        run();
      });
      els.zoneFilters.appendChild(p);
    });

    updateHint();
  }

  function filterPlaceholder(op, type) {
    if (op === "in" || op === "not_in") return T("rpt.rb.ph.list");
    if (op === "between") return type === "date" ? "2025-01-01 … 2025-12-31" : "0 … 100";
    return "";
  }
  function parseFilterValue(raw, op) {
    const s = String(raw).trim();
    if (op === "in" || op === "not_in") return s.split(",").map((x) => x.trim()).filter(Boolean);
    if (op === "between") return s.split(/\s*(?:…|\.\.\.|,|to)\s*/i).map((x) => x.trim()).filter(Boolean).slice(0, 2);
    return s;
  }

  function updateHint() {
    let key = "rpt.rb.hint";
    if (state.vizType !== "table") {
      if (!state.dimensions.length || !state.measures.length) key = "rpt.rb.hint.chart";
    }
    els.hint.textContent = T(key);
  }

  function updateVizUi() {
    els.vizToggle.querySelectorAll("[data-viz]").forEach((b) => b.classList.toggle("is-active", b.dataset.viz === state.vizType));
    els.publicChk.checked = state.ispublic;
    els.zoneDimLabel.textContent = state.vizType === "table" ? T("rpt.rb.zone.rows") : T("rpt.rb.zone.categorySeries");
    els.zoneMeasureLabel.textContent = state.vizType === "table" ? T("rpt.rb.zone.values") : T("rpt.rb.zone.value");
  }

  function setViz(v) {
    const wasChart = state.vizType !== "table";
    state.vizType = v;
    markDirty();
    updateVizUi();
    renderZones();
    // Charts want a smaller, aggregated result than a table — re-run when
    // crossing the table<->chart boundary so we never try to plot 1000 rows.
    if (wasChart !== (v !== "table")) run();
    else render();
  }

  // --- drag & drop ---------------------------------------------------
  function wireDropzones() {
    [els.zoneDimensions, els.zoneMeasures, els.zoneFilters].forEach((zone) => {
      zone.addEventListener("dragover", (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
        zone.classList.add("is-drop");
      });
      zone.addEventListener("dragleave", () => zone.classList.remove("is-drop"));
      zone.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.classList.remove("is-drop");
        let payload;
        try { payload = JSON.parse(e.dataTransfer.getData("text/plain")); } catch { return; }
        if (payload && payload.field) addField(payload.field, zone.dataset.zone);
      });
    });
  }

  // --- run + render -------------------------------------------------
  function currentConfig() {
    return {
      dataset: state.dataset,
      dimensions: state.dimensions.slice(),
      measures: state.measures.map((m) => ({ field: m.field, agg: m.agg })),
      filters: state.filters
        .filter((f) => f.value !== "" && !(Array.isArray(f.value) && !f.value.length))
        .map((f) => ({ field: f.field, op: f.op, value: f.value })),
      sort: state.sort,
      vizType: state.vizType,
      // A chart with hundreds of categories is unreadable (and slow to
      // build) — cap the query hard for chart modes.
      limit: state.vizType === "table" ? 1000 : 500,
    };
  }

  function run() {
    clearTimeout(runTimer);
    runTimer = setTimeout(doRun, 250);
  }

  async function doRun() {
    if (!state.dataset || (!state.dimensions.length && !state.measures.length)) {
      lastResult = null;
      render();
      return;
    }
    if (state.vizType !== "table" && (!state.dimensions.length || !state.measures.length)) {
      lastResult = null;
      render();
      return;
    }
    els.result.classList.add("is-loading");
    try {
      lastResult = await HITT_API.runReport(currentConfig());
    } catch (err) {
      lastResult = null;
      els.result.classList.remove("is-loading");
      els.result.innerHTML = `<div class="rpt-builder-empty">${escapeHtml(err.message || T("rpt.rb.runFail"))}</div>`;
      return;
    }
    els.result.classList.remove("is-loading");
    render();
  }

  function emptyResult(msgKey) {
    els.result.innerHTML = `<div class="rpt-builder-empty">${escapeHtml(T(msgKey))}</div>`;
  }

  function render() {
    if (state.vizType !== "table" && (!state.dimensions.length || !state.measures.length)) {
      emptyResult("rpt.rb.hint.chart");
      return;
    }
    if (!lastResult || !lastResult.columns.length) {
      emptyResult("rpt.rb.empty");
      return;
    }
    if (!lastResult.rows.length) {
      emptyResult("rpt.rb.noRows");
      return;
    }
    if (state.vizType === "bar") els.result.innerHTML = renderChart("bar");
    else if (state.vizType === "line") els.result.innerHTML = renderChart("line");
    else {
      els.result.innerHTML = renderTable();
      wireTableSort();
    }
  }

  // --- table ------------------------------------------------------
  function renderTable() {
    const cols = lastResult.columns;
    const head = `<tr>${cols
      .map((c) => {
        const active = state.sort && state.sort.field === c.key;
        const arrow = active ? (state.sort.dir === "asc" ? " ▲" : " ▼") : "";
        return `<th data-sort-key="${escapeHtml(c.key)}"${c.role === "measure" || c.type === "number" ? ' style="text-align:right;"' : ""}${active ? ' class="sorted"' : ""}>${escapeHtml(c.label)}<span class="sort-arrow">${arrow}</span></th>`;
      })
      .join("")}</tr>`;
    const body = lastResult.rows
      .map(
        (r) =>
          `<tr>${cols
            .map((c) => {
              const v = r[c.key];
              const isNum = c.role === "measure" || c.type === "number";
              return `<td${isNum ? ' style="text-align:right;"' : ""}>${escapeHtml(isNum && v != null ? fmtNum(v) : v ?? "—")}</td>`;
            })
            .join("")}</tr>`
      )
      .join("");
    return `<div class="rpt-table-wrap"><table class="rpt-table"><thead id="rbTableHead">${head}</thead><tbody>${body}</tbody></table></div>`;
  }

  function wireTableSort() {
    const head = document.getElementById("rbTableHead");
    if (!head) return;
    head.addEventListener("click", (e) => {
      const th = e.target.closest("th[data-sort-key]");
      if (!th) return;
      const key = th.dataset.sortKey;
      const col = lastResult.columns.find((c) => c.key === key);
      const numeric = col && (col.role === "measure" || col.type === "number");
      if (state.sort && state.sort.field === key) {
        state.sort.dir = state.sort.dir === "asc" ? "desc" : "asc";
      } else {
        state.sort = { field: key, dir: numeric ? "desc" : "asc" };
      }
      const mul = state.sort.dir === "asc" ? 1 : -1;
      lastResult.rows.sort((a, b) => {
        const av = a[key], bv = b[key];
        if (numeric) return (num(av) - num(bv)) * mul;
        return String(av ?? "").localeCompare(String(bv ?? ""), undefined, { numeric: true }) * mul;
      });
      render();
    });
  }

  // --- charts ----------------------------------------------------
  const CHART_MAX_CATS = 40;
  const CHART_MAX_SERIES = 12;

  function chartSeries(kind) {
    // category = dimensions[0], optional series = dimensions[1], value = m0
    const catKey = state.dimensions[0];
    const seriesKey = state.dimensions[1] || null;
    const valueCol = lastResult.columns.find((c) => c.role === "measure");
    if (!catKey || !valueCol) return null;

    // First pass — accumulate every (cat, series) cell + running totals.
    // Map/Set keep this O(rows), not O(rows²).
    const cell = new Map(); // `${cat} ${series}` -> value
    const catOrder = []; // first-seen order (matters for line charts)
    const catSeen = new Set();
    const catTotal = new Map();
    const seriesTotal = new Map();
    const defaultSeries = T("rpt.rb.role.value");
    lastResult.rows.forEach((r) => {
      const cat = String(r[catKey] ?? "—");
      const sName = seriesKey ? String(r[seriesKey] ?? "—") : defaultSeries;
      const v = num(r[valueCol.key]);
      if (!catSeen.has(cat)) { catSeen.add(cat); catOrder.push(cat); }
      cell.set(`${cat} ${sName}`, v);
      catTotal.set(cat, (catTotal.get(cat) || 0) + v);
      seriesTotal.set(sName, (seriesTotal.get(sName) || 0) + v);
    });

    // Keep the biggest series, then the biggest categories (bar) or the
    // first N categories in row order (line — the x-axis is a sequence).
    const seriesNames = [...seriesTotal.keys()]
      .sort((a, b) => (seriesTotal.get(b) || 0) - (seriesTotal.get(a) || 0))
      .slice(0, CHART_MAX_SERIES);
    let cats;
    if (kind === "bar") {
      cats = [...catTotal.keys()]
        .sort((a, b) => (catTotal.get(b) || 0) - (catTotal.get(a) || 0))
        .slice(0, CHART_MAX_CATS);
    } else {
      cats = catOrder.slice(0, CHART_MAX_CATS);
    }
    const truncated = catOrder.length > cats.length || seriesTotal.size > seriesNames.length;
    return {
      cats,
      seriesNames,
      valueLabel: valueCol.label,
      truncated,
      totalCats: catOrder.length,
      get: (c, sn) => cell.get(`${c} ${sn}`) || 0,
    };
  }

  function renderChart(kind) {
    const s = chartSeries(kind);
    if (!s || !s.cats.length) return `<div class="rpt-builder-empty">${escapeHtml(T("rpt.rb.hint.chart"))}</div>`;
    const { cats, seriesNames, valueLabel } = s;
    const cellGet = (c, sn) => s.get(c, sn);
    let maxV = 0;
    cats.forEach((c) => seriesNames.forEach((sn) => { maxV = Math.max(maxV, cellGet(c, sn)); }));
    const yMax = niceMax(maxV);

    const W = 960, H = 380, ML = 56, MR = 12, MT = 16, MB = 92;
    const plotW = W - ML - MR, plotH = H - MT - MB;
    const yScale = (v) => MT + plotH - (v / yMax) * plotH;
    let svg = "";
    // gridlines + y labels
    for (let i = 0; i <= 4; i++) {
      const val = (yMax / 4) * i;
      const y = yScale(val);
      svg += `<line class="rpt-chart-gridline" x1="${ML}" y1="${y}" x2="${W - MR}" y2="${y}" />`;
      svg += `<text class="rpt-chart-label" x="${ML - 6}" y="${y + 3}" text-anchor="end">${escapeHtml(fmtCompact(val))}</text>`;
    }
    svg += `<line class="rpt-chart-axis" x1="${ML}" y1="${MT}" x2="${ML}" y2="${MT + plotH}" />`;
    svg += `<line class="rpt-chart-axis" x1="${ML}" y1="${MT + plotH}" x2="${W - MR}" y2="${MT + plotH}" />`;

    const stepX = plotW / Math.max(cats.length, 1);
    if (kind === "bar") {
      const groupW = stepX * 0.72;
      const barW = groupW / Math.max(seriesNames.length, 1);
      cats.forEach((c, ci) => {
        const gx = ML + ci * stepX + (stepX - groupW) / 2;
        seriesNames.forEach((sn, si) => {
          const v = cellGet(c, sn);
          const h = (v / yMax) * plotH;
          const x = gx + si * barW;
          svg += `<rect x="${x.toFixed(1)}" y="${yScale(v).toFixed(1)}" width="${Math.max(barW - 2, 1).toFixed(1)}" height="${Math.max(h, 0).toFixed(1)}" fill="${CHART_PALETTE[si % CHART_PALETTE.length]}" rx="2"><title>${escapeHtml(`${c} · ${sn}: ${fmtNum(v)}`)}</title></rect>`;
        });
        svg += `<text class="rpt-chart-label" transform="rotate(-40 ${(ML + ci * stepX + stepX / 2).toFixed(1)} ${MT + plotH + 12})" x="${(ML + ci * stepX + stepX / 2).toFixed(1)}" y="${MT + plotH + 12}" text-anchor="end">${escapeHtml(c.length > 22 ? c.slice(0, 21) + "…" : c)}</text>`;
      });
    } else {
      // line — one polyline per series across categories in order
      const lx = (ci) => ML + ci * stepX + stepX / 2;
      seriesNames.forEach((sn, si) => {
        const pts = cats.map((c, ci) => `${lx(ci).toFixed(1)},${yScale(cellGet(c, sn)).toFixed(1)}`).join(" ");
        svg += `<polyline points="${pts}" fill="none" stroke="${CHART_PALETTE[si % CHART_PALETTE.length]}" stroke-width="2" />`;
        cats.forEach((c, ci) => {
          const v = cellGet(c, sn);
          svg += `<circle cx="${lx(ci).toFixed(1)}" cy="${yScale(v).toFixed(1)}" r="3" fill="${CHART_PALETTE[si % CHART_PALETTE.length]}"><title>${escapeHtml(`${c} · ${sn}: ${fmtNum(v)}`)}</title></circle>`;
        });
      });
      cats.forEach((c, ci) => {
        svg += `<text class="rpt-chart-label" transform="rotate(-40 ${lx(ci).toFixed(1)} ${MT + plotH + 12})" x="${lx(ci).toFixed(1)}" y="${MT + plotH + 12}" text-anchor="end">${escapeHtml(c.length > 22 ? c.slice(0, 21) + "…" : c)}</text>`;
      });
    }

    const legend = seriesNames
      .map((sn, si) => `<span class="rpt-legend-item"><span class="rpt-swatch" style="background:${CHART_PALETTE[si % CHART_PALETTE.length]}"></span>${escapeHtml(sn)}</span>`)
      .join("");
    const note = s.truncated
      ? `<div class="rpt-chart-note">${escapeHtml(T(kind === "bar" ? "rpt.rb.chart.topN" : "rpt.rb.chart.firstN", { n: cats.length, total: s.totalCats }))}</div>`
      : "";
    return `<div class="rpt-chart-title">${escapeHtml(valueLabel)}</div>` +
      `<svg class="rpt-chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(valueLabel)}">${svg}</svg>` +
      `<div class="rpt-legend">${legend}</div>${note}`;
  }

  // --- save / delete --------------------------------------------
  async function save(asNew) {
    if (!state.dimensions.length && !state.measures.length) { toast(T("rpt.rb.nothingToSave"), "navy"); return; }
    const name = (els.nameInput.value || "").trim();
    if (!name) { toast(T("rpt.rb.needName"), "navy"); els.nameInput.focus(); return; }
    const payload = { name, config: currentConfig(), ispublic: state.ispublic };
    try {
      let row;
      if (state.savedId && !asNew) {
        row = await HITT_API.updateSavedReport(state.savedId, payload);
      } else {
        row = await HITT_API.createSavedReport(payload);
      }
      state.savedId = row.id;
      state.name = row.name;
      state.ispublic = !!row.ispublic;
      els.nameInput.value = row.name;
      const idx = savedReports.findIndex((r) => String(r.id) === String(row.id));
      if (idx >= 0) savedReports[idx] = row; else savedReports.push(row);
      renderSavedSelect();
      els.savedSelect.value = String(row.id);
      toast(T("rpt.rb.saved.ok", { name: row.name }), "green");
    } catch (err) {
      toast(err.message || T("rpt.rb.saveFail"), "red");
    }
  }

  async function deleteSaved() {
    if (!state.savedId) return;
    const row = savedReports.find((r) => String(r.id) === String(state.savedId));
    if (row && !row.mine) { toast(T("rpt.rb.notYours"), "navy"); return; }
    if (!window.confirm(T("rpt.rb.deleteConfirm", { name: state.name }))) return;
    try {
      await HITT_API.deleteSavedReport(state.savedId);
      savedReports = savedReports.filter((r) => String(r.id) !== String(state.savedId));
      state.savedId = null;
      state.name = "";
      renderSavedSelect();
      els.savedSelect.value = "";
      toast(T("rpt.rb.deleted"), "navy");
    } catch (err) {
      toast(err.message || T("rpt.rb.deleteFail"), "red");
    }
  }

  // --- export --------------------------------------------------
  function exportCsv() {
    if (!lastResult || !lastResult.rows.length) { toast(T("rpt.nothingToExport"), "navy"); return; }
    const cols = lastResult.columns;
    downloadCsv(
      `${(state.name || "report").replace(/[^\w-]+/g, "_")}.csv`,
      cols.map((c) => c.label),
      lastResult.rows.map((r) => cols.map((c) => {
        const v = r[c.key];
        return (c.role === "measure" || c.type === "number") && v != null ? v : v ?? "";
      }))
    );
  }

  function screenshot() {
    if (typeof html2canvas !== "function") { toast(T("rpt.rb.screenshotFail"), "red"); return; }
    if (!lastResult || !lastResult.rows.length) { toast(T("rpt.nothingToExport"), "navy"); return; }
    const node = els.result;
    const bg = getComputedStyle(document.body).backgroundColor || "#ffffff";
    html2canvas(node, { backgroundColor: bg, scale: 2, logging: false })
      .then((canvas) => canvas.toBlob((blob) => {
        if (blob) downloadBlob(`${(state.name || "report").replace(/[^\w-]+/g, "_")}.png`, blob);
      }, "image/png"))
      .catch((err) => {
        console.error("[report-builder] screenshot failed:", err);
        toast(T("rpt.rb.screenshotFail"), "red");
      });
  }

  return { init, onLangChange };
})();
