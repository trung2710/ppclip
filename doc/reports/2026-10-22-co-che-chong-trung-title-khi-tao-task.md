# Cơ chế chống trùng task khi gọi API tạo issue (n8n → Paperclip)

Ngày: 2026-10-22

## 1. Tóm tắt

- Paperclip **không luôn luôn tạo task mới**. Khi gọi `POST /api/companies/:companyId/issues`, server có hai lớp chống trùng.
- Lớp chống trùng title **chỉ so title, không so description**, và **chỉ chặn khi task cũ có status khác `done` và `cancelled`**.
- Vì vậy, trong luồng Telegram → n8n → Paperclip, các task cùng title vẫn được tạo nếu task trước đã `done` hoặc `cancelled`. Hiện tượng này đã quan sát được ở KHT-105 → KHT-109.

## 2. Cơ chế trong code

Logic nằm trong hàm `create` của `server/src/services/issues.ts` (khoảng dòng 6237–6340). Schema nằm ở `packages/shared/src/validators/issue.ts` (khoảng dòng 478). Route nằm ở `server/src/routes/issues.ts` (khoảng dòng 7140–7170).

### Lớp 1: Idempotency key (tuỳ chọn)

- Chỉ chạy khi body có `idempotencyKey`.
- Nếu key đã tồn tại trong cùng company, API trả lại task đã tạo trước đó. Key được lưu ở bảng `issueCreateIdempotencyKeys`, có thời hạn lưu giữ.
- Lớp này **luôn hoạt động**, kể cả khi `allowDuplicate: true`.

### Lớp 2: Chống trùng title gần đây (bật mặc định)

- Schema gán `allowDuplicate` mặc định là `false`, nên request không gửi trường này sẽ bị kiểm tra.
- Task cũ bị coi là trùng khi thoả **tất cả** điều kiện sau:

| Điều kiện | Chi tiết |
|---|---|
| Cùng company | `companyId` giống nhau |
| Cùng cấp | Cùng `parentId`, hoặc cùng là task gốc (không có `parentId`) |
| Không bị ẩn | `hiddenAt` là null |
| Còn mở | status **không** phải `done` hoặc `cancelled` |
| Còn mới | tạo trong vòng **48 giờ** gần đây |
| Title giống | sau khi chuẩn hoá: trim, gộp khoảng trắng, chữ thường |

- Có advisory lock theo từng title, nên hai request đồng thời không cùng lọt qua.
- **Description không tham gia so sánh.**

### Khi phát hiện trùng

- Không tạo task mới. API trả **HTTP 200** kèm task cũ.
- Body có thêm: `deduplicated: true`, `deduplicationReason` (`"idempotency_key"` hoặc `"recent_open_title"`), `relatedWork`, `referencedIssueIdentifiers`.
- Khi tạo mới, body **không có** `deduplicated`. Mã trả về của nhánh tạo mới chưa được xác minh trong báo cáo này; nên phân biệt bằng `deduplicated` thay vì mã 200/201.

## 3. Các trường hợp

| # | Tình huống | Kết quả |
|---|---|---|
| 1 | Task cũ cùng title, còn `todo`/`in_progress`/`blocked`, trong 48h | **Bị dedupe**, trả task cũ (200) |
| 2 | Task cũ cùng title nhưng đã `done` | Tạo task mới |
| 3 | Task cũ cùng title nhưng đã `cancelled` | Tạo task mới |
| 4 | Task cũ cùng title nhưng tạo hơn 48h trước | Tạo task mới |
| 5 | Cùng title, khác `parentId` | Tạo task mới |
| 6 | Cùng title, khác description, task cũ có status khác `done`/`cancelled` | **Vẫn bị dedupe** (description không được so) |
| 7 | Body có `allowDuplicate: true` | Bỏ qua kiểm tra title, luôn tạo mới |
| 8 | Body có `idempotencyKey` đã dùng | Trả task cũ, bất kể `allowDuplicate` |
| 9 | Code nội bộ gọi thẳng `issueService.create()` không qua route | `allowDuplicate` là `undefined`, **không** dedupe |

## 4. Giải thích hiện tượng đã thấy

- **KHT-105, 106, 107** (cùng title "hãy cho tôi biết bạn là agent nào…"): cả ba đều `done`. Khi tạo task sau, task trước đã hoàn thành (agent chạy xong trong vài phút), nên rơi vào trường hợp 2.
- **KHT-108, 109** (cùng title "verify file này cho tôi với"): KHT-108 đã `cancelled` trước khi KHT-109 được tạo, nên rơi vào trường hợp 3.
- Hai trường hợp trên **không phải lỗi**; đây là hành vi đúng theo thiết kế của guard.

