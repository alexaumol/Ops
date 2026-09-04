/**
 * Report builder — dataset catalogue + query engine.
 * ---------------------------------------------------------------------------
 * Backs Reports → "My reports". The browser never names a table or writes
 * SQL: it drags fields declared HERE, and this module turns a validated
 * config object into one parameterised SELECT against a curated `rpt_*`
 * view (see migrations/*_report-builder.sql).
 *
 * SECURITY MODEL
 *   - Column identifiers only ever come from DATASETS[...].fields — keys are
 *     `[a-z_]+`, re-checked by assertIdent() before they reach the SQL.
 *   - Aggregates / operators / sort direction are whitelisted enums mapped
 *     to literal SQL fragments.
 *   - Every user value is a $n placeholder — never interpolated.
 *   - The statement runs inside `BEGIN READ ONLY` with a per-statement
 *     timeout (see lib/readOnlyQuery.js), so even a pathological config
 *     can't write or hang a connection.
 * ---------------------------------------------------------------------------
 */
const { runReadOnly } = require("./readOnlyQuery");

const MAX_ROWS = 5000;
const MAX_DIMENSIONS = 6;
const MAX_MEASURES = 6;
const MAX_FILTERS = 12;

class ReportConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ReportConfigError";
  }
}

// --- field helpers ------------------------------------------------------
const dim = (label, type = "text") => ({ label, role: "dimension", type });
const measure = (label, defaultAgg = "sum") => ({ label, role: "measure", type: "number", defaultAgg });

// --- the catalogue ----------------------------------------------------
// One entry per curated view. `view` is the physical relation; `fields`
// keys are the only identifiers this module will ever emit.
const DATASETS = {
  projects: {
    id: "projects",
    label: "Projects",
    view: "rpt_projects",
    fields: {
      project_code: dim("Project code"),
      project_name: dim("Project name"),
      status: dim("Status"),
      entity: dim("Entity"),
      owner: dim("Owner"),
      project_type: dim("Project type"),
      biotech_spectrum: dim("Biotech spectrum"),
      business_partner: dim("Customer/partner"),
      entry_year: dim("Entry year", "number"),
      entry_month: dim("Entry month", "number"),
      entry_date: dim("Entry date", "date"),
      invoiceable: dim("Invoiceable"),
      budget: measure("Budget"),
      invoiced_total: measure("Invoiced total"),
      invoice_count: measure("Invoice count"),
      po_hours: measure("PO hours"),
      res_hours: measure("RES hours"),
      total_hours: measure("Total hours"),
      expenses_total: measure("Expenses total"),
      project_count: measure("Project count"),
    },
  },
  time_tracking: {
    id: "time_tracking",
    label: "Time tracking",
    view: "rpt_time_tracking",
    fields: {
      project_code: dim("Project code"),
      project_name: dim("Project name"),
      entity: dim("Entity"),
      project_status: dim("Project status"),
      employee: dim("Employee"),
      resource_type: dim("Resource type"),
      track_year: dim("Year", "number"),
      track_month: dim("Month", "number"),
      track_date: dim("Date", "date"),
      hours: measure("Hours"),
      entry_count: measure("Entry count"),
    },
  },
  invoices: {
    id: "invoices",
    label: "Invoices",
    view: "rpt_invoices",
    fields: {
      invoice_code: dim("Invoice code"),
      project_code: dim("Project code"),
      project_name: dim("Project name"),
      entity: dim("Entity"),
      status: dim("Status"),
      corrective: dim("Corrective"),
      business_partner: dim("Customer/partner"),
      invoice_year: dim("Invoice year", "number"),
      invoice_month: dim("Invoice month", "number"),
      invoice_date: dim("Invoice date", "date"),
      due_date: dim("Due date", "date"),
      amount: measure("Amount"),
      vat_amount: measure("VAT amount"),
      invoice_count: measure("Invoice count"),
    },
  },
  expenses: {
    id: "expenses",
    label: "Expenses",
    view: "rpt_expenses",
    fields: {
      category: dim("Category"),
      project_code: dim("Project code"),
      project_name: dim("Project name"),
      employee: dim("Employee"),
      invoiceable: dim("Invoiceable"),
      expense_kind: dim("Expense kind"),
      expense_year: dim("Year", "number"),
      expense_month: dim("Month", "number"),
      expense_date: dim("Date", "date"),
      amount: measure("Amount"),
      expense_count: measure("Expense count"),
    },
  },
  business_partners: {
    id: "business_partners",
    label: "Customers & partners",
    view: "rpt_business_partners",
    fields: {
      business_partner: dim("Customer/partner"),
      company_type: dim("Company type"),
      entity: dim("Entity"),
      language: dim("Language"),
      project_count: measure("Project count"),
      invoiced_total: measure("Invoiced total"),
      bp_count: measure("Customer/partner count"),
    },
  },
};

