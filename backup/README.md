# backup/

Nightly database backups for both VPSes. Full setup, restore procedure, and
the rebuild-from-zero runbook are in **[docs/backups.md](../docs/backups.md)**.

| file | what |
|---|---|
| `backup.sh` | the job: `pg_dump -Fc` every DB → rclone to object storage (client-side encrypted) → verify → prune → healthcheck ping |
| `restore.sh` | restore one dump into a named DB (`restore.sh <dump\|rclone:path> <target-db>`) |
| `config.env.example` | copy to `/etc/ops/backup.env` (per host, gitignored) |
| `systemd/` | `ops-backup.{service,timer}` + the `OnFailure=` hook |

Quick start on a VPS:

```bash
sudo apt install -y rclone
sudo install -m 600 /opt/ops/backup/config.env.example /etc/ops/backup.env
# configure rclone remotes + edit /etc/ops/backup.env — see docs/backups.md
sudo cp /opt/ops/backup/systemd/ops-backup* /etc/systemd/system/
sudo chmod +x /opt/ops/backup/*.sh
sudo systemctl daemon-reload && sudo systemctl enable --now ops-backup.timer
sudo systemctl start ops-backup.service && journalctl -u ops-backup.service -f
```
