# Hướng Dẫn Cấu Hình Hoàn Thiện: Tái Sử Dụng Cây Task & Khôi Phục Ngữ Cảnh Lịch Sử (Telegram - n8n - Paperclip)

Tài liệu này hướng dẫn chi tiết từng bước (step-by-step) cấu hình hai logic nghiệp vụ quan trọng nhất trên hệ thống:
1. **Logic 1: Tái sử dụng cây Task (Task Hierarchy Reusability):** Khi nhận tin nhắn/file bổ sung từ Telegram, tự động quét tìm Subtask đang mắc kẹt (`blocked`), nạp dữ liệu và chạy tiếp duy nhất Subtask đó để hoàn thành chu trình cha - con.
2. **Logic 2: Khôi phục ngữ cảnh & lịch sử thực thi của các task trước đó:** So sánh và hướng dẫn triển khai cả 2 hướng:
   - **Hướng A:** Viết toàn bộ logic trích xuất ngữ cảnh bên n8n (Pre-packaging).
   - **Hướng B:** Để cho Agent tự chủ động gọi MCP Tool (`get_recent_tasks_by_chat` & `read_file_universal`).

---

## PHẦN 1: LOGIC 1 - TÁI SỬ DỤNG CÂY TASK (SUBTASK REUSE PIPELINE)

### 1.1. Sơ đồ luồng xử lý trên n8n (Architecture Flow)

```text
┌─────────────────────────┐
│ 1. Telegram Trigger     │ (Người dùng gửi tin nhắn hoặc gửi kèm File/Ảnh)
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ 2. Get Active Parent    │ HTTP GET /api/companies/:companyId/issues
│    Task (Paperclip)     │ Lấy task cha gần nhất đang mở (status: in_progress hoặc blocked)
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ 3. Get Subtasks         │ HTTP GET /api/companies/:companyId/issues?parentId={parentTaskId}
│    (Paperclip)          │ Lấy toàn bộ danh sách task con đã sinh ra
└────────────┬────────────┘
             │
             ▼
┌─────────────────────────┐
│ 4. Code Node (Router):  │ Quét tìm: có Subtask nào đang status == 'blocked' không?
│    Phân tích điểm nghẽn │ - Có: Xuất ra targetSubtaskId & routeAction = 'UNBLOCK_SUBTASK'
└────────────┬────────────┘ - Không: Xuất ra targetTaskId = parentTaskId & routeAction = 'COMMENT_PARENT'
             │
       ┌─────┴────────────────────────────────┐
       ▼ [Nhánh A: Có Subtask Blocked]        ▼ [Nhánh B: Không có Subtask Blocked]
┌─────────────────────────┐            ┌─────────────────────────┐
│ 5A. Upload File vào     │            │ 5B. Xử lý Comment hoặc  │
│     Subtask (nếu có)    │            │     Tạo Task mới        │
└────────────┬────────────┘            └─────────────────────────┘
             │
             ▼
┌─────────────────────────┐
│ 6A. POST /comments vào  │ (actorType: "user")
│     Subtask đang block  │ ==> Paperclip tự chuyển status sang "todo"
└────────────┬────────────┘ ==> Kích hoạt Agent con chạy tiếp để hoàn thành!
             │
             ▼
┌───────────────────────────────────────────────────────────────┐
│ 7A. Paperclip Core: Khi Subtask chuyển "done"                 │
│     Tự kích hoạt wakeReason: "issue_children_completed"       │
│     Agent Cha thức dậy nghiệm thu và gửi kết quả về Telegram! │
└───────────────────────────────────────────────────────────────┘
```

---

### 1.2. Cấu hình chi tiết từng Node trên n8n

#### Node 1: Telegram Trigger
* **Event:** `message` (bắt cả tin nhắn văn bản và tệp tin).

#### Node 2: HTTP Request - Get Active Parent Task
* **Method:** `GET`
* **URL:** `http://localhost:3100/api/companies/{{ $env.PAPERCLIP_COMPANY_ID }}/issues`
* **Query Parameters:**
  * `status`: `in_progress,blocked`
