# Hướng Dẫn Chuyển Đổi Container Paperclip Và Giữ Nguyên Dữ Liệu Cũ

Tài liệu này hướng dẫn cách tạo một Container Paperclip mới (ví dụ cập nhật phiên bản, đổi tên) nhưng vẫn giữ lại toàn bộ dữ liệu (tài khoản, mật khẩu, database) từ một Volume cũ, đồng thời tránh các lỗi bảo mật của Better Auth.

---

## 1. Hai "Quy Tắc Vàng" Tránh Lỗi Đăng Nhập

Khi bạn mount một volume cũ (ví dụ `paperclip_data`) vào một Container mới, bạn đang cắm một "chiếc ổ cứng đã có sẵn hệ điều hành". Do đó, bạn BẮT BUỘC phải tuân thủ 2 quy tắc sau:

1. **Phải giữ nguyên `BETTER_AUTH_SECRET`:** 
   - Đây là "chìa khóa" mã hóa toàn bộ phiên đăng nhập của hệ thống cũ. Nếu bạn đổi chuỗi này, hệ thống sẽ từ chối mọi phiên đăng nhập cũ, khiến bạn không thể vào lại tài khoản.
2. **Không tự ý đổi Port/URL nếu không chỉnh sửa `config.json`:**
   - URL truy cập (ví dụ `localhost:3100`) đã được ghi chết (hardcode) vào file `/paperclip/instances/default/config.json` nằm bên trong volume. 
   - Nếu bạn mớm biến môi trường `-e BETTER_AUTH_URL=http://localhost:3200` vào Docker Run, nó sẽ **bị vô hiệu hóa** bởi file `config.json` này.

---

## 2. Kịch Bản 1: Giữ Nguyên Port Cũ (Khuyên Dùng - Dễ Nhất)

Đây là cách an toàn nhất. Nếu Volume cũ của bạn đang chạy ở port 3100, hãy tiếp tục dùng port 3100 cho Container mới.

**Bước 1:** Xóa container cũ (để giải phóng port 3100)
```bash
docker rm -f paperclip-n8n-test
```

**Bước 2:** Chạy Container mới với đúng cấu hình URL và Secret cũ
```powershell
docker run -d `
--name paperclip-n8n-test-new `
-p 3100:3100 `
-v paperclip_data:/paperclip `
-e PAPERCLIP_DEPLOYMENT_MODE=authenticated `
-e BETTER_AUTH_SECRET=<nhập_lại_chuỗi_secret_cũ_vào_đây> `
-e BETTER_AUTH_URL=http://localhost:3100 `
paperclip:n8n-test
```

**Bước 3:** Truy cập `http://localhost:3100` bằng **Tab Ẩn Danh (Incognito)** để đăng nhập.

---


## 3. Bắt Bệnh & Xử Lý Lỗi Thường Gặp

### Lỗi 1: `ERROR [Better Auth]: Invalid origin: http://localhost:3200`
- **Triệu chứng:** Console của Docker nhảy liên tục các dòng đỏ báo `POST /api/auth/sign-out 403` và `Invalid origin`. Giao diện không cho đăng nhập.
- **Nguyên nhân:** Trình duyệt của bạn đang kẹt Cookie (thẻ phiên) của Port cũ. Khi sang trang mới, trình duyệt gửi tự động lệnh `sign-out`, nhưng Backend từ chối lệnh này do sai địa chỉ gốc (origin), tạo thành vòng lặp vô tận.
- **Cách sửa Triệt để:** 
  1. Mở trang web, ấn phím **F12** -> Chuyển sang Tab **Application** (hoặc Storage).
  2. Bấm vào **Cookies** ở cột bên trái -> Chọn tên miền của bạn (`localhost:3100` hoặc `3200`).
  3. Xóa sạch mọi thứ (Clear All).
  4. Hoặc đơn giản nhất: Dùng **Tab Ẩn danh (Ctrl + Shift + N)**.

### Lỗi 2: Báo sai Mật khẩu / Đăng nhập không được dù đúng mật khẩu
- **Triệu chứng:** Đăng nhập báo lỗi `401 Unauthorized` hoặc tự động văng ra ngay lập tức.
- **Nguyên nhân:** Bạn đã nhập sai mã `BETTER_AUTH_SECRET`. Nút thắt bảo mật bị lệch khiến Cookie không giải mã được.
- **Cách sửa:** Hủy Container hiện tại, tạo lại Container mới và đảm bảo truyền đúng 100% cái mã Secret của quá khứ. 

### Lỗi 3: Lỗi 42P07 `relation "agent_runtime_state" already exists`
- **Triệu chứng:** Container không chịu chạy, log báo lỗi Migration PostgreSQL.
- **Nguyên nhân:** Dữ liệu cũ đang dùng khác phiên bản Database với Container mới, hoặc lần chạy Database cũ bị tắt ngang (Ctrl+C) khi đang tạo bảng.
- **Cách sửa:** Xóa trắng Volume (`docker rm -v`) để Database tạo lại từ số 0, hoặc chui vào Postgres để Drop bảng bị kẹt bằng tay.
