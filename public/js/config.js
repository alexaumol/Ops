/**
 * HITT Ops — Runtime configuration
 * ---------------------------------------------------------------------------
 * This file is intentionally the ONLY place a deployed copy of the static
 * frontend needs editing. It contains NO secrets — just public endpoints
 * and the Azure AD (Microsoft 365) app registration identifiers, which are
 * not sensitive (a client ID / tenant ID is not a credential).
 *
 * Because the frontend can be run from a shared folder or copied to an
 * employee's machine, do NOT put database credentials, connection strings,
 * or API keys anywhere in /public. All of that lives server-side only
 * (see /server/.env on the API host) and is reached through authenticated
 * HTTPS calls to API_BASE_URL below.
 * ---------------------------------------------------------------------------
 */
window.HITT_CONFIG = {
  // Base URL of the Node/Express API (see /server). Point this at the
  // test VPS while prototyping; switch to the production API URL later.
  API_BASE_URL: "https://ops-api.fhitt.org", // TODO: replace with real test VPS URL

  // Microsoft Entra ID (Azure AD) app registration — used for M365 sign-in.
  // These are public identifiers, safe to ship in static files.
  MSAL: {
    tenantId: "REPLACE_WITH_TENANT_ID",     // <- Alex will supply this
    clientId: "REPLACE_WITH_APP_CLIENT_ID", // <- from the Entra app registration
    redirectUri: window.location.origin + "/welcome.html",
    authority: null, // computed at runtime from tenantId (see auth.js)
  },

  // Feature flags for progressive delivery — flip these on as each module
  // of the app becomes real instead of a placeholder.
  FEATURES: {
    msalLoginEnabled: false,   // true once tenant/client IDs + validation are wired up
    projectsLive: true,        // Projects kanban tries the API, falls back to demo data
    businessPartnersLive: true,
    timeAllocationLive: true,
    invoicingLive: false,
  },

  APP_VERSION: "0.1.0-prototype",
};
