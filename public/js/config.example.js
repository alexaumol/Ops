/**
 * Ops — runtime configuration TEMPLATE
 * ---------------------------------------------------------------------------
 * The committed reference for what a per-instance `config.js` should contain.
 * `config.js` is still tracked today (it holds HITT's values); the move to a
 * gitignored, per-instance `config.js` rendered by the provisioning script
 * happens with issue 0D — see docs/0B-config-inventory.md.
 *
 * Contains NO secrets — just public endpoints and OAuth/OIDC client
 * identifiers (a client ID / tenant ID is not a credential). Never put
 * database credentials, connection strings, or API keys anywhere in /public;
 * those live server-side only (server/.env on the API host).
 * ---------------------------------------------------------------------------
 */
window.HITT_CONFIG = {
  // Product name shown in the app header and on the sign-in page. The logo
  // is uploaded per instance in Settings → Customizations.
  APP_NAME: "Ops",

  // This instance's own origin — nginx proxies /api/ to the Node app on
  // 127.0.0.1:4000, so the frontend and API share an origin and no CORS is
  // needed. Must also be listed in server/.env CORS_ALLOWED_ORIGINS.
  API_BASE_URL: "https://CUSTOMER.ops.theaumol.com",

  // --- Identity ---------------------------------------------------------
  // OIDC via the shared identity broker (auth.theaumol.com). Wired up in
  // issue 0A (js/auth.js + server/lib/entraToken.js → generic OIDC). Until
  // then the MSAL block below is what's live.
  OIDC: {
    issuer: "https://auth.theaumol.com",          // shared across all instances
    clientId: "REPLACE_WITH_OPS_CLIENT_ID",        // the shared "Ops" app in the broker
    scopes: ["openid", "profile", "email"],
    // Optional: pin sign-in to this customer's broker organization so users
    // land in the right tenant. Blank = the broker resolves it by email domain.
    orgIdHint: "",
  },

  // --- Legacy Microsoft Entra ID (Azure AD) direct sign-in -------------
  // Used until issue 0A switches auth.js over to OIDC. The redirect URI
  // (this origin + /index.html) must be registered as an SPA redirect on
  // the app registration.
  MSAL: {
    tenantId: "REPLACE_WITH_TENANT_ID",
    clientId: "REPLACE_WITH_APP_CLIENT_ID",
    redirectUri: window.location.origin + "/index.html",
    authority: null,      // computed at runtime from tenantId (see auth.js)
    apiScopes: null,      // null → ["api://<clientId>/access_as_user"]
  },

  // Feature flags for progressive delivery.
  FEATURES: {
    msalLoginEnabled: true,
    projectsLive: true,
    businessPartnersLive: true,
    timeAllocationLive: true,
    invoicingLive: true,
    // Ops assistant (js/chat.js) — also gated server-side on GET
    // /api/chat/status, so this can ship on before the LLM is configured.
    chatEnabled: true,
    // Veri*Factu (Spain e-invoicing). Mirrors FEATURE_VERIFACTU on the
    // server — keep both in sync. Off for every non-Spanish instance; when
    // off, the Settings → Veri*Factu tab and the "Issue" action are hidden.
    verifactu: false,
  },

  APP_VERSION: "0.1.0-prototype",
};
