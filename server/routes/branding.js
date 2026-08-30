/**
 * /api/branding — company logo customization (Settings → Customizations).
 * ---------------------------------------------------------------------------
 * The uploaded logo is stored as a base64 data URL in the shared `appconfig`
 * table (key "branding.logo") — same table the Settings "Paths" tab uses.
 * Keeping it in the DB (rather than a file under public/) means it survives
 * a `git pull` deploy and needs no writable uploads directory.
 *
 * GET /logo is deliberately PUBLIC — the sign-in page (index.html, pre-auth)
 * shows the logo too. PUT/DELETE require an admin.
 * ---------------------------------------------------------------------------
 */
const express = require("express");
const { pool } = require("../config/db");
const { requireAdmin } = require("../lib/permissions");
const { logAudit } = require("../lib/audit");

const router = express.Router();

const KEY = "branding.logo";
// Generous ceiling for the base64 string. The client crops/resizes to a
// small square before upload, so real payloads are tens of KB.
const MAX_CHARS = 3 * 1024 * 1024;
const DATA_URL_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=\s]+$/;

let schemaReady = null;
function ensureConfigTable() {
  if (!schemaReady) {
    schemaReady = pool
      .query(`
        CREATE TABLE IF NOT EXISTS public.appconfig (
          configkey   varchar(64) PRIMARY KEY,
          configvalue text,
          updatedat   timestamp without time zone,
          updatedby   bigint
        )
      `)
      .catch((err) => {
        schemaReady = null;
        throw err;
      });
  }
  return schemaReady;
}

// GET /api/branding/logo — { dataUrl: string | null }. Public.
router.get("/logo", async (req, res) => {
  try {
    await ensureConfigTable();
    const { rows } = await pool.query(`SELECT configvalue FROM appconfig WHERE configkey = $1`, [KEY]);
    res.set("Cache-Control", "no-cache");
    res.json({ dataUrl: rows[0]?.configvalue || null });
  } catch (err) {
    console.error("[GET /api/branding/logo] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// PUT /api/branding/logo   { dataUrl }
router.put("/logo", requireAdmin, async (req, res) => {
  const dataUrl = typeof req.body?.dataUrl === "string" ? req.body.dataUrl.trim() : "";
  if (!DATA_URL_RE.test(dataUrl)) {
    return res.status(400).json({ error: "bad_request", message: "A PNG, JPEG or WebP image is required." });
  }
  if (dataUrl.length > MAX_CHARS) {
    return res.status(413).json({ error: "too_large", message: "That image is too large — crop it or pick a smaller file." });
  }
  try {
    await ensureConfigTable();
    await pool.query(
      `INSERT INTO appconfig (configkey, configvalue, updatedat, updatedby)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (configkey)
       DO UPDATE SET configvalue = EXCLUDED.configvalue, updatedat = now(), updatedby = EXCLUDED.updatedby`,
      [KEY, dataUrl, req.hittUser.employeeId || null]
    );
    res.json({ ok: true });
    logAudit(req, { kind: "settings.branding", desc: "Updated the company logo" });
  } catch (err) {
    console.error("[PUT /api/branding/logo] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

// DELETE /api/branding/logo — revert to the bundled Fundació HiTT mark.
router.delete("/logo", requireAdmin, async (req, res) => {
  try {
    await ensureConfigTable();
    await pool.query(`DELETE FROM appconfig WHERE configkey = $1`, [KEY]);
    res.status(204).end();
    logAudit(req, { kind: "settings.branding", desc: "Reset the company logo to the default" });
  } catch (err) {
    console.error("[DELETE /api/branding/logo] DB error:", err.message);
    res.status(502).json({ error: "database_unreachable", message: err.message });
  }
});

module.exports = router;
