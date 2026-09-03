/**
 * Veri*Factu provider adapter — BOLD Software
 * ---------------------------------------------------------------------------
 * Thin HTTP client for https://vf1.boldsoftware.es/v1. One function per
 * endpoint; every failure (HTTP 400/404/503, non-JSON, network) is thrown as
 * a VerifactuError (see ./errors.js). No retry logic here — the caller
 * decides, using `err.retryable`.
 *
 * Auth: `API-Key` header + the optional `Verify-Issuer-Id` guard (the
 * issuing entity's NIF), which we always send so a mis-configured key fails
 * loudly (code 000007) instead of registering an invoice under the wrong
 * company.
 *
 * Contract: docs/verifactu-boldsoftware-openapi.yaml (OpenAPI 3.1, v1.2.0).
 * ---------------------------------------------------------------------------
 */
const { fromResponse, networkError, VerifactuError } = require("./errors");

const DEFAULT_BASE_URL = "https://vf1.boldsoftware.es/v1";
const DEFAULT_TIMEOUT_MS = 20000;

function baseUrl() {
  return (process.env.VERIFACTU_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/**
 * @param {string} path            e.g. "/invoice"
 * @param {object} opts
 * @param {string} opts.apiKey
 * @param {string} [opts.issuerNif]
 * @param {object|string} [opts.body]   object → JSON; string → sent as-is (cancel takes a bare number)
 * @param {number} [opts.timeoutMs]
 */
async function call(path, { apiKey, issuerNif, body, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  if (!apiKey) {
    throw new VerifactuError({ category: "auth", message: "no Veri*Factu API key configured for this entity" });
  }

  const headers = { "API-Key": apiKey, "Content-Type": "application/json" };
  if (issuerNif) headers["Verify-Issuer-Id"] = issuerNif;

  const payload = body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body);

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let resp;
  try {
    resp = await fetch(baseUrl() + path, { method: "POST", headers, body: payload, signal: ac.signal });
  } catch (err) {
    throw networkError(err.name === "AbortError" ? new Error(`request timed out after ${timeoutMs}ms`) : err);
  } finally {
    clearTimeout(timer);
  }

  const text = await resp.text().catch(() => "");
  let json = null;
  if (text) {
    try { json = JSON.parse(text); } catch { /* left null — handled below */ }
  }

  if (resp.ok) {
    if (json === null) {
      throw new VerifactuError({ category: "unknown", message: "Veri*Factu API returned a non-JSON success body", httpStatus: resp.status });
    }
    return json;
  }

  if (resp.status === 404) {
    throw new VerifactuError({
      category: "auth",
      message: `Veri*Factu API route not found (404): POST ${path} — check VERIFACTU_BASE_URL`,
      httpStatus: 404,
    });
  }
  if (json === null) {
    throw new VerifactuError({
      category: resp.status === 503 ? "unavailable" : "unknown",
      message: `Veri*Factu API returned HTTP ${resp.status} with a non-JSON body`,
      retryable: resp.status === 503,
      httpStatus: resp.status,
    });
  }
  throw fromResponse(resp.status, json);
}

/**
 * Register an invoice (alta). `payload` is the `{ invoice: {...} }` object
 * from mapping.buildAltaPayload. Pass `isFix: true` to resend under a number
 * that already exists locally (recovers a rejected registration).
 * @returns {Promise<object>} DatosVerifactu — { qrcode, verifactuUrl, chainInfo, verifactuXml, queueId, requestId }
 */
function register(payload, { apiKey, issuerNif, isFix = false } = {}) {
  const body = isFix
    ? { invoice: { ...payload.invoice, isFix: true } }
    : payload;
  return call("/invoice", { apiKey, issuerNif, body });
}

/**
 * Cancel (anular) a previously registered invoice by its queueId.
 * The body is the bare queueId as JSON text — no object, no leading zeros.
 * @returns {Promise<object>} DatosVerifactu without `qrcode` / `verifactuUrl`
 */
function cancel(queueId, { apiKey, issuerNif } = {}) {
  const n = Number(queueId);
  if (!Number.isInteger(n) || n < 1) {
    throw new VerifactuError({ category: "validation", message: `invalid queueId for cancel: ${JSON.stringify(queueId)}` });
  }
  return call("/invoice_cancel", { apiKey, issuerNif, body: String(n) });
}

/**
 * AEAT processing state for a queueId: { state: "pending"|"sent"|"error", ... }.
 * `error_code` / `error_text` / `aeat_registered` are only present for
 * accounts BOLD has enabled them for.
 */
function state(queueId, { apiKey, issuerNif } = {}) {
  const n = Number(queueId);
  if (!Number.isInteger(n) || n < 1) {
    throw new VerifactuError({ category: "validation", message: `invalid queueId for state: ${JSON.stringify(queueId)}` });
  }
  return call(`/invoice_state/${n}`, { apiKey, issuerNif });
}

/**
 * Re-fetch the original DatosVerifactu (QR, XML, hash, URL) for a queueId —
 * recovery if the create/cancel response was not persisted.
 */
function data(queueId, { apiKey, issuerNif } = {}) {
  const n = Number(queueId);
  if (!Number.isInteger(n) || n < 1) {
    throw new VerifactuError({ category: "validation", message: `invalid queueId for data: ${JSON.stringify(queueId)}` });
  }
  return call(`/invoice_data/${n}`, { apiKey, issuerNif });
}

/**
 * Contrast a Spanish NIF/NIE/CIF + name against the AEAT census.
 * Resolves `{ message: "Valid", requestId }` or throws a VerifactuError
 * (category "recipient" when the pair doesn't match).
 */
function idCheck({ irsId, name }, { apiKey } = {}) {
  return call("/id_check", { apiKey, body: { irsId, name } });
}

module.exports = { register, cancel, state, data, idCheck, baseUrl };
