# Báo cáo vấn đề realtime log của n8n runtime adapter

## 1. Bối cảnh

Hiện tại Paperclip đang dùng external adapter `n8n_runtime` để gọi workflow n8n qua webhook, sau đó dùng n8n Execution API để lấy log từng node và hiển thị trong tab Runs của agent.

Mục tiêu mong muốn:

- Paperclip gọi workflow n8n.
- Workflow n8n đang chạy thì Paperclip vẫn thấy log/progress của các node đã hoàn thành.
- Khi workflow kết thúc, Paperclip nhận trạng thái cuối và task được chốt bằng comment/document/status.

Vấn đề phát hiện trong quá trình test:

- Workflow n8n đang ở trạng thái `running`.
- Một số node đầu đã chạy xong trong n8n.
- Nhưng Paperclip chỉ hiển thị log đầu như `run started`, `n8n runtime adapter received Paperclip run`.
- Log từng node chỉ xuất hiện muộn, hoặc chỉ xuất hiện sau khi workflow đã kết thúc.

## 2. Nguyên nhân kỹ thuật hiện tại

Trong adapter hiện tại, hàm `execute()` đang chạy theo thứ tự:

```ts
await triggerN8nWebhook({ ctx, config, traceId, issueId });

await emit(ctx, "n8n.triggered", {
  traceId,
  message: "n8n webhook triggered",
});

const executionId = await findExecutionId({
  ctx,
  config,
  traceId,
  startedAtMs,
});

const result = await pollExecution({
  ctx,
  config,
  executionId,
  traceId,
});
```

Điểm gây nghẽn là:

```ts
await triggerN8nWebhook(...)
```

Trong `triggerN8nWebhook()`, adapter gọi:

```ts
const response = await fetch(url, {
  method: config.method,
  headers: {
    "Content-Type": "application/json",
    Accept: "application/json,text/plain,*/*",
    ...config.headers,
  },
  body: config.method === "GET" ? undefined : JSON.stringify(body),
});
```

Nếu node Webhook của n8n cấu hình `Respond using Respond to Webhook Node`, HTTP response sẽ bị giữ tới cuối workflow.

Vì vậy adapter bị chặn tại `await fetch(...)`, chưa đi tới các bước:

```ts
findExecutionId()
pollExecution()
```

Kết quả là cơ chế realtime log bị biến thành:

```text
n8n chạy xong workflow
-> webhook mới trả response
-> adapter mới tìm executionId
-> adapter đọc execution data
-> adapter phát lại log từng node
```

Nói cách khác, với cấu hình hiện tại, nó dễ trở thành cơ chế `post-run log replay`, không phải realtime polling đúng nghĩa.

## 3. Mức độ ảnh hưởng

Ảnh hưởng chính:

- Paperclip không hiển thị được tiến độ node trong lúc workflow đang chạy.
- Nếu workflow bị treo ở một node lâu, Paperclip không thấy các node trước đó đã hoàn thành.
- Người vận hành khó biết workflow đang kẹt ở đâu.
- Adapter mất lợi thế realtime so với cách gọi HTTP adapter thông thường.

Điều này đặc biệt rõ khi workflow có các node chậm như:

- AI Agent / LLM node.
- HTTP Request tới API bên ngoài.
- Wait node.
- Tool node cần thời gian xử lý.
- Workflow xử lý file lớn.

## 4. Hướng sửa từ đơn giản đến nâng cao

## 4.1. Cách 1: Cấu hình n8n Webhook trả response ngay

Đây là cách đơn giản nhất, không cần sửa code adapter.

Trong node Webhook đầu workflow, đổi response mode sang:

```text
Respond Immediately
```

Thay vì:

```text
Respond using Respond to Webhook Node
```

Luồng sau khi sửa:

```text
Paperclip adapter gọi webhook
-> n8n trả HTTP 200 ngay
-> adapter tiếp tục findExecutionId()
-> adapter bắt đầu pollExecution()
-> workflow n8n vẫn chạy phía sau
-> node nào hoàn thành thì adapter emit log dần
```

Ưu điểm:

- Không cần sửa code.
- Có thể test ngay.
- Phù hợp demo nhanh.
- Giúp adapter bắt đầu polling sớm hơn.

Nhược điểm:

- Response webhook không còn mang final result cuối workflow.
- Node `Respond to Webhook` cuối luồng không còn cần thiết.
- Kết quả cuối phải được ghi về Paperclip bằng API riêng:

```text
PUT /api/issues/{issueId}/documents/result
POST /api/issues/{issueId}/comments
PATCH /api/issues/{issueId}
```

Đánh giá:

Đây là cách nên áp dụng ngay cho demo. Nó giải quyết phần nghẽn lớn nhất mà không cần deploy lại adapter.

## 4.2. Cách 2: Sửa adapter để không chờ webhook response trước khi polling

Đây là hướng sửa đúng hơn ở tầng adapter.

Ý tưởng:

Thay vì:

```ts
await triggerN8nWebhook();
const executionId = await findExecutionId();
await pollExecution();
```

Đổi thành:

```ts
const triggerPromise = triggerN8nWebhook();

await emit(ctx, "n8n.triggered", {
  traceId,
  message: "n8n webhook trigger request sent",
});

const executionId = await findExecutionId({
  ctx,
  config,
  traceId,
  startedAtMs,
});

const result = await pollExecution({
  ctx,
  config,
  executionId,
  traceId,
});

await triggerPromise;
return result;
```

Hoặc thực tế nên dùng logic an toàn hơn:

```ts
const triggerPromise = triggerN8nWebhook().catch((error) => error);

await emit(ctx, "n8n.triggered", {
  traceId,
  message: "n8n webhook trigger request sent",
});

const executionId = await findExecutionId(...);
const result = await pollExecution(...);

const triggerResult = await triggerPromise;
if (triggerResult instanceof Error && result.exitCode === 0) {
  await emit(ctx, "n8n.webhook.response_error_after_execution", {
    traceId,
    level: "warn",
    message: triggerResult.message,
  });
}

return result;
```

Ưu điểm:

- Adapter có thể polling khi workflow vẫn đang chạy, kể cả khi webhook giữ response đến cuối.
- Giảm phụ thuộc vào cấu hình n8n Webhook.
- Hợp lý hơn về kiến trúc vì trigger workflow và monitor execution là hai việc khác nhau.

Nhược điểm:

- Cần sửa code adapter.
- Cần xử lý race condition: có thể `findExecutionId()` chạy trước khi n8n tạo execution.
- Cần xử lý trường hợp webhook trả lỗi sớm.
- Cần xử lý timeout của webhook và timeout của execution riêng biệt.

Khuyến nghị:

Đây là sửa đổi nên làm sau demo hoặc trước khi đóng gói adapter nghiêm túc hơn.

## 4.3. Cách 3: Thêm cấu hình `webhookResponseMode`

Có thể cho adapter một option rõ ràng:

```json
{
  "webhookResponseMode": "await" | "detached"
}
```

Ý nghĩa:

- `await`: giữ hành vi cũ, chờ webhook response rồi mới poll.
- `detached`: gửi webhook xong là đi tìm execution và poll ngay.

Luồng `detached`:

```text
trigger webhook
-> không chờ final response
-> find execution
-> poll execution
-> emit node logs
```

Ưu điểm:

- Không phá vỡ workflow cũ đang phụ thuộc vào webhook final response.
- Cho phép từng agent chọn mode phù hợp.
- Dễ giải thích trong UI adapter config.

Nhược điểm:

- Adapter phức tạp hơn một chút.
- Cần test cả 2 mode.

Khuyến nghị:

Nên thêm nếu adapter sẽ dùng lâu dài cho nhiều loại workflow.

## 4.4. Cách 4: Tách trigger và monitor thành hai tiến trình logic

Hướng này biến adapter thành một bridge đúng nghĩa:

```text
execute()
-> trigger n8n
-> lưu mapping paperclipRunId <-> executionId
-> monitor execution bằng loop riêng
-> emit event/log về Paperclip
```

Có thể bổ sung persistence:

```text
paperclipRunId
traceId
workflowId
executionId
status
lastEmittedSequence
createdAt
updatedAt
```

Ưu điểm:

- Chịu lỗi tốt hơn.
- Nếu adapter process restart, có thể resume monitor.
- Phù hợp production hơn.

Nhược điểm:

- Cần storage/mapping.
- Cần cơ chế cleanup.
- Cần quản lý concurrency.

Khuyến nghị:

Chưa cần cho demo. Phù hợp phase production hardening.

## 4.5. Cách 5: Dùng n8n lifecycle hook hoặc extension để push event

Đây là hướng realtime mạnh nhất.

