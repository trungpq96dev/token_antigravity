#!/usr/bin/env sh
# Antigravity CLI statusLine hook: saves live JSON state (including quota) atomically.
DEST_DIR="${HOME}/.gemini/antigravity-cli"
mkdir -p "${DEST_DIR}"
TMP_FILE="${DEST_DIR}/latest-status.json.tmp.$$"
cat > "${TMP_FILE}" 2>/dev/null || exit 0
if [ -s "${TMP_FILE}" ]; then
  mv -f "${TMP_FILE}" "${DEST_DIR}/latest-status.json"
else
  rm -f "${TMP_FILE}"
fi
# Print compact summary for terminal status line
exit 0
