/**
 * server/lib/employeeProfile.js
 * ---------------------------------------------------------------------------
 * Shared read/write for the `employeesinfo` row behind the Settings
 * edit-user modal (admin) AND the self-service Profile modal (/api/me).
 *
 * The Access `employeesinfo` schema is topped up at runtime with three
 * columns the app adds (mirrored in server/db/schema-changes.sql):
 *   showbirthday    boolean — opt in to the team calendar birthday chip
 *   avatarimage     text    — a data:image/... URL (auto square-cropped +
 *                             downscaled client-side; ~15-25 KB)
 *   avatarusephoto  boolean — use avatarimage as the avatar; when false the
 *                             image is kept on file as a rollback option
 *
 * upsertEmployeeInfo() is a FULL overwrite of the managed columns — every
 * caller sends the complete `info` object it wants persisted.
 * ---------------------------------------------------------------------------
 */
const { pool } = require("../config/db");

let schemaReady = null;
function ensureEmployeeProfileSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      await pool.query(`ALTER TABLE employeesinfo ADD COLUMN IF NOT EXISTS showbirthday boolean NOT NULL DEFAULT false`);
      await pool.query(`ALTER TABLE employeesinfo ADD COLUMN IF NOT EXISTS avatarimage text`);
      await pool.query(`ALTER TABLE employeesinfo ADD COLUMN IF NOT EXISTS avatarusephoto boolean NOT NULL DEFAULT false`);
    })().catch((err) => {
      schemaReady = null; // allow a later call to retry
      throw err;
    });
  }
  return schemaReady;
}

// employeedocumentpath is derived server-side (base folder + username),
// never taken from the client. onboard/termination/birthday are stored
// via ::date.
const INFO_DATE_COLS = ["onboarddate", "terminationdate", "birthdaydate"];
const INFO_TEXT_COLS = [
  "phone_personal", "email_personal",
  "phone_emergency1", "contact_emergency1",
  "phone_emergency2", "contact_emergency2",
  "bankname", "bankacctemp",
];
const INFO_BOOL_COLS = ["showbirthday", "avatarusephoto"];
const INFO_BLOB_COLS = ["avatarimage"];

const trimOrNull = (x) => (x != null && String(x).trim() !== "" ? String(x).trim() : null);
const toBool = (x) => x === true || x === "true" || x === 1 || x === "1";
// Accept only a reasonably-sized image data URL; anything else -> null
// (clears the stored photo).
const AVATAR_MAX = 2_000_000; // bytes of the data-URL string
function sanitizeAvatar(x) {
  return typeof x === "string" &&
    /^data:image\/(png|jpe?g|webp|gif);base64,/.test(x) &&
    x.length <= AVATAR_MAX
    ? x
    : null;
}

// One employeesinfo row per employee: update the earliest if present, else
// insert. Column names are hardcoded above — never client input. Pass
// `docPath` (string or null) to also write employeedocumentpath; omit it
// entirely (undefined) to leave that column untouched.
async function upsertEmployeeInfo(empId, info = {}, docPath) {
  const writeDocPath = docPath !== undefined;
  const cols = [
    ...INFO_DATE_COLS, ...INFO_TEXT_COLS, ...INFO_BOOL_COLS, ...INFO_BLOB_COLS,
    ...(writeDocPath ? ["employeedocumentpath"] : []),
  ];
  const values = [
    ...INFO_DATE_COLS.map((c) => info[c] || null),
    ...INFO_TEXT_COLS.map((c) => trimOrNull(info[c])),
    ...INFO_BOOL_COLS.map((c) => toBool(info[c])),
    ...INFO_BLOB_COLS.map((c) => sanitizeAvatar(info[c])),
    ...(writeDocPath ? [docPath || null] : []),
  ];
  const cast = (c, ph) => {
    if (INFO_DATE_COLS.includes(c)) return `${ph}::date`;
    if (INFO_BOOL_COLS.includes(c)) return `${ph}::boolean`;
    return ph;
  };

  const existing = await pool.query(
    `SELECT id FROM employeesinfo WHERE empid = $1::double precision ORDER BY id LIMIT 1`,
    [empId]
  );
  if (existing.rows.length) {
    const setClause = cols.map((c, i) => `${c} = ${cast(c, `$${i + 1}`)}`).join(", ");
    await pool.query(
      `UPDATE employeesinfo SET ${setClause} WHERE id = $${cols.length + 1}`,
      [...values, existing.rows[0].id]
    );
  } else {
    const placeholders = cols.map((c, i) => cast(c, `$${i + 2}`)).join(", ");
    await pool.query(
      `INSERT INTO employeesinfo (empid, ${cols.join(", ")}) VALUES ($1, ${placeholders})`,
      [empId, ...values]
    );
  }
}

async function employeeInfoRow(empId) {
  const { rows } = await pool.query(
    `SELECT TO_CHAR(onboarddate, 'YYYY-MM-DD') AS onboarddate,
            TO_CHAR(terminationdate, 'YYYY-MM-DD') AS terminationdate,
            TO_CHAR(birthdaydate, 'YYYY-MM-DD') AS birthdaydate,
            employeedocumentpath,
            phone_personal, email_personal,
            phone_emergency1, contact_emergency1,
            phone_emergency2, contact_emergency2,
            bankname, bankacctemp,
            COALESCE(showbirthday, false) AS showbirthday,
            COALESCE(avatarusephoto, false) AS avatarusephoto,
            avatarimage
     FROM employeesinfo WHERE empid = $1::double precision ORDER BY id LIMIT 1`,
    [empId]
  );
  return rows[0] || {};
}

module.exports = {
  ensureEmployeeProfileSchema,
  upsertEmployeeInfo,
  employeeInfoRow,
  INFO_DATE_COLS,
  INFO_TEXT_COLS,
  INFO_BOOL_COLS,
  INFO_BLOB_COLS,
};
