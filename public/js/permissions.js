/**
 * HITT Ops — frontend permissions helper
 * ---------------------------------------------------------------------------
 * Thin wrapper around GET /api/permissions/me for UI-level gating (hide a
 * nav tile, redirect off a restricted module page). This is NOT the
 * security boundary — the server enforces the real rule on every request
 * (see server/lib/permissions.js). This just keeps the frontend from
 * showing/offering things the backend would reject anyway.
 * ---------------------------------------------------------------------------
 */
const HITT_PERMS = (() => {
  let cached = null;

  // Fetches once per page load and caches — every page that needs this
  // calls it at most a couple of times (nav gating + a module guard).
  async function get() {
    if (!cached) {
      cached = HITT_API.getMyPermissions().catch((err) => {
        cached = null; // allow retry on next call
        throw err;
      });
    }
    return cached;
  }

  // Signs out and sends a deactivated user back to the sign-in page with a
  // notice (?deactivated=1) — used right after sign-in (before ever
  // routing to welcome.html) and again on welcome.html/module pages as a
  // fallback for a bookmarked or already-open session that got deactivated
  // mid-session. Returns true if it redirected (caller must stop — don't
  // navigate anywhere else or render gated content). Fails open on error,
  // same reasoning as guardModule below.
  async function redirectIfDeactivated(signInPage = "index.html") {
    try {
      const perms = await get();
      if (perms.isDeactivated) {
        HITT_AUTH.signOut(`${signInPage}?deactivated=1`);
        return true;
      }
      return false;
    } catch (err) {
      console.error("[HITT_PERMS.redirectIfDeactivated] permissions check failed, allowing through:", err.message);
      return false;
    }
  }

  // Redirects to welcome.html if the current user is restricted from
  // moduleKey, or to sign-in (see redirectIfDeactivated) if deactivated.
  // Call this near the top of a module page's init script. Fails open on
  // error (matches the backend's fail-open-on-unresolved-identity
  // behavior) rather than locking someone out over a network blip.
  async function guardModule(moduleKey, redirectTo = "../welcome.html") {
    try {
      const perms = await get();
      if (perms.isDeactivated) {
        HITT_AUTH.signOut("../index.html?deactivated=1");
        return null;
      }
      if (!perms.isAdmin && perms.restrictedModules.includes(moduleKey)) {
        window.location.href = redirectTo;
        return null;
      }
      return perms;
    } catch (err) {
      console.error("[HITT_PERMS.guardModule] permissions check failed, allowing through:", err.message);
      return null;
    }
  }

  // Upgrades the header's #userName/#userAvatar from the username-derived
  // guess set at page load (see auth.js deriveDisplayName — accurate for
  // real MSAL sign-in, but there's nothing to derive a first name from for
  // a stub-mode short username like "abellmunt") to the real name from the
  // employees row this identity resolved to. Call this on every page right
  // after setting the header from `session`. Silently leaves the guessed
  // name in place on error/no-match — never worse than what was already
  // shown.
  async function applyRealName() {
    try {
      const perms = await get();
      if (perms.name) {
        const nameEl = document.getElementById("userName");
        if (nameEl) nameEl.textContent = perms.name;
        const avatarEl = document.getElementById("userAvatar");
        if (avatarEl) avatarEl.textContent = HITT_AUTH.initials({ displayName: perms.name });
      }
      return perms;
    } catch (err) {
      console.error("[HITT_PERMS.applyRealName] permissions check failed, keeping username-derived name:", err.message);
      return null;
    }
  }

  return { get, guardModule, redirectIfDeactivated, applyRealName };
})();
