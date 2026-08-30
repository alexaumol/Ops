/**
 * HITT Ops — Auth
 * ---------------------------------------------------------------------------
 * Real Microsoft Entra ID (Azure AD) sign-in via MSAL.js, vendored locally
 * at vendor/msal-browser.min.js (no CDN — see README on why: this app needs
 * to work from a locked-down corporate network / shared folder). The
 * library is now loaded on EVERY page, not just index.html, because
 * getApiToken() below needs MSAL on each page to silently renew the access
 * token that js/api.js sends to the backend.
 *
 *   index.html          calls signInWithMicrosoft() / completeMsalRedirect()
 *   every other page     calls getApiToken() (via js/api.js) — reads the
 *                        MSAL account from the shared sessionStorage cache
 *                        and calls acquireTokenSilent()
 *
 * getApiToken() returns an Entra ID ACCESS TOKEN for this app's own API
 * scope (config.js MSAL.apiScopes — default api://<clientId>/access_as_user).
 * The backend verifies it on every request (server/lib/entraToken.js);
 * the plain X-HITT-User header is only a fallback for the stub / legacy
 * "header" auth modes.
 *
 * IMPORTANT — file:// deployment does not work once real MSAL is live.
 * Microsoft Entra only accepts http/https redirect URIs for SPA app
 * registrations. Serve public/ over http(s) (a shared-folder web server,
 * the VPS, or the local dev preview). fakeSignIn() is still used
 * automatically when FEATURES.msalLoginEnabled is false, so file:// /
 * offline testing has a path — pair it with AUTH_MODE=header server-side.
 * ---------------------------------------------------------------------------
 */

