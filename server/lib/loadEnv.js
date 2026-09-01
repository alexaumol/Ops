/**
 * Loads this process's .env.
 *
 * A provisioned instance runs shared code from /opt/ops with its own state
 * in /srv/ops/<slug>/ — the systemd unit sets OPS_ENV_FILE to that
 * instance's env file. Without it, the default ./.env (next to cwd) is used,
 * which is the single-deployment / local-dev case.
 *
 * Require this once, first, before anything reads process.env — server.js
 * and scripts/migrate.js both do.
 */
const fs = require("fs");
const path = require("path");

const envFile = process.env.OPS_ENV_FILE
  ? path.resolve(process.env.OPS_ENV_FILE)
  : path.resolve(process.cwd(), ".env");

if (process.env.OPS_ENV_FILE && !fs.existsSync(envFile)) {
  console.error(`[env] OPS_ENV_FILE points at a file that doesn't exist: ${envFile}`);
}

require("dotenv").config({ path: envFile });

module.exports = { envFile };
