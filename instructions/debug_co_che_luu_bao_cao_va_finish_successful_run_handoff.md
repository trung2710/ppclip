# Kiến trúc & Cơ chế: Lưu báo cáo Run và Tự phục hồi `finish_successful_run_handoff` trong Paperclip

Tài liệu này tổng hợp toàn bộ kiến trúc, vị trí code và luồng dữ liệu từ khi một Agent thực thi xong, cách lưu báo cáo vào Database, cho đến khi cơ chế tự phục hồi (`finish_successful_run_handoff`) đọc lại báo cáo và ép Agent chốt trạng thái công việc.

---

## 1. Toàn bộ danh mục `wakeReason` (Lý do đánh thức Run) trong Paperclip

Dưới đây là toàn bộ danh mục `wakeReason` trong toàn bộ codebase Paperclip, được phân loại chi tiết theo từng nhóm nghiệp vụ:

### 1.1. Nhóm Vòng đời Task & Tương tác Issue (Issue Lifecycle)
* **`issue_assigned`**: Agent được phân công vào một issue mới hoặc vừa nhận việc.
* **`issue_commented`**: Có bình luận mới trong thread của issue.
* **`issue_comment_mentioned`**: Agent được `@mention` trực tiếp trong bình luận.
* **`issue_reopened_via_comment`**: Issue đã đóng (`done`/`cancelled`) nhưng được mở lại khi có bình luận mới.
* **`issue_blockers_resolved`**: Các task phụ thuộc (blockers) đã hoàn thành, giải phóng để task này có thể chạy tiếp.
* **`issue_children_completed`**: Toàn bộ các sub-tasks (task con) đã làm xong $\rightarrow$ Đánh thức Task Cha để nghiệm thu/tổng hợp.
* **`issue_unblock_requested`**: Có yêu cầu gỡ chặn (unblock) thủ công cho issue.

### 1.2. Nhóm Phục hồi & Tự sửa lỗi (Recovery & Self-Healing)
* **`source_scoped_recovery_action`**: Kích hoạt run để thực hiện hành động khắc phục sự cố theo phạm vi nguồn (source-scoped recovery).
* **`issue_continuation_needed`**: Task chưa hoàn thành hết khối lượng công việc, hệ thống lên lịch chạy tiếp nối.
* **`issue_recovery_action_restored`**: Khôi phục lại trạng thái làm việc sau khi thực hiện xong hành động recovery.
* **`issue_tree_restored`**: Toàn bộ cây công việc (Issue Tree) được gỡ tạm dừng (unhold/unpause) và phục hồi luồng chạy.
* **`issue_assignment_recovery`**: Tự động phục hồi lại lượt giao việc khi phát hiện agent trước đó bị crash hoặc treo (stale run).
* **`issue_graph_liveness_backstop`**: Cơ chế quét an toàn tự động (backstop) kích hoạt lại các issue bị kẹt trạng thái giữa chừng.
* **`provider_quota_recovery`**: Đánh thức lại sau khi hết thời gian chờ hạn mức API (Rate limit / Quota reset).
* **`task_watchdog_stopped_subtree`**: Watchdog phát hiện lỗi vòng lặp ở nhánh con và đánh thức Agent quản lý để xử lý.
* **`execution_review_participant_recovery`**: Khôi phục lại phiên review khi người tham gia review bị ngắt quãng.
* **`finish_successful_run_handoff`**: Bàn giao dữ liệu sau khi kết thúc một run thành công để chuẩn bị cho giai đoạn tiếp theo (khi agent quên chốt trạng thái).

### 1.3. Nhóm Nối tiếp phiên & Thử lại (Continuations & Retries)
* **`max_turns_continuation_retry`**: Agent đã chạm giới hạn số lượt hội thoại (max turns) trong 1 run, tự động tạo run mới để làm tiếp bài toán.
* **`interaction_continuation_infra_retry`**: Thử lại tự động sau khi gặp sự cố hạ tầng (infra error) trong lúc đang chờ tương tác/xác nhận.
* **`transient_failure_retry`** *(hoặc `bounded_transient_heartbeat_retry`)*: Tự động retry khi gặp sự cố mạng hoặc lỗi API tạm thời.
* **`run_liveness_continuation`**: Tiếp tục theo dõi và duy trì tiến trình chạy dài hạn.

