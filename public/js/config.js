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
  // These are public identifiers, safe to ship in static files (a client ID
  // / tenant ID identifies an app registration, it doesn't authenticate one).
  //
  // The redirect URI below MUST be registered as a "Single-page application"
  // redirect URI on this app registration in the Entra portal (App
  // registrations > this app > Authentication > SPA platform), exactly
  // matching whatever origin actually serves these files — e.g.
  // http://localhost:5500/index.html for local dev, plus the real
  // production URL once that's decided. It points at index.html (not
  // welcome.html) because that's the page with the MSAL library loaded —
  // the popup posts its result back there, then our own code navigates to
  // welcome.html, same as the old stub flow.
  MSAL: {
    tenantId: "6ab80f28-9ca1-4f48-9be7-7d98f3e1f076",
    clientId: "841556ac-d3af-47ee-a399-403de65c139c",
    redirectUri: window.location.origin + "/index.html",
    authority: null, // computed at runtime from tenantId (see auth.js)
  },

  // Feature flags for progressive delivery — flip these on as each module
  // of the app becomes real instead of a placeholder.
  FEATURES: {
    msalLoginEnabled: true,   // real Entra ID sign-in — see js/auth.js
    projectsLive: true,        // Projects kanban tries the API, falls back to demo data
    businessPartnersLive: true,
    timeAllocationLive: true,
    invoicingLive: true,
  },

  APP_VERSION: "0.1.0-prototype",
};
