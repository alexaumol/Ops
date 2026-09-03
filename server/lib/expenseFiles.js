/**
 * Where expense evidence files ("tickets") live on the API host, shared by
 * routes/expenses.js (which writes them) and lib/externalSync.js (which
 * backs them up). UPLOAD_DIR/expenses, or ../uploads/expenses by default —
 * never in the repo (see .gitignore).
 */
const path = require("path");

const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR, "expenses")
  : path.join(__dirname, "..", "uploads", "expenses");

// Absolute path of a stored evidence file (defends against a "../" in the
// stored name by taking only the basename).
function expenseFilePath(storedName) {
  return storedName ? path.join(UPLOAD_DIR, path.basename(storedName)) : null;
}

const EXT_MIME = {
  ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".png": "image/png", ".gif": "image/gif", ".webp": "image/webp",
  ".heic": "image/heic", ".heif": "image/heif",
};
const mimeForName = (name) => EXT_MIME[path.extname(name || "").toLowerCase()] || "application/octet-stream";

module.exports = { UPLOAD_DIR, expenseFilePath, mimeForName };
