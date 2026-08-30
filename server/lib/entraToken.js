/**
 * Microsoft Entra ID — bearer token verification
 * ---------------------------------------------------------------------------
 * Validates the access token the frontend (js/auth.js) sends as
 *   Authorization: Bearer <jwt>
 * on every API call, so the server stops trusting the client-supplied
 * X-HITT-User header (which anyone who can reach the API could forge).
 *
 * What "valid" means here:
 *   - RS256 signature, checked against the tenant's published signing keys
 *     (JWKS at the v2.0 discovery endpoint — fetched once, cached, and
 *     rotated automatically by jose's createRemoteJWKSet).
 *   - issuer is this tenant's STS (v1.0 sts.windows.net OR v2.0
 *     login.microsoftonline.com/<tid>/v2.0 — both accepted so the app
 *     registration's accessTokenAcceptedVersion doesn't have to be 2).
 *   - audience is one of AAD_ALLOWED_AUDIENCES (default: api://<client id>,
 *     i.e. a token minted for THIS API via its exposed scope — not a bare
 *     ID token, unless you opt into that by adding the client id below).
 *   - not expired / not before (60s clock skew allowed).
 *   - tenant (tid) matches AAD_TENANT_ID.
 *   - for an api:// audience, the delegated scope (scp) includes
 *     AAD_REQUIRED_SCOPE (default "access_as_user"). Set that env var empty
 *     to disable the scope check.
 *
 * Config (server/.env — see .env.example):
 *   AAD_TENANT_ID          required
 *   AAD_CLIENT_ID          required
 *   AAD_ALLOWED_AUDIENCES  optional, comma-separated. Default api://<client id>
 *   AAD_REQUIRED_SCOPE     optional. Default "access_as_user"
 *
 * If AAD_TENANT_ID / AAD_CLIENT_ID are missing, entraConfigured() returns
 * false and the caller (lib/permissions.js) falls back to header auth —
 * see AUTH_MODE there.
 * ---------------------------------------------------------------------------
 */
const { createRemoteJWKSet, jwtVerify } = require("jose");

const TENANT_ID = process.env.AAD_TENANT_ID || "";
const CLIENT_ID = process.env.AAD_CLIENT_ID || "";

const ALLOWED_AUDIENCES = (process.env.AAD_ALLOWED_AUDIENCES || `api://${CLIENT_ID}`)
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Empty string disables the scope check entirely.
const REQUIRED_SCOPE = process.env.AAD_REQUIRED_SCOPE === undefined ? "access_as_user" : process.env.AAD_REQUIRED_SCOPE;

const ISSUERS = [
  `https://login.microsoftonline.com/${TENANT_ID}/v2.0`,
  `https://sts.windows.net/${TENANT_ID}/`,
];

const JWKS_URI = `https://login.microsoftonline.com/${TENANT_ID}/discovery/v2.0/keys`;

let jwks = null;
function getJwks() {
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(JWKS_URI), {
      cacheMaxAge: 24 * 60 * 60 * 1000, // refresh signing keys at most daily
      cooldownDuration: 30 * 1000,      // ...but re-fetch on an unknown kid, min 30s apart
      timeoutDuration: 5 * 1000,
    });
  }
  return jwks;
}

function entraConfigured() {
  return !!(TENANT_ID && CLIENT_ID);
}

/**
 * Verifies a raw JWT string. Resolves to the token's claims payload, or
 * rejects with an Error whose message explains why it was refused.
 */
async function verifyEntraToken(token) {
  if (!entraConfigured()) {
    throw new Error("Entra token validation is not configured (AAD_TENANT_ID / AAD_CLIENT_ID missing)");
  }

  const { payload } = await jwtVerify(token, getJwks(), {
    issuer: ISSUERS,
    audience: ALLOWED_AUDIENCES,
    algorithms: ["RS256"],
    clockTolerance: 60,
  });

  if (payload.tid && payload.tid !== TENANT_ID) {
    throw new Error(`token tenant ${payload.tid} does not match expected tenant`);
  }

  const audIsApi = [].concat(payload.aud || []).some((a) => String(a).startsWith("api://"));
  if (audIsApi && REQUIRED_SCOPE) {
    const scopes = String(payload.scp || "").split(/\s+/).filter(Boolean);
    if (!scopes.includes(REQUIRED_SCOPE)) {
      throw new Error(`token is missing the required "${REQUIRED_SCOPE}" scope`);
    }
  }

  return payload;
}

/**
 * The identity string to resolve against the employees table — the UPN /
 * email, under whichever claim this token version carries it.
 */
function identityFromClaims(claims) {
  return (
    claims.preferred_username ||
    claims.upn ||
    claims.unique_name ||
    claims.email ||
    null
  );
}

module.exports = { entraConfigured, verifyEntraToken, identityFromClaims, ALLOWED_AUDIENCES, REQUIRED_SCOPE };
