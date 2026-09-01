/**
 * HITT Ops API
 * ---------------------------------------------------------------------------
 * The only server-side piece of this project. Its job:
 *   1. Hold the PostgreSQL credentials (via .env — see .env.example) so
 *      they never reach the static frontend or any employee's machine.
 *   2. Expose a small REST surface the static pages call over HTTPS.
 *   3. Verify the Microsoft Entra ID access token every request carries
 *      before trusting the caller's identity (see lib/entraToken.js and
 *      AUTH_MODE in lib/permissions.js).
 *
 * Run with:  npm install && npm start
 * ---------------------------------------------------------------------------
 */
require("./lib/loadEnv");

const express = require("express");
const cors = require("cors");
const helmet = require("helmet");

// Load each router in isolation — a single route file failing to load
// (e.g. a missing optional dependency) shouldn't take the whole API down.
// A failed router is replaced with one that returns 503 for that path.
function loadRouter(name) {
  try {
    return require(`./routes/${name}`);
  } catch (err) {
    console.error(`[server] route "${name}" failed to load — it will return 503:\n  ${err.message}`);
    const stub = require("express").Router();
    stub.use((req, res) => res.status(503).json({ error: "route_unavailable", message: `The ${name} API is unavailable — check the server logs.` }));
    return stub;
  }
}

const projectsRouter = loadRouter("projects");
const businessPartnersRouter = loadRouter("businessPartners");
const timeTrackingRouter = loadRouter("timeTracking");
const timeOffRouter = loadRouter("timeOff");
const invoicingRouter = loadRouter("invoicing");
const employeesRouter = loadRouter("employees");
const permissionsRouter = loadRouter("permissions");
const meRouter = loadRouter("me");
const settingsRouter = loadRouter("settings");
const brandingRouter = loadRouter("branding");
const entitiesRouter = loadRouter("entities");
const reportsRouter = loadRouter("reports");
const auditRouter = loadRouter("audit");
const expensesRouter = loadRouter("expenses");
const chatRouter = loadRouter("chat");
const { attachHittUser, requireAuth, AUTH_MODE } = require("./lib/permissions");
const { entraConfigured } = require("./lib/entraToken");
const { oidcConfigured, OIDC_ISSUER } = require("./lib/oidcToken");

const app = express();
const PORT = process.env.PORT || 4000;

// nginx on the VPS proxies to this app — trust its X-Forwarded-For so
// req.ip (and the audit log's client IP) reflect the real caller.
app.set("trust proxy", true);

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS || "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(helmet());
// 2 MB ceiling — most bodies are tiny, but Settings → Customizations posts
// the company logo as a base64 data URL (see routes/branding.js).
app.use(express.json({ limit: "2mb" }));
app.use(
  cors({
    origin(origin, callback) {
      // Requests from a locally-opened file:// page arrive with no Origin
      // header at all in some browsers, or "null" in others.
      if (!origin || allowedOrigins.includes(origin) || allowedOrigins.includes("null")) {
        return callback(null, true);
      }
      callback(new Error(`Origin not allowed by CORS: ${origin}`));
    },
  })
);

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Establishes req.hittUser (verified Bearer token, or X-HITT-User in the
// legacy dev modes) for every request that follows — see lib/permissions.js.
app.use(attachHittUser);

// Public, pre-auth endpoints — mounted BEFORE requireAuth. The sign-in page
// (index.html) shows the company logo before anyone has a token; branding's
// own PUT/DELETE are still admin-gated inside the router.
app.use("/api/branding", brandingRouter);

// Rejects a bad/expired token, and — in bearer mode — any unauthenticated
// request, before it reaches a route below. /api/health (above
// attachHittUser) and /api/branding (above this line) stay open.
app.use("/api", requireAuth);

app.use("/api/projects", projectsRouter);
app.use("/api/business-partners", businessPartnersRouter);
app.use("/api/time-tracking", timeTrackingRouter);
app.use("/api/time-off", timeOffRouter);
app.use("/api/invoicing", invoicingRouter);
app.use("/api/expenses", expensesRouter);
app.use("/api/employees", employeesRouter);
app.use("/api/permissions", permissionsRouter);
app.use("/api/me", meRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/entities", entitiesRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/audit", auditRouter);
app.use("/api/chat", chatRouter);

// Fallback 404 for unknown API routes.
app.use("/api", (req, res) => {
  res.status(404).json({ error: "not_found" });
});

app.listen(PORT, () => {
  console.log(`Ops API listening on port ${PORT}`);
  const providers = [
    entraConfigured() && "Entra",
    oidcConfigured() && `OIDC(${OIDC_ISSUER})`,
  ].filter(Boolean);
  console.log(`[auth] AUTH_MODE=${AUTH_MODE}  token validation: ${providers.length ? providers.join(" + ") : "NONE configured"}`);
  if (AUTH_MODE === "bearer" && !providers.length) {
    console.error("[auth] AUTH_MODE=bearer but no token provider is configured — every request will 401. Set AAD_* or OIDC_* env vars, or AUTH_MODE=header.");
  }
  if (AUTH_MODE === "header") {
    console.warn("[auth] AUTH_MODE=header — the API trusts the client-supplied X-HITT-User header. Use only for local/offline development.");
  }
});
