# TLS (0E)

`theaumol.com` DNS is at IONOS, so every cert is issued via **DNS-01** with
`certbot-dns-ionos` — the only way to get a wildcard, and it reuses the same
IONOS DNS API that `provision.js` uses for per-customer A records.

## Two certs

| name | SANs | used by |
|---|---|---|
| `ops` | `*.ops.theaumol.com` | every customer instance — `provision/config.json` `tls.*` points here |
| `theaumol` | `*.theaumol.com`, `theaumol.com` | `auth.theaumol.com` (Zitadel), `console.theaumol.com` later, apex |

Wildcards are one level only: `*.theaumol.com` does **not** cover
`x.ops.theaumol.com`, hence the separate `ops` cert.

## One-time setup on the VPS

### 1. IONOS DNS API key

<https://developer.hosting.ionos.com> → create a key. It has two parts, a
**prefix** and a **secret**.

### 2. certbot + the IONOS plugin

The plugin isn't in apt/snap, and Ubuntu 24.04 blocks system `pip`. Use an
isolated venv and make it the one `certbot` on `PATH`:

```bash
sudo python3 -m venv /opt/certbot
sudo /opt/certbot/bin/pip install --upgrade pip certbot certbot-dns-ionos
sudo ln -sf /opt/certbot/bin/certbot /usr/local/bin/certbot
hash -r; certbot --version           # confirm it's the /opt/certbot one
```

If an apt/snap certbot was there before (it issued the `auth.theaumol.com`
cert), its renewal config in `/etc/letsencrypt/renewal/` is picked up by the
new certbot unchanged. Disable the old timer so renewal runs once, not twice:

```bash
sudo systemctl disable --now certbot.timer 2>/dev/null || true   # apt
sudo snap stop --disable certbot 2>/dev/null || true             # snap
```

### 3. Credentials file

```bash
sudo tee /etc/letsencrypt/ionos.ini >/dev/null <<'EOF'
dns_ionos_prefix = YOUR_PREFIX
dns_ionos_secret = YOUR_SECRET
dns_ionos_endpoint = https://api.hosting.ionos.com
EOF
sudo chmod 600 /etc/letsencrypt/ionos.ini
```

### 4. Issue both certs

```bash
sudo certbot certonly --authenticator dns-ionos \
  --dns-ionos-credentials /etc/letsencrypt/ionos.ini \
  --dns-ionos-propagation-seconds 120 \
  --cert-name ops -d '*.ops.theaumol.com' \
  --deploy-hook 'systemctl reload nginx' \
  --agree-tos -m you@theaumol.com --no-eff-email

sudo certbot certonly --authenticator dns-ionos \
  --dns-ionos-credentials /etc/letsencrypt/ionos.ini \
  --dns-ionos-propagation-seconds 120 \
  --cert-name theaumol -d '*.theaumol.com' -d 'theaumol.com' \
  --deploy-hook 'systemctl reload nginx'
```

### 5. Move Zitadel onto the shared cert

Edit the `auth.theaumol.com` nginx server block:

```nginx
ssl_certificate     /etc/letsencrypt/live/theaumol/fullchain.pem;
ssl_certificate_key /etc/letsencrypt/live/theaumol/privkey.pem;
```

```bash
sudo nginx -t && sudo systemctl reload nginx
sudo certbot delete --cert-name auth.theaumol.com   # retire the old HTTP-01 cert
```

### 6. Renewal

The venv certbot ships a systemd timer (`/opt/certbot/...`), or add one:

```bash
sudo tee /etc/systemd/system/certbot-renew.service >/dev/null <<'EOF'
[Unit]
Description=certbot renew
[Service]
Type=oneshot
ExecStart=/usr/local/bin/certbot renew --quiet
EOF
sudo tee /etc/systemd/system/certbot-renew.timer >/dev/null <<'EOF'
[Unit]
Description=certbot renew twice daily
[Timer]
OnCalendar=*-*-* 03,15:00:00
RandomizedDelaySec=3600
Persistent=true
[Install]
WantedBy=timers.target
EOF
sudo systemctl enable --now certbot-renew.timer
sudo certbot renew --dry-run          # verify DNS-01 renewal works
```

The `--deploy-hook` on each cert reloads nginx after a renewal (covers
Zitadel too, since its TLS terminates at nginx).

## For `provision.js`

Its DNS step (`ionosCreateA`) needs the key as **one string**:

```bash
export IONOS_API_KEY="<prefix>.<secret>"
```

Set it in the environment where you run `provision.js` (or a root-only
`/etc/ops/provision.env` sourced before it).