const AGGS = {
  sum: (col) => `ROUND((SUM(${col}))::numeric, 2)`,
  avg: (col) => `ROUND((AVG(${col}))::numeric, 2)`,
  min: (col) => `MIN(${col})`,
  max: (col) => `MAX(${col})`,
  count: (col) => `COUNT(${col})`,
  count_distinct: (col) => `COUNT(DISTINCT ${col})`,
};

// operator -> (col, placeholder) -> sql fragment; `arrOp` marks array values
const OPS = {
  eq: { sql: (c, p) => `${c} = ${p}` },
  neq: { sql: (c, p) => `${c} <> ${p}` },
  gt: { sql: (c, p) => `${c} > ${p}` },
  gte: { sql: (c, p) => `${c} >= ${p}` },
  lt: { sql: (c, p) => `${c} < ${p}` },
  lte: { sql: (c, p) => `${c} <= ${p}` },
  contains: { sql: (c, p) => `${c}::text ILIKE '%' || ${p} || '%'` },
  in: { sql: (c, p) => `${c} = ANY(${p})`, array: true },
  not_in: { sql: (c, p) => `(${c} <> ALL(${p}) OR ${c} IS NULL)`, array: true },
  between: { sql: (c, p1, p2) => `${c} BETWEEN ${p1} AND ${p2}`, pair: true },
};

const OPS_BY_TYPE = {
  text: ["eq", "neq", "in", "not_in", "contains"],
  number: ["eq", "neq", "gt", "gte", "lt", "lte", "between", "in"],
  date: ["eq", "neq", "gt", "gte", "lt", "lte", "between"],
};

function assertIdent(id) {
  if (typeof id !== "string" || !/^[a-z_][a-z0-9_]*$/.test(id)) {
    throw new ReportConfigError(`invalid identifier: ${JSON.stringify(id)}`);
  }
  return id;
}

/**
 * Validate `config` and return { columns, text, params }.
 * config = { dataset, dimensions[], measures[{field,agg}], filters[{field,op,value}],
 *            sort{field,dir}, limit }
 */
