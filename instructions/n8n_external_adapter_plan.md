# Kế hoạch tạo external adapter `n8n_runtime` cho Paperclip và n8n

## 1. Mục tiêu

Mục tiêu của adapter `n8n_runtime` là thay thế cách dùng HTTP adapter thường khi Paperclip gọi sang n8n.

HTTP adapter hiện tại chỉ gọi một webhook và nhận kết quả HTTP. Nó không hiểu execution của n8n, không tự lấy log từng node, và không có logic riêng để đẩy trace về Run tab của Paperclip.

External adapter `n8n_runtime` sẽ đóng vai trò adapter chuyên biệt cho n8n:

- Paperclip gọi adapter khi agent được wake/run.
- Adapter trigger webhook n8n.
- Adapter tìm đúng execution vừa được tạo.
- Adapter poll n8n Execution API để lấy trạng thái workflow và từng node.
- Adapter đẩy log/event về Paperclip qua `ctx.onLog`, `ctx.onEvent`, `ctx.onRuntimeProgress` nếu có.
- Khi workflow kết thúc, adapter trả `AdapterExecutionResult` cho Paperclip.

Luồng tổng quát:

```txt
Paperclip run
-> n8n_runtime external adapter
-> n8n webhook
-> n8n execution API
-> ctx.onLog / ctx.onEvent / ctx.onRuntimeProgress
-> Paperclip Run tab
```

## 2. Vì sao cần external adapter

Hiện tại ta đã có prototype `n8n-bridge` chạy riêng ở `http://localhost:3005/run`.

Prototype này đã chứng minh được:

- Gọi được webhook n8n.
- Tự sinh `traceId`.
- Tìm được `executionId`.
- Đọc được execution data từ n8n.
- Lấy được output của từng node.
- Gửi log về Paperclip Run tab.

Tuy nhiên bridge hiện tại vẫn là một service HTTP đứng ngoài Paperclip. Hướng external adapter giúp đưa logic này vào đúng cơ chế adapter của Paperclip.

Lợi ích:

- Không cần cấu hình agent qua HTTP adapter trung gian.
- Adapter có quyền dùng callback native của Paperclip như `ctx.onLog`, `ctx.onEvent`.
- Config gắn trực tiếp vào agent.
- Có thể viết `testEnvironment` để nút Test trên UI kiểm tra n8n config.
- Có thể viết UI parser riêng để Run tab hiển thị đẹp hơn.
- Dễ nâng cấp về sau sang lifecycle hook hoặc callback gateway.

## 3. Phạm vi bản đầu

Bản đầu nên làm theo hướng ít rủi ro nhất:

- Chưa sửa n8n Docker image.
- Chưa dùng internal lifecycle hook của n8n.
- Chưa thay đổi core Paperclip nếu không cần.
- Chưa cần UI parser quá đẹp.
- Tận dụng logic đã chạy thành công trong `n8n-bridge`.
- Dùng polling n8n Execution API mỗi 1-2 giây.

Nói cách khác, bản đầu là:

```txt
External adapter + n8n webhook + n8n execution polling
```

Chưa phải:

```txt
External adapter + n8n internal lifecycle hook
```

## 4. Vị trí package

Theo tài liệu external adapter, adapter nên là một package riêng, nằm ngoài Paperclip core.

Đề xuất chuẩn:

```txt
C:\paperclip-n8n-adapter
```

Trong giai đoạn test nhanh, có thể đặt tạm trong repo:

```txt
C:\paperclip\n8n-runtime-adapter
```

Nhưng khi báo cáo kiến trúc, nên mô tả theo hướng package riêng bên ngoài Paperclip core. Điều này đúng với tinh thần external adapter: phát triển, build, install, reload độc lập với Paperclip.

## 5. Cấu trúc package

Cấu trúc tối thiểu:

```txt
paperclip-n8n-adapter/
  package.json
  tsconfig.json
  src/
    index.ts
    server/
      index.ts
      execute.ts
      parse.ts
      test.ts
    ui-parser.ts
```

Ý nghĩa từng file:

