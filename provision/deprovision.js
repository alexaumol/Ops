#!/usr/bin/env node
/**
 * Remove one Ops instance from this host.
 *
 *   node provision/deprovision.js <slug> [options]
 *
 *   --yes        don't prompt
 *   --dry-run    print every action, change nothing
 *   --no-dump    skip the final schema+data dump (default: dump first)
 *   --keep-db    stop the instance but leave the database + role in place
 *
 * Order: dump -> stop unit -> drop nginx -> drop DNS -> drop Zitadel org ->
 * drop DB + role -> remove instance dir -> remove registry entry.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const HERE = __dirname;
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const slug = argv.find((a) => !a.startsWith("--"));
const DRY = flags.has("--dry-run");

if (!slug) { console.error("usage: deprovision.js <slug> [--yes] [--dry-run] [--no-dump] [--keep-db]"); process.exit(1); }

const cfg = JSON.parse(fs.readFileSync(path.join(HERE, "config.json"), "utf8"));
const REGISTRY = path.join(cfg.instanceRoot, "registry.json");
const reg = (() => { try { return JSON.parse(fs.readFileSync(REGISTRY, "utf8")); } catch { return {}; } })();
const entry = reg[slug];
if (!entry) { console.error(`"${slug}" is not in the registry`); process.exit(1); }

const INSTANCE_DIR = path.join(cfg.instanceRoot, slug);
const DB_NAME = entry.db || `ops_${slug.replace(/-/g, "_")}`;
const DB_ROLE = entry.dbRole || DB_NAME;
const DOMAIN = entry.domain || `${slug}.${cfg.baseDomain}`;
const NGINX_CONF = path.join(cfg.nginx.sitesAvailable, `ops-${slug}.conf`);
const NGINX_LINK = path.join(cfg.nginx.sitesEnabled, `ops-${slug}.conf`);

function sh(file, args, opts = {}) {
  if (DRY) return console.log(`    [dry-run] ${file} ${args.join(" ")}`), "";
  try { return execFileSync(file, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts }); }
  catch (e) { console.error(`    (${file} failed: ${e.message.split("\n")[0]})`); return ""; }
}

(async () => {
  if (!flags.has("--yes") && !DRY) {
    console.error(`\n  This permanently removes instance "${slug}" (${DOMAIN}) and its database ${DB_NAME}.\n  Re-run with --yes to proceed.\n`);
    process.exit(1);
  }
  console.log(`\n  Deprovisioning ${slug} ${DRY ? "— DRY RUN" : ""}\n`);

  if (!flags.has("--no-dump") && !flags.has("--keep-db")) {
    const out = path.join(INSTANCE_DIR, `${slug}-final-${new Date().toISOString().slice(0, 10)}.dump`);
    console.log(`  • final dump -> ${out}`);
    sh("pg_dump", ["-h", cfg.postgres.host, "-p", String(cfg.postgres.port), "-Fc", "-f", out, DB_NAME]);
  }

  console.log("  • stop + disable unit");
  sh("systemctl", ["disable", "--now", `ops@${slug}`]);

  console.log("  • remove nginx vhost");
  if (!DRY) { fs.rmSync(NGINX_LINK, { force: true }); fs.rmSync(NGINX_CONF, { force: true }); }
  sh("systemctl", ["reload", "nginx"]);

  const key = process.env.IONOS_API_KEY;
  if (key && !flags.has("--no-dns")) {
    console.log("  • remove DNS record");
    if (!DRY) {
      const base = "https://api.hosting.ionos.com/dns/v1";
      const headers = { "X-API-Key": key };
      const zones = await (await fetch(`${base}/zones`, { headers })).json();
      const zone = zones.find((z) => z.name === cfg.dns.zone);
      if (zone) {
        const recs = await (await fetch(`${base}/zones/${zone.id}?recordName=${DOMAIN}&recordType=A`, { headers })).json();
        for (const r of recs.records || []) await fetch(`${base}/zones/${zone.id}/records/${r.id}`, { method: "DELETE", headers });
      }
    }
  } else {
    console.log(`  → remove the DNS A record for ${DOMAIN} by hand`);
  }

  if (entry.zitadelOrgId) {
    console.log(`  → Zitadel org ${entry.zitadelOrgId} left in place — delete it manually if the customer is gone`);
  }

  if (flags.has("--keep-db")) {
    console.log("  • --keep-db: database left in place");
  } else {
    console.log("  • drop database + role");
    sh("psql", ["-w", cfg.postgres.adminUrl, "-v", "ON_ERROR_STOP=1", "-c", `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`]);
    sh("psql", ["-w", cfg.postgres.adminUrl, "-v", "ON_ERROR_STOP=1", "-c", `DROP ROLE IF EXISTS ${DB_ROLE}`]);
  }

  console.log("  • remove instance directory");
  if (!DRY) fs.rmSync(INSTANCE_DIR, { recursive: true, force: true });

  console.log("  • remove registry entry");
  if (!DRY) { delete reg[slug]; fs.writeFileSync(REGISTRY, JSON.stringify(reg, null, 2) + "\n"); }

  console.log(`\n  ✓ ${slug} deprovisioned\n`);
})();
