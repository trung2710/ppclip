# Kế Hoạch Triển Khai: Zero-Hallucination Metadata Pipeline & Đóng Gói Toàn Diện Dữ Liệu Task
**Ngày lập:** 12/10/2026  
**Mục tiêu:** Loại bỏ hoàn toàn việc dùng Regex bóc tách text thô; ngăn chặn triệt để tình trạng AI Agent điền sai/quên `task_id`, `chat_id`; tự động hóa 100% việc trích xuất và đóng gói dữ liệu nguyên vẹn của Paperclip gửi về n8n Webhook.

---

## 1. BỐI CẢNH & PHÂN TÍCH VẤN ĐỀ CỐT LÕI

### 1.1. Hiện trạng & Nhược điểm
1. **Phụ thuộc vào Regex trên chuỗi text tự do:**
   * n8n ném thông tin kỹ thuật vào `description` theo dạng text tự do (`chat_id: 123 \n message_id: 45`).
   * Phía MCP Server hoặc Agent phải dùng Regex quét tìm. Chỉ cần người dùng hoặc Agent chỉnh sửa nội dung, xóa bớt dòng hoặc thay đổi định dạng là Regex gãy ngay lập tức.
2. **Bắt AI Agent tự nhớ và tự điền tham số kỹ thuật:**
   * Tool `finish_task_and_reply_telegram` trước đây yêu cầu Agent phải truyền: `chat_id`, `task_id`, `message`, `file_path`.
   * LLM sinh ra là để xử lý ngữ nghĩa và thực thi code, không được thiết kế để ghi nhớ các mã định danh kỹ thuật dài. Hệ quả là Agent thường xuyên:
     * Điền nhầm identifier (ví dụ `KHT-61`) thay vì UUID `835b1fab-...`.
     * Điền nhầm `parent_task_id` hoặc bịa ra một UUID ngẫu nhiên.
     * Quên `chat_id` hoặc truyền `0`.
3. **Payload gửi về n8n Webhook bị thiếu thông tin:**
   * Webhook callback trước đây chỉ gửi về vài trường rời rạc (`chat_id`, `message`).
   * Các node tiếp theo trong n8n (như cập nhật database PostgreSQL, đồng bộ trạng thái task, ghi log) không có đủ các thông tin quan trọng của Task (`id`, `identifier`, `title`, `status`, `attachments`, `parentId`, `createdAt`, v.v.).

---

## 2. KIẾN TRÚC MỚI: ZERO-HALLUCINATION METADATA PIPELINE

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                   CHIỀU ĐI (n8n -> Paperclip)                           │
│  n8n tạo Task mới: Đính kèm một khối JSON chuẩn cô lập ở cuối Description:             │
│  ```json:telegram_context                                                              │
│  { "chat_id": 8882960938, "message_id": 53 }                                          │
│  ```                                                                                   │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                              CHIỀU XỬ LÝ (AI Agent & MCP Server)                       │
│  1. Agent hoàn thành việc, CHỈ CẦN GỌI:                                                │
│     finish_task_and_reply_telegram(message="...", file_path="...")                     │
│     🚫 Không bắt Agent truyền `task_id`, 🚫 Không bắt Agent truyền `chat_id`!          │
│                                                                                        │
│  2. MCP Server tự động xử lý ngầm (Backend Automation):                                │
│     a. Tự lấy `run_id` từ JWT token runtime -> tra Paperclip ra `task_id` chuẩn 100%.  │
│     b. Tự đọc khối `json:telegram_context` từ Task -> lấy `chat_id`, `message_id`.    │
│     c. Tự upload file lên Paperclip Attachments (nếu có `file_path`).                  │
│     d. Tự chuyển status Task sang `done` và post comment nghiệm thu lên Paperclip.     │
│     e. Truy vấn toàn bộ object Task nguyên bản 100% từ Paperclip.                      │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│                                CHIỀU VỀ (MCP Server -> n8n)                            │
│  Gửi 1 JSON toàn diện về N8N_TELEGRAM_WEBHOOK_URL:                                     │
│  - Chứa nguyên vẹn 100% object `task` (id, identifier, title, status, attachments...) │
│  - Chứa metadata Telegram chuẩn: `chat_id`, `message_id`                               │
│  - Chứa nội dung trả lời: `reply_message`, link tải file kết quả                       │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## 3. CẤU TRÚC JSON GỬI VỀ N8N WEBHOOK (CHUẨN HÓA 100%)

