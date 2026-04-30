#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SERVICE_NAME="${SERVICE_NAME:-auto-deploy}"
ENV_FILE="${ENV_FILE:-/etc/auto-deploy.env}"
TEMPLATE_FILE="${TEMPLATE_FILE:-$SCRIPT_DIR/auto-deploy.service}"

if [[ ! -f "$ENV_FILE" ]]; then
  echo "error: env file $ENV_FILE does not exist" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

SERVICE_NAME="${SERVICE_NAME:-auto-deploy}"
UNIT_FILE="${UNIT_FILE:-/etc/systemd/system/${SERVICE_NAME}.service}"

if [[ -z "${BASE_DIR:-}" ]]; then
  echo "error: BASE_DIR is required in $ENV_FILE" >&2
  exit 1
fi

APP_DIR="${APP_DIR:-${BASE_DIR%/}/autodeploy}"
NODE_BIN="${NODE_BIN:-}"
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi

if [[ -z "$NODE_BIN" ]]; then
  echo "error: node was not found; set NODE_BIN in $ENV_FILE" >&2
  exit 1
fi

if [[ ! -f "$TEMPLATE_FILE" ]]; then
  echo "error: service template $TEMPLATE_FILE does not exist" >&2
  exit 1
fi

if [[ ! -f "$APP_DIR/scripts/auto-deploy-webhook.js" ]]; then
  echo "error: webhook script not found at $APP_DIR/scripts/auto-deploy-webhook.js" >&2
  exit 1
fi

install -d "$(dirname "$UNIT_FILE")"
sed \
  -e "s#__ENV_FILE__#$ENV_FILE#g" \
  -e "s#__APP_DIR__#$APP_DIR#g" \
  -e "s#__NODE_BIN__#$NODE_BIN#g" \
  "$TEMPLATE_FILE" > "$UNIT_FILE"

systemctl daemon-reload
systemctl enable "$SERVICE_NAME"
systemctl restart "$SERVICE_NAME"
systemctl --no-pager --lines=20 status "$SERVICE_NAME"
