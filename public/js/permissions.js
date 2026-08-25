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

  // Redirects to welcome.html if the current user is restricted from
  // moduleKey. Call this near the top of a module page's init script.
  // Fails open on error (matches the backend's fail-open-on-unresolved-
  // identity behavior) rather than locking someone out over a network blip.
  async function guardModule(moduleKey, redirectTo = "../welcome.html") {
    try {
      const perms = await get();
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

  return { get, guardModule };
})();