* **Headers:**
  * `Authorization`: `Bearer {{ $env.PAPERCLIP_BOARD_API_KEY }}`
* **Options:** `Always Output Data` = `true`.

#### Node 3: HTTP Request - Get Subtasks
* **Method:** `GET`
* **URL:** `http://localhost:3100/api/companies/{{ $env.PAPERCLIP_COMPANY_ID }}/issues`
* **Query Parameters:**
  * `parentId`: `{{ $('Get Active Parent Task').item.json.id }}`
* **Headers:**
  * `Authorization`: `Bearer {{ $env.PAPERCLIP_BOARD_API_KEY }}`

#### Node 4: Code Node (JavaScript Router) — "Detect Blocked Subtask"
Dán đoạn mã chuẩn sau vào Code Node:

```javascript
// Lấy thông tin tin nhắn Telegram
const tgMsg = $('Telegram Trigger').first().json.message;
const userText = tgMsg.text || tgMsg.caption || '';
const chatId = tgMsg.chat.id;

// Lấy thông tin Task cha đang hoạt động
const parentTask = $('Get Active Parent Task').first().json;
if (!parentTask || !parentTask.id) {
  // Không có Task cha nào đang mở -> Chuyển sang tạo Task mới
  return {
    hasActiveTask: false,
    routeAction: 'CREATE_NEW_TASK',
    userText: userText,
    chatId: chatId
  };
}

// Lấy danh sách subtasks từ Node 3
const subtaskItems = $('Get Subtasks').all().map(item => item.json);

// Tìm subtask đang bị tắc nghẽn (blocked hoặc waiting)
const blockedSubtask = subtaskItems.find(t => t.status === 'blocked');

// Kiểm tra xem khách có gửi kèm file không
const hasDocument = Boolean(tgMsg.document);
const hasPhoto = Boolean(tgMsg.photo && tgMsg.photo.length > 0);

if (blockedSubtask) {
  // 👉 PHÁT HIỆN TASK CON ĐANG BỊ TẮC NGHẼN: TÁI SỬ DỤNG NGAY!
  return {
    hasActiveTask: true,
    routeAction: 'UNBLOCK_SUBTASK',
    targetIssueId: blockedSubtask.id,
    targetIdentifier: blockedSubtask.identifier,
    parentIssueId: parentTask.id,
    userText: userText,
    chatId: chatId,
    hasFile: hasDocument || hasPhoto,
    fileType: hasDocument ? 'document' : (hasPhoto ? 'photo' : null)
  };
} else {
  // Không có subtask nào bị block -> Bình luận vào Task cha
  return {
    hasActiveTask: true,
    routeAction: 'COMMENT_PARENT',
    targetIssueId: parentTask.id,
    targetIdentifier: parentTask.identifier,
    userText: userText,
    chatId: chatId,
    hasFile: hasDocument || hasPhoto
  };
}
```

#### Node 5: Switch / IF Node
* Kiểm tra điều kiện: `{{ $json.routeAction }} == 'UNBLOCK_SUBTASK'`
  * **Nếu TRUE:**
    * **(Tùy chọn nếu có file):** Dùng node `Telegram Get File` tải file binary $\rightarrow$ Gọi `POST /api/companies/:companyId/issues/:targetIssueId/attachments` (multipart/form-data) để đính kèm file vào task con.
    * **Node Gọi Comment giải phóng Subtask:**
      * **Method:** `POST`
      * **URL:** `http://localhost:3100/api/issues/{{ $json.targetIssueId }}/comments`
      * **Headers:** `Authorization: Bearer {{ $env.PAPERCLIP_BOARD_API_KEY }}` *(Bắt buộc dùng Board Key để có actorType: 'user')*
      * **Body JSON:**
        ```json
        {
          "body": "Người dùng đã bổ sung thông tin từ Telegram: {{ $json.userText }}",
          "interrupt": false
        }
        ```
  * **Cơ chế tự động của Paperclip:** 
    1. Khi nhận User Comment, Paperclip tự chuyển status của Subtask từ `blocked` $\rightarrow$ `todo`.
    2. Bắn Heartbeat wake Agent con dậy xử lý tiếp.
    3. Khi Agent con xong (`done`), Paperclip Core thấy $4/4$ subtasks đều `done` $\rightarrow$ Tự động bắn `wakeReason: "issue_children_completed"` đánh thức Agent Cha.
    4. Agent Cha nghiệm thu và gọi `finish_task_and_reply_telegram` trả lời trọn vẹn cho khách.

