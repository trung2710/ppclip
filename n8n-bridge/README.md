# n8n Bridge Prototype for Paperclip HTTP Adapter

Bridge prototype này dùng cho giai đoạn thử nghiệm:

```text
Paperclip HTTP adapter -> n8n bridge -> n8n Webhook B
```

Bridge làm các việc:

- nhận request từ Paperclip/Postman;
- sinh `traceId`;
- gọi Webhook B của n8n kèm `traceId`;
- tự tìm `executionId` bằng n8n executions API;
- poll `/api/v1/executions/{executionId}?includeData=true`;
- stream log từng node về client dạng JSON Lines.

## 1. Cấu hình

Tạo file `.env` từ `.env.example`:

```powershell
Copy-Item .env.example .env
```

Điền các giá trị:

```env
N8N_BASE_URL=https://inexpert-aleida-rostrally.ngrok-free.dev
N8N_API_KEY=...
N8N_WEBHOOK_URL=https://inexpert-aleida-rostrally.ngrok-free.dev/webhook/309453b4-5a59-4b75-badf-999972cd393b
N8N_WORKFLOW_ID=AXa9GvhJ7SkQ2brv
```

`N8N_WORKFLOW_ID` lấy từ URL n8n:

```text
/workflow/<workflowId>/executions/<executionId>
```

## 2. Chạy bridge

```powershell
cd C:\paperclip\n8n-bridge
node bridge.js
```

Bridge mặc định chạy ở:

```text
http://localhost:3005
```

## 3. Test bằng Postman

Gọi:

```http
POST http://localhost:3005/run
Content-Type: application/json
```

Body:

```json
{
  "Content": "Lấy cho tôi thông tin các đơn hàng mà sản phẩm là Chuot"
}
```

Kết quả mong muốn là response stream dạng JSON Lines:

```jsonl
{"type":"bridge.started","message":"Bridge nhận request"}
{"type":"n8n.triggered","traceId":"pc-...","message":"Đã gọi webhook n8n"}
{"type":"n8n.execution.found","executionId":"151","message":"Đã tìm thấy execution n8n"}
{"type":"n8n.node.finished","nodeName":"Groq Chat Model","durationMs":726}
{"type":"n8n.execution.finished","status":"success"}
```

## 4. Nối với Paperclip

Sau khi test Postman ổn, đổi URL của agent HTTP adapter:

```text
https://.../webhook/B
```

sang:

```text
http://host.docker.internal:3005/run
```

Nếu Paperclip chạy trực tiếp trên Windows host, có thể dùng:

```text
http://localhost:3005/run
```

## 5. Lưu ý bảo mật

Bridge mặc định không gửi full input node, vì execution data có thể chứa prompt, API key, token, header hoặc dữ liệu khách hàng.

Bridge chỉ gửi summary rút gọn. Nếu cần debug input, bật:

```env
INCLUDE_INPUT_SUMMARY=true
```

Chỉ bật tùy chọn này khi debug local.

Mặc định bridge dùng log gọn:

```env
LOG_DETAIL=compact
```

Nếu cần xem thêm `outputSummary` dài để debug:

```env
LOG_DETAIL=verbose
```
