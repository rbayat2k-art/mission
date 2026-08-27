import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("normal deployment validates and restarts the canonical systemd app", async () => {
  const deploy = await read("../deploy.sh");
  assert.match(deploy, /APP_NAME="rahkar-taprasystem"/);
  assert.match(deploy, /SYSTEMD_SERVICE="rahkar-taprasystem\.service"/);
  assert.match(deploy, /systemctl is-active --quiet "\$SYSTEMD_SERVICE"/);
  assert.match(deploy, /kill -STOP "\$SYSTEMD_PID"/);
  assert.match(deploy, /SCORE_LEDGER_BACKFILL_MAINTENANCE=confirmed npm run score-ledger:backfill/);
  assert.match(deploy, /kill -TERM "\$SYSTEMD_PID"/);
  assert.match(deploy, /journalctl -u "\$SYSTEMD_SERVICE"/);
  assert.doesNotMatch(deploy, /pm2/);
});

test("deployment installs one idempotent per-user tracking cron", async () => {
  const deploy = await read("../deploy.sh");
  assert.match(deploy, /TRACKING_CRON_MARKER="# tapra-tracking-alerts"/);
  assert.match(deploy, /grep -Fv "\$TRACKING_CRON_MARKER"/);
  assert.match(deploy, /scripts\/check-tracking-alerts\.mjs/);
  assert.match(deploy, /crontab -/);
});

test("default Nginx disables untrusted IP buckets and overwrites inbound forwarding", async () => {
  const [safeDefault, trustedExample] = await Promise.all([
    read("../deploy/nginx.conf"),
    read("../deploy/nginx-cdn-real-ip.example.conf"),
  ]);
  assert.match(safeDefault, /proxy_set_header X-Tapra-Client-IP "";/);
  assert.match(safeDefault, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.doesNotMatch(safeDefault, /\$proxy_add_x_forwarded_for/);
  assert.match(trustedExample, /<OFFICIAL_CDN_PROXY_CIDR>/);
  assert.match(trustedExample, /<OFFICIAL_CDN_CLIENT_IP_HEADER>/);
  assert.match(trustedExample, /proxy_set_header X-Tapra-Client-IP \$remote_addr;/);
  assert.match(trustedExample, /proxy_set_header X-Forwarded-For \$remote_addr;/);
  assert.doesNotMatch(trustedExample, /\$proxy_add_x_forwarded_for/);
});

test("operations documentation matches the production systemd runtime", async () => {
  const [agents, deployReadme] = await Promise.all([read("../AGENTS.md"), read("../deploy/README.md")]);
  assert.match(agents, /canonical systemd unit `rahkar-taprasystem\.service`/);
  assert.match(deployReadme, /Canonical process manager: systemd/);
  assert.match(deployReadme, /tapra-tracking-alerts/);
});
