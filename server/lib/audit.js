/**
 * Audit log
 * ---------------------------------------------------------------------------
 * Every security- and data-relevant action in the app is appended to
 * public.actionsaudit — the same table the old Access app used. Its
 * pre-existing columns:
 *
 *   actionuserid      bigint   — the acting employee
 *   actiondesc        text     — human-readable description of what happened
 *   actionts          timestamp
 *   actioncomputer    varchar  — client device (see the "computer name" note
 *                                below)
 *   actionenvironment varchar  — client user-agent (truncated to 255)
 *   loglevel          bigint   — 1 = normal activity, 2 = auth event
 *
 * Topped up at runtime (ALTER TABLE ... ADD COLUMN IF NOT EXISTS — mirrored
 * in server/db/schema-changes.sql) with:
 *
 *   actionusername    varchar  — the raw X-HITT-User value, so an entry is
 *                                still attributable when the identity didn't
 *                                resolve to an employees row
 *   actionkind        varchar  — a stable machine code ("project.create",
 *                                "bp.update", "login", …) for the UI's
 *                                category chip and future filtering
 *   actionip          varchar  — client IP (real caller, via trust proxy)
 *
 * logAudit() is best-effort: it never throws back to the caller, so an
 * audit-write failure can't break the action being audited.
 *
 * "Computer name" note: a browser can NOT hand a web page the client's
 * NetBIOS / OS hostname — there's no API for it. actioncomputer is filled
 * best-effort, in order of preference:
 *   1. a reverse-DNS (PTR) lookup of the client IP — on a network that
 *      registers client machines in DNS (common on a corporate LAN / VPN)
 *      this yields the real machine name; the first label is stored,
 *      upper-cased, NetBIOS-style.
 *   2. failing that, the browser platform string the frontend sends in the
 *      X-HITT-Client header ("Windows", "macOS", …).
 * ---------------------------------------------------------------------------
 */
const dns = require("dns").promises;
const { pool } = require("../config/db");

let ready = null;
function ensureAuditSchema() {
  if (!ready) {
    ready = (async () => {
      await pool.query(`ALTER TABLE public.actionsaudit ADD COLUMN IF NOT EXISTS actionusername varchar(255)`);
      await pool.query(`ALTER TABLE public.actionsaudit ADD COLUMN IF NOT EXISTS actionkind varchar(64)`);
      await pool.query(`ALTER TABLE public.actionsaudit ADD COLUMN IF NOT EXISTS actionip varchar(64)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS actionsaudit_actionts_idx ON public.actionsaudit (actionts DESC)`);
      await pool.query(`CREATE INDEX IF NOT EXISTS actionsaudit_actionuserid_idx ON public.actionsaudit (actionuserid)`);
    })().catch((err) => {
      ready = null; // let a later call retry
      throw err;
    });
  }
  return ready;
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim() || null;
  return req.socket?.remoteAddress || req.ip || null;
}

// Reverse-DNS the client IP to a machine name, best-effort. Cached per IP
// (5 min, negatives included) so repeated actions from the same client
// don't each pay for a lookup. Times out fast so a slow/dead resolver
// never delays an audit write for long.
const hostCache = new Map();
async function reverseHostname(ip) {
  if (!ip) return null;
  const clean = String(ip).replace(/^::ffff:/i, "").replace(/[[\]]/g, "");
  if (!clean || clean === "127.0.0.1" || clean === "::1") return null;

  const cached = hostCache.get(clean);
  if (cached && cached.exp > Date.now()) return cached.name;

  let name = null;
  try {
    const names = await Promise.race([
      dns.reverse(clean),
      new Promise((_, reject) => setTimeout(() => reject(new Error("dns timeout")), 600)),
    ]);
    if (Array.isArray(names) && names[0]) {
      name = names[0].split(".")[0].toUpperCase() || null;
    }
  } catch {
    /* no PTR record, or resolver slow/unreachable — fall back to the header */
  }
  hostCache.set(clean, { name, exp: Date.now() + 5 * 60 * 1000 });
  return name;
}

/**
 * Best-effort audit write. Never throws.
 * @param {import('express').Request} req  for IP + the resolved req.hittUser
 * @param {object} entry { kind, desc, level?, computerName?, userAgent? }
 */
async function logAudit(req, entry) {
  try {
    await ensureAuditSchema();
    const u = (req && req.hittUser) || {};
    const { kind, desc, level = 1 } = entry || {};
    const ip = req ? clientIp(req) : null;
    // Prefer a resolved machine name (reverse DNS of the client IP); fall
    // back to the browser platform string the frontend sends on every
    // request (X-HITT-Client), or an explicit value from session-event.
    const fallbackComputer = entry?.computerName || req?.headers?.["x-hitt-client"] || null;
    const computerName = (await reverseHostname(ip)) || fallbackComputer || null;
    const userAgent = entry?.userAgent || req?.headers?.["user-agent"] || null;
    await pool.query(
      `INSERT INTO public.actionsaudit
         (actionuserid, actionusername, actionkind, actiondesc, actionts,
          actioncomputer, actionenvironment, actionip, loglevel)
       VALUES ($1, $2, $3, $4, now(), $5, $6, $7, $8)`,
      [
        u.employeeId || null,
        u.raw || null,
        kind || null,
        desc || null,
        computerName ? String(computerName).slice(0, 255) : null,
        userAgent ? String(userAgent).slice(0, 255) : null,
        ip,
        Number.isFinite(level) ? level : 1,
      ]
    );
  } catch (err) {
    console.error("[audit] failed to write audit entry:", err.message);
  }
}

module.exports = { logAudit, ensureAuditSchema };
