#!/usr/bin/env bash
set -euo pipefail

STATE_DIR="/opt/ag-tracker/state"
URL_FILE="${STATE_DIR}/tunnel-url.txt"
CONFIG_FILE="/opt/ag-tracker/config.json"
LOCAL_PORT="${AG_HTTP_PORT:-3888}"

mkdir -p "${STATE_DIR}"
rm -f "${URL_FILE}"

# Optional: if user configured a permanent Cloudflare Named Tunnel token in config.json
CF_TOKEN=""
if [ -f "${CONFIG_FILE}" ] && command -v jq >/dev/null 2>&1; then
  CF_TOKEN=$(jq -r '.cfTunnelToken // ""' "${CONFIG_FILE}" 2>/dev/null || echo "")
  CUSTOM_URL=$(jq -r '.customTunnelUrl // ""' "${CONFIG_FILE}" 2>/dev/null || echo "")
  if [ -n "${CUSTOM_URL}" ]; then
    printf '%s' "${CUSTOM_URL}" > "${URL_FILE}"
  fi
fi

if [ -n "${CF_TOKEN}" ]; then
  echo "[ag-tunnel] Starting permanent Named Cloudflare Tunnel..."
  exec /usr/local/bin/cloudflared tunnel --no-autoupdate run --token "${CF_TOKEN}"
fi

echo "[ag-tunnel] Starting free Cloudflare Quick Tunnel -> http://127.0.0.1:${LOCAL_PORT} ..."
/usr/local/bin/cloudflared tunnel --no-autoupdate --url "http://127.0.0.1:${LOCAL_PORT}" 2>&1 | while IFS= read -r line; do
  echo "${line}"
  if [[ "${line}" =~ (https://[a-zA-Z0-9-]+\.trycloudflare\.com) ]]; then
    FOUND_URL="${BASH_REMATCH[1]}"
    printf '%s' "${FOUND_URL}" > "${URL_FILE}.tmp"
    mv -f "${URL_FILE}.tmp" "${URL_FILE}"
    echo "[ag-tunnel] Live Realtime URL captured: ${FOUND_URL}"
  fi
done
