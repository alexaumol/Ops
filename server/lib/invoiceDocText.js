/**
 * Multi-language invoice document text (labels + email templates).
 * ---------------------------------------------------------------------------
 * Ported from the Access app's two tables:
 *
 *   invoicedocumentcontrols  id, controlname            — the field keys
 *                                                          ("lblInvoiceCode",
 *                                                          "strSubject", ...)
 *   invoicedocumenttext      id, controlnameid (FK),     — one translated
 *                            languageid (FK), languagetext  string per
 *                                                          (control, language)
 *
 *   languages                id, languagedesc            (1 English, 2 Spanish,
 *                                                          3 Catalan)
 *
 * The business partner drives the language: businesspartners.languageid.
 * Some `languagetext` values are wrapped in Access rich-text markup
 * ("<div>INVOICE NUMBER</div>", "<font color=...>") and the email templates
 * carry {InvoiceCode} / {Entity} placeholders HTML-entity-encoded
 * ("&#123;InvoiceCode&#125;") — decodeText() below normalises both.
 *
 * The whole table is tiny and static, so it's loaded once and cached for a
 * few minutes. A DB error serves the stale cache if there is one, else an
 * empty map — callers always pass a hardcoded English fallback to get().
 * ---------------------------------------------------------------------------
 */
const { pool } = require("../config/db");

const DEFAULT_LANGUAGE_ID = 1; // English
const TTL_MS = 10 * 60 * 1000;

function decodeText(s) {
  if (s == null) return null;
  const out = String(s)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(div|p)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&#123;/g, "{")
    .replace(/&#125;/g, "}")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/[ \t]+/g, " ")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
  return out || null;
}

let cache = null; // { at, byLang: Map<number, Map<string,string>> }

async function loadAll() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.byLang;
  const byLang = new Map();
  try {
    const { rows } = await pool.query(
      `SELECT c.controlname, t.languageid::int AS languageid, t.languagetext
         FROM invoicedocumenttext t
         JOIN invoicedocumentcontrols c ON c.id = t.controlnameid::bigint
        WHERE t.languagetext IS NOT NULL`
    );
    for (const r of rows) {
      const txt = decodeText(r.languagetext);
      if (!txt) continue;
      if (!byLang.has(r.languageid)) byLang.set(r.languageid, new Map());
      byLang.get(r.languageid).set(r.controlname, txt);
    }
    cache = { at: Date.now(), byLang };
    return byLang;
  } catch (err) {
    console.error("[invoiceDocText] load failed:", err.message);
    return cache ? cache.byLang : byLang;
  }
}

// Resolves a labels helper for one language. get(controlname, fallback)
// returns the language's text, then English, then the caller's fallback.
async function invoiceLabels(languageId) {
  const byLang = await loadAll();
  const id = Number(languageId) || DEFAULT_LANGUAGE_ID;
  const want = byLang.get(id) || new Map();
  const en = byLang.get(DEFAULT_LANGUAGE_ID) || new Map();
  return {
    languageId: id,
    get(controlname, fallback) {
      return want.get(controlname) || en.get(controlname) || fallback;
    },
  };
}

// {InvoiceCode} / {Entity} substitution for the email subject/body templates.
function fillTemplate(str, tokens = {}) {
  return String(str || "").replace(/\{(\w+)\}/g, (m, k) => (k in tokens && tokens[k] != null ? String(tokens[k]) : m));
}

module.exports = { invoiceLabels, decodeText, fillTemplate, DEFAULT_LANGUAGE_ID };
