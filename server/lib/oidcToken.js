/**
 * Generic OIDC bearer-token verification
 * ---------------------------------------------------------------------------
 * The provider-agnostic counterpart to lib/entraToken.js. When OIDC_ISSUER
 * and OIDC_AUDIENCE are set, the API also accepts access tokens minted by
 * that issuer — the shared identity broker (Zitadel at auth.theaumol.com)
 * for the SaaS fleet, or a customer's own IdP for a self-hosted instance.
 *
 * Both verifiers run side by side (see lib/permissions.js): a request's
 * token is routed to whichever one its `iss` claim matches, so an Entra
 * rollout and an OIDC cutover can overlap without a flag day.
 *
 * What "valid" means here:
 *   - RS256 signature against the issuer's published JWKS. The jwks_uri is
 *     read from {OIDC_ISSUER}/.well-known/openid-configuration (fetched
 *     once, cached; keys rotated automatically by jose).
 *   - iss === OIDC_ISSUER exactly.
 *   - the token is for THIS client: its `aud` contains, or its
 *     `azp` / `client_id` equals, one of OIDC_AUDIENCE. (Zitadel puts the
 *     project id in `aud` and the client id in `azp`, so both are checked.)
 *   - not expired / not before (60s skew).
 *
 * Config (server/.env — see .env.example):
 *   OIDC_ISSUER     required, e.g. https://auth.theaumol.com  (no trailing /)
 *   OIDC_AUDIENCE   required, comma-separated. The app's client id, plus
 *                   optionally its Zitadel project id.
 * ---------------------------------------------------------------------------
 */
const { createRemoteJWKSet, jwtVerify, decodeJwt } = require("jose");

const ISSUER = (process.env.OIDC_ISSUER || "").replace(/\/+$/, "");
const AUDIENCES = (process.env.OIDC_AUDIENCE || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

function oidcConfigured() {
  return !!(ISSUER && AUDIENCES.length);
}

// Discover the jwks_uri once from the issuer's OIDC metadata, then hand back
// a cached remote JWKS. On failure the promise is cleared so a later request
// retries rather than the API being permanently wedged.
let jwksPromise = null;
function getJwks() {
  if (!jwksPromise) {
    jwksPromise = fetch(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) })
      .then((r) => {
        if (!r.ok) throw new Error(`OIDC discovery failed: HTTP ${r.status}`);
        return r.json();
      })
      .then((doc) => {
        if (!doc.jwks_uri) throw new Error("OIDC discovery document has no jwks_uri");
        return createRemoteJWKSet(new URL(doc.jwks_uri), {
          cacheMaxAge: 24 * 60 * 60 * 1000,
          cooldownDuration: 30 * 1000,
          timeoutDuration: 5 * 1000,
        });
      })
      .catch((err) => {
        jwksPromise = null;
        throw err;
      });
  }
  return jwksPromise;
}

/**
 * Verifies a raw JWT string. Resolves to the claims payload, or rejects with
 * an Error whose message explains the refusal.
 */
async function verifyOidcToken(token) {
  if (!oidcConfigured()) {
    throw new Error("OIDC token validation is not configured (OIDC_ISSUER / OIDC_AUDIENCE missing)");
  }

  const jwks = await getJwks();
  const { payload } = await jwtVerify(token, jwks, {
    issuer: ISSUER,
    algorithms: ["RS256"],
    clockTolerance: 60,
  });

  // Audience / authorized-party check — lenient across providers.
  const auds = [].concat(payload.aud || []).map(String);
  const azp = String(payload.azp || payload.client_id || "");
  const accepted = AUDIENCES.some((a) => auds.includes(a) || a === azp);
  if (!accepted) {
    throw new Error(`token is not for this client (aud=${auds.join(",") || "-"} azp=${azp || "-"})`);
  }

  return payload;
}

/**
 * The identity string to resolve against the employees table. Prefer a
 * verified email; fall back to preferred_username, then the subject id.
 */
function identityFromOidcClaims(claims) {
  if (claims.email && (claims.email_verified === undefined || claims.email_verified)) {
    return String(claims.email);
  }
  return claims.email ? String(claims.email) : claims.preferred_username || claims.sub || null;
}

/**
 * Cheap unverified peek at a token's `iss` so the caller can route it to the
 * right verifier without trying both. Returns false for anything that isn't
 * a JWT from our configured issuer.
 */
function looksLikeOidc(token) {
  if (!ISSUER) return false;
  try {
    return decodeJwt(token).iss === ISSUER;
  } catch {
    return false;
  }
}

module.exports = { oidcConfigured, verifyOidcToken, identityFromOidcClaims, looksLikeOidc, OIDC_ISSUER: ISSUER };
