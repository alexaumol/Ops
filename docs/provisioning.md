# Provisioning (0D)

One command stands up a new Ops customer instance on the shared VPS.

```bash
node provision/provision.js <slug> "<Display Name>" <admin-email>
node provision/provision.js acme "Acme Corp" jane.doe@acme.com --dry-run
node provision/deprovision.js acme --yes
```

## Model

| | |
|---|---|
| Shared code | `config.codeDir` (`/opt/ops`) — one git checkout, updated by the deploy |
| Per-instance state | `config.instanceRoot/<slug>` (`/srv/ops/<slug>/`) — `env`, `config.js`, `uploads/` |
| Database | `ops_<slug>` + login role `ops_<slug>` in the shared Postgres cluster |
| Process | systemd `ops@<slug>` (template unit `ops@.service`, aggregate `ops.target`) on a port from `config.portRange` |
| Web | nginx vhost `ops-<slug>.conf`, TLS from the shared `*.<baseDomain>` wildcard (0E) |
| Registry | `config.instanceRoot/registry.json` — what's provisioned, ports, DB passwords, Zitadel org ids |

nginx serves the shared `/opt/ops/public` tree and overrides only
`/js/config.js` with the per-instance file.

## One-time host setup

1. `sudo mkdir -p /opt/ops /srv/ops && sudo useradd --system --home /srv/ops ops`
2. `git clone <repo> /opt/ops && cd /opt/ops/server && npm ci`
3. Wildcard cert `*.ops.theaumol.com` (0E — see [tls.md](tls.md)) at the path in `config.tls`
4. `cp provision/config.example.json provision/config.json` and fill it in
5. Populate `provision/seed/reference-data.sql` (see its header — a
   `pg_dump --data-only` of the lookup tables from `test_ops`)
6. For DNS/Zitadel automation, export `IONOS_API_KEY` and `ZITADEL_PAT`
   (a Zitadel machine user with org-creation rights). Without them the
   script prints the two manual steps instead.

The systemd `ops@.service` / `ops.target` units are installed automatically
on the first `provision.js` run.

## What a run does (in order, with rollback)

1. allocate a port, write a registry stub
2. `CREATE ROLE` + `CREATE DATABASE ops_<slug> OWNER …`, `REVOKE … FROM PUBLIC`
3. `mkdir /srv/ops/<slug>/uploads/expenses`
4. render `env` + `config.js` from `provision/templates/`
5. `npm run migrate` (0C baseline) → load `reference-data.sql` → run
   `seed-instance.sql` (first admin employee + admin row, one billing
   entity, current work-calendar year)
6. `systemctl enable --now ops@<slug>`
7. render + link the nginx vhost, `nginx -t`, `systemctl reload nginx`
8. IONOS: create the `<slug>.ops.theaumol.com` A record (or print it)
9. Zitadel: create the organization (or print it)
10. `GET http://127.0.0.1:<port>/api/health`
11. mark the registry entry `active`

Any failure rolls the completed steps back. `--force` deprovisions an
existing slug first.

## Deploy fan-out (after `git pull` in /opt/ops)

```bash
cd /opt/ops && git pull && cd server && npm ci
# migrate every instance's DB
node -e 'const r=require("/srv/ops/registry.json");for(const s in r)require("child_process").execSync(`OPS_ENV_FILE=/srv/ops/${s}/env npm --prefix /opt/ops/server run migrate`,{stdio:"inherit"})'
sudo systemctl restart ops.target
```

(This ad-hoc loop is what the control-plane console automates later.)

## Notes / limits

- The registry stores each instance's DB password in plaintext (root/ops
  readable only). Fine for one box; revisit with the control plane.
- `provision.js` runs on the VPS as a user that can `sudo`-less run
  `systemctl` / `nginx` / write `/etc/nginx` and `/etc/systemd` — run it
  with `sudo` or give the `ops` user those rights.
- DNS/Zitadel steps are best-effort. If they're skipped, the instance is
  still fully built — just finish those two by hand.
- Custom domains (`ops.customer.com`) aren't handled yet — Phase 2.