| File | Vai trò |
|---|---|
| `src/index.ts` | Khai báo metadata: adapter type, label, models, agentConfigurationDoc |
| `src/server/index.ts` | Export `createServerAdapter()` cho Paperclip plugin-loader |
| `src/server/execute.ts` | Logic chính: gọi n8n, tìm execution, poll, emit log/event |
| `src/server/parse.ts` | Helper parse/summarize node input-output, redact dữ liệu nhạy cảm |
| `src/server/test.ts` | Kiểm tra config n8n trước khi chạy |
| `src/ui-parser.ts` | Parser log JSONL để UI Run tab hiển thị dễ đọc hơn |

## 6. Adapter type

Adapter type đề xuất:

```txt
n8n_runtime
```

Khi tạo hoặc cập nhật agent, đổi:

```json
{
  "adapterType": "http"
}
```

sang:

```json
{
  "adapterType": "n8n_runtime"
}
```

## 7. Adapter config

Với HTTP adapter cũ, agent thường chỉ có:

```json
{
  "url": "http://localhost:3005/run",
  "method": "POST"
}
```

Với `n8n_runtime`, config nên là:

```json
{
  "webhookUrl": "https://inexpert-aleida-rostrally.ngrok-free.dev/webhook/<webhook-b>",
  "workflowId": "<workflow-b-id>",
  "baseUrl": "https://inexpert-aleida-rostrally.ngrok-free.dev",
  "method": "POST",
  "pollIntervalMs": 1000,
  "executionTimeoutMs": 300000,
  "matchTraceId": true,
  "logDetail": "compact"
}
```

Ý nghĩa:

| Field | Ý nghĩa |
|---|---|
| `webhookUrl` | URL webhook của workflow B trong n8n |
| `workflowId` | ID workflow B, dùng để query Execution API |
| `baseUrl` | Base URL của n8n, ví dụ ngrok URL |
| `method` | HTTP method khi gọi webhook, thường là `POST` |
| `pollIntervalMs` | Chu kỳ poll execution, ví dụ 1000ms |
| `executionTimeoutMs` | Timeout tối đa của execution |
| `matchTraceId` | Có kiểm tra `traceId` trong execution data hay không |
| `logDetail` | Mức chi tiết log: `compact` hoặc `full` |

Để dễ migrate, adapter nên hỗ trợ cả field cũ:

```ts
const webhookUrl = config.webhookUrl ?? config.url;
```

Như vậy có thể giữ gần giống cấu hình HTTP adapter cũ, rồi bổ sung `workflowId`, `baseUrl` để bật trace.

## 8. Secret và API key

Không nên lưu `N8N_API_KEY` trực tiếp trong `adapterConfig`, vì `adapterConfig` có thể bị hiển thị hoặc log ra ở nhiều nơi.

Khuyến nghị dùng environment variable ở Paperclip server:

```powershell
$env:N8N_API_KEY="your-n8n-api-key"
```

Nếu chạy Paperclip bằng terminal:

```powershell
cd C:\paperclip
$env:N8N_API_KEY="your-n8n-api-key"
pnpm dev
```

Nếu sau này cần nhiều n8n instance khác nhau, có thể thêm secret store hoặc config riêng, nhưng bản prototype nên dùng env để đơn giản và an toàn hơn.

## 9. Luồng xử lý trong `execute(ctx)`

Pseudo flow:

```txt
1. Adapter nhận AdapterExecutionContext từ Paperclip.
2. Đọc config: webhookUrl, baseUrl, workflowId, method, timeout.
3. Tạo traceId, ví dụ: pc-<runId>-<issueId>.
4. Build payload gửi sang n8n:
   - Content/query từ task context
   - paperclipRunId
   - issueId/taskId
   - agentId
   - companyId
   - traceId
5. Gọi webhook n8n.
6. Query /api/v1/executions?workflowId=...&limit=10.
7. Chọn execution mới nhất sau thời điểm trigger.
8. Nếu bật matchTraceId, đọc execution data để xác nhận traceId đúng.
9. Poll /api/v1/executions/{executionId}?includeData=true.
10. Với mỗi node mới có dữ liệu:
    - tạo event `n8n.node.finished`
    - emit `ctx.onLog("stdout", jsonLine)`
    - emit `ctx.onEvent?.({...})`
11. Khi execution finished:
    - emit `n8n.execution.finished`
    - trả AdapterExecutionResult cho Paperclip.
```

