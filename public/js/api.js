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
