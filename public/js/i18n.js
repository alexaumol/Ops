/**
 * HITT Ops — lightweight UI internationalisation.
 * ---------------------------------------------------------------------------
 * Effective language = the viewer's own choice (localStorage "hitt.lang"),
 * else the app-wide default (Settings → Customizations, GET
 * /api/branding/language), else English.
 *
 * Static markup: add `data-i18n="key"` (text), `data-i18n-placeholder`,
 * `data-i18n-title`, or `data-i18n-aria-label`. They're swapped on load and
 * on every language change.
 *
 * Dynamic strings: `HITT_I18N.t("key", { name: "…" })`. Re-render on the
 * `hitt:langchange` window event.
 *
 * Loaded on every page right after js/i18n-dict.js. The language switcher in
 * the top bar is injected here — no per-page markup needed.
 * ---------------------------------------------------------------------------
 */
(function () {
  var DICT = window.HITT_I18N_DICT || { en: {} };
  var SUPPORTED = ["en", "es", "ca"];
  var LS_KEY = "hitt.lang";
  var DEFAULT_CACHE = "hitt.lang.default";

  function stored(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function put(key, val) {
    try { val == null ? localStorage.removeItem(key) : localStorage.setItem(key, val); } catch (e) {}
  }

  var userLang = SUPPORTED.indexOf(stored(LS_KEY)) > -1 ? stored(LS_KEY) : null;
  var defaultLang = SUPPORTED.indexOf(stored(DEFAULT_CACHE)) > -1 ? stored(DEFAULT_CACHE) : "en";
  var lang = userLang || defaultLang;

  function t(key, vars) {
    var s = (DICT[lang] && DICT[lang][key]) != null ? DICT[lang][key]
          : (DICT.en && DICT.en[key]) != null ? DICT.en[key]
          : key;
    if (vars) {
      s = s.replace(/\{(\w+)\}/g, function (m, k) { return k in vars ? vars[k] : m; });
    }
    return s;
  }

  var ATTR_MAP = {
    "data-i18n": "textContent",
    "data-i18n-placeholder": "placeholder",
    "data-i18n-title": "title",
    "data-i18n-aria-label": "aria-label",
  };

  function apply(root) {
    root = root || document;
    Object.keys(ATTR_MAP).forEach(function (dataAttr) {
      var target = ATTR_MAP[dataAttr];
      root.querySelectorAll("[" + dataAttr + "]").forEach(function (el) {
        var key = el.getAttribute(dataAttr);
        if (!key) return;
        var val = t(key);
        if (target === "textContent") el.textContent = val;
        else el.setAttribute(target, val);
      });
    });
    if (root === document) {
      document.documentElement.setAttribute("lang", lang);
      syncSwitcher();
    }
  }

  function setLang(next, opts) {
    if (SUPPORTED.indexOf(next) === -1) return;
    lang = next;
    if (!opts || opts.persist !== false) put(LS_KEY, next);
    userLang = next;
    apply(document);
    window.dispatchEvent(new CustomEvent("hitt:langchange", { detail: { lang: lang } }));
  }

  // Drop the viewer's override and follow the app default again.
  function clearUserLang() {
    put(LS_KEY, null);
    userLang = null;
    lang = defaultLang;
    apply(document);
    window.dispatchEvent(new CustomEvent("hitt:langchange", { detail: { lang: lang } }));
  }

  // Update the remembered app-wide default (called by Settings after a save).
  // If the viewer has no personal override, the UI follows it immediately.
  function setDefaultLang(next) {
    if (SUPPORTED.indexOf(next) === -1) return;
    defaultLang = next;
    put(DEFAULT_CACHE, next);
    if (!userLang) {
      lang = next;
      apply(document);
      window.dispatchEvent(new CustomEvent("hitt:langchange", { detail: { lang: lang } }));
    }
  }

  /* ---- language switcher in the top bar -------------------------------- */
  var STYLE = [
    ".lang-switcher{appearance:none;-webkit-appearance:none;border:1px solid var(--border-subtle);",
    "background:var(--bg-surface);color:var(--text-primary);border-radius:999px;",
    "padding:0.3rem 1.6rem 0.3rem 0.7rem;font-size:0.78rem;font-weight:600;cursor:pointer;",
    "background-image:url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23888' fill='none' stroke-width='1.5'/%3E%3C/svg%3E\");",
    "background-repeat:no-repeat;background-position:right 0.6rem center;}",
    ".lang-switcher:hover{border-color:var(--hitt-teal);}",
    ".login-lang-switcher{position:fixed;top:1rem;right:1rem;z-index:5;}",
  ].join("");

  function injectStyle() {
    if (document.getElementById("hitt-i18n-style")) return;
    var s = document.createElement("style");
    s.id = "hitt-i18n-style";
    s.textContent = STYLE;
    (document.head || document.documentElement).appendChild(s);
  }

  function buildSwitcher(extraClass) {
    var sel = document.createElement("select");
    sel.className = "lang-switcher" + (extraClass ? " " + extraClass : "");
    sel.setAttribute("aria-label", t("lang.switcher.aria"));
    SUPPORTED.forEach(function (code) {
      var o = document.createElement("option");
      o.value = code;
      o.textContent = t("lang." + code);
      sel.appendChild(o);
    });
    sel.value = lang;
    sel.addEventListener("change", function () { setLang(sel.value); });
    return sel;
  }

  function mountSwitcher() {
    if (document.querySelector(".lang-switcher")) return;
    injectStyle();
    var host = document.querySelector(".app-header__user");
    if (host) {
      var avatar = host.querySelector(".avatar");
      host.insertBefore(buildSwitcher(), avatar || host.firstChild);
      return;
    }
    // sign-in page — no app header
    if (document.querySelector(".login-card, .login-body")) {
      document.body.appendChild(buildSwitcher("login-lang-switcher"));
    }
  }

  function syncSwitcher() {
    document.querySelectorAll(".lang-switcher").forEach(function (sel) {
      sel.setAttribute("aria-label", t("lang.switcher.aria"));
      Array.prototype.forEach.call(sel.options, function (o) {
        o.textContent = t("lang." + o.value);
      });
      sel.value = lang;
    });
  }

  function whenReady(fn) {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", fn);
    else fn();
  }

  whenReady(function () {
    mountSwitcher();
    apply(document);
  });

  /* ---- pick up the app-wide default from the server ------------------- */
  var base = ((window.HITT_CONFIG && window.HITT_CONFIG.API_BASE_URL) || "").replace(/\/$/, "");
  fetch(base + "/api/branding/language")
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (data) {
      if (!data) return;
      var d = SUPPORTED.indexOf(data.language) > -1 ? data.language : "en";
      defaultLang = d;
      put(DEFAULT_CACHE, d);
      if (!userLang && d !== lang) {
        lang = d;
        whenReady(function () {
          apply(document);
          window.dispatchEvent(new CustomEvent("hitt:langchange", { detail: { lang: lang } }));
        });
      }
    })
    .catch(function () {});

  window.HITT_I18N = {
    t: t,
    apply: apply,
    setLang: setLang,
    clearUserLang: clearUserLang,
    setDefaultLang: setDefaultLang,
    get lang() { return lang; },
    get userLang() { return userLang; },
    get defaultLang() { return defaultLang; },
    supported: SUPPORTED.slice(),
    langName: function (code) { return t("lang." + code); },
  };
})();
