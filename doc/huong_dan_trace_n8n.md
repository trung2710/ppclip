# Hướng dẫn các phương án lấy trace execution n8n cho Paperclip

Ngày cập nhật: 2026-08-13

## 1. Mục tiêu

Mục tiêu là để Paperclip theo dõi được quá trình chạy workflow n8n theo từng bước:

```text
Workflow bắt đầu
  -> Node A bắt đầu/kết thúc
  -> Node B bắt đầu/kết thúc
  -> Node C gọi tool hoặc AI
  -> Workflow thành công/thất bại
```

Thông tin cần theo dõi có thể gồm:

- Tên node và thứ tự thực thi.
- Thời điểm bắt đầu, kết thúc và thời gian chạy.
- Trạng thái thành công/thất bại.
- Input/output nếu n8n đã lưu.
- Tool call, model call và lỗi.
- Kết quả cuối cùng.

## 2. Ba khái niệm cần phân biệt

### 2.1. Execution data

Đây là dữ liệu n8n lưu trong execution, có thể truy xuất bằng API:

```http
GET /api/v1/executions/{executionId}?includeData=true
```

Trong response của workflow hiện tại, dữ liệu nằm ở:

```text
data.resultData.runData
```

Execution `151` đã cho thấy các kênh dữ liệu:

```text
data.main             -> output node thông thường
data.ai_languageModel -> lần gọi model AI
data.ai_tool          -> kết quả tool, ví dụ Google Sheets
```

### 2.2. External hook

External hook là callback ở tầng ứng dụng n8n. Nó được gọi tại các mốc lớn của workflow:

```text
workflow.preExecute  -> trước khi workflow bắt đầu
workflow.postExecute -> sau khi workflow kết thúc
```

External hook không đồng nghĩa với hook trước/sau từng node.

### 2.3. Internal node lifecycle hook

Đây là hook bên trong execution engine của n8n:

```text
nodeExecuteBefore -> ngay trước khi node chạy
nodeExecuteAfter  -> sau khi node chạy xong
```

Đây mới là cơ chế phù hợp để lấy event node-level chính xác. Nó cần code chạy bên trong hoặc được gắn vào process n8n, không phải chỉ cấu hình một HTTP Request node trong giao diện.

## 3. Kiến trúc hiện tại

Workflow hiện tại có hai nhánh webhook trong cùng một workflow n8n:

```text
Paperclip
  -> Webhook tạo task
  -> Tạo agent
  -> Tạo task

Paperclip gọi agent
  -> Webhook nhận request từ agent
  -> AI Agent1
  -> Google Sheets tool
  -> PATCH task done
  -> GET task
```

Ở execution `151`, Paperclip đã gửi `runId`, `taskId` và context task vào webhook agent. Execution này lấy được trace sau khi chạy xong; Paperclip hiện nhận response cuối cùng sau node `HTTP Request1`, chưa nhận từng event trong lúc node đang chạy.

## 4. Phương án 0: Chỉ lấy execution sau khi hoàn thành

### Cách hoạt động

```text
Paperclip gọi n8n
  -> n8n chạy xong
  -> wrapper lấy execution bằng API
  -> wrapper đọc toàn bộ runData
  -> gửi một lần sang Paperclip
```

### Dữ liệu nhận được

- Toàn bộ node đã chạy.
- Output từng node.
- AI model call và tool output.
- Trạng thái, lỗi và kết quả cuối.

### Ưu điểm

- Dễ làm nhất.
- Không cần sửa n8n runtime.
- Phù hợp để kiểm tra cấu trúc response và viết parser.

### Nhược điểm

- Không realtime.
- Workflow chạy lâu sẽ không có tiến độ ở giữa.
- Không biết chính xác node đang chạy tại thời điểm hiện tại.

Đây là bước đầu tiên nên làm để xây parser và kiểm tra dữ liệu.

## 5. Phương án 1: Polling incremental execution API

Đây là phương án đơn giản nhất để có theo dõi gần realtime.

### Cách hoạt động

```text
Paperclip
  -> Wrapper gọi n8n
  -> nhận hoặc xác định executionId

Wrapper lặp mỗi 1-2 giây:
  -> GET /api/v1/executions/{executionId}?includeData=true
  -> đọc runData
  -> phát hiện node mới
  -> gửi event mới sang Paperclip
```

### Cấu hình n8n

Với self-hosted n8n, bật lưu progress:

