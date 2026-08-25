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
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`API ${res.status}: ${text || res.statusText}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  return {
    getProjects: () => request("/api/projects"),
    getProjectStatuses: () => request("/api/projects/statuses"),
    getProjectLookups: () => request("/api/projects/lookups"),
    getProject: (id) => request(`/api/projects/${id}`),
    getProjectDeliverables: (id) => request(`/api/projects/${id}/deliverables`),
    addProjectDeliverable: (id, payload) =>
      request(`/api/projects/${id}/deliverables`, { method: "POST", body: JSON.stringify(payload) }),
    getProjectNotes: (id) => request(`/api/projects/${id}/notes`),
    addProjectNote: (id, payload) =>
      request(`/api/projects/${id}/notes`, { method: "POST", body: JSON.stringify(payload) }),
    getProjectQuotations: (id) => request(`/api/projects/${id}/quotations`),

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
    getBusinessPartnerNotes: (id) => request(`/api/business-partners/${id}/notes`),
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
    setEmployeeAdmin: (id, isAdmin) =>
      request(`/api/settings/employees/${id}/role`, { method: "PATCH", body: JSON.stringify({ isAdmin }) }),
    setEmployeeTimeOffApprover: (id, isTimeOffApprover) =>
      request(`/api/settings/employees/${id}/timeoff-approver`, { method: "PATCH", body: JSON.stringify({ isTimeOffApprover }) }),
    setEmployeeModuleAccess: (id, moduleKey, hasAccess) =>
      request(`/api/settings/employees/${id}/module-access`, { method: "PATCH", body: JSON.stringify({ moduleKey, hasAccess }) }),

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
    updateProjectStage: (id, stage) =>
      request(`/api/projects/${id}/stage`, {
        method: "PATCH",
        body: JSON.stringify({ stage }),
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
    health: () => request("/api/health"),
  };
})();
