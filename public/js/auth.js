/**
 * HITT Ops — Auth
 * ---------------------------------------------------------------------------
 * Real Microsoft Entra ID (Azure AD) sign-in via MSAL.js, vendored locally
 * at vendor/msal-browser.min.js (no CDN — see README on why: this app needs
 * to work from a locked-down corporate network / shared folder). Only
 * index.html loads that library and calls signInWithMicrosoft() — every
 * other page just reads the session this writes to sessionStorage, exactly
 * like the old stub did, so nothing else in the app needed to change.
 *
 * IMPORTANT — file:// deployment stops working once real MSAL is live.
 * Microsoft Entra only accepts http/https redirect URIs for SPA app
 * registrations, so loginRedirect() cannot complete when this is opened as
 * a local file. Serve public/ over http(s) (a shared-folder web server, the
 * VPS, or the local dev preview) for sign-in to work. fakeSignIn() is kept
 * below and still used automatically when FEATURES.msalLoginEnabled is
 * false, so file:// / offline testing still has a path — see index.html.
 *
 * The ID token MSAL returns is NOT currently sent to or checked by the
 * backend — server/routes still trust the plain X-HITT-User header (see
 * js/api.js). Validating a real bearer token server-side is a separate
 * follow-up, deliberately not bundled into "wire up sign-in".
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
      throw new Error("MSAL library not loaded on this page (vendor/msal-browser.min.js) — signInWithMicrosoft() can only be called from index.html.");
    }
    if (!msalInstance) {
      msalInstance = new msal.PublicClientApplication(msalConfig());
      msalReady = msalInstance.initialize();
    }
    await msalReady;
    return msalInstance;
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
    await instance.loginRedirect({ scopes: ["openid", "profile", "email"] });
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
      signedInAt: new Date().toISOString(),
      mode: "msal",
    };
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
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
    return session;
  }

  function deriveDisplayName(username) {
    if (!username) return "Employee";
    const local = username.split("@")[0].replace(/[._]/g, " ");
    return local.replace(/\b\w/g, (c) => c.toUpperCase());
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
  function signOut(redirectTo = "index.html") {
    sessionStorage.removeItem(SESSION_KEY);
    window.location.href = redirectTo;
  }

  function initials(session) {
    if (!session?.displayName) return "?";
    const parts = session.displayName.trim().split(/\s+/);
    return parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
  }

  return { signInWithMicrosoft, completeMsalRedirect, fakeSignIn, getSession, requireSession, signOut, initials };
})();
