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
  // Base URL of the Node/Express API (see /server). Same-origin as the
  // frontend — nginx on ops.fhitt.org proxies /api/ to the Node app on
  // 127.0.0.1:4000 (see /etc/nginx/sites-enabled/hitt-ops on the VPS), so
  // no CORS is needed. This was originally a separate ops-api.fhitt.org
  // subdomain, but that vhost was never actually wired up to proxy to
  // Node (DNS resolved, but nginx had no matching server block, so every
  // API call 404'd and the frontend silently fell back to demo data) — if
  // that subdomain gets a proper reverse proxy + cert later, switch this
  // back and add its origin to server/.env's CORS_ALLOWED_ORIGINS.
  API_BASE_URL: "https://ops.fhitt.org",

  // Microsoft Entra ID (Azure AD) app registration — used for M365 sign-in.
  // These are public identifiers, safe to ship in static files (a client ID
  // / tenant ID identifies an app registration, it doesn't authenticate one).
  //
  // The redirect URI below MUST be registered as a "Single-page application"
  // redirect URI on this app registration in the Entra portal (App
  // registrations > this app > Authentication > SPA platform), exactly
  // matching whatever origin actually serves these files — e.g.
  // http://localhost:5500/index.html for local dev, plus the real
  // production URL. It points at index.html because that's the page with
  // the MSAL library loaded and the "Sign in" button — loginRedirect()
  // (see js/auth.js) sends the whole tab here with an auth code, and
  // index.html's own script calls completeMsalRedirect() on load to finish
  // signing in and move on to welcome.html.
  //
  // This used to be a popup flow (loginPopup(), redirecting to a separate
  // blank auth-redirect.html) but login.microsoftonline.com's own
  // Cross-Origin-Opener-Policy header was severing window.opener between
  // the popup and this tab in some browsers, leaving the popup stuck with
  // an unused auth code and no way to complete. Full-page redirect avoids
  // that whole cross-window relationship.
  MSAL: {
    tenantId: "6ab80f28-9ca1-4f48-9be7-7d98f3e1f076",
    clientId: "841556ac-d3af-47ee-a399-403de65c139c",
    redirectUri: window.location.origin + "/index.html",
    authority: null, // computed at runtime from tenantId (see auth.js)

    // Scope(s) the frontend requests when calling this app's own API. The
    // API (server/lib/entraToken.js) validates the resulting access token's
    // signature, issuer, audience, expiry, tenant and scope server-side.
    //
    // Leave null to derive ["api://<clientId>/access_as_user"] at runtime —
    // that scope must exist on the app registration (Expose an API → Add a
    // scope). Override here only if you named the scope differently or the
    // API is a separate app registration.
    apiScopes: null,
  },

  // Feature flags for progressive delivery — flip these on as each module
  // of the app becomes real instead of a placeholder.
  FEATURES: {
    msalLoginEnabled: true,   // real Entra ID sign-in — see js/auth.js
    projectsLive: true,        // Projects kanban tries the API, falls back to demo data
    businessPartnersLive: true,
    timeAllocationLive: true,
    invoicingLive: true,
    // Ops assistant (js/chat.js). Even when true, the widget only appears
    // if the server reports GET /api/chat/status as configured — so this
    // can ship on before Azure OpenAI is wired up.
    chatEnabled: true,
  },

  APP_VERSION: "0.1.0-prototype",
};
