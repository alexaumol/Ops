/**
 * Ops — branding application (product name + logo)
 * ---------------------------------------------------------------------------
 * - Product name: from HITT_CONFIG.APP_NAME (config.js), applied to the app
 *   header wordmark, the sign-in card, and the document title.
 * - Logo: swaps the bundled neutral mark for an admin-uploaded logo
 *   (Settings → Customizations). The logo lives server-side in appconfig and
 *   is fetched from GET /api/branding/logo — a public endpoint, so this also
 *   works on the pre-auth sign-in page.
 *
 * The last-seen logo is cached in localStorage and applied synchronously on
 * load so headers don't flash the default mark before the fetch resolves.
 * Loaded on every page right after js/config.js.
 * ---------------------------------------------------------------------------
 */
(function () {
  var LS_KEY = "hitt.branding.logo";
  var SELECTOR = ".app-header__logo, .login-brand__logo";

  // --- Product name ---------------------------------------------------
  var APP_NAME = (window.HITT_CONFIG && window.HITT_CONFIG.APP_NAME) || "";
  function applyName() {
    if (!APP_NAME) return;
    document.querySelectorAll(".app-header__name, .login-brand__name").forEach(function (el) {
      if (el.textContent !== APP_NAME) el.textContent = APP_NAME;
    });
    // Titles are "<Default> — Page"; swap the product part, keep the page.
    if (document.title) {
      document.title = document.title.replace(/^(HITT Ops|HITT·Ops|Ops)\b/, APP_NAME);
    }
  }
  applyName();
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", applyName);
  }

  function applyLogo(dataUrl) {
    if (!dataUrl) return;
    document.querySelectorAll(SELECTOR).forEach(function (img) {
      if (img.getAttribute("src") !== dataUrl) img.src = dataUrl;
    });
  }

  function whenReady(fn) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", fn);
    } else {
      fn();
    }
  }

  var cached = null;
  try {
    cached = localStorage.getItem(LS_KEY);
  } catch (e) {}
  if (cached) {
    applyLogo(cached);
    whenReady(function () {
      applyLogo(cached);
    });
  }

  var base = ((window.HITT_CONFIG && window.HITT_CONFIG.API_BASE_URL) || "").replace(/\/$/, "");
  fetch(base + "/api/branding/logo")
    .then(function (r) {
      return r.ok ? r.json() : null;
    })
    .then(function (data) {
      if (!data) return;
      var url = data.dataUrl || null;
      try {
        if (url) localStorage.setItem(LS_KEY, url);
        else localStorage.removeItem(LS_KEY);
      } catch (e) {}
      if (url) {
        applyLogo(url);
        whenReady(function () {
          applyLogo(url);
        });
      }
      // If the logo was reset server-side there's nothing to do live — the
      // bundled asset is still in the markup on any fresh page load.
    })
    .catch(function () {});

  // Let the Settings page push a freshly-saved logo to every open element
  // without a reload.
  window.HITT_BRANDING = {
    apply: applyLogo,
    cache: function (url) {
      try {
        if (url) localStorage.setItem(LS_KEY, url);
        else localStorage.removeItem(LS_KEY);
      } catch (e) {}
    },
  };
})();
