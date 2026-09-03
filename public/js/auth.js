/**
 * Ops — Auth
 * ---------------------------------------------------------------------------
 * Two sign-in providers, chosen by HITT_CONFIG.AUTH.provider:
 *
 *   "entra"  Microsoft Entra ID (Azure AD) directly, via MSAL.js
 *            (vendor/msal-browser.min.js).
 *   "oidc"   the shared identity broker (Zitadel at auth.theaumol.com) or a
 *            customer's own IdP, via oidc-client-ts
 *            (vendor/oidc-client-ts.min.js) — Authorization Code + PKCE.
 *
 * Both libraries are loaded on every page (no CDN — this app must work from
 * a locked-down corporate network / shared folder). Whichever provider is
 * active, the flow is the same shape: a full-page redirect to the IdP, back
 * to index.html with an auth code, then silent access-token renewal via a
 * refresh token (no iframe, no third-party-cookie dependency).
 *
 * getApiToken() (called by js/api.js on every page) returns a JWT ACCESS
 * TOKEN the backend verifies on each request:
 *   entra -> server/lib/entraToken.js   (aud api://<clientId>)
 *   oidc  -> server/lib/oidcToken.js     (iss = the broker/IdP)
 * The plain X-HITT-User header is only a fallback for the stub / legacy
 * "header" auth modes.
 *
 * The API accepts tokens from BOTH providers while both are configured
 * server-side, so provider can be flipped and rolled back without a flag day.
 *
 * IMPORTANT — file:// deployment does not work with a real provider (IdPs
 * only accept http/https redirect URIs). Serve public/ over http(s).
 * fakeSignIn() still runs automatically when FEATURES.msalLoginEnabled is
 * false, so offline testing has a path (pair with AUTH_MODE=header).
 * ---------------------------------------------------------------------------
 */

