# Báo Cáo Chi Tiết: Khắc Phục Lỗi Log Realtime Polling Trong `execute.ts`

Tài liệu này tổng hợp toàn bộ phân tích nguyên nhân gốc rễ và các thay đổi mã nguồn đã thực hiện trong file [execute.ts](file:///C:/paperclip/n8n-runtime-adapter/src/server/execute.ts) thuộc `n8n-runtime-adapter`.

---

## 1. Triệu Chứng & Vấn Đề Ban Đầu

Khi một Paperclip Run kích hoạt workflow n8n (đặc biệt là các workflow có AI Agent hoặc các node xử lý mất nhiều thời gian):
- **Không hiển thị log từng bước theo thời gian thực (Realtime):** Giao diện Paperclip bị đứng yên và "im lặng" trong suốt thời gian workflow đang chạy (10–30 giây hoặc lâu hơn).
- **Log bị dồn một cục:** Chỉ khi toàn bộ workflow n8n kết thúc thì tất cả các dòng log của các node mới được đẩy ra cùng một lúc.
- **Lỗi 400 Bad Request (phát sinh khi thử lọc status):** Khi thêm tham số lọc nhiều trạng thái gộp dạng chuỗi, n8n API từ chối với lỗi schema validation.

---

## 2. Nguyên Nhân Gốc Rễ (Root Causes)

### 📌 Nguyên nhân 1: Cơ chế `seenCandidates` bỏ qua execution hợp lệ
* **Hiện tượng:** Trong hàm `findExecutionId()`, khi webhook vừa kích hoạt, n8n đã tạo bản ghi execution nhưng chưa kịp hoàn tất serialize dữ liệu (`runData`, `traceId`) vào database n8n.
* **Cơ chế lỗi:** 
  1. Adapter quét thấy `executionId = 123` nhưng khi kiểm tra `deepContains(detail, traceId)` thì trả về `false`.
  2. Code cũ gọi `seenCandidates.add("123")` để đánh dấu ID này là "đã xem".
  3. Ở các vòng lặp polling tiếp theo (khi n8n đã nạp xong `traceId`), vì `seenCandidates.has("123") === true` nên code `continue` bỏ qua vĩnh viễn.
  4. Adapter phải chờ hết 30 giây (`findExecutionTimeoutMs`) mới kích hoạt fallback lấy ID mới nhất, làm lỡ hoàn toàn giai đoạn workflow đang chạy để stream log.

### 📌 Nguyên nhân 2: n8n REST API mặc định ẩn Execution đang chạy (`running`)
* **Hiện tượng:** Khi gọi `GET /api/v1/executions` mặc định (không kèm query parameter `status`), n8n chỉ trả về danh sách các execution **đã hoàn thành** (`success`, `error`). Các execution đang ở trạng thái `running` hoặc `waiting` bị ẩn khỏi danh sách.
* **Cơ chế lỗi:** Trong suốt quá trình workflow đang chạy, `listExecutions()` liên tục trả về mảng rỗng `[]`. Adapter không tìm thấy ID nào cho tới khi workflow chạy xong và chuyển sang `success`.
* **Phát sinh lỗi 400:** n8n API chỉ nhận **1 giá trị đơn lẻ** cho query param `status` (ví dụ `status=running`). Khi truyền chuỗi gộp `status=running,waiting,new,success,error`, API n8n trả về `400 Bad Request: request/query/status must be equal to one of the allowed values`.

---

## 3. Giải Pháp Khắc Phục (Solutions)

| Vấn đề | Giải pháp đã triển khai |
|---|---|
| **`seenCandidates` chặn re-check** | Xóa bỏ hoàn toàn `seenCandidates`. Cho phép kiểm tra lại execution detail qua `getExecution()` ở mỗi chu kỳ polling cho đến khi khớp `traceId`. Sử dụng `lastLoggedId` để tránh spam log sự kiện `"n8n.execution.candidate"`. |
| **n8n ẩn execution `running`** | Triển khai cơ chế **gọi song song 2 request API** qua `Promise.all()`:<br>1. Request 1: `?status=running` (bắt ngay execution đang thực thi).<br>2. Request 2: URL mặc định (lấy các execution đã xong).<br>Sau đó gộp (`merge`) kết quả 2 danh sách lại. |
| **Tránh lỗi 400 Bad Request** | Truyền đúng 1 giá trị enum `status=running` cho request chuyên biệt, tuân thủ nghiêm ngặt schema API của n8n. |

---

## 4. Chi Tiết Thay Đổi Code Trong `execute.ts`

### 🔹 Thay đổi 1: Cập nhật hàm `findExecutionId`

**Mục đích:** Xóa bỏ `seenCandidates`, cho phép re-check execution ID liên tục cho đến khi tìm thấy `traceId`.

```typescript
// ==========================================
// CODE MỚI ĐÃ CẬP NHẬT:
// ==========================================
async function findExecutionId(params: {
  ctx: AdapterExecutionContext;
  config: N8nRuntimeConfig;
  traceId: string;
  startedAtMs: number;
  getWebhookTriggerError?: () => Error | null;
}): Promise<string> {
  const { ctx, config, traceId, startedAtMs, getWebhookTriggerError } = params;
  const deadline = Date.now() + config.findExecutionTimeoutMs;
  let lastLoggedId: string | null = null;

  // Chờ n8n kịp tạo execution trong DB
  await delay(400);

  while (Date.now() < deadline) {
    const triggerError = getWebhookTriggerError?.();
    if (triggerError) throw triggerError;

    const executions = await listExecutions(config);
    const recent = executions
      .filter((execution) => {
        const startedAt = Date.parse(asString(execution.startedAt, asString(execution.createdAt)));
        return Number.isFinite(startedAt) && startedAt >= startedAtMs - 10_000;
      })
      .sort((a, b) => {
        const bStarted = Date.parse(asString(b.startedAt, asString(b.createdAt)));
        const aStarted = Date.parse(asString(a.startedAt, asString(a.createdAt)));
        return bStarted - aStarted;
      });

    for (const execution of recent) {
      const id = String(execution.id);

      // Chỉ log 1 lần cho mỗi candidate mới (tránh spam log lặp lại)
      if (id !== lastLoggedId) {
        lastLoggedId = id;
        await emit(ctx, "n8n.execution.candidate", {
          executionId: id,
          startedAt: execution.startedAt,
          message: "checking n8n execution candidate",
        });
      }

      // KIỂM TRA LẠI MỖI VÒNG LẶP (Đã bỏ seenCandidates)
      const detail = await getExecution(config, id, true);
      if (deepContains(detail, traceId)) return id;
    }

    // Fallback nếu tắt matchTraceId
    if (!config.matchTraceId && recent[0]?.id) {
      return String(recent[0].id);
    }

    await delay(config.pollIntervalMs);
  }

  // Fallback cuối: lấy execution mới nhất
  const executions = await listExecutions(config);
  if (executions[0]?.id) {
    await emit(ctx, "n8n.execution.fallback", {
      executionId: String(executions[0].id),
      message: "traceId not matched, using newest execution",
    });
    return String(executions[0].id);
  }

  throw new Error("Could not find matching n8n execution");
}
```

---

### 🔹 Thay đổi 2: Cập nhật hàm `listExecutions`

**Mục đích:** Bắt được cả execution đang `running` và execution vừa `success`/hoàn thành thông qua 2 request song song, không bị n8n chặn với lỗi 400.

```typescript
// ==========================================
// CODE MỚI ĐÃ CẬP NHẬT:
// ==========================================
async function listExecutions(config: N8nRuntimeConfig): Promise<JsonRecord[]> {
  // 1. URL lấy các execution đang CHẠY (status=running)
  const urlRunning = new URL(`${config.baseUrl}/api/v1/executions`);
  urlRunning.searchParams.set("workflowId", config.workflowId);
  urlRunning.searchParams.set("limit", "10");
  urlRunning.searchParams.set("includeData", "false");
  urlRunning.searchParams.set("status", "running");

  // 2. URL mặc định (lấy các execution đã hoàn thành)
  const urlDefault = new URL(`${config.baseUrl}/api/v1/executions`);
  urlDefault.searchParams.set("workflowId", config.workflowId);
  urlDefault.searchParams.set("limit", "10");
  urlDefault.searchParams.set("includeData", "false");

  // Gọi song song cả 2 API
  const [resRunning, resDefault] = await Promise.all([
    fetch(urlRunning, { headers: { "X-N8N-API-KEY": config.n8nApiKey, Accept: "application/json" } }),
    fetch(urlDefault, { headers: { "X-N8N-API-KEY": config.n8nApiKey, Accept: "application/json" } })
  ]);

  if (!resDefault.ok) {
    const text = await resDefault.text().catch(() => "");
    throw new Error(`n8n list executions failed: ${resDefault.status} ${text.slice(0, 500)}`);
  }

  const jsonRunning = resRunning.ok ? (await resRunning.json() as JsonRecord) : { data: [] };
  const jsonDefault = await resDefault.json() as JsonRecord;

  const dataRunning = Array.isArray(jsonRunning.data) ? jsonRunning.data : [];
  const dataDefault = Array.isArray(jsonDefault.data) ? jsonDefault.data : [];

  // Gộp cả 2 danh sách và lọc trùng lặp theo execution ID
  const seenIds = new Set<string>();
  const executions: JsonRecord[] = [];

  for (const raw of [...dataRunning, ...dataDefault]) {
    const item = parseObject(raw);
    const id = item.id != null ? String(item.id) : "";
    if (id) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }
    executions.push(item);
  }

  return executions;
}
```

---

## 5. Kết Quả Luồng Thực Thi Sau Khi Sửa

1. **t = 0ms:** Paperclip bắn Webhook n8n và khởi chạy `findExecutionId()` song song.
2. **t = 400ms – 1s:** `listExecutions()` gọi API `status=running` → **Tìm thấy ngay `executionId` đang chạy**.
3. **t = 1s – khi kết thúc:** `pollExecution()` liên tục quét `runData` → mỗi khi một Node (hoặc AI Agent) trong n8n chạy xong, log của Node đó được `emit()` ngay lập tức lên giao diện Paperclip.
4. **Khi toàn bộ workflow xong:** Bắt trạng thái `finished` và đóng Run một cách mượt mà.