Ví dụ event log:

```json
{
  "type": "n8n.node.finished",
  "executionId": "266",
  "traceId": "pc-aa22b2dc-a82b-4278-8ca6-072008a5ea26",
  "nodeName": "AI Agent1",
  "status": "success",
  "durationMs": 726,
  "message": "[AI Agent1] success (726ms)"
}
```

## 10. Callback Paperclip nên dùng

External adapter có thể dùng các callback từ `AdapterExecutionContext`.

Các callback quan trọng:

| Callback | Vai trò |
|---|---|
| `ctx.onLog("stdout", chunk)` | Ghi log ra Run tab |
| `ctx.onLog("stderr", chunk)` | Ghi lỗi/cảnh báo ra Run tab |
| `ctx.onEvent?.({...})` | Ghi event có cấu trúc nếu runtime hỗ trợ |
| `ctx.onRuntimeProgress?.({...})` | Cập nhật progress runtime nếu runtime hỗ trợ |
| `ctx.onMeta?.({...})` | Ghi metadata invocation |

Bản đầu bắt buộc dùng `ctx.onLog`, vì bridge hiện tại đã chứng minh Run tab hiển thị được JSONL log.

Sau đó mới nâng cấp thêm `ctx.onEvent` để Paperclip lưu event có cấu trúc hơn.

## 11. Kết quả trả về cho Paperclip

Khi n8n workflow thành công:

```json
{
  "exitCode": 0,
  "signal": null,
  "timedOut": false,
  "summary": "Workflow n8n completed successfully",
  "resultJson": {
    "executionId": "266",
    "traceId": "pc-aa22b2dc-a82b-4278-8ca6-072008a5ea26",
    "status": "success"
  }
}
```

Khi n8n workflow lỗi:

```json
{
  "exitCode": 1,
  "signal": null,
  "timedOut": false,
  "errorMessage": "Workflow n8n failed",
  "summary": "Workflow n8n failed",
  "resultJson": {
    "executionId": "266",
    "traceId": "pc-aa22b2dc-a82b-4278-8ca6-072008a5ea26",
    "status": "error"
  }
}
```

Khi timeout:

```json
{
  "exitCode": null,
  "signal": null,
  "timedOut": true,
  "errorMessage": "n8n execution timed out"
}
```

## 12. `testEnvironment`

Adapter nên hỗ trợ nút Test trên giao diện agent.

Các check nên có:

| Check | Mức |
|---|---|
| Thiếu `webhookUrl` hoặc `url` | `error` |
| Thiếu `baseUrl` | `error` |
| Thiếu `workflowId` | `warn` hoặc `error`, tùy có fallback hay không |
| Thiếu `N8N_API_KEY` | `error` nếu cần gọi Execution API |
| `baseUrl` không hợp lệ | `error` |
| Không gọi được n8n API | `error` |
| Gọi được `/api/v1/executions` | `info` |

Ví dụ kết quả:

```json
{
  "adapterType": "n8n_runtime",
  "status": "pass",
  "checks": [
    {
      "level": "info",
      "code": "n8n_api_reachable",
      "message": "n8n Execution API reachable"
    }
  ],
  "testedAt": "2026-08-17T00:00:00.000Z"
}
```

## 13. UI config trên giao diện agent

Nếu chỉ làm server external adapter tối thiểu, giao diện có thể chưa render field riêng đẹp như HTTP adapter.

Hướng tốt hơn là tạo config UI để phần Adapter hiển thị các field:

```txt
Adapter type: n8n Runtime
Webhook URL
n8n Base URL
Workflow ID
Method
Poll interval
Execution timeout
Log detail
Match traceId
```

Trong bản đầu, có thể ưu tiên API/Postman để update agent config. Sau khi logic chạy ổn, mới làm UI config đẹp.

## 14. UI parser cho Run tab

Bản đầu có thể log JSONL như bridge hiện tại:

```json
{"type":"n8n.node.finished","nodeName":"AI Agent1","message":"[AI Agent1] success (726ms)"}
```