const HITT_AUTH = (() => {
  const SESSION_KEY = "hitt.session";
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
        // sessionStorage, not localStorage: matches hitt.session below —
        // one signed-in identity per tab, cleared when the tab closes.
        cacheLocation: "sessionStorage",
        storeAuthStateInCookie: false,
      },
    };
  }

  async function ensureMsal() {
    if (typeof msal === "undefined") {
      throw new Error("MSAL library not loaded on this page — every page must include vendor/msal-browser.min.js before js/auth.js.");
    }
    if (!msalInstance) {
      msalInstance = new msal.PublicClientApplication(msalConfig());
      msalReady = msalInstance.initialize();
    }
    await msalReady;
    return msalInstance;
  }

  // Scope(s) requested for calling this app's own backend API. Defaults to
  // the custom scope exposed on this same app registration.
  function apiScopes() {
    const cfg = window.HITT_CONFIG?.MSAL || {};
    if (Array.isArray(cfg.apiScopes) && cfg.apiScopes.length) return cfg.apiScopes;
    return [`api://${cfg.clientId}/access_as_user`];
  }

  // Sends the tab back to the sign-in page (relative path depends on
  // whether we're in /pages/ or at the site root). No-op if we're already
  // on the sign-in page, so this can't loop.
  function redirectToSignIn(reason) {
    const path = window.location.pathname;
    if (/(?:^|\/)index\.html$/.test(path) || path.endsWith("/")) return;
    const to = path.includes("/pages/") ? "../index.html" : "index.html";
    window.location.href = to + (reason ? `?${reason}=1` : "");
  }

  // Returns a fresh Entra ID access token for the API, or null when the app
  // is in stub mode (no MSAL). On an expired MSAL session it redirects to
  // sign-in and returns null (the caller's request is abandoned — the page
  // is navigating away anyway).
  //
  // acquireTokenSilent() serves the token straight from the MSAL cache when
  // it's still valid, and uses the refresh token (auth-code + PKCE, stored
  // in sessionStorage) to renew it silently when it isn't — no iframe, no
  // third-party-cookie dependency.
  async function getApiToken() {
    if (!window.HITT_CONFIG?.FEATURES?.msalLoginEnabled) return null; // stub mode

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
      const result = await instance.acquireTokenSilent({ scopes: apiScopes(), account });
      return result.accessToken || null;
    } catch (err) {
      console.warn("[auth] silent token acquisition failed:", err?.errorCode || err?.message || err);
      redirectToSignIn("expired");
      return null;
    }
  }

  // Real sign-in: navigates this whole tab to Microsoft's hosted login,
  // which redirects back to redirectUri (index.html) with an auth code —
  // see completeMsalRedirect() below for the other half of this flow.
  // Nothing after the loginRedirect() call runs; the page navigates away.
  //
  // This used to be loginPopup() (a popup window instead of a full-page
  // redirect), but login.microsoftonline.com sends its own
  // Cross-Origin-Opener-Policy header, which some browsers/profiles use to
  // sever window.opener between the popup and this tab the moment the
  // popup first navigates there — permanently, even once the popup
  // navigates back to our own origin. When that happens the popup just
  // sits on the final redirect page forever with a valid, unused auth code
  // in its URL: nothing is listening for it, because msal-browser's popup
  // flow completes by having the OPENER poll the popup's window.opener-
  // dependent state, and that link is already gone. Confirmed by checking
  // window.opener directly in a stuck popup's console — it was null.
  // loginRedirect() sidesteps the whole popup/opener relationship.
  async function signInWithMicrosoft() {
    const instance = await ensureMsal();
    // Include the API scope in the sign-in request so the user consents to
    // it once, here — otherwise the first acquireTokenSilent() on a module
    // page would throw consent_required and bounce them straight back.
    await instance.loginRedirect({ scopes: ["openid", "profile", "email", ...apiScopes()] });
  }

  // Call once, early, on every page load that has the MSAL library loaded
  // (currently just index.html, right before deciding whether to show the
  // sign-in button). On an ordinary visit this resolves to null almost
  // immediately. On the page load that IS Microsoft redirecting back after
  // loginRedirect() above, this completes sign-in — same session shape
  // signInWithMicrosoft() used to hand back directly from loginPopup().
  // Throws on failure — callers should catch and show the error.
  async function completeMsalRedirect() {
    const instance = await ensureMsal();
    const result = await instance.handleRedirectPromise();
    if (!result) return null;
    const account = result.account;
    const session = {
      username: account.username, // the signed-in UPN, typically their email
      displayName: account.name || deriveDisplayName(account.username),
      // Lets every other page pick this exact identity out of the shared
      // MSAL sessionStorage cache when renewing the API token.
      homeAccountId: account.homeAccountId,
      signedInAt: new Date().toISOString(),
      mode: "msal",
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
    await auditSessionEvent("login");
    return session;
  }

  // Prototype-mode fallback (no MSAL, no password check) — used when
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

  function deriveDisplayName(username) {
    if (!username) return "Employee";
    const local = username.split("@")[0].replace(/[._]/g, " ");
    return local.replace(/\b\w/g, (c) => c.toUpperCase());
  }

  // Best-effort audit ping for sign in / sign out — never blocks or fails
  // the auth flow. Sends the verified Bearer token when one is available
  // (so the entry is attributable in bearer mode), falling back to the
  // X-HITT-User header for stub / legacy modes. A browser can't read the OS
  // hostname, so `platform` is the closest a web page can report ("computer
  // name" in the audit UI). `keepalive` lets the logout ping survive the
  // page unload.
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
        headers: {
          "Content-Type": "application/json",
          ...authHeader,
        },
        body: JSON.stringify({
          type,
          userAgent: navigator.userAgent || "",
          platform: (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "",
        }),
      }).catch(() => {});
    } catch { /* never let audit logging break sign in/out */ }
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
      window.location.href = redirectTo;
      return null;
    }
    return session;
  }

  // App-level sign-out only: clears our own session marker so this app
  // treats the tab as signed out again. Deliberately does NOT call MSAL's
  // full logoutPopup/logoutRedirect — that would end the user's whole
  // Microsoft 365 session (Outlook, Teams, ...) across the browser, which
  // would be a surprising side effect for an internal line-of-business app.
  async function signOut(redirectTo = "index.html") {
    // Await so the token is attached before we tear the session down;
    // keepalive lets the request itself outlive the navigation below.
    try { await auditSessionEvent("logout", true); } catch { /* ignore */ }
    sessionStorage.removeItem(SESSION_KEY);
    window.location.href = redirectTo;
  }

  function initials(session) {
    if (!session?.displayName) return "?";
    const parts = session.displayName.trim().split(/\s+/);
    return parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
  }

  return { signInWithMicrosoft, completeMsalRedirect, fakeSignIn, getApiToken, getSession, requireSession, signOut, initials };
})();