### 1.4. Nhóm Phê duyệt & Đánh giá (Approvals & Reviews)
* **`approval_approved`**: Yêu cầu phê duyệt được User bấm **Approve** (Chấp thuận).
* **`approval_rejected`**: Yêu cầu phê duyệt bị User bấm **Reject** (Từ chối).
* **`execution_review_requested`**: Có yêu cầu Review lại mã nguồn hoặc kết quả công việc.
* **`execution_changes_requested`**: Reviewer yêu cầu chỉnh sửa lại giải pháp/mã nguồn (Request changes).
* **`execution_approval_requested`**: Cần xin phê duyệt trước khi tiếp tục thực thi các bước quan trọng.

### 1.5. Nhóm Hẹn giờ, Plugins & Gateway Ngoại vi
* **`heartbeat_timer`**: Đánh thức theo lịch định kỳ (Cron / One-shot timer).
* **`issue_monitor_due`**: Đến hạn kiểm tra định kỳ của cơ chế giám sát Issue Monitor.
* **`plugin_issue_wakeup_requested`**: Một External Plugin kích hoạt đánh thức issue thông qua API.
* **`gateway_chat_message`**: Nhận tin nhắn chat từ Gateway bên ngoài (như Telegram, Discord, OpenClaw).

---

## 2. Tổng quan bài toán & Cơ chế `finish_successful_run_handoff`

### 2.1. Vấn đề thực tế
1. Agent nhận một task và bắt đầu xử lý (trạng thái issue là `in_progress`).
2. Agent viết code, chạy test, in log hoàn thành và kết thúc lượt chạy thành công (`status: succeeded`).
3. **Vấn đề:** Agent **quên gọi Tool đổi trạng thái của Task** (không đổi sang `done`, không chuyển sang `in_review`, không báo `blocked`, và cũng không đăng ký chạy tiếp `continuation`).
4. Task bị treo lơ lửng ở `in_progress`, khiến hệ thống Control Plane không biết bước tiếp theo phải làm gì.

### 2.2. Giải pháp của Paperclip
Hệ thống kích hoạt ngay một lượt chạy phụ (Recovery Run) với:
```json
{
  "wakeReason": "finish_successful_run_handoff"
}
```
Run này sẽ trích xuất lại báo cáo của chính Agent ở run trước, nhúng vào Prompt và **ép Agent chỉ được chọn đúng 1 trong 4 hành động hợp lệ**:
1. **Hoàn thành / Hủy:** Đổi sang `done` hoặc `cancelled`.
2. **Cần duyệt:** Đổi sang `in_review` (chỉ định Reviewer hoặc xin Approval).
3. **Bị tắc nghẽn:** Đổi sang `blocked` (gắn kèm `blockedByIssueIds`).
4. **Chưa xong còn việc:** Xin lịch chạy nối tiếp (`continuation`) hoặc tạo subtask.

---

## 3. Sơ đồ luồng dữ liệu tổng thể (End-to-End Flow)

```mermaid
sequenceDiagram
    autonumber
    actor Agent as AI Agent / Adapter
    participant Adapter as Adapter Runtime (Codex / n8n)
    participant Server as Paperclip Heartbeat Service
    participant DB as PostgreSQL / PGlite DB
    participant Recovery as Recovery Service (successful-run-handoff)

    Note over Agent,Adapter: 1. Thực thi nhiệm vụ
    Agent->>Adapter: Hoàn thành lượt chạy, trả về kết quả
    Adapter->>Adapter: Đóng gói summary, usage, resultJson
    Adapter->>Server: return AdapterExecutionResult

    Note over Server,DB: 2. Lưu kết quả vào Database
    Server->>DB: Ghi vào bảng heartbeat_runs (result_json, usage_json, next_action)

    Note over Server,Recovery: 3. Phát hiện lỗi bỏ quên trạng thái
    Server->>Recovery: Gọi decideSuccessfulRunHandoff()
    Recovery->>DB: Query kiểm tra (run = succeeded nhưng issue = in_progress)
    Recovery->>Server: Trả về quyết định: enqueue recovery run

    Note over Recovery,Agent: 4. Dựng Prompt & Kích hoạt Run mới
    Recovery->>Recovery: Trích xuất finalReport & bọc bằng fenceUntrustedText()
    Recovery->>Server: Đưa vào hàng đợi với wakeReason = finish_successful_run_handoff
    Server->>Agent: Kích hoạt Agent với báo cáo cũ + ép chọn 1 trong 4 hành động
```