Sau đó `ui-parser.ts` có thể parse thành timeline dễ đọc:

```txt
Bridge started
n8n workflow triggered
Execution found: 266
Node finished: Nhận request từ Agent
Node finished: AI Agent1
Node finished: HTTP Request
Workflow finished: success
```

Mục tiêu là người vận hành xem Run tab hiểu được:

- workflow nào được gọi;
- executionId là gì;
- node nào đã chạy;
- node nào lỗi;
- mất bao lâu;
- output tóm tắt là gì.

## 15. Cài đặt local adapter

Sau khi tạo package:

```powershell
cd C:\paperclip-n8n-adapter
pnpm install
pnpm build
```

Cài vào Paperclip bằng CLI:

```powershell
paperclipai adapter install --payload-json "{\"localPath\":\"C:\\paperclip-n8n-adapter\"}"
```

Kiểm tra:

```powershell
paperclipai adapter list
paperclipai adapter get n8n_runtime
```

Sau khi sửa code adapter:

```powershell
cd C:\paperclip-n8n-adapter
pnpm build
paperclipai adapter reload n8n_runtime
```

## 16. Cập nhật agent để dùng adapter mới

Endpoint cập nhật một phần agent:

```txt
PATCH /api/companies/:companyId/agents/:agentId
```

Ví dụ:

```http
PATCH http://localhost:3100/api/companies/81ed1694-1183-47f8-8898-507b8b2f6520/agents/<agentId>
Authorization: Bearer <token>
Content-Type: application/json
```

Body:

```json
{
  "adapterType": "n8n_runtime",
  "adapterConfig": {
    "webhookUrl": "https://inexpert-aleida-rostrally.ngrok-free.dev/webhook/<webhook-b>",
    "workflowId": "<workflow-b-id>",
    "baseUrl": "https://inexpert-aleida-rostrally.ngrok-free.dev",
    "method": "POST",
    "pollIntervalMs": 1000,
    "executionTimeoutMs": 300000,
    "matchTraceId": true,
    "logDetail": "compact"
  }
}
```

Nếu n8n chạy Docker còn Paperclip chạy Windows, chú ý hướng kết nối:

- Từ n8n container gọi Paperclip Windows: dùng `http://host.docker.internal:3100`.
- Từ Paperclip Windows gọi n8n/ngrok: dùng ngrok URL hoặc `http://localhost:5678` nếu gọi trực tiếp được từ Windows.
- Từ Paperclip adapter gọi n8n Execution API: dùng `baseUrl` mà Paperclip server truy cập được.

## 17. Test end-to-end

Checklist test:

```txt
1. Chạy Paperclip.
2. Chạy n8n Docker.
3. Đảm bảo n8n có N8N_API_KEY và lưu execution data.
4. Test n8n Execution API:
   GET <baseUrl>/api/v1/executions/<id>?includeData=true
5. Build external adapter.
6. Install adapter vào Paperclip.
7. Đổi agent sang adapterType = n8n_runtime.
8. Tạo task mới trong Paperclip.
9. Paperclip wake agent.
10. Adapter gọi workflow B.
11. Run tab hiển thị log từng node.
12. Workflow B cập nhật status/comment của issue.
13. Adapter trả result success/error cho Paperclip.
```

## 18. Quan hệ với workflow A và workflow B

Kiến trúc hiện tại của bạn có 2 workflow:

```txt
Workflow A:
Người dùng gửi query
-> tạo task trong Paperclip
-> Paperclip giao task cho agent

Workflow B:
Paperclip gọi agent HTTP adapter
-> webhook n8n
-> AI Agent xử lý
-> update status/comment task
```

Khi chuyển sang external adapter:

```txt
Workflow A giữ nguyên.
Paperclip vẫn tạo task và assign agent như cũ.
Chỉ thay bước Paperclip gọi agent:
HTTP adapter -> n8n_runtime adapter.
Workflow B vẫn là workflow xử lý chính.
```

Nói ngắn gọn: không cần bỏ workflow A. External adapter chỉ thay cơ chế gọi workflow B và trace workflow B.

## 19. Vai trò của `traceId`

