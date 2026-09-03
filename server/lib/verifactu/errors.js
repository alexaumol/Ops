/**
 * Veri*Factu — error model
 * ---------------------------------------------------------------------------
 * BOLD returns HTTP 400 for almost everything (auth failures and business
 * validation alike), HTTP 503 for maintenance / DB trouble, and a bare
 * `{ error: "invalid_json" }` for a malformed cancel body. This module turns
 * any of those — plus a network failure — into a single typed error so
 * callers can branch on `category` / `retryable` instead of parsing codes.
 *
 * Categories:
 *   auth        bad/missing API-Key, IP not allowed, issuer NIF mismatch,
 *               unknown route. Configuration problem — not retryable.
 *   license     company licence expired (953443) or POA not yet received
 *               (953444). Needs a human at BOLD — not retryable.
 *   duplicate   a record with the same NIF+number+year already exists
 *               (B113047). The caller should resend the alta with
 *               `isFix: true`. Not retryable as-is.
 *   validation  the invoice payload broke a schema or business rule
 *               (1GQ3QH, 561xxx, 777xxx, 405530, …). The data must be fixed.
 *   recipient   the recipient could not be identified by the AEAT (397430)
 *               or its fiscal id is invalid (561123). Fix the tax company.
 *   unavailable HTTP 503, or a network error reaching the API. Retryable —
 *               issuing must NOT be blocked; the record is queued and re-sent.
 *   unknown     anything not recognised (3017-B, 5AXUFV, non-JSON body, …).
 *
 * See docs/verifactu-boldsoftware-openapi.yaml for the full code catalogue.
 * ---------------------------------------------------------------------------
 */

class VerifactuError extends Error {
  constructor({ category, code = null, message, retryable = false, requestId = null, httpStatus = null, raw = null }) {
    super(message || `Veri*Factu error (${category})`);
    this.name = "VerifactuError";
    this.category = category;
    this.code = code;
    this.retryable = retryable;
    this.requestId = requestId;
    this.httpStatus = httpStatus;
    this.raw = raw;
  }
}

// Business codes → category. Anything not listed falls through to "unknown"
// (or "validation" for the schema-violation sentinel 1GQ3QH).
const AUTH_CODES = new Set([
  "000001", "000002", "000003", "000005", "000007", "000008",
  "000012", "000013", "5AXUFV",
]);
const LICENSE_CODES = new Set(["953443", "953444"]);
const RECIPIENT_CODES = new Set(["397430", "561123", "561126"]);
const DUPLICATE_CODES = new Set(["B113047"]);
const UNAVAILABLE_CODES = new Set(["000006", "3015", "3016"]);

function categorise(code) {
  const c = code == null ? "" : String(code);
  if (UNAVAILABLE_CODES.has(c)) return "unavailable";
  if (LICENSE_CODES.has(c)) return "license";
  if (DUPLICATE_CODES.has(c)) return "duplicate";
  if (RECIPIENT_CODES.has(c)) return "recipient";
  if (AUTH_CODES.has(c)) return "auth";
  if (c === "1GQ3QH" || c === "3000" || /^561\d{3}$/.test(c) || /^777\d{3}/.test(c) ||
      ["405530", "031916", "519126", "169439", "561118", "561114"].includes(c)) {
    return "validation";
  }
  return "unknown";
}

const RETRYABLE = new Set(["unavailable"]);

/**
 * Build a VerifactuError from a parsed HTTP response.
 * @param {number} httpStatus
 * @param {object|null} body  parsed JSON body, or null if it wasn't JSON
 * @param {string} [forceCategory]  override (used for a hard 503)
 */
function fromResponse(httpStatus, body, forceCategory) {
  // Malformed-JSON cancel body: { error: "invalid_json", message: "..." }
  if (body && body.error === "invalid_json") {
    return new VerifactuError({
      category: "validation",
      message: body.message || "the request body was not valid JSON",
      httpStatus,
      raw: body,
    });
  }

  const code = body && body.code != null ? String(body.code) : null;
  const message = (body && body.message) || `Veri*Factu API returned HTTP ${httpStatus}`;
  const requestId = (body && body.requestId) || null;
  const category = forceCategory || (httpStatus === 503 ? "unavailable" : categorise(code));

  return new VerifactuError({
    category,
    code,
    message,
    retryable: RETRYABLE.has(category),
    requestId,
    httpStatus,
    raw: body,
  });
}

function networkError(err) {
  return new VerifactuError({
    category: "unavailable",
    message: `could not reach the Veri*Factu API: ${err && err.message ? err.message : err}`,
    retryable: true,
  });
}

module.exports = { VerifactuError, fromResponse, networkError, categorise };
