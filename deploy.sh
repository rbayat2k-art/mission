#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="/home/taprasystem/rahkar"
APP_NAME="rahkar-taprasystem"
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
command -v pm2 >/dev/null 2>&1 || fail "pm2 is not installed"
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

pm2 startOrReload ecosystem.config.cjs --only "$APP_NAME" --update-env
pm2 save

for attempt in {1..30}; do
  if curl --fail --silent --show-error "$HEALTH_URL" >/dev/null; then
    printf 'DEPLOY OK: %s -> %s\n' "$PREVIOUS_COMMIT" "$CURRENT_COMMIT"
    exit 0
  fi
  sleep 2
done

pm2 logs "$APP_NAME" --lines 80 --nostream || true
fail "health check did not pass: $HEALTH_URL"
