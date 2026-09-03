/**
 * Veri*Factu — entry point
 * ---------------------------------------------------------------------------
 * Feature gate + provider selection + the per-entity config an Ops route
 * needs to talk to the SIF. Route wiring (the "Issue invoice" action,
 * cancel/rectify, the status poll, the Settings tab) lands in phases V2–V5.
 *
 * Config (server/.env — see .env.example):
 *   FEATURE_VERIFACTU      "true" to enable anything in this module
 *   VERIFACTU_PROVIDER     "bold" (default; the only adapter today)
 *   VERIFACTU_ENV          "sandbox" | "production" — fallback when an
 *                          entity has no verifactu_environment of its own
 *   VERIFACTU_BASE_URL     override the provider base URL (testing)
 *
 * Per entity (DB, Settings → Entities → Veri*Factu, phase V5):
 *   entity.verifactu_enabled       this entity issues Veri*Factu invoices
 *   entity.verifactu_api_key       server-only secret — never leaves the API
 *   entity.verifactu_environment   "sandbox" | "production"
 *   entity.vatnumber               the issuer NIF (also the Verify-Issuer-Id guard)
 * ---------------------------------------------------------------------------
 */
const bold = require("./bold");
const mapping = require("./mapping");
const errors = require("./errors");

const PROVIDERS = { bold };

/** Master switch. Everything else in this module no-ops when this is false. */
function featureEnabled() {
  return String(process.env.FEATURE_VERIFACTU || "").trim().toLowerCase() === "true";
}

function providerName() {
  return (process.env.VERIFACTU_PROVIDER || "bold").trim().toLowerCase();
}

function getProvider(name = providerName()) {
  const p = PROVIDERS[name];
  if (!p) throw new errors.VerifactuError({ category: "auth", message: `unknown Veri*Factu provider "${name}"` });
  return p;
}

/**
 * Resolve everything a route needs to register/cancel invoices for one
 * billing entity. `entity` is a row from the `entity` table.
 *
 * @returns {{
 *   provider: object, providerName: string,
 *   apiKey: string|null, issuerNif: string|null, environment: string,
 *   enabled: boolean, reason: string|null
 * }}  `enabled` is true only when the feature flag is on AND the entity is
 *     switched on AND it has an API key AND it has a NIF. `reason` explains a
 *     false.
 */
function configForEntity(entity) {
  const e = entity || {};
  const environment = (e.verifactu_environment || process.env.VERIFACTU_ENV || "sandbox").trim().toLowerCase();
  const apiKey = e.verifactu_api_key || null;
  const issuerNif = mapping.normalizeFiscalId(e.vatnumber);

  let reason = null;
  if (!featureEnabled()) reason = "FEATURE_VERIFACTU is off";
  else if (!e.verifactu_enabled) reason = "entity has Veri*Factu disabled";
  else if (!apiKey) reason = "entity has no Veri*Factu API key";
  else if (!issuerNif) reason = "entity has no VAT number (issuer NIF)";

  return {
    provider: getProvider(),
    providerName: providerName(),
    apiKey,
    issuerNif,
    environment,
    enabled: reason === null,
    reason,
  };
}

/** Convenience: `{ apiKey, issuerNif }` for passing straight to a provider call. */
function credsForEntity(entity) {
  const cfg = configForEntity(entity);
  return { apiKey: cfg.apiKey, issuerNif: cfg.issuerNif };
}

module.exports = {
  featureEnabled,
  providerName,
  getProvider,
  configForEntity,
  credsForEntity,
  buildAltaPayload: mapping.buildAltaPayload,
  normalizeFiscalId: mapping.normalizeFiscalId,
  VerifactuError: errors.VerifactuError,
  MappingError: mapping.MappingError,
};
