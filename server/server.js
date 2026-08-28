/**
 * HITT Ops API
 * ---------------------------------------------------------------------------
 * The only server-side piece of this project. Its job:
 *   1. Hold the PostgreSQL credentials (via .env — see .env.example) so
 *      they never reach the static frontend or any employee's machine.
 *   2. Expose a small REST surface the static pages call over HTTPS.
 *   3. (Later) validate Microsoft Entra ID tokens before trusting a caller.
 *
 * Run with:  npm install && npm start
 * ---------------------------------------------------------------------------
 */
require("dotenv").config();

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
const settingsRouter = loadRouter("settings");
const reportsRouter = loadRouter("reports");
const auditRouter = loadRouter("audit");
const expensesRouter = loadRouter("expenses");
const { attachHittUser } = require("./lib/permissions");

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
app.use(express.json());
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

// Resolves X-HITT-User into req.hittUser = { raw, employeeId, isAdmin } for
// every request that follows — see lib/permissions.js for the caveats.
app.use(attachHittUser);

app.use("/api/projects", projectsRouter);
app.use("/api/business-partners", businessPartnersRouter);
app.use("/api/time-tracking", timeTrackingRouter);
app.use("/api/time-off", timeOffRouter);
app.use("/api/invoicing", invoicingRouter);
app.use("/api/expenses", expensesRouter);
app.use("/api/employees", employeesRouter);
app.use("/api/permissions", permissionsRouter);
app.use("/api/settings", settingsRouter);
app.use("/api/reports", reportsRouter);
app.use("/api/audit", auditRouter);

// Fallback 404 for unknown API routes.
app.use("/api", (req, res) => {
  res.status(404).json({ error: "not_found" });
});

app.listen(PORT, () => {
  console.log(`HITT Ops API listening on port ${PORT}`);
});
