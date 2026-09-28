# BÁO CÁO SỰ CỐ VÀ QUY TRÌNH KHẮC PHỤC
## Lỗi Khởi Động Embedded PostgreSQL (Port 54329) & Xung Đột Migration Drizzle

**Dự án:** Paperclip  
**Hệ điều hành:** Windows (PowerShell)  
**Thời gian phát sinh:** 28/09/2026  
**Người thực hiện & Báo cáo:** Antigravity AI Assistant

---

## 1. TỔNG QUAN SỰ CỐ

Trong quá trình phát triển và hoàn tác (rollback) thay đổi cấu trúc database (không thêm trường `taskKey` vào bảng `heartbeat_runs`), hệ thống đã gặp phải 2 sự cố liên tiếp khiến lệnh `pnpm dev` không thể khởi động:

1. **Sự cố 1 (Lệch Snapshot Migration):** Khi chạy `pnpm db:generate`, Drizzle tự động tạo ra file migration khổng lồ `0196_chunky_sunset_bain.sql` (>140KB) chứa lại toàn bộ các câu lệnh tạo bảng cũ của dự án.
2. **Sự cố 2 (Xung đột Port 54329 - Zombie Process):** Khi khởi động lại bằng `pnpm dev`, server báo lỗi crash ngay từ bước đầu do không thể mở socket trên port `54329`:
   ```text
   Error: Failed to start embedded PostgreSQL on port 54329
   LOG: could not bind IPv6 address "::1": Permission denied
   LOG: could not bind IPv4 address "127.0.0.1": Permission denied
   WARNING: could not create listen socket for "localhost"
   FATAL: could not create any TCP/IP sockets
   LOG: database system is shut down
   ```

Yêu cầu khắt khe: **Tuyệt đối không xóa thư mục database (`rm -rf data/pglite`)** nhằm bảo toàn 100% dữ liệu của các công ty, agents và issues đang có trên máy local.

---

## 2. NGUYÊN NHÂN GỐC RỄ (ROOT CAUSE ANALYSIS)

### 2.1. Lỗi Port 54329: `could not bind IPv4 address "127.0.0.1": Permission denied`
- **Nguyên nhân chính:** Khi một phiên chạy `pnpm dev` trước đó bị ngắt đột ngột (do Ctrl+C, đóng terminal hoặc bị crash do migration lỗi), tiến trình chạy ngầm `postgres.exe` (Embedded PostgreSQL) không nhận được tín hiệu shutdown mềm (graceful shutdown) từ Node.js.
- Tiến trình này tiếp tục sống ngầm dạng "Zombie Process" trên hệ điều hành Windows và tiếp tục chiếm dụng cổng TCP `54329`.
- Khi người dùng gõ lệnh `pnpm dev` mới, Paperclip cố gắng khởi tạo một tiến trình PostgreSQL nhúng mới trên cùng cổng `54329`. Do cổng này đang bị tiến trình cũ chiếm giữ, hệ thống Windows từ chối cấp phát socket (`Permission denied` / `WSAEACCES`), dẫn đến việc PostgreSQL crash ngay lập tức.

