/**
 * HITT Ops — Mobile landing ("home screen" launcher)
 * ---------------------------------------------------------------------------
 * The mobile app's actual entry point (manifest.json start_url) — a small
 * menu of mobile-ready features, each its own dedicated screen. Kept
 * separate from welcome.html (the desktop module grid) on purpose: none of
 * the desktop-shaped pages (kanban, wide tables) work on a phone yet, so
 * mobile traffic should never wander into them — same reasoning as
 * pages/mobile-expenses.html being a dead end with no link back out.
 * ---------------------------------------------------------------------------
 */
const session = HITT_AUTH.requireSession("index.html");
const T = (k, v) => (window.HITT_I18N ? HITT_I18N.t(k, v) : k);
if (session) {
  document.getElementById("userName").textContent = session.displayName;
  document.getElementById("userAvatar").textContent = HITT_AUTH.initials(session);
}

function markRestricted(tileId, statusId) {
  const tile = document.getElementById(tileId);
  const status = document.getElementById(statusId);
  if (!tile || !status) return;
  tile.classList.add("mh-tile--restricted");
  tile.removeAttribute("href");
  tile.setAttribute("aria-disabled", "true");
  status.textContent = T("welcome.status.restricted");
  status.classList.remove("hidden");
  status.classList.add("mh-tile__status--restricted");
}

// A deactivated employee should never actually see this page — bounced
// straight back to sign-in (see js/permissions.js). This is a fallback for
// a bookmarked/already-open tab or the home-screen shortcut re-opened after
// deactivation; the main defense is index.html checking right after sign-in.
HITT_PERMS.redirectIfDeactivated("index.html").then((blocked) => {
  if (blocked) return;
  HITT_PERMS.applyRealName().then((perms) => {
    if (!perms) return;
    if (perms.isAdmin) return;
    if (perms.restrictedModules.includes("expenses")) markRestricted("mhExpensesTile", "mhExpensesStatus");
    if (perms.restrictedModules.includes("presence")) markRestricted("mhPresenceTile", "mhPresenceStatus");
  }).catch((err) => {
    console.error("[mobile-home] permissions check failed, showing all tiles:", err.message);
  });
});

window.addEventListener("hitt:langchange", () => {
  ["mhExpensesStatus", "mhPresenceStatus"].forEach((id) => {
    const status = document.getElementById(id);
    if (status && !status.classList.contains("hidden")) status.textContent = T("welcome.status.restricted");
  });
});