function buildReportQuery(config) {
  if (!config || typeof config !== "object") throw new ReportConfigError("config must be an object");

  const ds = DATASETS[config.dataset];
  if (!ds) throw new ReportConfigError(`unknown dataset: ${JSON.stringify(config.dataset)}`);
  const fieldOf = (id) => {
    const f = ds.fields[assertIdent(id)];
    if (!f) throw new ReportConfigError(`field "${id}" is not in dataset "${ds.id}"`);
    return f;
  };

  // --- measures ---
  const measuresIn = Array.isArray(config.measures) ? config.measures : [];
  if (measuresIn.length > MAX_MEASURES) throw new ReportConfigError(`too many measures (max ${MAX_MEASURES})`);
  const measures = measuresIn.map((m, i) => {
    if (!m || typeof m !== "object") throw new ReportConfigError("each measure must be an object");
    const field = fieldOf(m.field);
    let agg = String(m.agg || field.defaultAgg || "sum");
    if (field.role === "dimension") {
      // only a distinct-count makes sense on a dimension
      if (agg !== "count" && agg !== "count_distinct") agg = "count_distinct";
    } else if (!["sum", "avg", "min", "max", "count"].includes(agg)) {
      throw new ReportConfigError(`invalid aggregate "${m.agg}"`);
    }
    return { key: `m${i}`, field: m.field, agg, label: field.label };
  });

  const aggregated = measures.length > 0;

  // --- dimensions / raw columns ---
  // In aggregated mode `dimensions` are GROUP BY keys and must be real
  // dimensions. With no measures the report is a raw list, so any field
  // (a measure like `amount` included) may appear as a plain column.
  const dimensions = [...new Set(Array.isArray(config.dimensions) ? config.dimensions : [])];
  if (dimensions.length > MAX_DIMENSIONS) throw new ReportConfigError(`too many columns (max ${MAX_DIMENSIONS})`);
  dimensions.forEach((d) => {
    const f = fieldOf(d);
    if (aggregated && f.role !== "dimension") throw new ReportConfigError(`"${d}" is a measure — give it an aggregate or drop the other measures`);
  });

  if (!dimensions.length && !measures.length) {
    throw new ReportConfigError("pick at least one field");
  }

  // --- filters ---
  const params = [];
  const bind = (v) => {
    params.push(v);
    return `$${params.length}`;
  };
  const filtersIn = Array.isArray(config.filters) ? config.filters : [];
  if (filtersIn.length > MAX_FILTERS) throw new ReportConfigError(`too many filters (max ${MAX_FILTERS})`);
  const whereParts = filtersIn.map((f) => {
    if (!f || typeof f !== "object") throw new ReportConfigError("each filter must be an object");
    const field = fieldOf(f.field);
    const op = String(f.op || "eq");
    if (!OPS[op] || !(OPS_BY_TYPE[field.type] || []).includes(op)) {
      throw new ReportConfigError(`operator "${f.op}" not allowed on ${field.type} field "${f.field}"`);
    }
    const col = f.field; // already asserted by fieldOf
    const spec = OPS[op];
    const coerce = (v) => (field.type === "number" ? Number(v) : v);
    if (spec.array) {
      const arr = Array.isArray(f.value) ? f.value : [f.value];
      if (!arr.length) throw new ReportConfigError(`filter "${f.field}" needs at least one value`);
      return spec.sql(col, bind(arr.map(coerce)));
    }
    if (spec.pair) {
      const arr = Array.isArray(f.value) ? f.value : [];
      if (arr.length !== 2) throw new ReportConfigError(`"between" filter on "${f.field}" needs [from, to]`);
      return spec.sql(col, bind(coerce(arr[0])), bind(coerce(arr[1])));
    }
    if (f.value === undefined || f.value === null || f.value === "") {
      throw new ReportConfigError(`filter "${f.field}" needs a value`);
    }
    return spec.sql(col, bind(coerce(f.value)));
  });

  // --- SELECT list + column metadata ---
  const selectParts = [];
  const columns = [];
  dimensions.forEach((d) => {
    selectParts.push(`${d} AS ${d}`);
    columns.push({ key: d, label: ds.fields[d].label, role: ds.fields[d].role, type: ds.fields[d].type });
  });
  measures.forEach((m) => {
    const fn = AGGS[m.agg] || AGGS.sum;
    selectParts.push(`${fn(m.field)} AS ${m.key}`);
    columns.push({ key: m.key, label: m.label, role: "measure", type: "number", agg: m.agg });
  });

  // --- ORDER BY ---
  let orderBy = "";
  const sort = config.sort && typeof config.sort === "object" ? config.sort : null;
  const sortDir = sort && String(sort.dir).toLowerCase() === "asc" ? "ASC" : "DESC";
  if (sort && sort.field && columns.some((c) => c.key === sort.field)) {
    orderBy = `ORDER BY ${assertIdent(sort.field)} ${sortDir} NULLS LAST`;
  } else if (measures.length) {
    orderBy = `ORDER BY ${measures[0].key} DESC NULLS LAST`;
  } else if (dimensions.length) {
    orderBy = `ORDER BY ${dimensions[0]} ASC NULLS LAST`;
  }

  // --- assemble ---
  const where = whereParts.length ? `WHERE ${whereParts.join(" AND ")}` : "";
  const groupBy = aggregated && dimensions.length ? `GROUP BY ${dimensions.join(", ")}` : "";
  const limit = Math.min(Math.max(Number.parseInt(config.limit, 10) || 1000, 1), MAX_ROWS);

  const text = [
    `SELECT ${selectParts.join(", ")}`,
    `FROM public.${ds.view}`,
    where,
    groupBy,
    orderBy,
    `LIMIT ${limit}`,
  ]
    .filter(Boolean)
    .join("\n");

  return { columns, text, params };
}

async function runReport(config) {
  const { columns, text, params } = buildReportQuery(config);
  const rows = await runReadOnly(text, params);
  return { columns, rows };
}

// Catalogue as sent to the browser (no SQL, just the shape).
function catalogForClient() {
  return Object.values(DATASETS).map((ds) => ({
    id: ds.id,
    label: ds.label,
    fields: Object.entries(ds.fields).map(([id, f]) => ({
      id,
      label: f.label,
      role: f.role,
      type: f.type,
      defaultAgg: f.defaultAgg || null,
    })),
  }));
}

module.exports = {
  DATASETS,
  ReportConfigError,
  buildReportQuery,
  runReport,
  catalogForClient,
  OPS_BY_TYPE,
};