```env
EXECUTIONS_DATA_SAVE_ON_PROGRESS=true
EXECUTIONS_DATA_SAVE_ON_SUCCESS=all
EXECUTIONS_DATA_SAVE_ON_ERROR=all
```

Sau khi thay đổi cần restart n8n.

### Chống gửi trùng

Mỗi run tạo một khóa:

```ts
const eventKey = `${executionId}:${nodeName}:${run.executionIndex}`;
```

Nếu `eventKey` đã gửi thì bỏ qua. `executionIndex` quan trọng vì một node có thể chạy nhiều lần, đặc biệt trong AI Agent hoặc vòng lặp.

### Pseudocode

```ts
const seen = new Set<string>();

while (true) {
  const execution = await getExecution(executionId);
  const runData = execution.data?.resultData?.runData ?? {};

  for (const [nodeName, runs] of Object.entries(runData)) {
    for (const run of runs as any[]) {
      const key = `${execution.id}:${nodeName}:${run.executionIndex}`;
      if (seen.has(key)) continue;

      seen.add(key);
      const channel = Object.keys(run.data ?? {})[0] ?? "unknown";

      await emitEvent({
        eventType: "n8n.node.finished",
        message: `Node ${nodeName} đã hoàn thành`,
        payload: {
          executionId: execution.id,
          nodeName,
          executionIndex: run.executionIndex,
          channel,
          status: run.executionStatus,
          durationMs: run.executionTime,
          output: run.data?.[channel] ?? null,
          error: run.error ?? null,
        },
      });
    }
  }

  if (execution.finished) break;
  await sleep(1500);
}
```

### Lấy được gì

- Node đã hoàn thành.
- Output node đã được lưu.
- Tool output và AI model output.
- Thời gian, lỗi và trạng thái execution.

### Hạn chế

- Không lấy chính xác thời điểm node vừa bắt đầu.
- Có thể bỏ lỡ trạng thái rất ngắn.
- Dữ liệu realtime phụ thuộc việc n8n lưu progress.
- Cần xử lý race condition khi tìm execution mới.

### Đánh giá

Đây là phương án nên triển khai đầu tiên cho prototype và bản production ban đầu vì không cần sửa từng workflow hay n8n runtime.

## 6. Phương án 2: n8n external hooks cấp workflow

### Link tham khảo

