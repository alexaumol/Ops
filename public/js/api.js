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

  async function request(path, options = {}) {
    const session = HITT_AUTH?.getSession?.();
    const res = await fetch(`${base()}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        // Prototype: identify the caller by their M365 username. Once real
        // MSAL auth is wired in, replace this with a Bearer ID token and
        // verify it server-side instead of trusting a plain header.
        "X-HITT-User": session?.username || "unknown",
        "X-HITT-Client": clientPlatform(),
        ...(options.headers || {}),
      },
    });
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
    getProjects: () => request("/api/projects"),
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
    getProjectQuotations: (id) => request(`/api/projects/${id}/quotations`),
    addProjectQuotation: (id, payload) =>
      request(`/api/projects/${id}/quotations`, { method: "POST", body: JSON.stringify(payload) }),
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
    getBusinessPartnerTaxCompanies: (id) => request(`/api/business-partners/${id}/tax-companies`),
    addBusinessPartnerTaxCompany: (id, payload) =>
      request(`/api/business-partners/${id}/tax-companies`, { method: "POST", body: JSON.stringify(payload) }),

    getEmployees: () => request("/api/employees"),
    getTimeTracking: (userId, weekStart) =>
      request(`/api/time-tracking?userId=${encodeURIComponent(userId)}&weekStart=${encodeURIComponent(weekStart)}`),
    saveTimeTracking: (payload) =>
      request("/api/time-tracking", { method: "POST", body: JSON.stringify(payload) }),
    deleteTimeTracking: (id) => request(`/api/time-tracking/${id}`, { method: "DELETE" }),

    getTimeOffRequests: (empId) => request(`/api/time-off/requests?empId=${encodeURIComponent(empId)}`),
    createTimeOffRequest: (payload) =>
      request("/api/time-off/requests", { method: "POST", body: JSON.stringify(payload) }),
    withdrawTimeOffRequest: (id) => request(`/api/time-off/requests/${id}/withdraw`, { method: "PATCH" }),
    getTimeOffBalance: (empId, year) =>
      request(`/api/time-off/balance?empId=${encodeURIComponent(empId)}&year=${encodeURIComponent(year)}`),
    getPendingTimeOffRequests: () => request("/api/time-off/requests/pending"),
    approveTimeOffRequest: (id) => request(`/api/time-off/requests/${id}/approve`, { method: "PATCH" }),
    rejectTimeOffRequest: (id, comment) =>
      request(`/api/time-off/requests/${id}/reject`, { method: "PATCH", body: JSON.stringify({ comment }) }),

    getMyPermissions: () => request("/api/permissions/me"),
    getModuleKeys: () => request("/api/permissions/module-keys"),

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

    getAuditUsers: () => request("/api/audit/users"),
    getAuditKinds: () => request("/api/audit/kinds"),
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
    getInvoicingProjects: () => request("/api/invoicing/projects"),
    getProjectRelease: (projectId) => request(`/api/invoicing/projects/${projectId}/release`),
    saveProjectRelease: (projectId, payload) =>
      request(`/api/invoicing/projects/${projectId}/release`, { method: "PATCH", body: JSON.stringify(payload) }),
    getProjectInvoices: (projectId) => request(`/api/invoicing/projects/${projectId}/invoices`),
    createInvoice: (projectId, payload) =>
      request(`/api/invoicing/projects/${projectId}/invoices`, { method: "POST", body: JSON.stringify(payload) }),
    updateInvoice: (id, payload) =>
      request(`/api/invoicing/invoices/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
    deleteInvoice: (id) => request(`/api/invoicing/invoices/${id}`, { method: "DELETE" }),
    createProject: (payload) =>
      request("/api/projects", { method: "POST", body: JSON.stringify(payload) }),
    updateProjectStage: (id, stage, employeeId) =>
      request(`/api/projects/${id}/stage`, {
        method: "PATCH",
        body: JSON.stringify({ stage, employeeId }),
      }),
    assignProjectBusinessPartner: (id, businessPartnerId) =>
      request(`/api/projects/${id}/business-partner`, {
        method: "PATCH",
        body: JSON.stringify({ businessPartnerId }),
      }),
    assignProjectInvoicingPartner: (id, taxCompanyId) =>
      request(`/api/projects/${id}/invoicing-partner`, {
        method: "PATCH",
        body: JSON.stringify({ taxCompanyId }),
      }),
    updateProject: (id, payload) =>
      request(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),

    getHoursPerProject: (startDate, endDate) => {
      const params = new URLSearchParams();
      if (startDate) params.set("startDate", startDate);
      if (endDate) params.set("endDate", endDate);
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
    getResourceLeaves: (startDate, endDate) =>
      request(`/api/reports/resource-leaves?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`),

    getProjectsByStatusEntity: (year) =>
      request(`/api/reports/projects-by-status-entity${year ? `?year=${encodeURIComponent(year)}` : ""}`),
    getProjectYears: () => request("/api/reports/project-years"),
    getProjectsOpenedByMonth: (year) =>
      request(`/api/reports/projects-opened-by-month${year ? `?year=${encodeURIComponent(year)}` : ""}`),
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

    health: () => request("/api/health"),
  };
})();
