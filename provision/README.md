# provision/

Stand up / tear down an Ops customer instance on the shared VPS.

```bash
node provision/provision.js <slug> "<Display Name>" <admin-email> [--dry-run]
node provision/deprovision.js <slug> --yes
```

Full guide + host setup: [`docs/provisioning.md`](../docs/provisioning.md).

- `config.json` — per-host config (gitignored; copy from `config.example.json`)
- `templates/` — `env`, `config.js`, nginx vhost, systemd unit/target
- `seed/` — `reference-data.sql` (lookup data, populate once) + `seed-instance.sql`