Thay vì adapter poll execution API, n8n runtime tự bắn event khi node chạy:

```text
nodeExecuteBefore
nodeExecuteAfter
workflowExecuteAfter
-> bridge/Paperclip event endpoint
```

Luồng:

```text
n8n node started
-> push event sang Paperclip
n8n node finished
-> push event sang Paperclip
n8n workflow finished
-> push final event sang Paperclip
```

Ưu điểm:

- Realtime thật hơn polling.
- Có thể biết node started, finished, error.
- Không cần đoán executionId bằng traceId sau webhook.

Nhược điểm:

- Phức tạp hơn nhiều.
- Có thể phải custom n8n image hoặc extension.
- Cần Paperclip có endpoint ingest event hoặc adapter bridge nhận callback.
- Cần bảo mật token, idempotency, ordering.

Khuyến nghị:

Chỉ nên làm sau khi adapter polling đã ổn.

## 5. Đề xuất thứ tự triển khai

## Phase 1: Khắc phục nhanh cho demo

Mục tiêu:

- Paperclip thấy log node trong lúc workflow đang chạy.
- Không sửa code adapter.

Việc cần làm:

1. Đổi Webhook node của n8n sang `Respond Immediately`.
2. Bỏ hoặc không phụ thuộc node `Respond to Webhook` cuối luồng.
3. Đảm bảo workflow ghi kết quả bằng Paperclip API:

```text
PUT /api/issues/{issueId}/documents/result
POST /api/issues/{issueId}/comments
PATCH /api/issues/{issueId}
```

Kết quả kỳ vọng:

- Adapter nhận response webhook sớm.
- Adapter tìm được executionId sớm.
- Adapter bắt đầu polling trong lúc n8n còn chạy.
- Paperclip hiển thị dần các node đã hoàn thành.

## Phase 2: Sửa adapter để trigger webhook không block polling

Mục tiêu:

- Không phụ thuộc người cấu hình n8n có chọn `Respond Immediately` hay không.
- Adapter tự chủ động monitor execution sớm.

Việc cần sửa:

1. Trong `execute()`, đổi:

```ts
await triggerN8nWebhook(...)
```

thành:

```ts
const triggerPromise = triggerN8nWebhook(...)
```

2. Emit event `n8n.triggered` ngay sau khi gửi request hoặc sau khi request bắt đầu.
3. Gọi `findExecutionId()` ngay sau đó.
4. Gọi `pollExecution()` ngay khi tìm được executionId.
5. Sau khi execution terminal, xử lý kết quả `triggerPromise` như warning nếu cần.

Điểm cần test:

- Webhook trả ngay.
- Webhook giữ response đến cuối workflow.
- Webhook trả 404.
- Webhook trả 500.
- Không tìm thấy executionId.
- Workflow thành công.
- Workflow lỗi giữa chừng.

## Phase 3: Thêm option `webhookResponseMode`

Mục tiêu:

- Tương thích cả workflow cũ và workflow cần realtime.

Config đề xuất:

```json
{
  "webhookResponseMode": "detached"
}
```

Default khuyến nghị:

```text
detached
```

Vì adapter này có mục tiêu chính là runtime monitoring.

## Phase 4: Lifecycle hook/callback

Mục tiêu:

- Realtime node-level chính xác hơn polling.

Việc cần làm:

- Tạo n8n extension/global hook.
- Tạo callback gateway hoặc Paperclip ingest endpoint.
- Gửi event có `traceId`, `paperclipRunId`, `executionId`, `nodeName`, `status`, `sequence`.
- Chống duplicate bằng `Idempotency-Key`.
- Kiểm tra company/run scope.

## 6. Kết luận

Vấn đề hiện tại không nằm ở Paperclip UI, cũng không phải do n8n không có execution data. Vấn đề chính nằm ở thứ tự trong adapter:

```text
await webhook response
-> find execution
-> poll execution
```

Khi n8n giữ webhook response tới cuối workflow, adapter chỉ bắt đầu polling sau khi workflow gần như đã xong. Vì vậy log realtime bị biến thành phát lại log sau chạy.

Khuyến nghị hành động:

1. Demo ngay: đổi n8n Webhook sang `Respond Immediately`.
2. Sửa adapter: trigger webhook theo kiểu non-blocking rồi tìm execution/poll song song.
3. Sau đó mới tính lifecycle hook nếu cần realtime node-level chuẩn hơn.