const HITT_AUTH = (() => {
  const SESSION_KEY = "hitt.session";
  const RETURN_TO_KEY = "hitt.postLoginReturnTo";

  function provider() {
    return (window.HITT_CONFIG?.AUTH?.provider || "entra").toLowerCase();
  }

  // =========================================================================
  // Shared helpers
  // =========================================================================

  function deriveDisplayName(username) {
    if (!username) return "Employee";
    const local = username.split("@")[0].replace(/[._]/g, " ");
    return local.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // Sends the tab back to the sign-in page (relative path depends on whether
  // we're in /pages/ or at the site root). No-op if we're already there, so
  // this can't loop.
  function redirectToSignIn(reason) {
    const path = window.location.pathname;
    if (/(?:^|\/)index\.html$/.test(path) || path.endsWith("/")) return;
    const to = path.includes("/pages/") ? "../index.html" : "index.html";
    window.location.href = to + (reason ? `?${reason}=1` : "");
  }

  function getSession() {
    try {
      return JSON.parse(sessionStorage.getItem(SESSION_KEY));
    } catch {
      return null;
    }
  }

  function requireSession(redirectTo = "index.html") {
    const session = getSession();
    if (!session) {
      // Remember what was being opened (e.g. a bookmarked module page, or
      // the mobile expense-capture shortcut added to a phone's home screen)
      // so index.html can send the user straight back here after they sign
      // in, instead of always landing on welcome.html — see
      // consumePostLoginReturnTo().
      try {
        const file = window.location.pathname.split("/").pop();
        if (file) {
          const inPages = window.location.pathname.includes("/pages/");
          sessionStorage.setItem(RETURN_TO_KEY, (inPages ? "pages/" : "") + file + (window.location.search || ""));
        }
      } catch {}
      window.location.href = redirectTo;
      return null;
    }
    return session;
  }

  // Reads + clears the path requireSession() stashed before bouncing an
  // unauthenticated visit to sign-in. Only trusts a same-app relative
  // "welcome.html", "mobile.html", or "pages/<name>.html" path (optionally
  // with a query string) — never an absolute/external URL — since this
  // value round-trips through sessionStorage across the Microsoft/OIDC
  // redirect. Returns null when there's nothing stashed or it doesn't look
  // safe.
  function consumePostLoginReturnTo() {
    let path = null;
    try {
      path = sessionStorage.getItem(RETURN_TO_KEY);
      sessionStorage.removeItem(RETURN_TO_KEY);
    } catch {}
    if (!path || !/^(pages\/[\w-]+\.html|welcome\.html|mobile\.html)(\?[\w=&%.-]*)?$/.test(path)) return null;
    return path;
  }

  function initials(session) {
    if (!session?.displayName) return "?";
    const parts = session.displayName.trim().split(/\s+/);
    return parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
  }

  // Best-effort audit ping for sign in / sign out — never blocks or fails the
  // auth flow. Attaches the verified Bearer token when one is available (so
  // the entry is attributable), falling back to X-HITT-User for stub / legacy
  // modes. `keepalive` lets the logout ping survive the page unload.
  async function auditSessionEvent(type, keepalive) {
    try {
      const base = (window.HITT_CONFIG?.API_BASE_URL || "").replace(/\/$/, "");
      const session = getSession();
      let authHeader;
      try {
        const token = await getApiToken();
        authHeader = token
          ? { Authorization: `Bearer ${token}` }
          : { "X-HITT-User": session?.username || "unknown" };
      } catch {
        authHeader = { "X-HITT-User": session?.username || "unknown" };
      }
      fetch(`${base}/api/audit/session-event`, {
        method: "POST",
        keepalive: !!keepalive,
        headers: { "Content-Type": "application/json", ...authHeader },
        body: JSON.stringify({
          type,
          userAgent: navigator.userAgent || "",
          platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "",
        }),
      }).catch(() => {});
    } catch { /* never let audit logging break sign in/out */ }
  }

  // Prototype-mode fallback (no IdP, no password check) — used when
  // FEATURES.msalLoginEnabled is false, e.g. testing over file://.
  function fakeSignIn(username) {
    const session = {
      username,
      displayName: deriveDisplayName(username),
      signedInAt: new Date().toISOString(),
      mode: "stub",
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    auditSessionEvent("login");
    return session;
  }

  // =========================================================================
  // Provider: Microsoft Entra ID (MSAL)
  // =========================================================================

  let msalInstance = null;
  let msalReady = null;

  function msalConfig() {
    const cfg = window.HITT_CONFIG?.MSAL || {};
    return {
      auth: {
        clientId: cfg.clientId,
        authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
        redirectUri: cfg.redirectUri || window.location.origin,
      },
      cache: {
        // sessionStorage: one signed-in identity per tab, cleared on close.
        cacheLocation: "sessionStorage",
        storeAuthStateInCookie: false,
      },
    };
  }

  async function ensureMsal() {
    if (typeof msal === "undefined") {
      throw new Error("MSAL library not loaded on this page — include vendor/msal-browser.min.js before js/auth.js.");
    }
    if (!msalInstance) {
      msalInstance = new msal.PublicClientApplication(msalConfig());
      msalReady = msalInstance.initialize();
    }
    await msalReady;
    return msalInstance;
  }

  // Scope(s) requested for calling this app's own backend API — the custom
  // scope exposed on this same app registration.
  function msalApiScopes() {
    const cfg = window.HITT_CONFIG?.MSAL || {};
    if (Array.isArray(cfg.apiScopes) && cfg.apiScopes.length) return cfg.apiScopes;
    return [`api://${cfg.clientId}/access_as_user`];
  }

  async function entraGetApiToken() {
    let instance;
    try {
      instance = await ensureMsal();
    } catch (err) {
      console.error("[auth] MSAL unavailable on this page:", err.message);
      return null;
    }

    const session = getSession();
    const accounts = instance.getAllAccounts() || [];
    const account =
      (session?.homeAccountId && accounts.find((a) => a.homeAccountId === session.homeAccountId)) ||
      (session?.username && accounts.find((a) => a.username?.toLowerCase() === session.username.toLowerCase())) ||
      accounts[0] ||
      null;

    if (!account) {
      redirectToSignIn("expired");
      return null;
    }

    try {
      const result = await instance.acquireTokenSilent({ scopes: msalApiScopes(), account });
      return result.accessToken || null;
    } catch (err) {
      console.warn("[auth] silent token acquisition failed:", err?.errorCode || err?.message || err);
      redirectToSignIn("expired");
      return null;
    }
  }

  // Full-page redirect to Microsoft's hosted login (not a popup — see the
  // long history note removed in the 0A rewrite; loginRedirect sidesteps the
  // popup/window.opener COOP problem). Nothing after this runs.
  async function entraSignIn() {
    const instance = await ensureMsal();
    // Include the API scope so the user consents once, here.
    await instance.loginRedirect({ scopes: ["openid", "profile", "email", ...msalApiScopes()] });
  }

  async function entraCompleteRedirect() {
    const instance = await ensureMsal();
    const result = await instance.handleRedirectPromise();
    if (!result) return null;
    const account = result.account;
    const session = {
      username: account.username, // the signed-in UPN, typically their email
      displayName: account.name || deriveDisplayName(account.username),
      homeAccountId: account.homeAccountId, // lets other pages find this identity in the MSAL cache
      signedInAt: new Date().toISOString(),
      mode: "msal",
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    await auditSessionEvent("login");
    return session;
  }

  // =========================================================================
  // Provider: generic OIDC (oidc-client-ts)
  // =========================================================================

  let oidcMgr = null;

  function oidcManager() {
    if (oidcMgr) return oidcMgr;
    if (typeof oidc === "undefined") {
      throw new Error("oidc-client-ts not loaded on this page — include vendor/oidc-client-ts.min.js before js/auth.js.");
    }
    const cfg = window.HITT_CONFIG?.OIDC || {};
    const store = new oidc.WebStorageStateStore({ store: window.sessionStorage });
    oidcMgr = new oidc.UserManager({
      authority: cfg.authority,
      client_id: cfg.clientId,
      redirect_uri: cfg.redirectUri || window.location.origin + "/index.html",
      post_logout_redirect_uri: cfg.redirectUri || window.location.origin + "/index.html",
      response_type: "code",
      scope: (cfg.scopes || ["openid", "profile", "email", "offline_access"]).join(" "),
      userStore: store,
      stateStore: store,
      automaticSilentRenew: true,
      // Renew via the refresh token, not a hidden iframe (matches MSAL here).
      monitorSession: false,
    });
    return oidcMgr;
  }

  function oidcUserToSession(user) {
    const p = user.profile || {};
    const session = {
      username: p.email || p.preferred_username || p.sub,
      displayName: p.name || deriveDisplayName(p.email || p.preferred_username),
      sub: p.sub,
      signedInAt: new Date().toISOString(),
      mode: "oidc",
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session;
  }

  async function oidcSignIn() {
    await oidcManager().signinRedirect();
  }

  // On the redirect_uri page carrying ?code=&state=, completes sign-in and
  // scrubs the code from the URL. Resolves to null on any other page load.
  async function oidcCompleteRedirect() {
    if (!/[?&](code|error)=/.test(window.location.search)) return null;
    const mgr = oidcManager();
    const user = await mgr.signinRedirectCallback();
    window.history.replaceState({}, document.title, window.location.pathname);
    const session = oidcUserToSession(user);
    await auditSessionEvent("login");
    return session;
  }

  async function oidcGetApiToken() {
    const mgr = oidcManager();
    let user = await mgr.getUser();
    if (user && !user.expired && user.access_token) return user.access_token;
    if (user && user.refresh_token) {
      try {
        user = await mgr.signinSilent();
        if (user && user.access_token) return user.access_token;
      } catch (err) {
        console.warn("[auth] OIDC silent renew failed:", err?.message || err);
      }
    }
    redirectToSignIn("expired");
    return null;
  }

  async function oidcSignOut(redirectTo) {
    // App-level sign-out only: clear our session, keep the broker's SSO
    // session so re-login is one click and other apps aren't logged out.
    sessionStorage.removeItem(SESSION_KEY);
    try { await oidcManager().removeUser(); } catch { /* ignore */ }
    window.location.href = redirectTo;
  }

  // =========================================================================
  // Dispatchers — the public surface
  // =========================================================================

  async function signIn() {
    return provider() === "oidc" ? oidcSignIn() : entraSignIn();
  }

  // Call once, early, on the sign-in page. On an ordinary visit resolves to
  // null; on the load that IS the IdP redirecting back, completes sign-in.
  async function completeRedirect() {
    return provider() === "oidc" ? oidcCompleteRedirect() : entraCompleteRedirect();
  }

  // Fresh JWT access token for the API, or null in stub mode. On an expired
  // session, redirects to sign-in and returns null.
  async function getApiToken() {
    if (!window.HITT_CONFIG?.FEATURES?.msalLoginEnabled) return null; // stub mode
    return provider() === "oidc" ? oidcGetApiToken() : entraGetApiToken();
  }

  async function signOut(redirectTo = "index.html") {
    try { await auditSessionEvent("logout", true); } catch { /* ignore */ }
    if (provider() === "oidc") return oidcSignOut(redirectTo);
    // Entra: app-level only — deliberately NOT MSAL logoutRedirect, which
    // would end the user's whole Microsoft 365 session across the browser.
    sessionStorage.removeItem(SESSION_KEY);
    window.location.href = redirectTo;
  }

  return {
    // canonical
    signIn,
    completeRedirect,
    getApiToken,
    getSession,
    requireSession,
    consumePostLoginReturnTo,
    signOut,
    initials,
    fakeSignIn,
    // back-compat aliases (index.html and older callers)
    signInWithMicrosoft: signIn,
    completeMsalRedirect: completeRedirect,
  };
})();
