/**
 * HITT Ops — notification badges
 * ---------------------------------------------------------------------------
 * Small, best-effort helper for the red count badges on the Time allocation
 * tile (welcome page) and the "Time off requests" tab.
 *
 * The badge number means:
 *   - time-off approvers: how many requests are still awaiting a decision
 *   - everyone else:       how many of your own requests were approved or
 *                          rejected since you last looked
 *
 * "Since you last looked" is a timestamp kept in localStorage (per browser,
 * best-effort — a private window just means the badge always reflects
 * "recently"). It is reset by markTimeOffSeen() when the user opens the
 * Time off requests tab.
 * ---------------------------------------------------------------------------
 */
window.HITT_NOTIFY = (function () {
  const SINCE_KEY = "hitt.timeoff.notifSince";

  function getSince() {
    let s = null;
    try { s = localStorage.getItem(SINCE_KEY); } catch { /* storage blocked */ }
    if (!s) {
      // First run on this browser — baseline to now so we don't surface a
      // backlog of historical decisions.
      s = new Date().toISOString();
      try { localStorage.setItem(SINCE_KEY, s); } catch { /* storage blocked */ }
    }
    return s;
  }

  async function timeOffCount() {
    try {
      const n = await HITT_API.getTimeOffNotifications(getSince());
      const raw = n.isApprover ? n.pendingApprovals : n.myUpdates;
      return Math.max(0, Number(raw) || 0);
    } catch (err) {
      console.warn("[notify] time-off badge check failed:", err.message);
      return 0;
    }
  }

  function markTimeOffSeen() {
    try { localStorage.setItem(SINCE_KEY, new Date().toISOString()); } catch { /* storage blocked */ }
  }

  function paint(el, count) {
    if (!el) return;
    if (count > 0) {
      el.textContent = count > 99 ? "99+" : String(count);
      el.classList.remove("hidden");
    } else {
      el.textContent = "";
      el.classList.add("hidden");
    }
  }

  return { timeOffCount, markTimeOffSeen, paint };
})();
