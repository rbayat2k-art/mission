#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/home/taprasystem/rahkar"
APP_NAME="rahkar-taprasystem"
SYSTEMD_SERVICE="rahkar-taprasystem.service"
BRANCH="main"
HEALTH_URL="http://127.0.0.1:3000/api/health"

fail() {
  printf 'DEPLOY FAILED: %s\n' "$1" >&2
  exit 1
}

cd "$APP_DIR"

command -v git >/dev/null 2>&1 || fail "git is not installed"
command -v node >/dev/null 2>&1 || fail "node is not installed"
command -v npm >/dev/null 2>&1 || fail "npm is not installed"
command -v curl >/dev/null 2>&1 || fail "curl is not installed"
test -f .env || fail ".env is missing"
test -d .git || fail "application directory is not a Git checkout"

CURRENT_BRANCH="$(git branch --show-current)"
test "$CURRENT_BRANCH" = "$BRANCH" || fail "expected branch $BRANCH, found $CURRENT_BRANCH"

if test -n "$(git status --porcelain --untracked-files=no)"; then
  fail "tracked production files contain local changes"
fi

PREVIOUS_COMMIT="$(git rev-parse HEAD)"
git fetch --prune origin "$BRANCH"
git merge --ff-only "origin/$BRANCH"
CURRENT_COMMIT="$(git rev-parse HEAD)"

npm ci
npm run build
npm run db:backup
npm run db:migrate

if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "$SYSTEMD_SERVICE"; then
  SYSTEMD_WORKING_DIRECTORY="$(systemctl show "$SYSTEMD_SERVICE" --property=WorkingDirectory --value)"
  test "$SYSTEMD_WORKING_DIRECTORY" = "$APP_DIR" || fail "unexpected systemd working directory: $SYSTEMD_WORKING_DIRECTORY"
  SYSTEMD_PID="$(systemctl show "$SYSTEMD_SERVICE" --property=MainPID --value)"
  case "$SYSTEMD_PID" in
    ''|*[!0-9]*) fail "invalid systemd MainPID" ;;
  esac
  test "$SYSTEMD_PID" -gt 1 || fail "systemd service has no safe MainPID"
  kill -TERM "$SYSTEMD_PID"
  for attempt in {1..30}; do
    NEW_SYSTEMD_PID="$(systemctl show "$SYSTEMD_SERVICE" --property=MainPID --value)"
    if test "$NEW_SYSTEMD_PID" != "$SYSTEMD_PID" && test "$NEW_SYSTEMD_PID" -gt 1 2>/dev/null; then
      break
    fi
    sleep 1
  done
  printf 'Restarted %s through systemd (PM2 fallback remains available).\n' "$SYSTEMD_SERVICE"
else
  command -v pm2 >/dev/null 2>&1 || fail "pm2 is not installed"
  pm2 startOrReload ecosystem.config.cjs --only "$APP_NAME" --update-env
  pm2 save
fi

for attempt in {1..30}; do
  if curl --fail --silent --show-error "$HEALTH_URL" >/dev/null; then
    printf 'DEPLOY OK: %s -> %s\n' "$PREVIOUS_COMMIT" "$CURRENT_COMMIT"
    exit 0
  fi
  sleep 2
done

pm2 logs "$APP_NAME" --lines 80 --nostream || true
fail "health check did not pass: $HEALTH_URL"