## 5. Rủi ro với workflow n8n hiện tại

JSON hiện tại gửi `title`, `description`, `status`, `priority`, `assigneeAgentId`. Không có `allowDuplicate` và không có `idempotencyKey`. Hệ quả:

1. **Người dùng gửi lại cùng câu khi task cũ có status khác `done`/`cancelled`**: n8n nhận lại task cũ (HTTP 200). `telegram_context` của tin nhắn mới (`message_id`, `chat_id`) **không được ghi** vào task. Câu trả lời có thể đi sai message hoặc không đi.
2. **n8n retry**: không có `idempotencyKey` nên không phân biệt được "gửi lại do lỗi mạng" với "người dùng hỏi lại".
3. **Title chỉ dựa vào nội dung tin nhắn**: hai tin nhắn khác nhau nhưng cùng chữ (ví dụ "ok", "tiếp tục") dễ bị coi là trùng.

## 6. Cách khắc phục đề xuất

| Phương án | Cách làm | Kết quả | Hạn chế |
|---|---|---|---|
| **1. Đơn giản nhất** | Thêm `allowDuplicate: true` | Mỗi tin nhắn luôn tạo một task mới | Nếu n8n retry cùng một tin nhắn thì sinh task trùng |
| **2. Khuyến nghị** | Thêm `allowDuplicate: true` và `idempotencyKey` | Mỗi tin nhắn một task; retry cùng tin nhắn trả lại đúng task cũ | Thêm một trường |

### Phương án 1: chỉ thêm `allowDuplicate: true`

```js
return JSON.stringify({
  title: title,
  description: description,
  status: 'todo',
  priority: 'critical',
  assigneeAgentId: '4919b15f-2218-475c-ae83-76bd6ab43a2e',
  allowDuplicate: true
});
```

- Giá trị phải là boolean `true`, không phải chuỗi `"true"`.

### Phương án 2: thêm `idempotencyKey` theo tin nhắn Telegram

Mỗi tin nhắn Telegram có cặp `chat_id` + `message_id` duy nhất, dùng làm key:
- n8n retry cùng tin nhắn: trả lại task đã tạo, không tạo trùng.
- Hai tin nhắn khác nhau (dù cùng chữ): luôn là hai task riêng.

```js
return JSON.stringify({
  title: title,
  description: description,
  status: 'todo',
  priority: 'critical',
  assigneeAgentId: '4919b15f-2218-475c-ae83-76bd6ab43a2e',
  allowDuplicate: true,
  idempotencyKey: 'telegram:' + msg.chat.id + ':' + msg.message_id
});
```

- `idempotencyKey` không rỗng, tối đa 255 ký tự.

### Request

```
POST http://host.docker.internal:3100/api/companies/b0964fd7-2db2-482a-94eb-2fff77c5b50c/issues
Content-Type: application/json
```

## 7. Cách xem kết quả trong n8n

Node HTTP Request mặc định chỉ trả body. Để xem mã trạng thái:

1. Mở node HTTP Request → **Options** → thêm **Response**.
2. Bật **Include Response Headers and Status**.
3. Output có dạng `{ headers, statusCode, statusMessage, body }`.

Để phân biệt tạo mới và trùng, dùng node IF:
- Khi đã bật Include Response Headers and Status: `{{ $json.body.deduplicated === true }}`
- Khi chưa bật: `{{ $json.deduplicated === true }}`

## 8. Cách kiểm tra lại sau khi sửa

1. Gửi hai tin nhắn cùng nội dung liên tiếp khi task đầu chưa `done`/`cancelled` (ví dụ tạm gán cho agent đang tắt).
2. Với Phương án 1: hai tin nhắn cùng title luôn cho hai task khác nhau.
3. Với Phương án 2: hai tin nhắn Telegram khác nhau → hai task khác nhau; gửi lại cùng `message_id` → trả về cùng một task (`deduplicated: true`).

## 9. Tuỳ chọn thay đổi ở phía server (chưa thực hiện)

Nếu muốn chặn trùng cả khi task cũ đã `done`/`cancelled`, hoặc so thêm description, cần sửa điều kiện `notInArray(issues.status, ["done", "cancelled"])` và truy vấn so title trong `create` của `server/src/services/issues.ts`. Thay đổi này ảnh hưởng toàn bộ client, cần cân nhắc vì người dùng hỏi lại cùng một câu là tình huống bình thường.
