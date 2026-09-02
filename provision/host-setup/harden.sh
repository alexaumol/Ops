#!/usr/bin/env bash
#
# Host security baseline (0H). Idempotent — safe to re-run. Run as root on
# each VPS (Ops host and HITT host).
#
#   ⚠  KEEP YOUR CURRENT SSH SESSION OPEN.
#      After it runs, open a SECOND session and confirm you can still log in
#      BEFORE you close this one. A firewall or sshd mistake can lock you out.
#
# What it does:
#   1. ufw           — default deny inbound; allow 22, 80, 443
#   2. sshd          — key-only, no root password, MaxAuthTries 3  (drop-in)
#   3. fail2ban      — sshd jail, escalating bans
#   4. unattended-upgrades — security updates auto-applied (reboot stays manual)
#
# Not done here (see docs/security-baseline.md): disk encryption, off-box log
# shipping, secret store — those are decisions / follow-ups, not one-liners.

set -Eeuo pipefail
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
export DEBIAN_FRONTEND=noninteractive

# ---------------------------------------------------------------------------
step "1/4  ufw firewall"
apt-get install -y -qq ufw
ufw allow OpenSSH            >/dev/null
ufw allow 80/tcp             >/dev/null
ufw allow 443/tcp            >/dev/null
ufw default deny incoming    >/dev/null
ufw default allow outgoing   >/dev/null
yes | ufw enable             >/dev/null
ufw status verbose
echo "  NOTE: a Docker container that publishes 0.0.0.0:<port> bypasses ufw."
echo "        Zitadel must publish to 127.0.0.1 only (nginx proxies it)."

# ---------------------------------------------------------------------------
step "2/4  sshd hardening"
install -m 644 "$HERE/sshd-hardening.conf" /etc/ssh/sshd_config.d/10-ops-hardening.conf

# refuse to lock the operator out: every account that can log in needs a key
missing=""
while IFS=: read -r user _ uid _ _ home _; do
  { [ "$uid" -ge 1000 ] || [ "$user" = root ]; } || continue
  [ -d "$home" ] || continue
  if [ ! -s "$home/.ssh/authorized_keys" ]; then missing="$missing $user"; fi
done < <(getent passwd)

sshd -t
if [ -n "$missing" ]; then
  echo "  ⚠ these accounts have no ~/.ssh/authorized_keys:$missing"
  echo "  ⚠ sshd config staged but NOT reloaded. Add your key, then:"
  echo "      sshd -t && systemctl reload ssh"
else
  systemctl reload ssh
  echo "  sshd reloaded — password auth is now OFF. Test a new session now."
fi

# ---------------------------------------------------------------------------
step "3/4  fail2ban"
apt-get install -y -qq fail2ban
install -m 644 "$HERE/fail2ban-ops.local" /etc/fail2ban/jail.d/ops.local
echo "  → edit /etc/fail2ban/jail.d/ops.local and add your admin IP to ignoreip"
systemctl enable --now fail2ban >/dev/null
systemctl restart fail2ban
sleep 1
fail2ban-client status sshd || true

# ---------------------------------------------------------------------------
step "4/4  unattended-upgrades"
apt-get install -y -qq unattended-upgrades
install -m 644 "$HERE/20auto-upgrades"              /etc/apt/apt.conf.d/20auto-upgrades
install -m 644 "$HERE/52unattended-upgrades-ops"    /etc/apt/apt.conf.d/52unattended-upgrades-ops
systemctl enable --now unattended-upgrades >/dev/null
echo "  dry run:"
unattended-upgrade --dry-run 2>&1 | grep -Ei 'allowed origins|packages that|would be' | sed 's/^/    /' || true

printf '\n\033[1mdone.\033[0m Open a SECOND ssh session and confirm login works before closing this one.\n'
echo "Then check: ufw status  |  fail2ban-client status sshd  |  systemctl status unattended-upgrades"
