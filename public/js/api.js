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
    createProject: (payload) =>
      request("/api/projects", { method: "POST", body: JSON.stringify(payload) }),
    updateProjectStage: (id, stage) =>
      request(`/api/projects/${id}/stage`, {
        method: "PATCH",
        body: JSON.stringify({ stage }),
      }),
    updateProject: (id, payload) =>
      request(`/api/projects/${id}`, { method: "PATCH", body: JSON.stringify(payload) }),
    health: () => request("/api/health"),
  };
})();
