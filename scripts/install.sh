#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

SERVICE_NAME="${SERVICE_NAME:-auto-deploy}"
ENV_FILE="${ENV_FILE:-/etc/auto-deploy.env}"
LOCAL_ENV_FILE="${LOCAL_ENV_FILE:-$REPO_DIR/.env}"
EXAMPLE_ENV_FILE="${EXAMPLE_ENV_FILE:-$REPO_DIR/.env.example}"

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "error: install.sh must run as root because it writes systemd and env files" >&2
  exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
  if [[ -f "$LOCAL_ENV_FILE" ]]; then
    install -m 600 "$LOCAL_ENV_FILE" "$ENV_FILE"
    echo "created $ENV_FILE from $LOCAL_ENV_FILE"
  elif [[ -f "$EXAMPLE_ENV_FILE" ]]; then
    install -m 600 "$EXAMPLE_ENV_FILE" "$ENV_FILE"
    echo "created $ENV_FILE from $EXAMPLE_ENV_FILE"
    echo "edit $ENV_FILE with real values, then run this script again" >&2
    exit 1
  else
    echo "error: neither $LOCAL_ENV_FILE nor $EXAMPLE_ENV_FILE exists" >&2
    exit 1
  fi
else
  chmod 600 "$ENV_FILE"
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

if [[ -z "${BASE_DIR:-}" ]]; then
  echo "error: BASE_DIR is required in $ENV_FILE" >&2
  exit 1
fi

if [[ -z "${GITHUB_WEBHOOK_SECRET:-}" || "$GITHUB_WEBHOOK_SECRET" == "replace-with-github-webhook-secret" ]]; then
  echo "error: set a real GITHUB_WEBHOOK_SECRET in $ENV_FILE" >&2
  exit 1
fi

APP_DIR="${APP_DIR:-${BASE_DIR%/}/autodeploy}"
LOG_FILE="${LOG_FILE:-$APP_DIR/data/logs/deploy.log}"

install -d -m 750 "$(dirname "$LOG_FILE")"
touch "$LOG_FILE"
chmod 640 "$LOG_FILE"

SERVICE_NAME="$SERVICE_NAME" ENV_FILE="$ENV_FILE" "$SCRIPT_DIR/deploy.sh"
