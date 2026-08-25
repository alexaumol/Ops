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

const projectsRouter = require("./routes/projects");
const businessPartnersRouter = require("./routes/businessPartners");
const timeTrackingRouter = require("./routes/timeTracking");
const timeOffRouter = require("./routes/timeOff");
const invoicingRouter = require("./routes/invoicing");
const employeesRouter = require("./routes/employees");

const app = express();
const PORT = process.env.PORT || 4000;

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

app.use("/api/projects", projectsRouter);
app.use("/api/business-partners", businessPartnersRouter);
app.use("/api/time-tracking", timeTrackingRouter);
app.use("/api/time-off", timeOffRouter);
app.use("/api/invoicing", invoicingRouter);
app.use("/api/employees", employeesRouter);

// Fallback 404 for unknown API routes.
app.use("/api", (req, res) => {
  res.status(404).json({ error: "not_found" });
});

app.listen(PORT, () => {
  console.log(`HITT Ops API listening on port ${PORT}`);
});
