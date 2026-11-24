#!/usr/bin/env bash
set -euo pipefail

echo "=========================================================="
echo "  Antigravity Live % Quota Collector — Ubuntu Installer"
echo "=========================================================="

if [ "$(id -u)" -ne 0 ]; then
  echo "Vui lòng chạy với quyền root (thêm sudo ở đầu lệnh)."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
echo "[1/5] Cài đặt các gói cơ bản (curl, git, tmux, jq)..."
apt-get update -qq
apt-get install -y -qq curl git tmux jq ca-certificates gnupg

# Install Node.js 20+ if missing or < v18
NEED_NODE=1
if command -v node >/dev/null 2>&1; then
  NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]" 2>/dev/null || echo "0")
  if [ "${NODE_MAJOR}" -ge 18 ]; then
    NEED_NODE=0
  fi
fi

if [ "${NEED_NODE}" -eq 1 ]; then
  echo "[2/5] Cài đặt Node.js 20 LTS..."
  mkdir -p /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_20.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq
  apt-get install -y -qq nodejs
else
  echo "[2/5] Node.js $(node -v) đã được cài đặt."
fi

echo "[3/6] Cài đặt Google Antigravity CLI (agy) và Cloudflare Tunnel (cloudflared)..."
if ! command -v agy >/dev/null 2>&1 && [ ! -x /usr/local/bin/agy ]; then
  curl -fsSL https://antigravity.google/cli/install.sh | bash
  if [ -x "${HOME}/.local/bin/agy" ]; then
    cp -f "${HOME}/.local/bin/agy" /usr/local/bin/agy
    chmod 755 /usr/local/bin/agy
  fi
else
  echo "  -> agy CLI đã sẵn sàng."
fi

if [ ! -x /usr/local/bin/cloudflared ]; then
  ARCH=$(dpkg --print-architecture 2>/dev/null || uname -m)
  case "${ARCH}" in
    amd64|x86_64) CF_ARCH="amd64" ;;
    arm64|aarch64) CF_ARCH="arm64" ;;
    armhf|armv7l) CF_ARCH="arm" ;;
    *) CF_ARCH="amd64" ;;
  esac
  echo "  -> Tải cloudflared (${CF_ARCH})..."
  curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${CF_ARCH}" -o /usr/local/bin/cloudflared
  chmod 755 /usr/local/bin/cloudflared
else
  echo "  -> cloudflared đã sẵn sàng."
fi

echo "[4/6] Tải mã nguồn bộ thu thập vào /opt/ag-tracker..."
mkdir -p /opt/ag-tracker/profiles /opt/ag-tracker/state
if [ -d /opt/ag-tracker/repo/.git ]; then
  git -C /opt/ag-tracker/repo fetch origin main
  git -C /opt/ag-tracker/repo reset --hard origin/main
else
  git clone https://github.com/trungpq96dev/token_antigravity.git /opt/ag-tracker/repo
fi
chmod +x /opt/ag-tracker/repo/ubuntu/statusline-hook.sh
chmod +x /opt/ag-tracker/repo/ubuntu/daemon.js
chmod +x /opt/ag-tracker/repo/ubuntu/tunnel-runner.sh

if [ ! -f /opt/ag-tracker/config.json ]; then
  cat > /opt/ag-tracker/config.json <<'EOF'
{
  "repoUrl": "https://github.com/trungpq96dev/token_antigravity.git",
  "gitToken": "",
  "branch": "quota-data",
  "extraAliases": {}
}
EOF
  chmod 600 /opt/ag-tracker/config.json
fi

# Create `ag-tracker` helper CLI
cat > /usr/local/bin/ag-tracker <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

CMD="${1:-help}"
SHIFT_ARG="${2:-}"

