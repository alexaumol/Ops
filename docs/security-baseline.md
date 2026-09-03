# Host & control-plane security baseline (0H)

Covers both VPSes (Ops host, HITT host). Scripted parts live in
`provision/host-setup/`.

| # | item | status |
|---|---|---|
| 1 | SSH key-only, no root password, fail2ban | **scripted** — `harden.sh` |
| 2 | Unattended security upgrades | **scripted** — `harden.sh` |
| 3 | Firewall (default-deny inbound) | **scripted** — `harden.sh` (ufw) |
| 4 | One least-privilege DB role per instance | **done in 0D** — see below |
| 5 | Disk encryption at rest | **decision below** — rely on IONOS volume encryption; backups separately client-encrypted |
| 6 | Ship logs off-box | **plan below** — journald → the other VPS |
| 7 | Provisioning secrets out of the repo | **done** — posture below |

## 1–3. Run the hardening script

On each VPS, as root:

```bash
cd /opt/ops && git pull
# ⚠ keep this session open
sudo bash provision/host-setup/harden.sh
```

Then **in a second terminal**, confirm you can still SSH in. Only then close
the first session. After that, edit `/etc/fail2ban/jail.d/ops.local` and add
your home/office IP to `ignoreip`, then `systemctl restart fail2ban`.

What it sets:

- **ufw** — default deny inbound, allow 22 / 80 / 443. Outbound open.
  ⚠ A Docker container publishing `0.0.0.0:<port>` bypasses ufw's INPUT
  rules. **Zitadel must publish only to `127.0.0.1`** (`127.0.0.1:8080:8080`
  in the compose/run args) — nginx is the only thing that should reach it.
  Check: `ss -tlnp | grep -v 127.0.0.1` should show only 22/80/443.
- **Postgres** — direct access from outside is intentionally closed. Reach the
  DB over an **SSH tunnel** (pgAdmin → connection → *SSH Tunnel* tab; Postgres
  host then `127.0.0.1`). Set `listen_addresses = 'localhost'` in
  `postgresql.conf` so the DB isn't on a public interface at all — the tunnel
  and all local tooling (provision, migrate, backup) still work.
- **sshd** (`/etc/ssh/sshd_config.d/10-ops-hardening.conf`) — `PasswordAuthentication no`,
  `PermitRootLogin prohibit-password`, `MaxAuthTries 3`, `LoginGraceTime 30`.
  TCP forwarding stays **on** (pgAdmin/psql tunnel to Postgres). The script
  refuses to reload sshd if the logging-in account has no `authorized_keys`.
- **fail2ban** — `sshd` jail, aggressive mode, escalating bans (1h → ×2 → 1w).
  Reads the systemd journal (no logpath needed on 24.04).
- **unattended-upgrades** — `-security` pocket only, auto-applied daily.
  **Reboots stay manual** (one VPS, many customers). Kernel updates therefore
  need a scheduled reboot window — check monthly:
  `ls /var/run/reboot-required 2>/dev/null && echo "reboot pending"`.
  To switch to automatic reboots, edit `52unattended-upgrades-ops`.

## 4. Least-privilege DB roles — done in 0D

`provision.js` already does this per instance:

```
CREATE ROLE ops_<slug> LOGIN PASSWORD '…';
CREATE DATABASE ops_<slug> OWNER ops_<slug>;
REVOKE ALL ON DATABASE ops_<slug> FROM PUBLIC;
```

The app connects **only** as `ops_<slug>` (`PGUSER` in
`/srv/ops/<slug>/env`). It owns its own database and nothing else — it cannot
see or touch another customer's database or the `zitadel` DB. The `postgres`
superuser appears **only** in root-owned tooling (`provision.js`,
`server/scripts/migrate.js`, `backup/backup.sh`) via `/root/.pgpass`, never
in an app env file.

Verify on the Ops VPS:

```bash
sudo -u postgres psql -c "\du"      # each ops_<slug> has no superuser/createrole
grep PGUSER /srv/ops/*/env          # never 'postgres'
```

HITT host: the legacy `.env` should likewise use a non-superuser role that
owns only the `ops` database. If it currently uses a superuser, create a
scoped owner role and switch `PGUSER`/`PGPASSWORD` — tracked as the one 0H
item still open on that box.

## 5. Disk encryption at rest — decision

**IONOS Cloud block-storage volumes are encrypted at rest** (AES-XTS 256-bit,
per-volume keys held outside the VM, inaccessible to the guest root). That
defends against physical drive theft / decommissioned-disk recovery.

It does **not** defend against: a compromised root on the running VM, or
IONOS-side access to a running instance's memory/volume. LUKS-on-root would
raise that bar, but on a headless VPS it means either typing a passphrase on
the provider console at every boot or running `dropbear-initramfs` for remote
unlock — meaningful operational fragility for a single-operator SaaS.

**Decision:** rely on IONOS volume encryption for data-at-rest; do not
LUKS the root disk. Compensate where it matters most — the database backups,
which leave our infrastructure — with **client-side encryption before upload**
(`rclone crypt`, done in 0F). Revisit if a customer contract requires
customer-managed keys or full-disk encryption with attestation.

_Recorded 2026-09-02._

## 6. Off-box logs — plan

Goal: an attacker who roots one box can't erase their tracks by wiping its
journal.

**Approach:** `systemd-journal-upload` on each VPS → `systemd-journal-remote`
on the *other* VPS (mutual), over HTTPS with the wildcard cert. Keeps log data
on infrastructure we control, no third party, ~zero cost.

```
# on the receiver
apt install systemd-journal-remote
systemctl enable --now systemd-journal-remote.socket
# on the sender: /etc/systemd/journal-upload.conf
[Upload]
URL=https://<other-vps-domain>:19532
```

Alternative if that proves flaky: a hosted tier (Better Stack / Grafana Cloud
free) with a 3–7 day retention — fine for tamper-evidence, less good for
data residency.

**Status:** not yet set up. Do after the hardening script is confirmed on
both boxes. Not a launch blocker for the first customer, but should land
before there are several.

## 7. Provisioning secrets — posture

No secrets in the repo (`git grep` clean; `provision/config.json`,
`backup/config.env`, `.env` all gitignored). At rest on the host:

| secret | location | mode |
|---|---|---|
| Postgres superuser password | `/root/.pgpass` | 0600 root |
| IONOS DNS API key, Zitadel PAT | `/etc/ops/provision.env` | 0600 root |
| rclone crypt password + salt | `/root/.config/rclone/rclone.conf` | 0600 root |
| per-instance DB password | `/srv/ops/<slug>/env` | 0640 `ops:ops` |
| Zitadel masterkey | Zitadel's own env / compose file | 0600 root |

For a single operator this is a defensible baseline: root compromise is
already game-over, and these files don't widen that. A real secret store
(Vault, SOPS+age, cloud KMS) buys rotation, audit, and multi-operator access
control — **adopt when** a second person needs deploy access, or customer
count / contracts demand audited secret handling. Until then: keep the
`rclone` crypt secret and the Zitadel masterkey copied into a password
manager (offline), since losing either is unrecoverable.

## Quick audit checklist

```bash
ufw status verbose
sshd -T | grep -Ei 'passwordauth|permitrootlogin|maxauthtries'
fail2ban-client status sshd
systemctl is-enabled unattended-upgrades
ss -tlnp | grep -vE '127.0.0.1|\[::1\]'          # only 22/80/443 public
sudo -u postgres psql -Atc "SELECT rolname FROM pg_roles WHERE rolsuper AND rolcanlogin"
grep -h PGUSER /srv/ops/*/env 2>/dev/null        # no 'postgres'
```
