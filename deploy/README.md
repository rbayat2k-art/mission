# TAPRA production runtime

## Canonical process manager: systemd

Production runs from `/home/taprasystem/rahkar` as
`rahkar-taprasystem.service`. This is the service that is actually enabled on
the server; PM2 is not part of the normal release path.

The application account cannot install system units. The alert checker is
therefore registered as one idempotent user-crontab entry marked
`tapra-tracking-alerts`. Its database advisory lock prevents overlapping runs.

The normal `deploy.sh` flow is:

1. verify branch, clean tracked files, active systemd unit and working directory;
2. fast-forward from `origin/main`;
3. install locked dependencies, build, and create a database backup;
4. temporarily suspend the existing process while additive migrations and the
   one-time score-ledger opening reconciliation run;
5. install/update the single alert-checker cron entry;
6. resume and terminate the old PID so systemd starts the new build;
7. require the internal health check to pass.

The opening score-ledger backfill has a durable completion marker. Re-running
deployment performs reconciliation but cannot create opening balances for new
post-cutover rows. The ledger remains shadow-only; existing score columns remain
the product source of truth.

After deployment verify:

```bash
systemctl status rahkar-taprasystem.service --no-pager
crontab -l | grep tapra-tracking-alerts
curl --fail http://127.0.0.1:3000/api/health
journalctl -u rahkar-taprasystem.service -n 80 --no-pager
tail -n 80 storage/logs/tracking-alerts.log
```

Heartbeat and accepted-location ingress update presence immediately. Stale
contact or trusted-GPS alerts are checked every minute. The documented
worst-case recovery delay is 60 seconds. Tracking alerts never change work time
or score.

## Nginx and client IP trust

`nginx.conf` is the safe default while the CDN provider and its official proxy
ranges are not confirmed. It strips `X-Tapra-Client-IP`, so account-based login
limiting remains active while the optional IP bucket remains disabled. It also
overwrites, rather than appends to, any inbound `X-Forwarded-For` value.

`nginx-cdn-real-ip.example.conf` is intentionally unusable until its explicit
placeholders are replaced with the CDN provider's current official proxy CIDRs,
client-IP header, and public hostname. Never guess these values. The origin must
also reject direct public traffic that bypasses the trusted CDN before enabling
the IP bucket.
