#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/home/taprasystem/rahkar"
APP_NAME="rahkar-taprasystem"
SYSTEMD_SERVICE="rahkar-taprasystem.service"
TRACKING_CRON_MARKER="# tapra-tracking-alerts"
BRANCH="main"
HEALTH_URL="http://127.0.0.1:3000/api/health"
APP_SUSPENDED=0

fail() {
  printf 'DEPLOY FAILED: %s\n' "$1" >&2
  exit 1
}

resume_app_if_needed() {
  if test "$APP_SUSPENDED" = "1" && test -n "${SYSTEMD_PID:-}"; then
    kill -CONT "$SYSTEMD_PID" 2>/dev/null || true
  fi
}
trap resume_app_if_needed EXIT

cd "$APP_DIR"

command -v git >/dev/null 2>&1 || fail "git is not installed"
command -v node >/dev/null 2>&1 || fail "node is not installed"
command -v npm >/dev/null 2>&1 || fail "npm is not installed"
command -v curl >/dev/null 2>&1 || fail "curl is not installed"
command -v systemctl >/dev/null 2>&1 || fail "systemctl is not installed"
command -v crontab >/dev/null 2>&1 || fail "crontab is not installed"
test -f .env || fail ".env is missing"
test -d .git || fail "application directory is not a Git checkout"

CURRENT_BRANCH="$(git branch --show-current)"
test "$CURRENT_BRANCH" = "$BRANCH" || fail "expected branch $BRANCH, found $CURRENT_BRANCH"
if test -n "$(git status --porcelain --untracked-files=no)"; then
  fail "tracked production files contain local changes"
fi

systemctl is-active --quiet "$SYSTEMD_SERVICE" || fail "$SYSTEMD_SERVICE is not active"
SYSTEMD_WORKING_DIRECTORY="$(systemctl show "$SYSTEMD_SERVICE" --property=WorkingDirectory --value)"
test "$SYSTEMD_WORKING_DIRECTORY" = "$APP_DIR" || fail "unexpected systemd working directory: $SYSTEMD_WORKING_DIRECTORY"

PREVIOUS_COMMIT="$(git rev-parse HEAD)"
git fetch --prune origin "$BRANCH"
git merge --ff-only "origin/$BRANCH"
CURRENT_COMMIT="$(git rev-parse HEAD)"

npm ci
node scripts/ensure-vapid.mjs .env
npm run build
npm run db:backup

# Freeze the old process during additive migration and the opening ledger
# reconciliation so score-changing requests cannot race the maintenance step.
SYSTEMD_PID="$(systemctl show "$SYSTEMD_SERVICE" --property=MainPID --value)"
[[ "$SYSTEMD_PID" =~ ^[1-9][0-9]*$ ]] || fail "invalid systemd MainPID"
kill -STOP "$SYSTEMD_PID"
APP_SUSPENDED=1

npm run db:migrate
SCORE_LEDGER_BACKFILL_CUTOFF="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
  SCORE_LEDGER_BACKFILL_MAINTENANCE=confirmed npm run score-ledger:backfill

mkdir -p storage/logs
CURRENT_CRONTAB="$(crontab -l 2>/dev/null || true)"
FILTERED_CRONTAB="$(printf '%s\n' "$CURRENT_CRONTAB" | grep -Fv "$TRACKING_CRON_MARKER" || true)"
TRACKING_CRON="* * * * * cd $APP_DIR && /usr/local/bin/node --env-file-if-exists=.env scripts/check-tracking-alerts.mjs >> storage/logs/tracking-alerts.log 2>&1 $TRACKING_CRON_MARKER"
printf '%s\n%s\n' "$FILTERED_CRONTAB" "$TRACKING_CRON" | crontab -

kill -CONT "$SYSTEMD_PID"
APP_SUSPENDED=0
kill -TERM "$SYSTEMD_PID"
for attempt in {1..30}; do
  NEW_SYSTEMD_PID="$(systemctl show "$SYSTEMD_SERVICE" --property=MainPID --value)"
  if [[ "$NEW_SYSTEMD_PID" =~ ^[1-9][0-9]*$ ]] && test "$NEW_SYSTEMD_PID" != "$SYSTEMD_PID"; then
    break
  fi
  sleep 1
done

for attempt in {1..30}; do
  if curl --fail --silent --show-error "$HEALTH_URL" >/dev/null; then
    printf 'DEPLOY OK: %s -> %s\n' "$PREVIOUS_COMMIT" "$CURRENT_COMMIT"
    exit 0
  fi
  sleep 2
done

systemctl status "$SYSTEMD_SERVICE" --no-pager || true
journalctl -u "$SYSTEMD_SERVICE" -n 80 --no-pager || true
fail "health check did not pass: $HEALTH_URL"
