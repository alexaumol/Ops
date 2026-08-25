/**
 * HITT Ops — Auth stub
 * ---------------------------------------------------------------------------
 * Placeholder for Microsoft 365 (Entra ID) sign-in.
 *
 * TODO once Alex supplies the Entra tenant ID + app registration client ID:
 *   1. Add the MSAL Browser library (@azure/msal-browser) to /public/vendor
 *      or load it from an on-prem/allowed CDN mirror (no external CDN calls
 *      once this runs from a locked-down shared folder).
 *   2. Build a PublicClientApplication using window.HITT_CONFIG.MSAL.
 *   3. Replace fakeSignIn() below with msalInstance.loginPopup()/loginRedirect().
 *   4. Validate the returned ID token server-side (in /server) before
 *      trusting any user identity for API calls — never trust the frontend.
 *
 * Until then, this stub only captures the typed username so the rest of the
 * app (header greeting, welcome menu) has something to display. It performs
 * NO real authentication and NO password check, as requested.
 * ---------------------------------------------------------------------------
 */

const HITT_AUTH = (() => {
  const SESSION_KEY = "hitt.session";

  function fakeSignIn(username) {
    const session = {
      username,
      displayName: deriveDisplayName(username),
      signedInAt: new Date().toISOString(),
      mode: "stub", // becomes "msal" once real auth is wired in
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

  function signOut(redirectTo = "index.html") {
    sessionStorage.removeItem(SESSION_KEY);
    window.location.href = redirectTo;
  }

  function initials(session) {
    if (!session?.displayName) return "?";
    const parts = session.displayName.trim().split(/\s+/);
    return parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("");
  }

  return { fakeSignIn, getSession, requireSession, signOut, initials };
})();
