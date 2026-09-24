# Hướng Dẫn Migration Database (Paperclip)

Tài liệu này ghi chú lại quy trình chuẩn để thay đổi cấu trúc Cơ sở dữ liệu (Database) trong dự án Paperclip, cũng như cách xử lý lỗi đặc biệt khi dự án bị mất lịch sử snapshot.

---

## 1. Quy trình chuẩn (Khi dự án bình thường)

Khi bạn muốn thêm/sửa/xóa một cột hoặc một bảng trong database, hãy làm theo các bước sau:

**Bước 1: Cập nhật Schema bằng TypeScript**
- Mở các file trong thư mục `packages/db/src/schema/*.ts`.
- Chỉnh sửa kiểu dữ liệu hoặc cấu trúc bảng (Ví dụ: Đổi `integer` thành `doublePrecision`).
- Nếu tạo bảng mới, đảm bảo bảng đó được `export` ở file `packages/db/src/schema/index.ts`.

**Bước 2: Chạy Typecheck**
- Chạy lệnh sau ở terminal để đảm bảo việc đổi schema không làm hỏng các đoạn code TypeScript cũ (Ví dụ: Code cũ đang cần truyền vào một `string` nhưng bạn lại đổi schema thành kiểu `number`).
```bash
pnpm -r typecheck
```
*(Đảm bảo lệnh báo thành công - màu xanh).*

**Bước 3: Sinh file SQL Migration tự động**
- Chạy lệnh sau để thư viện Drizzle tự động so sánh code TypeScript hiện tại với snapshot cũ và sinh ra file SQL chứa các lệnh thay đổi database:
```bash
pnpm db:generate
```
- Lệnh này sẽ tạo ra một file SQL mới trong thư mục `packages/db/src/migrations/`.

**Bước 4: Thực thi Migration**
- Chạy lệnh khởi động server:
```bash
pnpm dev
```
- Khi server khởi động, nó sẽ tự động quét và chạy các file SQL migration mới trực tiếp vào Database của bạn một cách an toàn.

*(Tùy chọn: Nếu bạn muốn test trên một DB mới tinh sạch sẽ, bạn có thể xóa DB cũ bằng lệnh `rm -rf data/pglite` trước khi chạy `pnpm dev`)*.

---

## 2. Xử lý sự cố: Lỗi "Tự sinh file Migration khổng lồ"

**Triệu chứng:**
Khi chạy `pnpm db:generate`, Drizzle tạo ra một file SQL khổng lồ (vài ngàn dòng) với hàng loạt lệnh `CREATE TABLE` cho các bảng vốn dĩ đã tồn tại sẵn trong database. Khi chạy `pnpm dev` sẽ báo lỗi `PostgresError: relation "xyz" already exists`.

**Nguyên nhân gốc rễ:**
Dự án đã bị mất các file snapshot lịch sử (các file `.json` từ `0100_snapshot.json` đến `0194_snapshot.json` nằm trong `packages/db/src/migrations/meta/`) do có ai đó lỡ xóa hoặc quên commit lên Git. 
Do thiếu lịch sử này, công cụ Drizzle bị "lú": nó lấy code TypeScript hiện tại so sánh với snapshot mới nhất còn sót lại (là số `0099`). Kết quả là nó lầm tưởng rằng toàn bộ các thay đổi từ mốc 100 đến 194 (bao gồm hàng chục bảng mới) chưa từng được tạo, nên nó nhồi nhét toàn bộ các lệnh `CREATE TABLE` thừa thãi đó cùng với thay đổi hiện tại vào chung 1 file khổng lồ.
Tuy nhiên, database thực tế đang chạy trên máy (PGlite) đã được chạy tới bản 194 rồi. Khi chạy `pnpm dev`, nó thực thi file khổng lồ này, đòi tạo lại những bảng vốn đã có sẵn, nên database sẽ ném ra lỗi `already exists` và sập ngay lập tức.

**Cách giải quyết (Tạo Migration thủ công):**

1. **Xóa file lỗi:** Hãy xóa ngay cái file SQL khổng lồ bị sinh lỗi đi, đồng thời xóa luôn cái file snapshot `.json` đi kèm nó trong thư mục `meta/`. Có thể dùng git checkout để hoàn tác file `_journal.json`.

2. **Tạo file Migration Custom:**
   Vào thư mục db và yêu cầu Drizzle tạo một file migration trống có đăng ký với hệ thống:
   ```bash
   cd packages/db
   pnpm exec drizzle-kit generate --custom --name ten_chuc_nang_cua_ban
   ```

   Mở file SQL vừa được tạo ra ở `packages/db/src/migrations/` và tự tay copy - paste các lệnh `ALTER TABLE` cần thiết. Lưu ý **phải thêm dòng `-- > statement-breakpoint`** sau mỗi câu lệnh.
   *Ví dụ đoạn code hoàn chỉnh để đổi các cột tiền sang double precision:*
   ```sql
   ALTER TABLE "cost_events" ALTER COLUMN "cost_cents" SET DATA TYPE double precision;--> statement-breakpoint
   ALTER TABLE "agent_runtime_state" ALTER COLUMN "total_cost_cents" SET DATA TYPE double precision;--> statement-breakpoint
   ALTER TABLE "agents" ALTER COLUMN "budget_monthly_cents" SET DATA TYPE double precision;--> statement-breakpoint
   ALTER TABLE "agents" ALTER COLUMN "spent_monthly_cents" SET DATA TYPE double precision;--> statement-breakpoint
   ALTER TABLE "companies" ALTER COLUMN "budget_monthly_cents" SET DATA TYPE double precision;--> statement-breakpoint
   ALTER TABLE "companies" ALTER COLUMN "spent_monthly_cents" SET DATA TYPE double precision;--> statement-breakpoint
   ALTER TABLE "status_card_updates" ALTER COLUMN "cost_cents" SET DATA TYPE double precision;--> statement-breakpoint
   ALTER TABLE "finance_events" ALTER COLUMN "amount_cents" SET DATA TYPE double precision;
   ```

4. **Thực thi:**
   Quay lại thư mục gốc và chạy `pnpm dev` để apply migration vào DB mà không làm mất dữ liệu cũ.