### 2.2. Lỗi Drizzle sinh file `0196_chunky_sunset_bain.sql` khổng lồ
- **Nguyên nhân chính:** Cơ chế của Drizzle Kit phụ thuộc vào các file snapshot lịch sử dạng JSON nằm trong thư mục [packages/db/src/migrations/meta](file:///c:/paperclip/packages/db/src/migrations/meta).
- Trên nhánh Git hiện tại, các file snapshot từ mốc `0100` đến `0195` không có sẵn trong thư mục `meta` (snapshot mới nhất còn lưu chỉ là `0099_snapshot.json`).
- Khi người dùng chạy lệnh `pnpm db:generate`, Drizzle Kit lấy toàn bộ định nghĩa TypeScript trong [packages/db/src/schema](file:///c:/paperclip/packages/db/src/schema) đi so sánh với `0099_snapshot.json`. Do thiếu dữ liệu lịch sử từ 100 đến 195, Drizzle tưởng rằng toàn bộ các bảng mới tạo sau này đều chưa có, nên đã tự ý nhồi nhét hàng trăm lệnh `CREATE TABLE` vào file `0196_chunky_sunset_bain.sql`.
- Nếu file này được áp dụng (execute), PostgreSQL sẽ ném lỗi `PostgresError: relation "..." already exists` và làm gián đoạn hệ thống.

---

## 3. DANH SÁCH CÁC CÂU LỆNH ĐÃ THỰC THI & QUY TRÌNH KHẮC PHỤC

### Bước 1: Tiêu diệt tiến trình PostgreSQL và Node bị treo (Giải phóng Port 54329)
Để giải phóng ngay lập tức port `54329` mà không cần khởi động lại máy tính:

```powershell
# 1. Kiểm tra xem có tiến trình postgres nào đang chạy ngầm không:
Get-Process -Name "postgres" -ErrorAction SilentlyContinue

# 2. Cưỡng bức tắt toàn bộ tiến trình postgres đang chạy ngầm:
Stop-Process -Name "postgres" -Force -ErrorAction SilentlyContinue

# 3. (Nếu cần) Tắt các tiến trình node/tsx cũ đang giữ file lock:
Stop-Process -Name "node" -Force -ErrorAction SilentlyContinue

# 4. Xác nhận port 54329 đã được giải phóng hoàn toàn:
Get-NetTCPConnection -LocalPort 54329 -ErrorAction SilentlyContinue
```

> **Kết quả:** Port `54329` trở về trạng thái tự do, sẵn sàng cho phiên chạy mới.

---

### Bước 2: Hủy bỏ file Migration rác 0196 (Bảo vệ tính toàn vẹn Database)
Xóa file SQL khổng lồ và file snapshot lỗi do Drizzle sinh nhầm, đồng thời khôi phục file nhật ký migration:

```powershell
# 1. Xóa file SQL rác 140KB:
Remove-Item "packages\db\src\migrations\0196_chunky_sunset_bain.sql" -Force -ErrorAction SilentlyContinue

# 2. Xóa snapshot rác 0196:
Remove-Item "packages\db\src\migrations\meta\0196_snapshot.json" -Force -ErrorAction SilentlyContinue

# 3. Hoàn tác file _journal.json về trạng thái nguyên bản (chỉ dừng ở 0195):
git checkout -- packages/db/src/migrations/meta/_journal.json
```

---

### Bước 3: Hoàn tác Schema TypeScript (Bỏ cột taskKey)
Trong file [packages/db/src/schema/heartbeat_runs.ts](file:///c:/paperclip/packages/db/src/schema/heartbeat_runs.ts):
- Đảm bảo **không** thêm trường `taskKey` vào bảng `heartbeat_runs`.
- Schema hiện tại đã đồng bộ với nhánh chính, không phát sinh thay đổi cấu trúc bảng nào so với bản migration `0195`.

---

### Bước 4: Kiểm tra và sửa lỗi Symlink / TSX (Nếu gặp lỗi "Command tsx not found")
Nếu sau khi kill tiến trình đột ngột, `pnpm` bị mất symlink thực thi trong `node_modules/.bin`:

```powershell
# Cài đặt lại các liên kết phụ thuộc:
pnpm install
```

---

### Bước 5: Khởi động lại hệ thống thành công
Chạy lại dự án:

```powershell
pnpm dev
```

Hệ thống sẽ:
1. Tự động khởi động Embedded PostgreSQL trên cổng `54329` thành công.
2. Quét nhật ký migration [meta/_journal.json](file:///c:/paperclip/packages/db/src/migrations/meta/_journal.json) và nhận thấy database đã ở trạng thái cập nhật nhất (`0195_double_precision_costs`), không chạy thêm migration lỗi nào.
3. Toàn bộ dữ liệu trong thư mục `data/pglite/` được bảo tồn nguyên vẹn 100%.

---

## 4. BẢNG TỔNG HỢP CÁC LỆNH (CHEAT SHEET)

| Mục đích | Lệnh PowerShell / Bash |
| :--- | :--- |
| **Kill zombie Postgres** | `Stop-Process -Name "postgres" -Force -ErrorAction SilentlyContinue` |
| **Kill zombie Node/TSX** | `Stop-Process -Name "node" -Force -ErrorAction SilentlyContinue` |
| **Kiểm tra cổng 54329** | `Get-NetTCPConnection -LocalPort 54329 -ErrorAction SilentlyContinue` |
| **Xóa file 0196 lỗi** | `Remove-Item "packages\db\src\migrations\0196_*.sql", "packages\db\src\migrations\meta\0196_*.json" -Force` |
| **Khôi phục journal** | `git checkout -- packages/db/src/migrations/meta/_journal.json` |
| **Làm mới dependency** | `pnpm install` |
| **Khởi động Paperclip** | `pnpm dev` |

---

## 5. CÁCH TẮT PAPERCLIP CHUẨN ĐỂ KHÔNG BAO GIỜ BỊ LỖI KẸT PORT

Trên hệ điều hành Windows, chuỗi tiến trình khi chạy `pnpm dev` gồm:  
`PowerShell` $\rightarrow$ `dev-runner (Node.js)` $\rightarrow$ `Server (Node.js)` $\rightarrow$ `postgres.exe (Postgres nhúng)`.

Khi bạn tắt không đúng cách, Windows sẽ ngắt tiến trình cha (Node.js) nhưng **bỏ quên tiến trình con `postgres.exe`**. Tiến trình này sẽ chạy ngầm vĩnh viễn và giữ chặt port `54329`.

### 5.1. Hai thói quen CẦN TRÁNH TUYỆT ĐỐI
* ❌ **Không bấm nút "X" để đóng tab terminal hoặc tắt luôn cửa sổ VS Code / PowerShell:** Đây là nguyên nhân hàng đầu! Windows sẽ "chém ngang" cửa sổ dòng lệnh, Node.js không kịp nhận tín hiệu để tắt `postgres.exe`.
* ❌ **Không spam `Ctrl + C` liên tục nhiều lần:** Lần bấm đầu tiên kích hoạt quá trình dọn dẹp. Nếu bạn bấm lần 2, lần 3 liên tiếp, Windows sẽ ép buộc Node dừng ngay lập tức khi chưa kịp đóng Postgres.

---

### 5.2. Cách tắt đúng chuẩn (Graceful Shutdown)
1. Tại cửa sổ Terminal đang chạy `pnpm dev`, bấm `Ctrl + C` **đúng 1 lần duy nhất**.
2. Nếu PowerShell hỏi: `Terminate batch job (Y/N)?`, hãy gõ `Y` rồi ấn `Enter`.
3. **Đợi từ 3 đến 5 giây** để server tự động ngắt kết nối database và giải phóng port an toàn trước khi đóng terminal.

---

### 5.3. Cách "cứu cánh" nhanh nhất khi lỡ tắt sai hoặc muốn tắt sạch
Nếu lỡ tắt sai hoặc nghi ngờ port đang bị kẹt, chỉ cần mở terminal và chạy đúng 1 dòng lệnh PowerShell này:
```powershell
Stop-Process -Name "postgres" -Force -ErrorAction SilentlyContinue
```
Lệnh này sẽ quét và tiêu diệt ngay lập tức mọi tiến trình Postgres nhúng đang chạy ngầm, đưa port `54329` về trạng thái tự do 100%.

---

## 6. BÀI HỌC VÀ KHUYẾN NGHỊ (BEST PRACTICES)

1. **Khi muốn ngắt `pnpm dev` trên Windows:** Tuân thủ quy tắc `Ctrl + C` 1 lần và đợi 3-5 giây.
2. **Không chạy `pnpm db:generate` khi thư mục `meta` bị thiếu snapshot:** Dùng lệnh tùy biến `--custom` để viết SQL thủ công thay vì để Drizzle tự sinh.
3. **Khi database báo lỗi `could not bind address`:** Không bao giờ xóa `data/pglite`. Hãy chạy lệnh kill tiến trình postgres ở mục 5.3 là xong ngay.