- [n8n external hooks](https://github.com/n8n-io/n8n/blob/9205eb3f1908b94904b6d5400c32dcf3c4baf1b7/packages/cli/src/external-hooks.ts#L149)
- [workflow.preExecute/postExecute](https://github.com/n8n-io/n8n/blob/9205eb3f1908b94904b6d5400c32dcf3c4baf1b7/packages/cli/src/external-hooks.ts#L149)

Hai liên kết trên cùng trỏ tới một cơ chế external hook ở tầng CLI của n8n; chúng không phải hai phương án riêng biệt.

### Các mốc chính

```text
workflow.preExecute
  -> workflow sắp bắt đầu

workflow.postExecute
  -> workflow đã kết thúc, có fullRunData
```

### Dùng để làm gì?

External hooks phù hợp để:

- Đăng ký `executionId` ngay khi workflow bắt đầu.
- Gắn `executionId` với Paperclip `runId`.
- Gửi trạng thái workflow bắt đầu.
- Gửi kết quả cuối khi workflow kết thúc.
- Kích hoạt hoặc kết thúc một worker polling.

### Không dùng được cho

External hook cấp workflow không tự cung cấp event:

```text
node A started
node A finished
node B started
node B finished
```

Vì vậy external hook không giải quyết đầy đủ yêu cầu trace từng node. Giá trị lớn nhất của `preExecute` là giúp wrapper biết `executionId` sớm, thay vì đoán execution mới nhất bằng cách lọc danh sách executions.

## 7. Phương án 3: Internal node lifecycle hooks

### Link tham khảo

[n8n internal node lifecycle hooks](https://github.com/n8n-io/n8n/blob/9205eb3f1908b94904b6d5400c32dcf3c4baf1b7/packages/core/src/execution-engine/execution-lifecycle-hooks.ts#L16)

### Các hook chính

```text
nodeExecuteBefore -> trước khi node chạy
nodeExecuteAfter  -> sau khi node chạy xong
workflowExecuteBefore -> trước khi workflow chạy
workflowExecuteAfter -> sau khi workflow kết thúc
sendChunk -> node gửi chunk cho streaming response
```

### Luồng sử dụng

```text
nodeExecuteBefore
  -> n8n.node.started
  -> bridge
  -> Paperclip

nodeExecuteAfter
  -> n8n.node.finished hoặc n8n.node.failed
  -> bridge
  -> Paperclip
```

### Dùng để làm gì?

Đây là phương án phù hợp nhất nếu cần:

- Event node bắt đầu gần như tức thời.
- Event node kết thúc ngay khi có output.
- Bắt lỗi node tại thời điểm xảy ra.
- Theo dõi tool/model node bên trong AI Agent.
- Không phụ thuộc hoàn toàn vào polling database.

### Vì sao cần bridge?

Lifecycle event của n8n có kiểu dữ liệu nội bộ. Paperclip lại cần event theo contract adapter của Paperclip.

Ví dụ n8n phát ra:

```ts
nodeExecuteAfter(nodeName, taskData, executionData)
```

Bridge chuyển thành:

```ts
{
  eventType: "n8n.node.finished",
  message: `Node ${nodeName} đã hoàn thành`,
  payload: {
    executionId,
    nodeName,
    status: "success",
    output: taskData.data,
    durationMs: taskData.executionTime,
  },
}
```

Bridge không nhất thiết là service thứ hai. Nếu wrapper đang chạy trong Paperclip external adapter, wrapper có thể đồng thời làm:

```text
Adapter = gọi n8n
Bridge  = chuyển lifecycle event n8n
```

### Hạn chế

- Đây là API nội bộ của n8n, cần kiểm tra tương thích theo phiên bản.
- Có thể phải build hoặc patch phần runtime n8n.
- Cần xác thực callback.
- Cần chống gửi trùng và giữ thứ tự event.
- Cần giới hạn kích thước input/output vì dữ liệu có thể rất lớn.

## 8. Phương án 4: Callback gateway và API ingest của Paperclip

Lifecycle hook tạo được event trong n8n, nhưng cần có đường nhận để đẩy event vào Paperclip.

### Kiến trúc

```text
n8n lifecycle hook
  -> POST /wrapper/events
  -> wrapper xác thực và chuẩn hóa
  -> Paperclip event ingest
  -> Paperclip lưu event
  -> UI nhận live update
```

### Payload đề xuất

```json
{
  "executionId": "151",
  "paperclipRunId": "8216c7b5-dea3-4975-8306-b16fc7162cb2",
  "sequence": 4,
  "eventType": "n8n.node.finished",
  "nodeName": "AI Agent1",
  "status": "success",
  "durationMs": 1421,
  "payload": {
    "channel": "main",
    "outputSummary": "AI trả về danh sách 4 đơn hàng Tiki"
  }
}
```

### Các kiểm tra bắt buộc

- API key hoặc integration token.
- Company scope.
- Mapping đúng `Paperclip runId` và `n8n executionId`.
- `sequence` tăng dần.
- `Idempotency-Key` để chống event trùng.
- Không nhận event sau khi run đã terminal.
- Redaction dữ liệu nhạy cảm.
- Giới hạn kích thước payload.

### Khi nào cần sửa Paperclip core?

Nếu Paperclip chưa có public endpoint nhận event cho external runtime, cần thêm route ingest riêng. Đây là thay đổi Paperclip core, không chỉ là cấu hình n8n.

Nếu chưa muốn sửa Paperclip core, có thể gửi event thông qua comment hoặc cập nhật issue, nhưng cách đó không phù hợp cho hàng trăm event node-level vì làm timeline bị nhiễu.

## 9. Phương án 5: Progress node trong từng workflow

### Cách hoạt động

Thêm node HTTP Request hoặc Code vào workflow để chủ động gửi progress:

```json
{
  "eventType": "business.progress",
  "message": "Đã đọc xong dữ liệu đơn hàng",
  "progress": 60,
  "metadata": {
    "processed": 60,
    "total": 100
  }
}
```

### Ưu điểm

- Phản ánh đúng tiến độ nghiệp vụ.
- Có thể báo `60/100`, `4/10`, hoặc milestone có ý nghĩa.
- Không cần can thiệp n8n runtime.

### Nhược điểm

- Phải sửa từng workflow.
- Người tạo workflow phải nhớ thêm progress node.
- Không tự động bao phủ các node không có callback.

### Khi dùng

Chỉ dùng cho workflow quan trọng cần tiến độ nghiệp vụ; không nên bắt buộc cho mọi workflow.

## 10. So sánh các phương án

| Phương án | Sửa từng workflow | Theo dõi từng node | Realtime | Độ phức tạp | Khuyến nghị |
|---|---:|---:|---:|---:|---|
| Lấy API sau khi chạy | Không | Có, sau khi xong | Không | Thấp | Kiểm tra ban đầu |
| Polling API + save progress | Không | Node đã hoàn thành | Gần realtime | Thấp-vừa | Nên làm đầu tiên |
| External `preExecute/postExecute` | Không | Không đầy đủ | Mốc workflow | Vừa | Lấy executionId và lifecycle tổng |
| Internal node lifecycle hook | Không | Có | Có | Cao | Bản nâng cao |
| Callback gateway + ingest | Không | Có | Có | Cao | Production nhiều event |
| Progress node | Có | Theo milestone | Có | Thấp-vừa | Tiến độ nghiệp vụ |

## 11. Lộ trình đề xuất cho hệ thống hiện tại

### Giai đoạn 1: Hoàn thiện parser

Đã thực hiện được một phần với execution `151`:

```text
GET execution
  -> đọc runData
  -> đọc main/ai_languageModel/ai_tool
  -> xác định output từng node
```

### Giai đoạn 2: Polling incremental

1. Bật `EXECUTIONS_DATA_SAVE_ON_PROGRESS`.
2. Nhận hoặc đăng ký `executionId` ngay khi workflow bắt đầu.
3. Lặp gọi execution API mỗi 1-2 giây.
4. Phát hiện run mới bằng `executionIndex`.
5. Gửi `n8n.node.finished` sang Paperclip.
6. Khi `finished=true`, gửi `n8n.workflow.finished`.

### Giai đoạn 3: External hook cấp workflow

Thêm `workflow.preExecute` để:

```text
workflow bắt đầu
  -> gửi executionId + Paperclip runId cho wrapper
```

Sau đó polling không cần đoán execution mới nhất.

### Giai đoạn 4: Node lifecycle bridge

Chỉ triển khai khi polling chưa đáp ứng yêu cầu:

```text
nodeExecuteBefore/After
  -> bridge
  -> Paperclip event ingest
```

### Giai đoạn 5: UI Paperclip

Phân loại event trong UI:

```text
Comment       -> báo cáo/milestone cho con người
Activity      -> thay đổi task
Run event     -> trace kỹ thuật từng node
Live status   -> node hiện đang chạy
```

Không nên ghi toàn bộ input/output lớn thành comment. Nên lưu event kỹ thuật vào run transcript hoặc event store, còn comment chỉ chứa kết quả và milestone quan trọng.

## 12. Khuyến nghị cuối cùng

Không cần triển khai tất cả phương án cùng lúc.

Lựa chọn phù hợp nhất là:

```text
Hiện tại:
Polling incremental + EXECUTIONS_DATA_SAVE_ON_PROGRESS

Sau đó:
External preExecute để lấy executionId chính xác

Khi cần realtime node.started/node.finished:
Internal lifecycle hook + bridge

Khi cần hệ thống production quy mô lớn:
Callback gateway + Paperclip ingest endpoint
```

Tóm tắt vai trò:

```text
Polling
  = wrapper chủ động hỏi n8n có dữ liệu mới chưa

External hook
  = n8n báo các mốc bắt đầu/kết thúc workflow

Internal lifecycle hook
  = n8n báo chính xác trước/sau từng node

Bridge
  = chuyển định dạng event của n8n sang Paperclip

Ingest endpoint
  = cổng để Paperclip nhận và lưu event được push vào
```

## 13. Tài liệu tham khảo

- [n8n external hooks](https://github.com/n8n-io/n8n/blob/9205eb3f1908b94904b6d5400c32dcf3c4baf1b7/packages/cli/src/external-hooks.ts#L149)
- [n8n internal execution lifecycle hooks](https://github.com/n8n-io/n8n/blob/9205eb3f1908b94904b6d5400c32dcf3c4baf1b7/packages/core/src/execution-engine/execution-lifecycle-hooks.ts#L16)
- [n8n execution history](https://docs.n8n.io/workflows/executions/all-executions/)
- [Paperclip adapter callbacks](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/packages/adapter-utils/src/types.ts#L186-L189)
- [Paperclip external adapters](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/docs/adapters/external-adapters.md#L6)
- [Paperclip HTTP adapter limitation](https://github.com/paperclipai/paperclip/blob/66575fe519db7320147aece94fa66e15eba375c1/docs/adapters/http.md#L15-L17)
