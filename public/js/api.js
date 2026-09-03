/**
 * HITT Ops — thin API client
 * ---------------------------------------------------------------------------
 * Talks to the Node/Express backend in /server. The backend is the ONLY
 * thing that knows the PostgreSQL credentials (see /server/.env) — this
 * file never touches the database directly and never sees a DB password.
 * ---------------------------------------------------------------------------
 */
const HITT_API = (() => {
  const base = () => (window.HITT_CONFIG?.API_BASE_URL || "").replace(/\/$/, "");

  // Best a browser can report as the client "computer" — a real OS hostname
  // isn't available to a web page (see server/lib/audit.js). Sent on every
  // request so the audit log's Computer/device column is populated for all
  // actions, not just sign in/out.
  const clientPlatform = () => {
    try {
      return (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
    } catch {
      return "";
    }
  };

  // Verified Entra ID access token when MSAL is live; null in stub mode, in
  // which case we fall back to the X-HITT-User header (the server must be
  // in AUTH_MODE=header for that to be accepted).
  async function authHeaders() {
    const session = HITT_AUTH?.getSession?.();
    let token = null;
    try {
      token = await HITT_AUTH?.getApiToken?.();
    } catch (err) {
      console.warn("[api] could not get an access token:", err?.message || err);
    }
    return token
      ? { Authorization: `Bearer ${token}` }
      : { "X-HITT-User": session?.username || "unknown" };
  }

  // Bounces the tab to the sign-in page after the server rejects our token
  // (expired mid-session, or the server was reconfigured). Guarded so it
  // can't loop on the sign-in page itself.
  function handleUnauthorized() {
    try { sessionStorage.removeItem("hitt.session"); } catch {}
    const path = window.location.pathname;
    if (/(?:^|\/)index\.html$/.test(path) || path.endsWith("/")) return;
    window.location.href = (path.includes("/pages/") ? "../index.html" : "index.html") + "?expired=1";
  }

  async function request(path, options = {}) {
    const isForm = typeof FormData !== "undefined" && options.body instanceof FormData;
    const res = await fetch(`${base()}${path}`, {
      ...options,
      headers: {
        // FormData sets its own multipart Content-Type (with boundary) —
        // don't override it.
        ...(isForm ? {} : { "Content-Type": "application/json" }),
        ...(await authHeaders()),
        "X-HITT-Client": clientPlatform(),
        ...(options.headers || {}),
      },
    });
    if (res.status === 401) {
      handleUnauthorized();
      throw new Error("Your session has expired. Please sign in again.");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      // Every route here responds with { error, message } on failure —
      // surface just the human-readable message when present (e.g. "You
      // can't remove your own admin role.") instead of the whole raw JSON
      // body, which every caller's toast would otherwise show verbatim.
      let message = text || res.statusText;
      try {
        const parsed = JSON.parse(text);
        if (parsed?.message) message = parsed.message;
      } catch {}
      throw new Error(message);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  return {
    getProjects: (opts = {}) => request("/api/projects" + (opts.scope ? `?scope=${encodeURIComponent(opts.scope)}` : "")),
    getProjectStatuses: () => request("/api/projects/statuses"),
    getProjectAttention: () => request("/api/projects/attention"),
    getProjectLookups: () => request("/api/projects/lookups"),
    getProject: (id) => request(`/api/projects/${id}`),
    getProjectDeliverables: (id) => request(`/api/projects/${id}/deliverables`),
    addProjectDeliverable: (id, payload) =>
      request(`/api/projects/${id}/deliverables`, { method: "POST", body: JSON.stringify(payload) }),
    updateProjectDeliverable: (id, deliverableId, payload) =>
      request(`/api/projects/${id}/deliverables/${deliverableId}`, { method: "PATCH", body: JSON.stringify(payload) }),
    deleteProjectDeliverable: (id, deliverableId) =>
      request(`/api/projects/${id}/deliverables/${deliverableId}`, { method: "DELETE" }),
    getProjectNotes: (id) => request(`/api/projects/${id}/notes`),
    addProjectNote: (id, payload) =>
      request(`/api/projects/${id}/notes`, { method: "POST", body: JSON.stringify(payload) }),
    deleteProjectNote: (id, noteId) =>
      request(`/api/projects/${id}/notes/${noteId}`, { method: "DELETE" }),
    getProjectQuotations: (id) => request(`/api/projects/${id}/quotations`),
    addProjectQuotation: (id, payload) =>
      request(`/api/projects/${id}/quotations`, { method: "POST", body: JSON.stringify(payload) }),
    deleteProjectQuotation: (id, quotationId) =>
      request(`/api/projects/${id}/quotations/${quotationId}`, { method: "DELETE" }),
    getProjectHistory: (id) => request(`/api/projects/${id}/history`),
    getProjectResources: (id) => request(`/api/projects/${id}/resources`),
    addProjectResource: (id, payload) =>
      request(`/api/projects/${id}/resources`, { method: "POST", body: JSON.stringify(payload) }),
    updateProjectResource: (id, resourceRowId, payload) =>
      request(`/api/projects/${id}/resources/${resourceRowId}`, { method: "PATCH", body: JSON.stringify(payload) }),
    deleteProjectResource: (id, resourceRowId, employeeId) =>
      request(`/api/projects/${id}/resources/${resourceRowId}`, { method: "DELETE", body: JSON.stringify({ employeeId }) }),

    getBusinessPartners: (q) => request(`/api/business-partners${q ? `?q=${encodeURIComponent(q)}` : ""}`),
    getBusinessPartnerLookups: () => request("/api/business-partners/lookups"),
    getBusinessPartner: (id) => request(`/api/business-partners/${id}`),
    createBusinessPartner: (payload) =>
      request("/api/business-partners", { method: "POST", body: JSON.stringify(payload) }),
    updateBusinessPartner: (id, payload) =>
      request(`/api/business-partners/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
    getBusinessPartnerContacts: (id) => request(`/api/business-partners/${id}/contacts`),
    addBusinessPartnerContact: (id, payload) =>
      request(`/api/business-partners/${id}/contacts`, { method: "POST", body: JSON.stringify(payload) }),
    updateBusinessPartnerContact: (id, contactId, payload) =>
      request(`/api/business-partners/${id}/contacts/${contactId}`, { method: "PATCH", body: JSON.stringify(payload) }),
    deleteBusinessPartnerContact: (id, contactId, employeeId) =>
      request(`/api/business-partners/${id}/contacts/${contactId}`, { method: "DELETE", body: JSON.stringify({ employeeId }) }),
    getBusinessPartnerNotes: (id) => request(`/api/business-partners/${id}/notes`),
    getBusinessPartnerHistory: (id) => request(`/api/business-partners/${id}/history`),
    getBusinessPartnerProjects: (id) => request(`/api/business-partners/${id}/projects`),
    addBusinessPartnerNote: (id, payload) =>
      request(`/api/business-partners/${id}/notes`, { method: "POST", body: JSON.stringify(payload) }),
    deleteBusinessPartnerNote: (id, noteId) =>
      request(`/api/business-partners/${id}/notes/${noteId}`, { method: "DELETE" }),
    getBusinessPartnerTaxCompanies: (id) => request(`/api/business-partners/${id}/tax-companies`),
    addBusinessPartnerTaxCompany: (id, payload) =>
      request(`/api/business-partners/${id}/tax-companies`, { method: "POST", body: JSON.stringify(payload) }),
    updateBusinessPartnerTaxCompany: (id, tcId, payload) =>
      request(`/api/business-partners/${id}/tax-companies/${tcId}`, { method: "PATCH", body: JSON.stringify(payload) }),
    deleteBusinessPartnerTaxCompany: (id, tcId) =>
      request(`/api/business-partners/${id}/tax-companies/${tcId}`, { method: "DELETE" }),

    getEmployees: () => request("/api/employees"),
    getTimeTracking: (userId, weekStart) =>
      request(`/api/time-tracking?userId=${encodeURIComponent(userId)}&weekStart=${encodeURIComponent(weekStart)}`),
    saveTimeTracking: (payload) =>
      request("/api/time-tracking", { method: "POST", body: JSON.stringify(payload) }),
    deleteTimeTracking: (id) => request(`/api/time-tracking/${id}`, { method: "DELETE" }),
    getTimeTrackingSummary: (userId) =>
      request(`/api/time-tracking/summary?userId=${encodeURIComponent(userId)}`),

    getTimeOffRequests: (empId) => request(`/api/time-off/requests?empId=${encodeURIComponent(empId)}`),
    createTimeOffRequest: (payload) =>
      request("/api/time-off/requests", { method: "POST", body: JSON.stringify(payload) }),
    withdrawTimeOffRequest: (id) => request(`/api/time-off/requests/${id}/withdraw`, { method: "PATCH" }),
    getTimeOffBalance: (empId, year) =>
      request(`/api/time-off/balance?empId=${encodeURIComponent(empId)}&year=${encodeURIComponent(year)}`),
    getPendingTimeOffRequests: () => request("/api/time-off/requests/pending"),
    getTimeOffNotifications: (since) =>
      request(`/api/time-off/notifications${since ? `?since=${encodeURIComponent(since)}` : ""}`),
    approveTimeOffRequest: (id) => request(`/api/time-off/requests/${id}/approve`, { method: "PATCH" }),
    rejectTimeOffRequest: (id, comment) =>
      request(`/api/time-off/requests/${id}/reject`, { method: "PATCH", body: JSON.stringify({ comment }) }),

    getMyPermissions: () => request("/api/permissions/me"),
    getModuleKeys: () => request("/api/permissions/module-keys"),

    getMyProfile: () => request("/api/me/profile"),
    updateMyProfile: (payload) =>
      request("/api/me/profile", { method: "PATCH", body: JSON.stringify(payload) }),

    getSettingsEmployees: () => request("/api/settings/employees"),
    getEmployeeDetail: (id) => request(`/api/settings/employees/${id}`),
    createEmployee: (payload) =>
      request("/api/settings/employees", { method: "POST", body: JSON.stringify(payload) }),
    updateEmployeeProfile: (id, payload) =>
      request(`/api/settings/employees/${id}/profile`, { method: "PATCH", body: JSON.stringify(payload) }),
    getAppConfig: () => request("/api/settings/config"),
    setAppConfig: (key, value) =>
      request(`/api/settings/config/${encodeURIComponent(key)}`, { method: "PUT", body: JSON.stringify({ value }) }),
    setEmployeeAdmin: (id, isAdmin) =>
      request(`/api/settings/employees/${id}/role`, { method: "PATCH", body: JSON.stringify({ isAdmin }) }),
    setEmployeeTimeOffApprover: (id, isTimeOffApprover) =>
      request(`/api/settings/employees/${id}/timeoff-approver`, { method: "PATCH", body: JSON.stringify({ isTimeOffApprover }) }),
    setEmployeePresenceRole: (id, role, granted) =>
      request(`/api/settings/employees/${id}/presence-role`, { method: "PATCH", body: JSON.stringify({ role, granted }) }),
    setEmployeeModuleAccess: (id, moduleKey, hasAccess) =>
      request(`/api/settings/employees/${id}/module-access`, { method: "PATCH", body: JSON.stringify({ moduleKey, hasAccess }) }),
    setEmployeeStatus: (id, isDeactivated) =>
      request(`/api/settings/employees/${id}/status`, { method: "PATCH", body: JSON.stringify({ isDeactivated }) }),

    getHolidays: (year) => request(`/api/settings/holidays${year ? `?year=${encodeURIComponent(year)}` : ""}`),
    getHolidayYears: () => request("/api/settings/holidays/years"),
    addHoliday: (payload) =>
      request("/api/settings/holidays", { method: "POST", body: JSON.stringify(payload) }),
    deleteHoliday: (id) => request(`/api/settings/holidays/${id}`, { method: "DELETE" }),
    importPublicHolidays: () => request("/api/settings/holidays/import", { method: "POST" }),
    getWorkCalendar: () => request("/api/settings/work-calendar"),
    setWorkCalendarYear: (year, payload) =>
      request(`/api/settings/work-calendar/${year}`, { method: "PUT", body: JSON.stringify(payload) }),
    // Settings → Categories: id/name lists (expense-categories,
    // biotech-spectrums, project-types). Same CRUD shape for each.
    settingsCatalog: (slug) => ({
      list: () => request(`/api/settings/${slug}`),
      create: (name) => request(`/api/settings/${slug}`, { method: "POST", body: JSON.stringify({ name }) }),
      rename: (id, name) =>
        request(`/api/settings/${slug}/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
      remove: (id) => request(`/api/settings/${slug}/${id}`, { method: "DELETE" }),
    }),

    getBrandingLogo: () => request("/api/branding/logo"),
    setBrandingLogo: (dataUrl) =>
      request("/api/branding/logo", { method: "PUT", body: JSON.stringify({ dataUrl }) }),
    clearBrandingLogo: () => request("/api/branding/logo", { method: "DELETE" }),
    getAppLanguage: () => request("/api/branding/language"),
    setAppLanguage: (language) =>
      request("/api/branding/language", { method: "PUT", body: JSON.stringify({ language }) }),

    getEntities: () => request("/api/entities"),
    getEntity: (id) => request(`/api/entities/${id}`),
    createEntity: (payload) =>
      request("/api/entities", { method: "POST", body: JSON.stringify(payload) }),
    updateEntity: (id, payload) =>
      request(`/api/entities/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
    deleteEntity: (id) => request(`/api/entities/${id}`, { method: "DELETE" }),

    getInvoiceCurrencies: () => request("/api/settings/currencies"),
    createInvoiceCurrency: (payload) =>
      request("/api/settings/currencies", { method: "POST", body: JSON.stringify(payload) }),
    updateInvoiceCurrency: (id, payload) =>
      request(`/api/settings/currencies/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
    reorderInvoiceCurrencies: (ids) =>
      request("/api/settings/currencies/order", { method: "PUT", body: JSON.stringify({ ids }) }),
    deleteInvoiceCurrency: (id) =>
      request(`/api/settings/currencies/${id}`, { method: "DELETE" }),

    getExpenses: (filters = {}) => {
      const params = new URLSearchParams();
      ["search", "projectId", "categoryId", "scope", "startDate", "endDate", "sort", "dir", "topScope", "page", "limit"].forEach((k) => {
        if (filters[k] != null && filters[k] !== "") params.set(k, filters[k]);
      });
      const qs = params.toString();
      return request(`/api/expenses${qs ? `?${qs}` : ""}`);
    },
    getExpenseCategories: () => request("/api/expenses/categories"),
    // { rows: [{id, code, name, statusLabel}], mineOnly } — alive projects
    // for the mobile capture flow. mineOnly is true unless the caller is an
    // admin (see server/routes/expenses.js).
    getExpenseMyProjects: () => request("/api/expenses/my-projects"),
    // payload: FormData (with optional `document` file) or a plain object.
    createExpense: (payload) =>
      request("/api/expenses", { method: "POST", body: payload instanceof FormData ? payload : JSON.stringify(payload) }),
    updateExpense: (id, payload) =>
      request(`/api/expenses/${id}`, { method: "PATCH", body: payload instanceof FormData ? payload : JSON.stringify(payload) }),
    deleteExpense: (id) => request(`/api/expenses/${id}`, { method: "DELETE" }),
    bulkExpenses: (body) => request("/api/expenses/bulk", { method: "POST", body: JSON.stringify(body) }),
    deleteExpenseDocument: (id) => request(`/api/expenses/${id}/document`, { method: "DELETE" }),
    expenseDocumentUrl: (id) => `${base()}/api/expenses/${id}/document`,
    // Fetches the evidence file as a blob (carries the auth header — a plain
    // <a>/window.open can't, and the route is guarded).
    fetchExpenseDocument: async (id) => {
      const res = await fetch(`${base()}/api/expenses/${id}/document`, {
        headers: { ...(await authHeaders()) },
      });
      if (res.status === 401) {
        handleUnauthorized();
        throw new Error("Your session has expired. Please sign in again.");
      }
      if (!res.ok) throw new Error("Could not load the document.");
      return res.blob();
    },

    getAuditUsers: () => request("/api/audit/users"),
    getAuditKinds: () => request("/api/audit/kinds"),
    getAuditSummary: () => request("/api/audit/summary"),
    getAuditLogs: (filters = {}) => {
      const params = new URLSearchParams();
      if (filters.userId) params.set("userId", filters.userId);
      if (filters.startDate) params.set("startDate", filters.startDate);
      if (filters.endDate) params.set("endDate", filters.endDate);
      if (filters.search) params.set("search", filters.search);
      if (filters.kind) params.set("kind", filters.kind);
      if (filters.sort) params.set("sort", filters.sort);
      if (filters.dir) params.set("dir", filters.dir);
      if (filters.page) params.set("page", filters.page);
      if (filters.limit) params.set("limit", filters.limit);
      const qs = params.toString();
      return request(`/api/audit/logs${qs ? `?${qs}` : ""}`);
    },

    getInvoicingLookups: () => request("/api/invoicing/lookups"),
    getAllTaxCompanies: (search) =>
      request(`/api/invoicing/tax-companies${search ? `?search=${encodeURIComponent(search)}` : ""}`),
    getInvoicingProjects: () => request("/api/invoicing/projects"),
    getProjectRelease: (projectId) => request(`/api/invoicing/projects/${projectId}/release`),
    saveProjectRelease: (projectId, payload) =>
      request(`/api/invoicing/projects/${projectId}/release`, { method: "PATCH", body: JSON.stringify(payload) }),
    getProjectInvoices: (projectId) => request(`/api/invoicing/projects/${projectId}/invoices`),
    getAllInvoices: () => request("/api/invoicing/invoices"),
    createInvoice: (projectId, payload) =>
      request(`/api/invoicing/projects/${projectId}/invoices`, { method: "POST", body: JSON.stringify(payload) }),
    updateInvoice: (id, payload) =>
      request(`/api/invoicing/invoices/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
    deleteInvoice: (id) => request(`/api/invoicing/invoices/${id}`, { method: "DELETE" }),
    // Invoice PDF as a blob — carries the auth header a plain window.open can't.
    fetchInvoicePdf: async (id) => {
      const res = await fetch(`${base()}/api/invoicing/invoices/${id}/pdf`, {
        headers: { ...(await authHeaders()) },
      });
      if (!res.ok) throw new Error("Could not load the invoice PDF.");
      return res.blob();
    },
    getInvoiceEmailDefaults: (id) => request(`/api/invoicing/invoices/${id}/email`),
    sendInvoiceEmail: (id, payload) =>
      request(`/api/invoicing/invoices/${id}/email`, { method: "POST", body: JSON.stringify(payload) }),
    // Veri*Factu (Spain) — see server/lib/verifactu/issue.js. Only called
    // from the invoicing UI when HITT_CONFIG.FEATURES.verifactu is on.
    getProjectInvoiceVerifactu: (projectId) =>
      request(`/api/invoicing/projects/${projectId}/invoices/verifactu`),
    getAllInvoiceVerifactu: () => request("/api/invoicing/invoices/verifactu"),
    getInvoiceVerifactu: (id) => request(`/api/invoicing/invoices/${id}/verifactu`),
    refreshInvoiceVerifactu: (id) =>
      request(`/api/invoicing/invoices/${id}/verifactu/refresh`, { method: "POST" }),
    issueInvoice: (id, payload = {}) =>
      request(`/api/invoicing/invoices/${id}/issue`, { method: "POST", body: JSON.stringify(payload) }),
    cancelInvoice: (id) =>
      request(`/api/invoicing/invoices/${id}/cancel`, { method: "POST" }),
    retryInvoiceVerifactu: (id) =>
      request(`/api/invoicing/invoices/${id}/verifactu/retry`, { method: "POST" }),
    createProject: (payload) =>
      request("/api/projects", { method: "POST", body: JSON.stringify(payload) }),
    updateProjectStage: (id, stage, employeeId) =>
      request(`/api/projects/${id}/stage`, {
        method: "PATCH",
        body: JSON.stringify({ stage, employeeId }),
      }),
    updateProjectOwner: (id, ownerId, employeeId) =>
      request(`/api/projects/${id}/owner`, {
        method: "PATCH",
        body: JSON.stringify({ ownerId: ownerId || null, employeeId }),
      }),
    assignProjectBusinessPartner: (id, businessPartnerId) =>
      request(`/api/projects/${id}/business-partner`, {
        method: "PATCH",
        body: JSON.stringify({ businessPartnerId }),
      }),
    assignProjectInvoicingPartner: (id, taxCompanyId, employeeId) =>
      request(`/api/projects/${id}/invoicing-partner`, {
        method: "PATCH",
        body: JSON.stringify({ taxCompanyId, employeeId }),
      }),
    updateProject: (id, payload) =>
      request(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),

    getHoursPerProject: (startDate, endDate, groupBy) => {
      const params = new URLSearchParams();
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);
      if (groupBy) params.set("groupBy", groupBy);
      const qs = params.toString();
      return request(`/api/reports/hours-per-project${qs ? `?${qs}` : ""}`);
    },
    getHoursPerProjectDetail: (projectId, startDate, endDate) => {
      const params = new URLSearchParams();
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);
      const qs = params.toString();
      return request(`/api/reports/hours-per-project/${projectId}${qs ? `?${qs}` : ""}`);
    },
    getHoursByEntity: (entityId, startDate, endDate) => {
      const params = new URLSearchParams();
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);
      const qs = params.toString();
      return request(`/api/reports/hours-per-project/by-entity/${encodeURIComponent(entityId || "none")}${qs ? `?${qs}` : ""}`);
    },
    getHoursByEmployee: (empId, startDate, endDate) => {
      const params = new URLSearchParams();
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);
      const qs = params.toString();
      return request(`/api/reports/hours-per-project/by-employee/${encodeURIComponent(empId)}${qs ? `?${qs}` : ""}`);
    },
    getCalendarLeaves: (startDate, endDate, opts = {}) =>
      request(`/api/time-off/calendar?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}${opts.deliverables ? "&deliverables=1" : ""}`),

    getProjectsByStatusEntity: (year) =>
      request(`/api/reports/projects-by-status-entity${year ? `?year=${encodeURIComponent(year)}` : ""}`),
    getProjectYears: () => request("/api/reports/project-years"),
    getProjectsOpenedByMonth: (year) =>
      request(`/api/reports/projects-opened-by-month${year ? `?year=${encodeURIComponent(year)}` : ""}`),
    getInvoicedByMonth: () => request("/api/reports/invoiced-by-month"),
    getProjectsByMonthDetail: (year, month, type) => {
      const params = new URLSearchParams({ month, type });
      if (year) params.set("year", year);
      return request(`/api/reports/projects-by-month-detail?${params.toString()}`);
    },
    getProjectTimeline: (filters = {}) => {
      const params = new URLSearchParams();
      if (filters.projectId) params.set("projectId", filters.projectId);
      if (filters.search) params.set("search", filters.search);
      if (filters.startDate) params.set("startDate", filters.startDate);
      if (filters.endDate) params.set("endDate", filters.endDate);
      if (filters.page) params.set("page", filters.page);
      if (filters.limit) params.set("limit", filters.limit);
      const qs = params.toString();
      return request(`/api/reports/project-timeline${qs ? `?${qs}` : ""}`);
    },

    getStaleProjects: (page, limit) => {
      const params = new URLSearchParams();
      if (page) params.set("page", page);
      if (limit) params.set("limit", limit);
      const qs = params.toString();
      return request(`/api/reports/stale-projects${qs ? `?${qs}` : ""}`);
    },

    // Presence register ("Presence" tab — registro de jornada)
    getPresenceConfig: () => request("/api/presence/config"),
    setPresenceConfig: (payload) => request("/api/presence/config", { method: "PUT", body: JSON.stringify(payload) }),
    getPresenceToday: () => request("/api/presence/me/today"),
    getPresenceRegister: (from, to, employeeId) => {
      const p = new URLSearchParams();
      if (from) p.set("from", from);
      if (to) p.set("to", to);
      const path = employeeId ? `/api/presence/employees/${encodeURIComponent(employeeId)}` : "/api/presence/me";
      const qs = p.toString();
      return request(`${path}${qs ? `?${qs}` : ""}`);
    },
    presenceClock: (payload) => request("/api/presence/clock", { method: "POST", body: JSON.stringify(payload) }),
    presenceManual: (payload) => request("/api/presence/manual", { method: "POST", body: JSON.stringify(payload) }),
    getPresenceMonthly: (year, month, employeeId, regenerate) => {
      const p = new URLSearchParams();
      if (year) p.set("year", year);
      if (month) p.set("month", month);
      if (employeeId) p.set("employeeId", employeeId);
      if (regenerate) p.set("regenerate", "1");
      const qs = p.toString();
      return request(`/api/presence/monthly${qs ? `?${qs}` : ""}`);
    },
    acknowledgePresenceMonthly: (id) => request(`/api/presence/monthly/${id}/acknowledge`, { method: "POST" }),
    // Presence export as a blob — carries the auth header a plain link can't.
    fetchPresenceExport: async (from, to, format, employeeId) => {
      const p = new URLSearchParams({ from, to, format });
      if (employeeId) p.set("employeeId", employeeId);
      const res = await fetch(`${base()}/api/presence/export?${p.toString()}`, { headers: { ...(await authHeaders()) } });
      if (!res.ok) throw new Error("No se pudo generar el registro.");
      return res.blob();
    },
    getPresenceOverview: (date) => request(`/api/presence/overview${date ? `?date=${encodeURIComponent(date)}` : ""}`),
    getPresenceContract: (employeeId) => request(`/api/presence/contract/${encodeURIComponent(employeeId)}`),
    addPresenceContract: (employeeId, payload) => request(`/api/presence/contract/${encodeURIComponent(employeeId)}`, { method: "POST", body: JSON.stringify(payload) }),

    // Report builder ("My reports" tab)
    getReportDatasets: () => request("/api/reports/datasets"),
    runReport: (config) => request("/api/reports/run", { method: "POST", body: JSON.stringify(config) }),
    getSavedReports: () => request("/api/reports/saved"),
    createSavedReport: (payload) => request("/api/reports/saved", { method: "POST", body: JSON.stringify(payload) }),
    updateSavedReport: (id, payload) => request(`/api/reports/saved/${id}`, { method: "PUT", body: JSON.stringify(payload) }),
    deleteSavedReport: (id) => request(`/api/reports/saved/${id}`, { method: "DELETE" }),

    health: () => request("/api/health"),

    // Ops assistant (see js/chat.js). getChatStatus tells the widget
    // whether to show itself; sendChat posts the conversation so far.
    getChatStatus: () => request("/api/chat/status"),
    sendChat: (messages) => request("/api/chat", { method: "POST", body: JSON.stringify({ messages }) }),
  };
})();