`traceId` không bắt buộc tuyệt đối, nhưng rất nên dùng.

Nếu không có `traceId`, adapter phải đoán execution bằng:

```txt
workflowId + startedAt >= thời điểm trigger + execution mới nhất
```

Cách này có thể nhầm nếu nhiều request chạy gần nhau.

Nếu có `traceId`, adapter sẽ:

```txt
1. Sinh traceId trước khi gọi webhook.
2. Gửi traceId vào query/body của webhook.
3. Đọc Webhook node input trong execution data.
4. Chỉ chọn execution có traceId đúng.
```

Với luồng 2 workflow:

- Workflow A không cần traceId nếu chỉ tạo task.
- Workflow B nên nhận traceId từ adapter.
- Nếu Workflow A gọi Paperclip rồi Paperclip mới gọi Workflow B, traceId của Workflow B nên do adapter tạo tại thời điểm Paperclip wake agent.

## 20. So sánh các hướng

| Hướng | Có cần sửa workflow n8n không | Realtime | Độ khó | Ghi chú |
|---|---|---|---|---|
| HTTP adapter thường | Không | Không tốt | Thấp | Chỉ gọi webhook, ít trace |
| HTTP adapter + bridge ngoài | Không | Gần realtime | Trung bình | Prototype hiện tại đã chạy |
| External adapter + polling | Không | Gần realtime | Trung bình | Hướng nên làm tiếp |
| External adapter + lifecycle hook | Không sửa từng workflow, nhưng sửa runtime n8n | Realtime tốt hơn | Cao | Là nâng cấp sau |
| Thêm node log vào từng workflow | Có | Rất rõ nghiệp vụ | Thấp-trung bình | Nhưng tốn công và dễ miss |

## 21. Rủi ro và giới hạn

External adapter bản polling có vài giới hạn:

- Không biết node vừa bắt đầu chạy ngay lập tức, chỉ biết rõ khi execution data có cập nhật.
- Độ trễ phụ thuộc `pollIntervalMs`.
- Nếu n8n không lưu execution progress/data, adapter không lấy được node output.
- Nếu workflow chạy quá nhanh, log vẫn có nhưng có thể hiện gần như cùng lúc.
- Nếu nhiều execution chạy song song mà không có `traceId`, có thể match nhầm.

Vì vậy cần đảm bảo:

- n8n bật lưu execution success/error/progress.
- `traceId` được truyền vào webhook.
- `workflowId` đúng.
- `N8N_API_KEY` dùng được với Execution API.

## 22. Lộ trình triển khai

Đề xuất làm theo thứ tự:

```txt
Phase 1: External adapter polling
1. Scaffold package adapter.
2. Port logic từ n8n-bridge.
3. Build/install/reload adapter.
4. Đổi một agent test sang n8n_runtime.
5. Test Run tab có log từng node.

Phase 2: Làm log dễ đọc hơn
1. Chuẩn hóa event schema.
2. Thêm ui-parser.ts.
3. Rút gọn outputSummary.
4. Redact dữ liệu nhạy cảm.

Phase 3: Config UI tốt hơn
1. Thêm field Webhook URL, Workflow ID, Base URL.
2. Thêm Test button/check diagnostics.
3. Cho phép migrate từ HTTP config cũ.

Phase 4: Realtime nâng cao nếu cần
1. Nghiên cứu n8n lifecycle hook.
2. Tạo callback gateway hoặc hook extension.
3. Đẩy node start/end/error theo push thay vì polling.
```

## 23. Kết luận

External adapter `n8n_runtime` là hướng phù hợp sau khi prototype bridge đã chạy thành công.

Bản đầu nên chuyển logic bridge vào adapter Paperclip thay vì sửa n8n. Như vậy ta có một tích hợp sạch hơn:

```txt
Paperclip = control plane, task lifecycle, Run tab
n8n = execution runtime
n8n_runtime adapter = lớp tích hợp chuyên biệt để trigger, trace và báo cáo execution
```

Khi bản polling hoạt động ổn, có thể nâng cấp tiếp sang lifecycle hook để lấy node-level realtime chính xác hơn mà không phải thêm HTTP Request node thủ công vào từng workflow.