---

## PHẦN 2: LOGIC 2 - XEM LẠI LỊCH SỬ THỰC THI CÁC TASK TRƯỚC ĐÓ

Có **2 hướng tiếp cận** để cấp "trí nhớ" cho Agent đọc lại lịch sử các task cũ:

```text
┌────────────────────────────────────────────────────────────────────────┐
│               SO SÁNH 2 HƯỚNG TRÍCH XUẤT NGỮ CẢNH LỊCH SỬ              │
├────────────────────────────────────────────────────────────────────────┤
│                                                                        │
│  【HƯỚNG A】n8n Viết Hết Logic               【HƯỚNG B】Agent Tự Chủ Động Gọi   │
│  - n8n truy vấn 3 Task cũ & log chat         - n8n chỉ gửi tin nhắn + chat_id  │
│  - Ghép sẵn vào trường Description           - Agent dùng tool tra cứu khi cần │
│  - ⚡ 0s delay, Agent thấy ngay lập tức       - 🧹 UI sạch sẽ, không phình to   │
│  - ⚠️ Description trên UI bị dài & rối       - ⏳ Tốn thêm 1-2 lượt gọi tool   │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
```

---

### 2.1. HƯỚNG A: Viết hết logic trích xuất ngữ cảnh trong n8n (Pre-packaging)

Trong hướng này, n8n đóng vai trò là "người tổng hợp thông tin" trước khi tạo task mới.

#### Các bước thiết lập trên n8n:
1. **Node Truy vấn Lịch sử:**
   * Sau khi tiếp nhận tin nhắn Telegram, n8n gọi Paperclip API:
     `GET /api/companies/:companyId/issues?limit=5`
   * Lọc lấy 3 Task gần nhất của `chat_id` này đã ở trạng thái `done`.
2. **Node Code (Đóng gói Markdown Description):**
   ```javascript
   const currentMsg = $json.message.text;
   const recentTasks = $('Get Recent Issues').all().map(i => i.json);

   let historySummary = "";
   for (const task of recentTasks.slice(0, 3)) {
     historySummary += `- [${task.identifier}] ${task.title} (Trạng thái: ${task.status})\n`;
   }

   const packagedDescription = `### YÊU CẦU HIỆN TẠI:
${currentMsg}

### LỊCH SỬ CÔNG VIỆC ĐÃ THỰC HIỆN GẦN ĐÂY:
${historySummary || "Chưa có task nào trước đó."}

---
chat_id: ${$json.message.chat.id}
message_id: ${$json.message.message_id}`;

   return {
     taskTitle: currentMsg.slice(0, 80),
     taskDescription: packagedDescription
   };
   ```
3. **Node Tạo Task:** Gọi `POST /api/companies/:companyId/issues` với `description: packagedDescription`.

👉 **Kết quả:** Agent thức dậy đọc Prompt đầu tiên là có đầy đủ ngữ cảnh ngay lập tức!

---

### 2.2. HƯỚNG B: Để cho Agent tự chủ động gọi MCP Tool (Agent-Driven)

Trong hướng này, n8n giữ cho Task cực kỳ gọn gàng. Khi Agent thấy yêu cầu có liên quan đến quá khứ, Agent sẽ **tự dùng các MCP Tool mà chúng ta vừa xây dựng**.

