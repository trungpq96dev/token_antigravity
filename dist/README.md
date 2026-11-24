# Antigravity Token % Quota Dashboard (Multi-Account + Ubuntu 24/7 Collector)

Giao diện Web theo dõi `%` hạn mức còn lại của **Antigravity** (**Gemini Models** & **Claude/GPT models** — Weekly & Five Hour Limit Remaining), hỗ trợ chuyển đổi nhanh nhiều tài khoản và tự động thu thập `%` thật 24/7 từ máy chủ Ubuntu thông qua **Google Antigravity CLI (`agy`)**.

- **Web Public:** https://trungpq96dev.github.io/token_antigravity/

---

## Cài đặt 1 chạm trên Ubuntu Server (Cockpit Terminal)

Mở terminal trên Ubuntu (`https://192.168.0.50:9090/system/terminal`) và dán duy nhất dòng lệnh sau:

```bash
curl -fsSL https://raw.githubusercontent.com/trungpq96dev/token_antigravity/main/ubuntu/setup-ubuntu.sh | sudo bash
```

Sau khi cài xong, chạy 2 lệnh sau (chỉ làm 1 lần):

1. **Đăng nhập tài khoản Google Antigravity trên Ubuntu:**
   ```bash
   sudo ag-tracker login acc1
   ```
   *(Mở link Google OAuth hiện ra trên màn hình, đăng nhập, dán mã xác thực vào terminal. Nếu có nhiều tài khoản, chạy tiếp `sudo ag-tracker login ten_tai_khoan_2`.)*

2. **Gắn GitHub Personal Access Token để tự động đẩy dữ liệu mã hóa lên nhánh `quota-data`:**
   ```bash
   sudo ag-tracker set-token ghp_xxxxxxxxxxxxxxxxxxxx
   ```

3. **Kiểm tra trạng thái bất cứ lúc nào:**
   ```bash
   sudo ag-tracker status
   sudo ag-tracker logs
   ```

### Cơ chế đồng bộ thông minh 1 phút/lần (`Smart-Diff`)
- Dịch vụ `ag-tracker.service` trên Ubuntu kiểm tra lệnh `/usage` của `agy` **mỗi 60 giây** (không gọi LLM nên tốn **0% token**).
- **Chỉ khi số `%` thực sự thay đổi**, Ubuntu mới mã hóa `AES-256-GCM` vào `cloud-vault.json` và ghi đè 1 commit duy nhất lên nhánh độc lập `quota-data` — giúp cập nhật trong 1 phút mà **không làm phình dung lượng Git** và **không chạm giới hạn build của GitHub Pages**.

---

## Chạy & Build trên máy Local
```bash
npm start      # Chạy local server tại http://localhost:3000
npm run build  # Đóng gói ra thư mục dist/
```