Payload gửi sang n8n Webhook sẽ có cấu trúc **kết hợp đa tầng**: vừa có các trường phẳng ở root để dùng ngay, vừa chứa nguyên vẹn object `task` gốc:

```json
{
  "task": {
    "id": "835b1fab-cc82-407d-96ef-1cafb0eef2f6",
    "identifier": "KHT-61",
    "title": "[Telegram] Xử lý yêu cầu: ...",
    "description": "...",
    "status": "done",
    "priority": "critical",
    "workMode": "standard",
    "companyId": "b0964fd7-2cb2-482a-94eb-2fff77c5b50c",
    "parentId": null,
    "projectId": null,
    "goalId": null,
    "assigneeAgentId": "4919b15f-2218-475c-ae83-76bd6ab43a2e",
    "createdAt": "2026-10-12T08:15:30.000Z",
    "updatedAt": "2026-10-12T10:30:00.000Z",
    "attachments": [
      {
        "id": "att-1234",
        "filename": "bc10_6_2026.md",
        "contentType": "text/markdown",
        "byteSize": 1540,
        "contentPath": "/api/attachments/att-1234/content"
      }
    ],
    "ancestors": []
  },
  "telegram": {
    "chat_id": 8882960938,
    "message_id": 53
  },
  "reply": {
    "message": "Xin chào! Báo cáo thử nghiệm đã được tạo thành công...",
    "file": {
      "filename": "bc10_6_2026.md",
      "download_url": "http://host.docker.internal:3100/api/attachments/att-1234/content",
      "attachment_id": "att-1234"
    }
  },
  "chat_id": 8882960938,
  "message_id": 53,
  "task_id": "835b1fab-cc82-407d-96ef-1cafb0eef2f6",
  "task_identifier": "KHT-61",
  "task_status": "done",
  "reply_message": "Xin chào! Báo cáo thử nghiệm đã được tạo thành công..."
}
```

---

## 4. CÁC BƯỚC TRIỂN KHAI CHI TIẾT (STEP-BY-STEP)

### BƯỚC 1: Tái cấu trúc tool `finish_task_and_reply_telegram` trong `server.py`
* **File mục tiêu:** `c:\paperclip\paperclip-mcp\src\paperclip_mcp\server.py`
* **Nhiệm vụ cụ thể:**
  1. Đổi signature của hàm:
     ```python
     @mcp.tool()
     async def finish_task_and_reply_telegram(
         message: str,
         file_path: str = "",
         api_key: str = "",
         run_id: str = "",
         task_id: str = "",
     ) -> dict:
     ```
     *(Agent chỉ cần truyền `message` và `file_path`. Các tham số còn lại là tùy chọn để hệ thống tự suy diễn).*
  2. **Hàm tự động resolve `task_id`:**
     * Trích xuất `run_id` từ JWT claims của `PAPERCLIP_API_KEY`.
     * Gọi API Paperclip: `GET /api/heartbeat-runs/{run_id}` để lấy `contextSnapshot.issueId` hoặc `GET /api/heartbeat-runs/{run_id}/issues`.
  3. **Hàm tự động trích xuất Telegram Metadata:**
     * Lấy issue chi tiết qua `GET /api/issues/{task_id}`.
     * Quét tìm khối ````json:telegram_context ... ```` hoặc parse JSON metadata.
     * Trích xuất chính xác `chat_id` và `message_id`.
  4. **Tự động Upload File Attachment (nếu có `file_path`):**
     * Đọc file từ đĩa, gọi `POST /api/companies/{company_id}/issues/{task_id}/attachments`.
     * Lấy về `attachment_id`, `filename`, `contentPath`.
  5. **Tự động đóng Task trên Paperclip:**
     * Thêm comment nghiệm thu: `POST /api/issues/{task_id}/comments`.
     * Cập nhật status issue thành `done`: `PATCH /api/issues/{task_id}` với `{"status": "done"}`.
  6. **Đóng gói toàn diện & Gửi Webhook:**
     * Lấy lại toàn bộ dữ liệu mới nhất của Issue từ Paperclip (`GET /api/issues/{task_id}`).
     * Đóng gói payload đầy đủ như Mục 3.
     * Gửi `POST` tới `N8N_TELEGRAM_WEBHOOK_URL`.