---

## 4. Chi tiết vị trí Code trong Hệ thống

### 4.1. Tầng Adapter: Nơi tạo ra `summary` và `resultJson`

#### A. Trong `n8n-runtime-adapter`
File: [`c:/paperclip/n8n-runtime-adapter/src/server/execute.ts`](file:///c:/paperclip/n8n-runtime-adapter/src/server/execute.ts)

* **Dòng 399 - 420 (Đóng gói kết quả sau khi poll n8n workflow):**
```typescript
return {
  exitCode: failed ? 1 : 0,
  signal: null,
  timedOut: false,
  errorMessage: failed ? `n8n workflow ended with status ${status}` : null,
  summary: failed ? "n8n workflow failed" : "n8n workflow completed successfully",
  usage: usageResult,
  usageBasis: "per_run",
  model: primaryModel || fallbackModel || undefined,
  provider: primaryProvider || fallbackProvider || undefined,
  resultJson: removeUndefined({
    executionId,
    traceId,
    status,
    finished: execution.finished,
    startedAt: execution.startedAt,
    stoppedAt: execution.stoppedAt,
    tokenBreakdown: nodeUsageList.length > 0 ? nodeUsageList : undefined,
    totalTokens: totalTokens > 0 ? totalTokens : undefined,
  }),
};
```
* **Dòng 120 - 124 (Gán Webhook body làm result):**
```typescript
if (result.resultJson && !result.resultJson.result) {
  result.resultJson.result = triggerResult.body;
}
return result;
```

#### B. Trong `codex-local` Adapter (OpenAI Codex CLI)
File: [`packages/adapters/codex-local/src/server/execute.ts`](file:///c:/paperclip/packages/adapters/codex-local/src/server/execute.ts)

* **Dòng 1226 - 1238:**
```typescript
return {
  provider: "openai",
  model,
  resultJson: {
    stdout: attempt.proc.stdout,
    stderr: attempt.proc.stderr,
    outputInactivityMonitor: { ... },
  },
  summary: attempt.parsed.summary,  // Tóm tắt phản hồi từ Codex CLI
  clearSession: clearSessionOnMissingSession,
};
```

---

### 4.2. Tầng Server: Nơi ghi kết quả vào Database
File: [`server/src/services/heartbeat.ts`](file:///c:/paperclip/server/src/services/heartbeat.ts)

* **Dòng 13696:** Chờ Adapter thực thi xong:
```typescript
adapterResult = await adapter.execute({ ... });
```
* **Dòng 13918 - 13955:** Cập nhật bảng `heartbeat_runs` trong Database:
```typescript
const persistedResultJson = mergeHeartbeatRunResultJson(
  ...,
  adapterResult.summary ?? null,
);

await setRunStatusIfRunning(run.id, status, {
  finishedAt: new Date(),
  usageJson,                                  // Token input, output, chi phí USD
  resultJson: persistedResultJson,            // Lưu JSON tổng kết từ adapter
  nextAction: adapterResult.nextAction,       // Hành động dự kiến tiếp theo
  exitCode: adapterResult.exitCode,
  sessionIdAfter: nextSessionState.displayId,
  stdoutExcerpt,
  stderrExcerpt,
});
```

---

### 4.3. Tầng Recovery: Trích xuất báo cáo của Run trước
File: [`server/src/services/heartbeat.ts`](file:///c:/paperclip/server/src/services/heartbeat.ts)

* **Dòng 8008 - 8020 (Đọc dữ liệu từ bản ghi run cũ):**
```typescript
// 1. Parse JSON kết quả của run trước từ DB:
const resultJson = parseObject(run.resultJson);

// 2. Ưu tiên lấy summary -> result -> message làm finalReport:
const finalReport = redactSuccessfulRunHandoffEvidence(
  [
    readNonEmptyString(resultJson.summary),
    readNonEmptyString(resultJson.result),
    readNonEmptyString(resultJson.message),
  ].find((value): value is string => Boolean(value)) ?? null,
  currentUserRedactionOptions,
);

// 3. Lấy tóm tắt bằng chứng tiến độ từ activity_log (nếu có):
const detectedProgressSummary = buildDetectedSuccessfulRunProgressSummary(
  run,
  currentUserRedactionOptions,
);
```

---

### 4.4. Tầng Recovery: Quyết định kích hoạt & Ép luật 4 hành động
File: [`server/src/services/recovery/successful-run-handoff.ts`](file:///c:/paperclip/server/src/services/recovery/successful-run-handoff.ts)

#### A. Hàm kiểm tra điều kiện kích hoạt `decideSuccessfulRunHandoff` (Dòng 469 - 552)
```typescript
// 1. Run trước phải thành công:
if (run.status !== "succeeded") return { kind: "skip", reason: "source run did not succeed" };

// 2. Nhưng Issue vẫn bị kẹt ở in_progress:
if (issue.status !== "in_progress") {
  return { kind: "skip", reason: `issue status ${issue.status} is a valid disposition` };
}

// 3. Không có đường chạy hay phê duyệt nào khác:
if (input.hasActiveExecutionPath) return { kind: "skip", reason: "issue already has an active execution path" };

// 4. Kích hoạt Run Handoff:
const instruction = buildSuccessfulRunHandoffInstruction({ ... });
return {
  kind: "enqueue",
  targetAgentId: run.agentId,
  instruction,
  contextSnapshot: {
    wakeReason: "finish_successful_run_handoff",
    handoffRequired: true,
    handoffReason: "successful_run_missing_state",
    validDispositionOptions: [...SUCCESSFUL_RUN_HANDOFF_OPTIONS],
  },
};
```

#### B. Hàm dựng Prompt chuẩn hóa `buildSuccessfulRunHandoffInstruction` (Dòng 387 - 444)
```typescript
const report = ellipsize(
  readUntrustedText(input.finalReport) ?? readUntrustedText(input.detectedProgressSummary),
  2000,
);

return [
  "## What happened",
  "Your last run on this issue ended successfully, but the issue is still `in_progress` and has no valid disposition...",
  "",
  "Here is your own final report from that run (quoted verbatim as untrusted data):",
  fenceUntrustedText(report), // <--- Bọc dữ liệu báo cáo an toàn

  "## Your options",
  "Choose **exactly one** outcome and perform the matching Paperclip action:",
  "1. Is the issue finished? -> Mark it `done` or `cancelled`.",
  "2. Does someone else need to look at it? -> Move it to `in_review`.",
  "3. Can it not continue right now? -> Mark it `blocked` with blockers.",
  "4. Is there more work to do? -> Delegate follow-up or record continuation (`resumeIntent: true`).",

  "## What you need to do",
  "Read your own report above and decide honestly. Do not restate progress in a comment as a substitute for a disposition."
].join("\n");
```

---

## 5. Cơ chế bảo vệ Prompt: `fenceUntrustedText`

File: [`server/src/services/recovery/successful-run-handoff.ts:L337-L344`](file:///c:/paperclip/server/src/services/recovery/successful-run-handoff.ts#L337-L344)

```typescript
function fenceUntrustedText(value: string) {
  // 1. Quét tìm chuỗi dấu backtick (`) dài nhất nằm trong nội dung text:
  const longestBacktickRun = Math.max(
    2,
    ...Array.from(value.matchAll(/`+/g), (match) => match[0].length),
  );

  // 2. Tạo fence bao ngoài dài hơn 1 dấu backtick:
  const fence = "`".repeat(longestBacktickRun + 1);

  // 3. Trả về khối: ````text \n [nội dung] \n ````
  return [`${fence}text`, value, fence].join("\n");
}
```

### Tác dụng:
1. **Chống vỡ định dạng Markdown:** Nếu báo cáo chứa code block ```` ``` ````, hàm sẽ tự động dùng 4 dấu ```` ```` ```` để bao bên ngoài, giúp cấu trúc văn bản không bị đứt đoạn.
2. **Chống tấn công Prompt Injection:** Toàn bộ báo cáo cũ bị giam hoàn toàn bên trong khối dữ liệu thô (`untrusted data`), AI Model hiểu đây chỉ là văn bản tham khảo chứ không phải là câu lệnh chỉ thị mới.

---

## 6. Tóm tắt các bảng Database liên quan

| Tên bảng | Trường dữ liệu | Ý nghĩa |
| :--- | :--- | :--- |
| **`heartbeat_runs`** | `result_json` | Chứa object JSON tổng kết do Adapter trả về (`summary`, `result`, `executionId`...) |
| **`heartbeat_runs`** | `usage_json` | Chứa số lượng token input, output, cached và chi phí USD |
| **`heartbeat_runs`** | `next_action` | Hành động tiếp theo mà Agent đã ghi nhận |
| **`heartbeat_runs`** | `context_snapshot` | Lưu `wakeReason`, `issueId`, và các tham số khi kích hoạt run |
| **`activity_log`** | `action`, `details` | Ghi nhận theo thời gian thực mọi thao tác gọi tool (sửa issue, comment, tạo file) của Agent trong run |

---

## 7. Giải thích: Tại sao có bình luận tự động `"n8n workflow completed successfully"`?

Câu bình luận `"n8n workflow completed successfully"` xuất hiện là do **cơ chế tự động đăng thông báo (Auto Run-Summary Comment)** của Paperclip kết hợp với **giá trị mặc định trong `n8n-runtime-adapter`**.

### 7.1. Nguồn gốc chuỗi chữ `"n8n workflow completed successfully"`
Trong file [`c:/paperclip/n8n-runtime-adapter/src/server/execute.ts:Dòng 404`](file:///c:/paperclip/n8n-runtime-adapter/src/server/execute.ts#L404), khi workflow trên n8n chạy xong mà không bị lỗi, adapter này đã hardcode sẵn một trường `summary`:

```typescript
// File: n8n-runtime-adapter/src/server/execute.ts (Dòng 404)
return {
  exitCode: 0,
  summary: "n8n workflow completed successfully", // <--- Chuỗi chữ sinh ra từ đây
  ...
};
```

### 7.2. Tại sao Paperclip lại tự ý lấy chuỗi đó đem đi Comment?
Tại file [`server/src/services/heartbeat.ts:Dòng 14007 - 14015`](file:///c:/paperclip/server/src/services/heartbeat.ts#L14007-L14015), Paperclip có một luật hiển thị:

```typescript
// File: server/src/services/heartbeat.ts (Dòng 14007 - 14015)
if (issueId && outcome === "succeeded" && !skipRunIssueComment) {
  // 1. Kiểm tra xem trong suốt lượt chạy vừa rồi, Agent đã comment câu nào chưa:
  const existingRunComment = await findRunIssueComment(livenessRun.id, livenessRun.companyId, issueId);

  // 2. NẾU AGENT CHƯA TỪNG COMMENT CÂU NÀO:
  if (!existingRunComment) {
    // Tự động trích xuất trường `summary` của adapter:
    const issueComment = buildHeartbeatRunIssueComment(persistedResultJson);
    if (issueComment) {
      // Tự động POST chuỗi summary này lên Issue thread dưới tên của Agent (HRR)!
      await issuesSvc.addComment(issueId, issueComment, { agentId: agent.id, runId: livenessRun.id });
    }
  }
}
```

> **Mục đích:** Tránh việc một Run chạy xong mà thread hoàn toàn im lặng, giúp người dùng nhìn vào biết Agent đã hoàn thành lượt chạy này.

### 7.3. Giải thích chuỗi sự kiện thực tế:
1. **Lượt 1 (`worked for 3 seconds`):** Agent `HRR` gọi webhook sang n8n. n8n chạy xong, `HRR` kết thúc nhưng không gọi API comment hay đổi trạng thái task.
2. **Paperclip tự động Comment:** Thấy `HRR` im lặng, Server tự lấy `summary: "n8n workflow completed successfully"` đăng lên làm comment thay cho `HRR`.
3. **Lượt 2 (`worked for 2 seconds`):** Vì `HRR` chỉ để lại câu comment tự động mà **không chốt trạng thái task sang `done`**, hệ thống phát hiện lỗi và bung ngay thông báo cảnh báo **`Stale disposition warning`** (cơ chế `finish_successful_run_handoff`).

> 💡 **Cách tùy chỉnh:** Trong workflow n8n, bạn có thể thêm một Node gọi API Paperclip để Agent tự viết comment có ý nghĩa (ví dụ: *"Đã thẩm định xong hợp đồng của Nguyễn Văn An, kết quả đạt"*). Khi Agent đã chủ động comment, Paperclip sẽ **không tự động chèn câu mặc định** nữa.

---

## 8. Giải thích: Chi tiết thẻ cảnh báo `Stale disposition warning`

Khối **`Stale disposition warning`** là **Thẻ thông báo cảnh báo tự động của Hệ thống (System Notice)** được Paperclip đăng trực tiếp lên Issue thread để báo cho người dùng và Agent biết về sự cố **"Chạy xong mà quên chốt trạng thái task"**.

### 8.1. Phân tích chi tiết các mục trên thẻ

| Mục trên thẻ | Ý nghĩa thực tế |
| :--- | :--- |
| **`SOURCE ISSUE`** | Task đang gặp vấn đề: `KHT-30 - Thẩm định hợp đồng thử việc — Nguyễn Văn An`. |
| **`ASSIGNEE`** | Agent đang phụ trách: **`HRR`**. |
| **`MISSING DISPOSITION: clear_next_step`** | **Lỗi thiếu hành động kết thúc:** Agent `HRR` chạy xong nhưng không để lại quyết định rõ ràng cho bước tiếp theo. |
| **`VALID DISPOSITIONS`** | **4 trạng thái hợp lệ mà hệ thống yêu cầu:** `done` (xong), `cancelled` (hủy), `in_review` (chờ duyệt), `blocked` (bị nghẽn), hoặc `continuation` (chạy tiếp). |
| **`RUN STATUS: succeeded`** | Lượt chạy trước đó (`25967e40...`) đã kết thúc hoàn toàn thành công, không bị lỗi mạng hay crash. |
| **`NORMALIZED CAUSE: successful_run_missing_state`** | Tên mã chuẩn hóa của lỗi này trong mã nguồn Paperclip. |
| **`DETECTED PROGRESS`** | **Bằng chứng Agent có làm việc:** Hệ thống kiểm tra `activity_log` và thấy Agent đã gọi **7 Tool actions** và **1 Workspace operation**, chứng tỏ Agent có làm việc thật chứ không phải chạy rỗng. |
| **`AUTOMATIC RETRY: one corrective handoff wake queued`** | **Hành động tự sửa lỗi:** Hệ thống thông báo rằng nó đã **tự động tạo một Run mới đưa vào hàng đợi** để yêu cầu Agent `HRR` vào chốt lại trạng thái ngay lập tức! |

### 8.2. Thẻ này được sinh ra từ đoạn code nào?

1. **Hàm tạo dữ liệu thẻ** tại [`server/src/services/recovery/successful-run-handoff.ts:Dòng 176 - 217`](file:///c:/paperclip/server/src/services/recovery/successful-run-handoff.ts#L176-L217):
```typescript
export function buildSuccessfulRunHandoffRequiredNotice(input) {
  return {
    body: "Paperclip needs a disposition before this issue can continue.",
    presentation: {
      kind: "system_notice",
      tone: "warning",
      title: "Missing issue disposition", // UI hiển thị "Stale disposition warning"
    },
    metadata: { ... } // Chứa các hàng: Assignee, Missing disposition, Run evidence...
  };
}
```

2. **Hàm tự động đăng thẻ lên thread** tại [`server/src/services/heartbeat.ts:Dòng 7960 - 7970`](file:///c:/paperclip/server/src/services/heartbeat.ts#L7960-L7970):
```typescript
// Tự động post comment cảnh báo dưới dạng System Notice:
await issuesSvc.addComment(issueId, notice.body, { ... }, {
  authorType: "system",
  presentation: notice.presentation,
  metadata: notice.metadata,
});
```

---

## 9. Cơ chế Chạy tiếp sức `wakeReason = "issue_continuation_needed"`

`issue_continuation_needed` là cơ chế **"Tiếp sức tự động / Chạy nối tiếp" (Continuation Recovery)** của Paperclip.

Nó được kích hoạt khi: **Một Task đang ở trạng thái `in_progress` (đang làm dở), nhưng không còn tiến trình nào đang chạy để tiếp quản task đó (Stranded Issue)**.

### 9.1. Ba nguyên nhân chính trong code kích hoạt lý do này:

1. **Nguyên nhân 1: Run trước có tiến độ thực sự nhưng công việc chưa xong (`isProductiveContinuationRun`)**
   * *Code:* [`server/src/services/recovery/service.ts:Dòng 3998 - 4005`](file:///c:/paperclip/server/src/services/recovery/service.ts#L3998-L4005)
   * *Kịch bản:* Agent nhận task lớn, viết được một số file hoặc comment tiến độ (`status: succeeded`), nhưng task vẫn ở trạng thái `in_progress`. Paperclip tự động xếp Run mới vào hàng đợi để Agent làm tiếp.

2. **Nguyên nhân 2: Người dùng vừa Phê duyệt / Trả lời câu hỏi tiếp nối (`interaction_continuation_recovery`)**
   * *Code:* [`server/src/services/recovery/service.ts:Dòng 3688 - 3703`](file:///c:/paperclip/server/src/services/recovery/service.ts#L3688-L3703)
   * *Kịch bản:* Agent tạo `request_confirmation` hoặc `ask_user_question` để xin ý kiến. Khi bạn bấm **Accept / Approve** hoặc gửi câu trả lời, Paperclip lập tức kích hoạt lại Agent với `wakeReason = "issue_continuation_needed"` kèm câu trả lời của bạn để chạy tiếp.

3. **Nguyên nhân 3: Tiến trình cũ bị ngắt quãng bất thường (Stranded Issue Auto-Retry)**
   * *Code:* [`server/src/services/recovery/service.ts:Dòng 4094 - 4101`](file:///c:/paperclip/server/src/services/recovery/service.ts#L4094-L4101)
   * *Kịch bản:* Task đang `in_progress` nhưng lượt chạy trước bị ngắt (restart server, timeout nhẹ). Recovery Sweep quét định kỳ phát hiện task bị "mồ côi" $\rightarrow$ tự động tạo Run mới để thử lại (áp dụng Exponential Backoff).

---

## 10. Tại sao lượt Run lại kết thúc khi Task vẫn đang `in_progress`?

Trong Paperclip, AI Agent **không bao giờ chạy liên tục 24/7**, mà hoạt động theo **từng nhịp đập rời rạc (Heartbeat Runs / Turn-based)** vì 4 lý do an toàn & kinh tế:

```mermaid
flowchart TD
    TaskStart["Task in_progress"] --> Run1["Run 1 bắt đầu"]
    Run1 --> TriggerStop{"Lý do Run 1 kết thúc?"}
    TriggerStop -->|"1. Cần người duyệt / trả lời"| Stop1["Chủ động dừng Run để chờ con người<br/>(Tránh treo máy, tốn token)"]
    TriggerStop -->|"2. Hết số turn cho phép"| Stop2["Chạm Max Turns (ví dụ 20 turns)<br/>Dừng lại để tránh vòng lặp vô hạn"]
    TriggerStop -->|"3. Hết thời gian (Timeout)"| Stop3["Chạm timeoutSec (ví dụ 300s)<br/>Dừng lại để giải phóng CPU"]
    TriggerStop -->|"4. Xong 1 batch công việc"| Stop4["Hoàn thành 1 giai đoạn<br/>Lên lịch Continuation chạy tiếp"]
    
    Stop1 --> AutoWake["Kích hoạt Run 2 khi có kết quả<br/>(wakeReason: issue_continuation_needed)"]
    Stop2 --> AutoWake
    Stop3 --> AutoWake
    Stop4 --> AutoWake
```

1. **Agent chủ động nhường quyền (Yielding for Human Input):** Khi Agent cần con người bấm duyệt kế hoạch hoặc trả lời câu hỏi, Agent **chủ động dừng Run ngay lập tức**. Việc dừng này giúp giải phóng tài nguyên server và tránh đốt tiền token trong thời gian chờ con người vào xem.
2. **Giới hạn số lượt gọi Tool (`Max Turns`):** Mỗi Run được cấp quota số lần gọi Tool (ví dụ: tối đa 20 turns). Nếu bài toán quá lớn, hết quota turns thì Run kết thúc để lưu checkpoint, sau đó kích hoạt Run mới làm tiếp.
3. **Giới hạn thời gian Timeout (`timeoutSec`):** Tránh việc Agent bị treo terminal do lệnh cài đặt mạng hoặc vòng lặp code vô tận (ví dụ quá 300s thì dừng để đánh giá lại).
4. **Mô hình Batch / Webhook:** Các adapter như n8n chạy xong 1 vòng luồng nghiệp vụ và trả về kết quả để kết thúc nhịp chạy đó.

---

## 11. Chi tiết 2 cơ chế Tương tác: `request_confirmation` và `ask_user_question`

Đây là **2 dạng Thẻ tương tác Người - Máy (Issue Thread Interaction Cards)** nằm trong bảng [`issue_thread_interactions`](file:///c:/paperclip/packages/db/src/schema/issue_thread_interactions.ts).

### 11.1. `request_confirmation` (Thẻ Xin phê duyệt / Xác nhận)
* **Bản chất:** Là một chiếc hộp trên UI có nội dung đề xuất kèm 2 nút bấm: **`[ Accept / Approve ]`** và **`[ Reject ]`**.
* **Khi nào Agent dùng?**
  * Khi Agent vừa lập xong Implementation Plan và muốn người dùng duyệt trước khi viết code.
  * Khi Agent chuẩn bị làm hành động rủi ro cao (xóa database, merge code vào nhánh main).
* **Cấu trúc dữ liệu trong DB:**
```json
{
  "kind": "request_confirmation",
  "title": "Xác nhận kế hoạch thẩm định hợp đồng",
  "payload": {
    "summary": "Kế hoạch gồm 3 bước: 1. Đọc file, 2. So khớp điều khoản, 3. Đánh giá rủi ro.",
    "target": { "kind": "plan", "documentId": "..." }
  },
  "status": "pending" // Sẽ đổi thành "accepted" hoặc "rejected" khi bấm nút
}
```

### 11.2. `ask_user_question` (Thẻ Đặt câu hỏi cho người dùng)
* **Bản chất:** Là một Form câu hỏi có các ô lựa chọn (Radio/Checkbox) hoặc ô nhập text để người dùng điền câu trả lời.
* **Khi nào Agent dùng?**
  * Khi yêu cầu bài toán bị thiếu thông tin hoặc mơ hồ (ví dụ: *"Bạn muốn xuất báo cáo dưới dạng PDF hay Excel?"*).
  * Khi Agent cần người dùng lựa chọn giữa các phương án kỹ thuật.
* **Cấu trúc dữ liệu trong DB:**
```json
{
  "kind": "ask_user_questions",
  "title": "Lựa chọn định dạng xuất dữ liệu",
  "payload": {
    "questions": [
      {
        "id": "export_format",
        "question": "Bạn muốn lưu kết quả thẩm định vào đâu?",
        "options": ["Tạo file Markdown trong repo", "Đẩy lên Google Drive", "Gửi qua Email"],
        "isMultiSelect": false
      }
    ]
  },
  "status": "pending"
}
```

### 11.3. Vòng đời khép kín của một Interaction:
1. **Agent tạo yêu cầu:** Agent gọi Tool tạo `request_confirmation` hoặc `ask_user_question` $\rightarrow$ Run hiện tại lập tức kết thúc thành công để nhường quyền.
2. **Chờ con người:** UI Paperclip hiển thị thẻ tương tác chờ người dùng bấm.
3. **Người dùng tương tác:** Bạn vào UI bấm nút **Accept** hoặc chọn đáp án và ấn **Submit**.
4. **Tiếp sức tự động (Auto-Continuation):** Paperclip cập nhật interaction thành `resolved` và **tự động kích hoạt Run mới** với:
   ```json
   {
     "wakeReason": "issue_continuation_needed",
     "extraContext": {
       "interactionId": "...",
       "interactionKind": "request_confirmation",
       "userDecision": "accepted"
     }
   }
   ```
   Agent thức dậy ở Run mới, nhận ngay quyết định của bạn và tiếp tục làm việc tự động!