#### Bước 1: Phía n8n truyền Metadata chuẩn qua khối Fenced JSON trong Description
Do Paperclip REST API không nhận trường metadata tuỳ biến ở body tạo Issue, n8n sẽ kẹp khối JSON cô lập ở cuối description:
```json
{
  "title": "[Telegram] {{ $json.message.text.slice(0, 80) }}",
  "description": "{{ $json.message.text }}\n\n```json:telegram_context\n{\n  \"chat_id\": {{ $json.message.chat.id }},\n  \"message_id\": {{ $json.message.message_id }}\n}\n```"
}
```
*Cách này đảm bảo máy đọc chuẩn xác 100%, không bị vỡ định dạng và loại bỏ hoàn toàn việc phải dùng Regex.*

#### Bước 2: Cấu hình Prompt trong `AGENTS.md` để hướng dẫn Agent
Bổ sung đoạn chỉ dẫn sau vào file [`c:\paperclip\AGENTS.md`](file:///c:/paperclip/AGENTS.md) của công ty:

```markdown
### QUY TẮC HOÀN THÀNH CÔNG VIỆC & TRẢ LỜI TELEGRAM:
Khi bạn hoàn thành công việc hoặc đã tạo xong file được yêu cầu, hãy gọi tool:
finish_task_and_reply_telegram(
    message="<Nội dung giải thích kết quả cho người dùng>",
    file_path="<đường dẫn file nếu có>"
)
*Lưu ý: Bạn KHÔNG CẦN điền task_id hay chat_id, hệ thống backend sẽ tự động nhận diện và chuyển dữ liệu trọn vẹn về Telegram cho khách.*
```

#### Bước 3: Chu trình tự thực thi của Agent (Dòng suy nghĩ thực tế)
Khi Agent nhận yêu cầu: *"Vẽ biểu đồ từ file số liệu hôm trước cho tôi"*:
1. **Lượt 1 (Tra cứu lịch sử):**
   Agent phát hiện câu hỏi nhắc tới "hôm trước" $\rightarrow$ Tự gọi:
   ```json
   {
     "name": "get_recent_tasks_by_chat",
     "arguments": { "chat_id": 123456789, "limit": 3 }
   }
   ```
2. **Lượt 2 (Nhận kết quả & Đọc file):**
   Tool trả về: *Task KHT-58 (done) có file đính kèm `so_lieu_thang6.csv` với downloadPath `/api/attachments/att-99/content`*.
   Agent tự gọi tiếp:
   ```json
   {
     "name": "read_file_universal",
     "arguments": { "file_path": "/api/attachments/att-99/content" }
   }
   ```
3. **Lượt 3 (Xử lý & Trả lời):**
   Tool đọc xong file CSV $\rightarrow$ Agent viết code vẽ biểu đồ, lưu file `bieu_do.png` $\rightarrow$ Gọi `finish_task_and_reply_telegram(file_path="bieu_do.png", message="Đã vẽ biểu đồ...")`.

---

## 3. KHUYẾN NGHỊ VẬN HÀNH TỐI ƯU (MÔ HÌNH LAI - HYBRID BEST PRACTICE)

Để hệ thống đạt độ ổn định và chi phí tối ưu nhất, hãy áp dụng mô hình kết hợp:

1. **Với Logic 1 (Subtask Blocked):** **100% xử lý bằng n8n Router (Node 4 & 5)** để unblock ngay lập tức subtask đang mắc. Tiết kiệm 90% chi phí và không bao giờ bị trùng lặp task.
2. **Với Logic 2 (Ngữ cảnh lịch sử):**
   * Nếu người dùng **chat liên tục trong 15 phút**: n8n nối ngắn gọn 1-2 câu chat gần nhất vào description (theo **Hướng A**).
   * Nếu người dùng **quay lại sau nhiều ngày** hỏi tìm lại file cũ, báo cáo cũ: Để Agent sử dụng **Hướng B** (`get_recent_tasks_by_chat` + `read_file_universal`) để tự động tra cứu sâu!

---

## 4. TÀI LIỆU CHI TIẾT TỪNG BƯỚC TRIỂN KHAI BACKEND & WEBHOOK

Xem hướng dẫn chi tiết toàn diện step-by-step (kèm toàn bộ mã nguồn Python MCP Server, cấu hình n8n, payload đầy đủ gửi về webhook) tại:
👉 [huong_dan_trien_khai_zero_hallucination_pipeline.md](file:///c:/paperclip/instructions/huong_dan_trien_khai_zero_hallucination_pipeline.md)

