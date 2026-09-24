# Lỗi Migration `agent_runtime_state already exists`

## 1. Thông báo lỗi

Paperclip không khởi động được và PostgreSQL trả về:

```text
relation "agent_runtime_state" already exists
code: 42P07
```

Lỗi xuất hiện trong quá trình Paperclip chạy migration database.

## 2. Migration là gì?

Migration là tập hợp các câu lệnh SQL dùng để cập nhật cấu trúc database khi Paperclip thay đổi.

Migration có thể thực hiện các việc như:

- Tạo bảng mới.
- Thêm hoặc đổi cột.
- Tạo index.
- Cập nhật quan hệ giữa các bảng.

Ví dụ:

```text
Migration 001: tạo bảng agents
Migration 002: tạo bảng issues
Migration 003: tạo bảng agent_runtime_state
```

Khi khởi động, Paperclip kiểm tra các migration đã chạy và thực hiện những migration còn thiếu.

## 3. Bản chất lỗi

Paperclip đang cố chạy migration tạo bảng:

```text
agent_runtime_state
```

Tuy nhiên, PostgreSQL đã có bảng này. Vì vậy câu lệnh tạo bảng bị từ chối:

```sql
CREATE TABLE agent_runtime_state (...);
```

Nói cách khác, database đang ở trạng thái:

- Bảng `agent_runtime_state` đã tồn tại.
- Migration history không ghi nhận migration tương ứng đã hoàn tất, hoặc migration đang bị chạy trùng.

Đây là lỗi không đồng bộ giữa schema thực tế và lịch sử migration.

## 4. Các nguyên nhân thường gặp

### 4.1. Dùng lại volume PostgreSQL cũ

Ví dụ service PostgreSQL trong `docker-compose.yml` dùng:

```yaml
volumes:
  - pgdata:/var/lib/postgresql/data
```

Volume `pgdata` có thể đã chứa bảng `agent_runtime_state` từ lần triển khai trước. Khi container Paperclip mới khởi động, nó chạy migration lại trên database cũ.

Việc mount volume cũ tự bản thân không sai. Đây là cách bình thường để giữ dữ liệu khi thay container.

### 4.2. Migration trước đó bị dừng giữa chừng

Một migration có thể đã tạo bảng thành công nhưng Paperclip bị dừng trước khi ghi nhận migration đã hoàn tất. Lần khởi động sau, Paperclip tưởng migration chưa chạy và cố tạo lại bảng.

### 4.3. Có nhiều container Paperclip cùng chạy

Nếu hai container Paperclip cùng kết nối một PostgreSQL database và cùng khởi động, cả hai có thể chạy một migration cùng lúc. Một container tạo bảng trước, container còn lại nhận lỗi bảng đã tồn tại.

### 4.4. Kết nối nhầm database

Container mới có thể đang dùng `DATABASE_URL` khác với dự kiến. Cần kiểm tra hostname, database name, username và password.

Trong Docker Compose, không dùng `localhost`:

```env
DATABASE_URL=postgres://paperclip:password@postgres:5432/paperclip
```

Trong đó `postgres` là tên service PostgreSQL.

### 4.5. Database và image Paperclip khác phiên bản

Database có thể được tạo bởi một phiên bản Paperclip khác. Nếu migration history và schema không còn tương thích, migration mới có thể cố tạo lại bảng đã tồn tại.

## 5. Phân biệt hai loại database

### PostgreSQL service bên ngoài

Database được lưu trong volume PostgreSQL:

```yaml
postgres:
  volumes:
    - pgdata:/var/lib/postgresql/data
```

Paperclip kết nối tới database này khi có:

```env
DATABASE_URL=postgres://...
```

### Embedded PostgreSQL

Paperclip tự quản lý database trong volume của ứng dụng:

```text
/paperclip/instances/default/db
```

Paperclip dùng embedded PostgreSQL khi không khai báo `DATABASE_URL`.

## 6. Lưu ý khi chuyển từ embedded sang PostgreSQL service

Dữ liệu trong:

```text
/paperclip/instances/default/db
```

không tự động chuyển sang volume:

```text
pgdata
```

Nếu khai báo `DATABASE_URL`, Paperclip sẽ sử dụng PostgreSQL service và không đọc dữ liệu embedded cũ.

Vì vậy:

- Muốn giữ dữ liệu PostgreSQL service: giữ volume `pgdata`.
- Muốn giữ dữ liệu embedded: giữ volume `/paperclip` và bỏ `DATABASE_URL`.
- Không nên trộn volume embedded với volume PostgreSQL service.

## 7. Quy trình xử lý an toàn

### Bước 1: Dừng Paperclip cũ

```powershell
docker compose stop paperclip
```

Đảm bảo chỉ có một container Paperclip kết nối tới database.

### Bước 2: Kiểm tra service

```powershell
docker compose ps
```

Kiểm tra Paperclip chỉ có một replica và PostgreSQL đang hoạt động.

### Bước 3: Kiểm tra cấu hình kết nối

Đảm bảo `DATABASE_URL` trỏ tới đúng service:

```env
DATABASE_URL=postgres://paperclip:password@postgres:5432/paperclip
```

Không dùng:

```text
localhost
127.0.0.1
```

### Bước 4: Khởi động lại một Paperclip duy nhất

```powershell
docker compose up -d paperclip
docker compose logs -f paperclip
```

### Bước 5: Backup nếu dữ liệu quan trọng

Trước khi sửa schema hoặc migration, cần backup database PostgreSQL. Không tự ý xóa bảng `agent_runtime_state`.

## 8. Trường hợp database chỉ dùng để test

Nếu database không có dữ liệu cần giữ, có thể tạo volume PostgreSQL mới thay vì xóa volume cũ.

Ví dụ trong `docker-compose.yml`:

```yaml
services:
  postgres:
    volumes:
      - pgdata_clean:/var/lib/postgresql/data

volumes:
  pgdata_clean:
```

Sau đó:

```powershell
docker compose down
docker compose up -d
```

Volume cũ `pgdata` vẫn được giữ nguyên.

Không chạy lệnh xóa volume nếu chưa chắc chắn:

```powershell
docker volume rm <ten-volume-postgres>
```

## 9. Kết luận

Lỗi `relation "agent_runtime_state" already exists` không phải lỗi của external adapter và cũng không có nghĩa mount volume cũ là sai.

Nguyên nhân là một trong các trạng thái:

```text
schema database đã có bảng
nhưng migration history không đồng bộ
hoặc có nhiều Paperclip chạy migration đồng thời
```

Cách an toàn nhất là:

1. Giữ đúng volume database cần dùng.
2. Đảm bảo `DATABASE_URL` trỏ đúng service.
3. Chỉ chạy một Paperclip instance.
4. Backup trước khi sửa database.
5. Với môi trường test, tạo volume mới thay vì xóa volume cũ.