---

### BƯỚC 2: Cập nhật System Prompt trong `AGENTS.md`
* **File mục tiêu:** `c:\paperclip\AGENTS.md`
* **Nội dung bổ sung:** Hướng dẫn Agent cách thức kết thúc công việc:
  ```markdown
  ### QUY TẮC HOÀN THÀNH CÔNG VIỆC & PHẢN HỒI TELEGRAM:
  Khi đã thực hiện xong yêu cầu của người dùng, bạn BẮT BUỘC gọi công cụ:
  `finish_task_and_reply_telegram(message="<Nội dung giải thích kết quả cho người dùng>", file_path="<đường dẫn file nếu có>")`
  Lưu ý: Bạn KHÔNG CẦN điền task_id hay chat_id, hệ thống sẽ tự động liên kết và chuyển kết quả về Telegram cho khách hàng.
  ```

---

### BƯỚC 3: Cập nhật Node Tạo Task trong n8n (Kẹp JSON Context)
* **Node mục tiêu:** Node `Tạo Task Mới Trên Paperclip` (hoặc node Code đóng gói Description).
* **Nhiệm vụ:**
  * Giữ nguyên text hiển thị đẹp mắt cho người đọc ở trên.
  * Thêm khối JSON cô lập ở cuối `description`:
    ```javascript
    const telegramContextBlock = `\n\n\`\`\`json:telegram_context\n${JSON.stringify({
      chat_id: chatId,
      message_id: messageId
    }, null, 2)}\n\`\`\``;
    ```

---

### BƯỚC 4: Cập nhật Workflow n8n Webhook đón kết quả
* **Node mục tiêu:** Webhook trigger và các node xử lý phía sau (Send Telegram Message, Update Postgres).
* **Nhiệm vụ:**
  * Node Telegram Send Message:
    * Chat ID: `{{ $json.body.chat_id }}`
    * Text: `{{ $json.body.reply_message }}`
  * Node Update Postgres (bảng `telegram_messages`):
    * Cập nhật trạng thái `completed`, gắn `task_id` = `{{ $json.body.task_id }}`.
  * Node lưu log chi tiết:
    * Toàn bộ dữ liệu của Task có sẵn tại `{{ $json.body.task }}`.

---

## 5. CHECKLIST KIỂM THỬ & NGHIỆM THU (VERIFICATION)

| STT | Kịch bản kiểm thử | Kết quả mong đợi |
| :--- | :--- | :--- |
| **TC-01** | Khách gửi tin nhắn text: *"Cho tôi biết tỷ giá hôm nay"* | Agent hoàn thành $\rightarrow$ Gọi `finish_task_and_reply_telegram(message="...")` $\rightarrow$ Webhook n8n nhận JSON có đầy đủ `task`, `chat_id`, tin nhắn bắn về Telegram ngay lập tức. |
| **TC-02** | Khách gửi yêu cầu sinh file: *"Tạo file baocao.md"* | Agent tạo file $\rightarrow$ Gọi `finish_task_and_reply_telegram(file_path="baocao.md")` $\rightarrow$ File tự động upload vào Paperclip attachments $\rightarrow$ n8n nhận được `file_download_url` và gửi file về Telegram. |
| **TC-03** | Khách gửi tiếp file để unblock subtask | Hệ thống đi đúng luồng unblock $\rightarrow$ Task cha nghiệm thu $\rightarrow$ Gửi đúng `chat_id` ban đầu. |
| **TC-04** | Kiểm tra độ toàn vẹn của Task object | Kiểm tra payload tại n8n Webhook: có đầy đủ 100% các trường `task.id`, `task.identifier`, `task.status == 'done'`, `task.attachments`... |
