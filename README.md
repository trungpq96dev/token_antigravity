# Antigravity Token Usage Dashboard (Multi-Account)

## Mô tả dự án
Giao diện Web theo dõi lượng token còn lại của **Antigravity** với phong cách Dark Mode tối giản (đối chiếu chuẩn theo `ui-mockup.png`), hỗ trợ **chuyển đổi nhanh giữa nhiều tài khoản (Switch Account)**, đồng bộ dữ liệu thực tế từ Antigravity IDE local hoặc API bên ngoài, và lưu cấu hình + API key an toàn trên trình duyệt (`localStorage`).

## Cấu trúc thư mục
- `index.html`: Giao diện Dashboard hoàn chỉnh (HTML + Tailwind CSS + Vanilla JS), hỗ trợ quản lý đa tài khoản, Top-up, Alert Settings, Transaction History và đồng bộ API.
- `server.js`: Node.js local server (zero dependencies) phục vụ static files và cung cấp 2 endpoints:
  - `GET /api/local-antigravity`: Đọc dữ liệu phiên làm việc từ `~/.gemini/antigravity/brain` để ước tính token sử dụng theo tác vụ và biểu đồ 7 ngày gần nhất.
  - `POST /api/fetch-usage`: Proxy đồng bộ quota cho OpenRouter, Gemini API Key, hoặc Custom Endpoint (không lưu API key xuống ổ đĩa).
- `scripts/build.js`: Script đóng gói bản static production ra thư mục `dist/`.
- `vercel.json` & `netlify.toml`: Cấu hình deploy nhanh lên Vercel / Netlify.
- `.env.example`: Mẫu biến môi trường cho local server (không commit `.env` lên Git).
- `ui-mockup.png`: Ảnh thiết kế giao diện mẫu.

## Hướng dẫn chạy & Build

### 1. Chạy local server (kèm đồng bộ Antigravity IDE)
```bash
npm start
```
Mở trình duyệt tại `http://localhost:3000`.

### 2. Build bản production tĩnh (`dist/`)
```bash
npm run build
```
Xem thử bản đã build:
```bash
npm run preview
```

### 3. Cấu hình tài khoản & API Key an toàn
- Nhấn vào bộ chuyển tài khoản ở góc trên bên phải → **+ Thêm tài khoản mới** hoặc **⚙ Cấu hình API & hạn mức tài khoản hiện tại**.
- Chọn nguồn dữ liệu:
  - **Local Antigravity IDE**: Tự động đọc từ thư mục `~/.gemini/antigravity` khi chạy `npm start`.
  - **OpenRouter API / Google Gemini API / Custom Endpoint**: Nhập API Key trực tiếp trên giao diện; key chỉ được lưu trong `localStorage` của trình duyệt, không hardcode lên mã nguồn hay Git.

## Đẩy code lên GitHub & Deploy
```bash
git init
git add .
git commit -m "feat: antigravity multi-account token dashboard"
git branch -M main
git remote add origin https://github.com/trungpq96dev/antigravity-tracker.git
git push -u origin main
```
Sau đó deploy thư mục `dist/` (hoặc kết nối trực tiếp repo GitHub) lên **Vercel**, **Netlify**, hoặc **Cloudflare Pages**.