case "${CMD}" in
  login)
    if [ -z "${SHIFT_ARG}" ]; then
      echo "Cách dùng: sudo ag-tracker login <ten_tai_khoan>  (VD: sudo ag-tracker login acc1)"
      exit 1
    fi
    PROFILE_DIR="/opt/ag-tracker/profiles/${SHIFT_ARG}"
    mkdir -p "${PROFILE_DIR}/.gemini/antigravity-cli"
    cat > "${PROFILE_DIR}/.gemini/antigravity-cli/settings.json" <<JSON
{
  "altScreenMode": "always",
  "statusLine": {
    "type": "command",
    "command": "/opt/ag-tracker/repo/ubuntu/statusline-hook.sh",
    "enabled": true,
    "stack_with_default": true
  }
}
JSON
    echo "=========================================================="
    echo " Đang mở Antigravity CLI cho tài khoản: ${SHIFT_ARG}"
    echo " 1. Mở đường link Google OAuth hiện ra bên dưới trên trình duyệt"
    echo " 2. Đăng nhập Google và dán mã xác nhận vào đây"
    echo " 3. Khi vào màn hình chat chính, gõ /usage để kiểm tra rồi bấm Ctrl+D 2 lần để thoát"
    echo "=========================================================="
    systemctl stop ag-tracker >/dev/null 2>&1 || true
    tmux kill-session -t "agy_${SHIFT_ARG}" >/dev/null 2>&1 || true
    HOME="${PROFILE_DIR}" /usr/local/bin/agy || true
    systemctl start ag-tracker
    echo "Đã lưu phiên đăng nhập cho '${SHIFT_ARG}' và khởi động lại dịch vụ chạy ngầm!"
    ;;
  set-token)
    if [ -z "${SHIFT_ARG}" ]; then
      echo "Cách dùng: sudo ag-tracker set-token <GITHUB_PERSONAL_ACCESS_TOKEN>"
      exit 1
    fi
    TMP_CFG=$(mktemp)
    jq --arg tok "${SHIFT_ARG}" '.gitToken = $tok' /opt/ag-tracker/config.json > "${TMP_CFG}"
    mv "${TMP_CFG}" /opt/ag-tracker/config.json
    chmod 600 /opt/ag-tracker/config.json
    echo "Đã lưu GitHub Token thành công! Đang đẩy thử dữ liệu..."
    node /opt/ag-tracker/repo/ubuntu/daemon.js --once
    systemctl restart ag-tracker
    ;;
  status)
    node /opt/ag-tracker/repo/ubuntu/daemon.js --status
    ;;
  sync)
    node /opt/ag-tracker/repo/ubuntu/daemon.js --once
    ;;
  tunnel)
    if [ -f /opt/ag-tracker/state/tunnel-url.txt ]; then
      echo "⚡ Realtime Cloudflare Tunnel URL: $(cat /opt/ag-tracker/state/tunnel-url.txt)"
    else
      echo "⏳ Cloudflare Tunnel đang khởi động... Xem log: journalctl -u ag-tunnel -n 20"
    fi
    systemctl is-active ag-tunnel ag-tracker || true
    ;;
  update)
    systemctl stop ag-tracker ag-tunnel >/dev/null 2>&1 || true
    git -C /opt/ag-tracker/repo fetch origin main
    git -C /opt/ag-tracker/repo reset --hard origin/main
    chmod +x /opt/ag-tracker/repo/ubuntu/statusline-hook.sh /opt/ag-tracker/repo/ubuntu/daemon.js /opt/ag-tracker/repo/ubuntu/tunnel-runner.sh
    systemctl start ag-tunnel
    sleep 4
    node /opt/ag-tracker/repo/ubuntu/daemon.js --once
    systemctl start ag-tracker
    ;;
  logs)
    journalctl -u ag-tracker -u ag-tunnel -f -n 50
    ;;
  *)
    echo "Các lệnh quản lý Antigravity Quota Tracker:"
    echo "  sudo ag-tracker login <ten>       - Đăng nhập thêm 1 tài khoản Google Antigravity"
    echo "  sudo ag-tracker set-token <PAT>   - Cài GitHub Token để tự động đẩy dữ liệu lên web"
    echo "  sudo ag-tracker status            - Xem trực tiếp % các tài khoản ngay trên Ubuntu"
    echo "  sudo ag-tracker tunnel            - Xem link Cloudflare Tunnel Realtime đang chạy"
    echo "  sudo ag-tracker sync              - Ép cập nhật và đẩy lên GitHub ngay lập tức"
    echo "  sudo ag-tracker update            - Cập nhật code mới nhất và khởi động lại"
    echo "  sudo ag-tracker logs              - Xem nhật ký chạy ngầm (collector + tunnel)"
    ;;
esac
EOF
chmod 755 /usr/local/bin/ag-tracker

echo "[5/6] Cấu hình dịch vụ chạy ngầm systemd (ag-tracker.service)..."
cat > /etc/systemd/system/ag-tracker.service <<'EOF'
[Unit]
Description=Antigravity Live Quota Collector + Realtime HTTP API
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/ag-tracker/repo
ExecStart=/usr/bin/node /opt/ag-tracker/repo/ubuntu/daemon.js
Restart=always
RestartSec=10
Environment=AG_POLL_INTERVAL_MS=60000
Environment=AG_HTTP_PORT=3888

[Install]
WantedBy=multi-user.target
EOF

echo "[6/6] Cấu hình dịch vụ Cloudflare Tunnel Realtime (ag-tunnel.service)..."
cat > /etc/systemd/system/ag-tunnel.service <<'EOF'
[Unit]
Description=Antigravity Realtime Cloudflare Tunnel (Quick/Named)
After=network-online.target ag-tracker.service
Wants=network-online.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/ag-tracker/repo
ExecStart=/opt/ag-tracker/repo/ubuntu/tunnel-runner.sh
Restart=always
RestartSec=5
Environment=AG_HTTP_PORT=3888

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable ag-tracker ag-tunnel >/dev/null 2>&1
systemctl restart ag-tunnel
sleep 4
systemctl restart ag-tracker

echo ""
echo "✅ CÀI ĐẶT HOÀN TẤT (CHẾ ĐỘ KẾT HỢP A + B REALTIME)!"
if [ -f /opt/ag-tracker/state/tunnel-url.txt ]; then
  echo "⚡ Cloudflare Tunnel Realtime: $(cat /opt/ag-tracker/state/tunnel-url.txt)"
fi
echo "----------------------------------------------------------"
echo "Bước tiếp theo (chỉ làm 1 lần ngay tại terminal này):"
echo "  1) Đăng nhập tài khoản Google Antigravity:"
echo "     sudo ag-tracker login acc1"
echo ""
echo "  2) Gắn GitHub Personal Access Token (quyền repo/contents) để tự đẩy lên web:"
echo "     sudo ag-tracker set-token <GITHUB_PAT>"
echo ""
echo "  3) Kiểm tra % ngay trên terminal:"
echo "     sudo ag-tracker status"
echo "----------------------------------------------------------"
