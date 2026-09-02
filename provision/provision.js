#!/usr/bin/env node
/**
 * Provision one Ops instance on this host.
 *
 *   node provision/provision.js <slug> "<Display Name>" <admin-email> [options]
 *
 *   --dry-run     print every action, change nothing
 *   --force       tear down an existing instance with this slug first
 *   --no-dns      skip the DNS record (do it by hand)
 *   --no-zitadel  skip the Zitadel org (do it by hand)
 *
 * Deployment model: shared code at config.codeDir (/opt/ops), per-instance
 * state at config.instanceRoot/<slug> (/srv/ops/<slug>). One Postgres
 * database + login role per instance in the shared cluster. TLS from the
 * shared *.<baseDomain> wildcard. systemd unit ops@<slug>, nginx vhost
 * ops-<slug>.conf.
 *
 * Steps run in order; a failure rolls back the completed ones. Re-running a
 * failed provision: --force (destructive) or deprovision then provision.
 *
 * See docs/provisioning.md. Requires: node 18+, psql/createdb/dropdb,
 * nginx, systemctl, and (for DNS/Zitadel) IONOS_API_KEY / ZITADEL_PAT in
 * the environment.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const HERE = __dirname;

// ---------------------------------------------------------------------------
// args + config
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const [slug, displayName, adminEmail] = argv.filter((a) => !a.startsWith("--"));
const DRY = flags.has("--dry-run");

function die(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

if (!slug || !displayName || !adminEmail) {
  die('usage: provision.js <slug> "<Display Name>" <admin-email> [--dry-run] [--force] [--no-dns] [--no-zitadel]');
}
if (!/^[a-z][a-z0-9-]{1,30}$/.test(slug)) {
  die(`invalid slug "${slug}" — lowercase letter, then letters/digits/hyphens, 2–31 chars`);
}
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(adminEmail)) {
  die(`"${adminEmail}" doesn't look like an email address`);
}

const cfgPath = path.join(HERE, "config.json");
if (!fs.existsSync(cfgPath)) {
  die(`provision/config.json not found — copy config.example.json and fill it in`);
}
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

const INSTANCE_DIR = path.join(cfg.instanceRoot, slug);
const DB_NAME = `ops_${slug.replace(/-/g, "_")}`;
const DB_ROLE = DB_NAME;
const DOMAIN = `${slug}.${cfg.baseDomain}`;
const REGISTRY = path.join(cfg.instanceRoot, "registry.json");
const NGINX_CONF = path.join(cfg.nginx.sitesAvailable, `ops-${slug}.conf`);
const NGINX_LINK = path.join(cfg.nginx.sitesEnabled, `ops-${slug}.conf`);
const APP_VERSION = readAppVersion();

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

function sh(file, args, opts = {}) {
  const pretty = `${file} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`;
  if (DRY) {
    console.log(`    [dry-run] ${pretty}`);
    return "";
  }
  return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function psqlAdmin(sql) {
  return sh("psql", ["-w", cfg.postgres.adminUrl, "-v", "ON_ERROR_STOP=1", "-Atqc", sql]);
}
function psqlInstance(url, args) {
  return sh("psql", ["-w", url, "-v", "ON_ERROR_STOP=1", ...args]);
}

function writeFile(p, content, mode) {
  if (DRY) {
    console.log(`    [dry-run] write ${p} (${content.length} bytes${mode ? `, mode ${mode.toString(8)}` : ""})`);
    return;
  }
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, mode ? { mode } : undefined);
}

function render(tmplName, vars) {
  const tmpl = fs.readFileSync(path.join(HERE, "templates", tmplName), "utf8");
  return tmpl.replace(/\{\{(\w+)\}\}/g, (_, k) => {
    if (!(k in vars)) throw new Error(`template ${tmplName}: no value for {{${k}}}`);
    return vars[k];
  });
}

function readAppVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, "server", "package.json"), "utf8")).version || "0";
  } catch {
    return "0";
  }
}

function nextFreePort() {
  const [lo, hi] = cfg.portRange;
  const used = new Set(Object.values(readRegistry()).map((e) => e.port));
  for (let p = lo; p <= hi; p++) if (!used.has(p)) return p;
  throw new Error(`no free port in ${lo}-${hi}`);
}

// ---------------------------------------------------------------------------
// registry (source of truth for what's provisioned on this host)
// ---------------------------------------------------------------------------

function readRegistry() {
  try {
    return JSON.parse(fs.readFileSync(REGISTRY, "utf8"));
  } catch {
    return {};
  }
}
function registry() {
  return {
    read: (s) => readRegistry()[s],
    upsert: (s, patch) => {
      if (DRY) return console.log(`    [dry-run] registry[${s}] <- ${JSON.stringify(patch)}`);
      const all = readRegistry();
      all[s] = { ...(all[s] || {}), ...patch };
      fs.mkdirSync(path.dirname(REGISTRY), { recursive: true });
      fs.writeFileSync(REGISTRY, JSON.stringify(all, null, 2) + "\n");
    },
    remove: (s) => {
      if (DRY) return console.log(`    [dry-run] registry delete ${s}`);
      const all = readRegistry();
      delete all[s];
      fs.writeFileSync(REGISTRY, JSON.stringify(all, null, 2) + "\n");
    },
  };
}

// ---------------------------------------------------------------------------
// external APIs (best-effort; skipped with a printed instruction if creds
// are missing or --no-* is passed)
// ---------------------------------------------------------------------------

async function ionosCreateA() {
  const key = process.env.IONOS_API_KEY;
  if (flags.has("--no-dns") || !key) {
    console.log(`    → DNS not automated. Add an A record:  ${DOMAIN}  ->  ${cfg.publicIp}`);
    return null;
  }
  if (DRY) return console.log(`    [dry-run] IONOS: create A ${DOMAIN} -> ${cfg.publicIp}`), "dry";
  const base = "https://api.hosting.ionos.com/dns/v1";
  const headers = { "X-API-Key": key, "Content-Type": "application/json" };
  const zones = await (await fetch(`${base}/zones`, { headers })).json();
  const zone = zones.find((z) => z.name === cfg.dns.zone);
  if (!zone) throw new Error(`IONOS: zone ${cfg.dns.zone} not found`);
  const res = await fetch(`${base}/zones/${zone.id}/records`, {
    method: "POST",
    headers,
    body: JSON.stringify([{ name: DOMAIN, type: "A", content: cfg.publicIp, ttl: 3600, disabled: false }]),
  });
  if (!res.ok) throw new Error(`IONOS: ${res.status} ${await res.text()}`);
  return zone.id;
}

async function ionosDeleteA(zoneId) {
  const key = process.env.IONOS_API_KEY;
  if (!key || !zoneId || zoneId === "dry") return;
  const base = "https://api.hosting.ionos.com/dns/v1";
  const headers = { "X-API-Key": key };
  const recs = await (await fetch(`${base}/zones/${zoneId}?recordName=${DOMAIN}&recordType=A`, { headers })).json();
  for (const r of recs.records || []) {
    await fetch(`${base}/zones/${zoneId}/records/${r.id}`, { method: "DELETE", headers });
  }
}

async function zitadelCreateOrg() {
  const pat = process.env.ZITADEL_PAT;
  if (flags.has("--no-zitadel") || !pat) {
    console.log(`    → Zitadel not automated. Create an organization "${displayName}" and (optionally) its SSO connection.`);
    return null;
  }
  if (DRY) return console.log(`    [dry-run] Zitadel: create org "${displayName}"`), "dry";
  const res = await fetch(`${cfg.zitadel.apiUrl}/management/v1/orgs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${pat}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: displayName }),
  });
  if (!res.ok) throw new Error(`Zitadel: ${res.status} ${await res.text()}`);
  return (await res.json()).id || null;
}

async function zitadelDeleteOrg(orgId) {
  const pat = process.env.ZITADEL_PAT;
  if (!pat || !orgId || orgId === "dry") return;
  await fetch(`${cfg.zitadel.apiUrl}/management/v1/orgs/me`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${pat}`, "x-zitadel-orgid": orgId },
  });
}

// ---------------------------------------------------------------------------
// the steps
// ---------------------------------------------------------------------------

const port = { value: null };
const dbPassword = crypto.randomBytes(18).toString("base64url");
const zitCleanup = {};
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

const steps = [
  {
    name: "allocate port + registry stub",
    do: () => {
      port.value = nextFreePort();
      registry().upsert(slug, {
        displayName, domain: DOMAIN, db: DB_NAME, dbRole: DB_ROLE, dbPassword,
        port: port.value, adminEmail, status: "provisioning", createdAt: new Date().toISOString(),
      });
      console.log(`    port ${port.value}, db ${DB_NAME}`);
    },
    undo: () => registry().remove(slug),
  },
  {
    name: "create database + scoped role",
    do: () => {
      psqlAdmin(`CREATE ROLE ${DB_ROLE} LOGIN PASSWORD '${dbPassword.replace(/'/g, "''")}'`);
      psqlAdmin(`CREATE DATABASE ${DB_NAME} OWNER ${DB_ROLE}`);
      psqlAdmin(`REVOKE ALL ON DATABASE ${DB_NAME} FROM PUBLIC`);
    },
    undo: () => {
      try { psqlAdmin(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`); } catch {}
      try { psqlAdmin(`DROP ROLE IF EXISTS ${DB_ROLE}`); } catch {}
    },
  },
  {
    name: "instance directory",
    do: () => {
      if (!DRY) fs.mkdirSync(path.join(INSTANCE_DIR, "uploads", "expenses"), { recursive: true });
      else console.log(`    [dry-run] mkdir -p ${INSTANCE_DIR}/uploads/expenses`);
    },
    undo: () => { if (!DRY) fs.rmSync(INSTANCE_DIR, { recursive: true, force: true }); },
  },
  {
    name: "render env + config.js",
    do: () => {
      const vars = {
        SLUG: slug, DISPLAY_NAME: displayName, DOMAIN, INSTANCE_DIR,
        PGHOST: cfg.postgres.host, PGPORT: String(cfg.postgres.port), PGSSLMODE: cfg.postgres.sslmode,
        DB_NAME, DB_ROLE, DB_PASSWORD: dbPassword,
        PORT: String(port.value),
        OIDC_ISSUER: cfg.oidc.issuer, OIDC_AUDIENCE: cfg.oidc.audience,
        OIDC_CLIENT_ID: cfg.oidc.clientId,
        MSAL_TENANT_ID: cfg.msal.tenantId || "", MSAL_CLIENT_ID: cfg.msal.clientId || "",
        APP_VERSION,
      };
      writeFile(path.join(INSTANCE_DIR, "env"), render("env.tmpl", vars), 0o640);
      writeFile(path.join(INSTANCE_DIR, "config.js"), render("config.js.tmpl", vars), 0o644);
      // the systemd unit runs as cfg.runUser — it must read env (0640) and
      // write uploads/. provision.js itself runs as root.
      sh("chown", ["-R", `${cfg.runUser}:${cfg.runUser}`, INSTANCE_DIR]);
    },
    undo: () => {},
  },
  {
    name: "schema + reference data + seed",
    do: () => {
      const url = `postgresql://${DB_ROLE}:${encodeURIComponent(dbPassword)}@${cfg.postgres.host}:${cfg.postgres.port}/${DB_NAME}?sslmode=${cfg.postgres.sslmode}`;
      // baseline via node-pg-migrate (uses the instance's env file)
      sh("npm", ["--prefix", path.join(ROOT, "server"), "run", "migrate"], {
        env: { ...process.env, OPS_ENV_FILE: path.join(INSTANCE_DIR, "env") },
      });
      const ref = path.join(HERE, "seed", "reference-data.sql");
      if (!/\(reference data goes here\)/.test(fs.readFileSync(ref, "utf8"))) {
        psqlInstance(url, ["-f", ref]); // sh() no-ops under --dry-run
      } else {
        console.log("    ⚠ reference-data.sql is still a placeholder — instance will have empty lookup tables");
      }
      const [first, ...rest] = adminEmail.split("@")[0].split(/[._-]/);
      psqlInstance(url, [
        "-v", `display_name=${displayName}`,
        "-v", `admin_email=${adminEmail}`,
        "-v", `admin_first=${cap(first)}`,
        "-v", `admin_last=${cap(rest.join(" ")) || cap(first)}`,
        "-f", path.join(HERE, "seed", "seed-instance.sql"),
      ]);
      // reference-data + seed insert explicit ids — resync the sequences.
      psqlInstance(url, ["-f", path.join(HERE, "seed", "fix-sequences.sql")]);
    },
    undo: () => {}, // the DB drop in the earlier step covers this
  },
  {
    name: "systemd unit",
    do: () => {
      const unitPath = "/etc/systemd/system/ops@.service";
      const targetPath = "/etc/systemd/system/ops.target";
      if (!DRY && !fs.existsSync(unitPath)) {
        writeFile(unitPath, render("ops@.service", {
          CODE_DIR: cfg.codeDir, INSTANCE_ROOT: cfg.instanceRoot, RUN_USER: cfg.runUser,
        }));
        if (!fs.existsSync(targetPath)) writeFile(targetPath, fs.readFileSync(path.join(HERE, "templates", "ops.target"), "utf8"));
        sh("systemctl", ["daemon-reload"]);
        sh("systemctl", ["enable", "ops.target"]);
      }
      sh("systemctl", ["enable", "--now", `ops@${slug}`]);
    },
    undo: () => {
      try { sh("systemctl", ["disable", "--now", `ops@${slug}`], { stdio: "ignore" }); } catch {}
    },
  },
  {
    name: "nginx vhost",
    do: () => {
      writeFile(NGINX_CONF, render("nginx.conf.tmpl", {
        SLUG: slug, DISPLAY_NAME: displayName, DOMAIN, PORT: String(port.value),
        CODE_DIR: cfg.codeDir, INSTANCE_DIR,
        TLS_CERT: cfg.tls.cert, TLS_KEY: cfg.tls.key,
      }));
      if (!DRY) { try { fs.symlinkSync(NGINX_CONF, NGINX_LINK); } catch (e) { if (e.code !== "EEXIST") throw e; } }
      sh("nginx", ["-t"]);
      sh("systemctl", ["reload", "nginx"]);
    },
    undo: () => {
      if (!DRY) { fs.rmSync(NGINX_LINK, { force: true }); fs.rmSync(NGINX_CONF, { force: true }); }
      try { sh("systemctl", ["reload", "nginx"], { stdio: "ignore" }); } catch {}
    },
  },
  {
    name: "DNS record",
    do: async () => { zitCleanup.dnsZone = await ionosCreateA(); },
    undo: async () => { await ionosDeleteA(zitCleanup.dnsZone); },
  },
  {
    name: "Zitadel organization",
    do: async () => {
      zitCleanup.orgId = await zitadelCreateOrg();
      if (zitCleanup.orgId && zitCleanup.orgId !== "dry") registry().upsert(slug, { zitadelOrgId: zitCleanup.orgId });
    },
    undo: async () => { await zitadelDeleteOrg(zitCleanup.orgId); },
  },
  {
    name: "smoke check",
    do: async () => {
      if (DRY) return console.log(`    [dry-run] curl http://127.0.0.1:${port.value}/api/health`);
      await new Promise((r) => setTimeout(r, 1500));
      const res = await fetch(`http://127.0.0.1:${port.value}/api/health`);
      const body = await res.json();
      if (!res.ok || body.status !== "ok") throw new Error(`health check failed: ${res.status} ${JSON.stringify(body)}`);
      console.log(`    /api/health ok`);
    },
    undo: () => {},
  },
  {
    name: "finalize registry",
    do: () => registry().upsert(slug, { status: "active", activatedAt: new Date().toISOString() }),
    undo: () => {},
  },
];

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

(async () => {
  console.log(`\n  Provisioning ${slug}  (${displayName})  ${DRY ? "— DRY RUN" : ""}\n`);

  const existing = readRegistry()[slug];
  if (existing && !flags.has("--force")) {
    die(`"${slug}" is already in the registry (status ${existing.status}). Use --force to replace, or deprovision.js first.`);
  }
  if (existing && flags.has("--force") && !DRY) {
    console.log("  --force: removing existing instance first\n");
    execFileSync("node", [path.join(HERE, "deprovision.js"), slug, "--yes", "--no-dump"], { stdio: "inherit" });
  }

  for (const f of ["reference-data.sql", "seed-instance.sql"].map((n) => path.join(HERE, "seed", n))) {
    if (!fs.existsSync(f)) die(`missing ${f}`);
  }

  const done = [];
  try {
    for (const step of steps) {
      console.log(`  • ${step.name}`);
      await step.do();
      done.push(step);
    }
  } catch (err) {
    console.error(`\n  ✗ ${err.message}\n  rolling back…\n`);
    for (const step of done.reverse()) {
      try { console.log(`  ↩ ${step.name}`); await step.undo(); } catch (e) { console.error(`    (undo failed: ${e.message})`); }
    }
    process.exit(1);
  }

  console.log(`
  ✓ ${slug} provisioned

    URL      https://${DOMAIN}
    DB       ${DB_NAME}
    port     ${port.value}
    admin    ${adminEmail}

  Next:
    - if DNS / Zitadel weren't automated, do those now (see above)
    - configure the customer's SSO connection in Zitadel if they use one
    - the admin signs in at https://${DOMAIN} once DNS resolves
`);
})();
