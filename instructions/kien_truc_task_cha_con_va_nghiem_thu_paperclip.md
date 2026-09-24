# Báo Cáo Chi Tiết: Kiến Trúc Task Cha - Con, Vòng Đời Run & Cơ Chế Nghiệm Thu Trong Paperclip

---

## 1. Tổng Quan Kiến Trúc Multi-Agent Trong Paperclip

Trong Paperclip, các Agent (CEO, HR, Kế Toán, Dev...) hoạt động theo mô hình **hướng sự kiện (Event-Driven) và bất đồng bộ (Asynchronous)**. 
- Một **Task cha (Parent Issue)** đóng vai trò là một đơn vị quản lý/điều phối (Container).
- Các **Task con (Sub-tasks / Child Issues)** là các đơn vị thực thi nghiệp vụ độc lập được phân công cho các Agent chuyên môn.
- **Paperclip Server** đóng vai trò là **Control Plane Orchestrator**: theo dõi trạng thái, bảo vệ ranh giới phân quyền, quản lý khóa thực thi (execution lock), và tự động đánh thức (wake up) các Agent liên quan khi có sự kiện nghiệp vụ xảy ra.

```
                  ┌──────────────────────────────────────────────┐
                  │              PAPERCLIP CORE                  │
                  │  (State Machine / Lock / Event Orchestrator) │
                  └──────────────┬───────────────────────────────┘
                                 │
         ┌───────────────────────┴───────────────────────┐
         ▼                                               ▼
┌──────────────────┐                           ┌──────────────────┐
│   Agent Cha      │                           │   Agent Con      │
│   (Ví dụ: CEO)   │                           │ (Ví dụ: HR / KT) │
└────────┬─────────┘                           └────────┬─────────┘
         │                                               ▲
         │ 1. Tạo task con (parentId)                    │
         ├───────────────────────────────────────────────┤
         │                                               │
         │ 2. CEO kết thúc Run 1 (ngủ chờ)               │
         │                                               │ 3. Nhận Run, xử lý
         │                                               │ 4. PATCH sub-task = done
         │                                               │ 5. Respond webhook
         │ 6. Paperclip tự động đánh thức                │
         │    với wakeReason = issue_children_completed  │
         │    (Run 2: Nghiệm thu)                        │
         ▼                                               │
┌──────────────────┐                                     │
│  CEO Nghiệm thu  │◄────────────────────────────────────┘
│  & PATCH done    │
└──────────────────┘
```

---

## 2. Phân Biệt Rạch Ròi: Run Status vs Task (Issue) Status

Rất nhiều người nhầm lẫn giữa **Run (Lượt chạy)** và **Task/Issue (Nhiệm vụ nghiệp vụ)**. Đây là 2 thực thể tách biệt có vòng đời riêng:

| Khái niệm | Run Status (`heartbeat_runs.status`) | Task/Issue Status (`issues.status`) |
| :--- | :--- | :--- |
| **Bản chất** | Là một **phiên thực thi kỹ thuật** (Execution session) của Agent adapter (ví dụ: 1 cuộc gọi webhook sang n8n). | Là **trạng thái nghiệp vụ** của đầu việc trong công ty. |
| **Các trạng thái** | `queued` $\rightarrow$ `running` $\rightarrow$ `succeeded` / `failed` / `timed_out` / `cancelled` | `backlog` $\rightarrow$ `todo` $\rightarrow$ `in_progress` $\rightarrow$ `in_review` $\rightarrow$ `done` / `blocked` / `cancelled` |
| **Khi nào bắt đầu** | Khi Paperclip gọi adapter (kích hoạt webhook n8n). | Khi người dùng hoặc Agent gọi `POST /api/issues`. |
| **Khi nào kết thúc** | Khi adapter trả về kết quả (n8n gọi `Respond to Webhook`). | Khi Agent gọi `PATCH /api/issues/{id}` với `status: "done"`. |
| **Quan hệ** | **1 Task có thể có NHIỀU Run** trong suốt vòng đời của nó (Run 1: Phân tích & Giao việc, Run 2: Nghiệm thu khi con làm xong, Run 3: Sửa lỗi nếu cần...). | Task tồn tại lâu dài cho đến khi hoàn thành nghiệm thu. |

> **Quy tắc vàng:** Run thành công (`succeeded`) **KHÔNG ĐỒNG NGHĨA** với việc Task đã `done`. Task cha sau khi giao việc vẫn ở trạng thái `in_progress` để chờ con thực hiện.

---

## 3. Code Logic Chi Tiết Trong Paperclip Core

### 3.1. Khi Tạo Mới Task: Kích hoạt Run 1 ngay lập tức
📁 **File:** `server/src/routes/issues.ts` (Dòng 7257 - 7265) & `server/src/services/issue-assignment-wakeup.ts`

Khi một Task được tạo (`POST /api/issues`), Paperclip ngay lập tức gọi cơ chế kích hoạt Agent:

```typescript
// Trích từ server/src/routes/issues.ts
void queueIssueAssignmentWakeup({
  heartbeat,
  issue,           // Task vừa tạo
  reason: "issue_assigned",
  mutation: "create",
  contextSource: "issue.create",
  requestedByActorType: actor.actorType,
  requestedByActorId: actor.actorId,
});
```
`queueIssueAssignmentWakeup` gọi `heartbeat.wakeup()` $\rightarrow$ chèn bản ghi vào bảng `heartbeat_runs` với `status: "queued"` $\rightarrow$ Scheduler lấy RunId này gọi sang Adapter $\rightarrow$ Adapter bắn Webhook sang n8n kèm `runId` và `issueId`.

---

### 3.2. Khi Agent Con Hoàn Thành: Cơ chế phát hiện hoàn tất Sub-task
📁 **File:** `server/src/services/issues.ts` (Hàm `getWakeableParentAfterChildCompletion`)

Khi Agent con gọi `PATCH /api/issues/{childIssueId}` chuyển trạng thái sang `done` hoặc `cancelled` (terminal status), Paperclip kích hoạt logic kiểm tra Task cha:

```typescript
// Trích từ server/src/services/issues.ts (dòng ~5814)
// 1. Tìm task cha theo parentId
// 2. Lấy toàn bộ danh sách task con của task cha đó
const siblings = await getChildrenOfParent(parent.id);

// 3. KIỂM TRA ĐIỀU KIỆN: Tất cả các con đã về trạng thái terminal (done/cancelled) chưa?
const allChildrenDone = siblings.every(
  (child) => child.status === "done" || child.status === "cancelled"
);

if (allChildrenDone) {
  // 4. Thu thập tóm tắt kết quả của tất cả các con
  const childSummaries = siblings.map(c => ({
    id: c.id,
    identifier: c.identifier,
    title: c.title,
    status: c.status,
    assigneeAgentId: c.assigneeAgentId
  }));

  // 5. Chuẩn bị payload đánh thức Agent cha
  return {
    parentAssigneeAgentId: parent.assigneeAgentId,
    parentIssueId: parent.id,
    wakeReason: "issue_children_completed",
    childIssueSummaries: childSummaries
  };
}
```

---

### 3.3. Đánh Thức Task Cha: Tạo Run 2 (Nghiệm thu)
📁 **File:** `server/src/services/heartbeat.ts` (Dòng 16246 - 16287 & 17030)

Khi phát hiện tất cả task con đã xong, Paperclip gọi `heartbeat.wakeup()` (thực chất là hàm `enqueueWakeup`):

```typescript
// 1. Tạo yêu cầu đánh thức
const wakeupRequest = await tx
  .insert(agentWakeupRequests)
  .values({
    companyId: agent.companyId,
    agentId,
    source: "automation",
    reason: "issue_children_completed",
    status: "queued",
  })
  .returning()
  .then((rows) => rows[0]);

// 2. Chèn bản ghi Run 2 mới vào Database
const newRun = await tx
  .insert(heartbeatRuns)
  .values({
    companyId: agent.companyId,
    agentId,
    invocationSource: "automation",
    triggerDetail: "system",
    status: "queued",
    wakeupRequestId: wakeupRequest.id,
    contextSnapshot: {
      issueId: parentIssueId,
      wakeReason: "issue_children_completed",
      childIssueSummaries: [ ... ] // Dữ liệu nghiệm thu các con
    },
  })
  .returning()
  .then((rows) => rows[0]);
```

---

### 3.4. Adapter Đóng Gói Và Gọi Sang n8n
📁 **File:** `server/src/adapters/http/execute.ts` & `n8n-runtime-adapter/src/server/execute.ts`

Adapter nhận `newRun` từ Paperclip, đóng gói toàn bộ metadata vào HTTP Body và gửi sang Webhook n8n của CEO:

```typescript
const body = {
  agentId: ctx.agent.id,
  runId: ctx.runId, // RunId mới của Lượt 2
  context: {
    issueId: "...",
    wakeReason: "issue_children_completed",
    childIssueSummaries: [
      {
        id: "child-1",
        title: "Báo cáo doanh thu Kế Toán",
        status: "done"
      }
    ]
  }
};
```

---

## 4. Cơ Chế Nghiệm Thu Và Chốt Task Cha Bên n8n

### 4.1. Vấn đề vòng lặp vô hạn nếu không phân luồng
Nếu workflow CEO trên n8n chỉ chạy tuyến tính từ đầu đến cuối mà không kiểm tra `wakeReason`, khi nhận được webhook đánh thức ở Run 2, n8n sẽ lại tiếp tục chạy logic phân tích và **tạo thêm sub-task mới** $\rightarrow$ Dẫn đến vòng lặp vô hạn!

### 4.2. Giải pháp tối ưu: Phân luồng bằng 1 Node If
Trong Workflow của CEO trên n8n, chia làm 2 nhánh:

```text
                               ┌────────────────────────────────────────────────────────┐
                               │                     [CEO Webhook]                      │
                               └───────────────────────────┬────────────────────────────┘
                                                           │
                                                           ▼
                               ┌────────────────────────────────────────────────────────┐
                               │           [If: wakeReason == children_done?]           │
                               └─────────────┬────────────────────────────┬─────────────┘
                                             │                            │
                     (True: Đánh thức để Nghiệm thu)               (False: Lần đầu nhận việc)
                                             │                            │
                                             ▼                            ▼
                      ┌──────────────────────────────┐            ┌──────────────────────────────┐
                      │  [Logic Nghiệm Thu]          │            │  [Phân Tích Câu Hỏi]         │
                      │  - Đọc childIssueSummaries   │            │  - Kiểm tra từ khóa HR/KT    │
                      └──────────────┬───────────────┘            └──────────────┬───────────────┘
                                     │                                           │
                                     ▼                                           ▼
                      ┌──────────────────────────────┐            ┌──────────────────────────────┐
                      │  [PATCH Parent Task = done]  │            │  [Tạo Sub-task cho HR/KT]    │
                      │  - Cập nhật hoàn tất         │            │  - parentId = CEO taskId     │
                      └──────────────┬───────────────┘            └──────────────┬───────────────┘
                                     │                                           │
                                     ▼                                           ▼
                      ┌──────────────────────────────┐            ┌──────────────────────────────┐
                      │  [Respond to Webhook 1]      │            │  [Respond to Webhook 2]      │
                      │  - Đóng Run 2 thành công     │            │  - Đóng Run 1 (CEO ngủ)      │
                      └──────────────────────────────┘            └──────────────────────────────┘
```

---

## 5. Checklist Cấu Hình Node n8n Chuẩn Xác

Khi cấu hình Workflow trên n8n (như file `Sub-task.json`), cần tuân thủ các quy tắc sau:

| Node | Cấu hình quan trọng | Lưu ý / Lỗi thường gặp |
| :--- | :--- | :--- |
| **Node If (CEO)** | `Value 1`: `{{ $json.body.context.wakeReason }}`<br>`Operator`: `Equal`<br>`Value 2`: `issue_children_completed` | Đảm bảo đường dẫn đúng `body.context.wakeReason`. |
| **Tạo Sub-task (HR/KT)** | `Method`: `POST`<br>`URL`: `/api/companies/{companyId}/issues`<br>`Body.parentId`: `{{ $('CEO').item.json.body.taskId }}`<br>`Body.status`: `"todo"` | ⚠️ **Không để `status: "blocked"`**, phải để `"todo"` để Paperclip kích hoạt ngay agent con. |
| **Update Sub-task Status (HR/KT)** | `Method`: `PATCH`<br>`URL`: `/api/issues/{{ $('HR').item.json.body.taskId }}`<br>`Body`: `{"status": "done"}`<br>`Headers`: `x-paperclip-run-id: {{ runId }}` | Phải có Bearer Auth của Agent con tương ứng. |
| **Update Parent Task Status (CEO)** | `Method`: `PATCH`<br>`URL`: `/api/issues/{{ $('CEO').item.json.body.taskId }}`<br>`Body`: `{"status": "done"}` | ⚠️ **Phải là method `PATCH`**, không được dùng `POST`. |
| **Respond to Webhook** | Tất cả các nhánh bắt buộc phải kết thúc bằng node `Respond to Webhook`. | Nếu thiếu node này, Paperclip sẽ bị timeout sau thời gian `timeoutMs` cấu hình trong adapter. |

---

## 6. Tổng Kết

1. **Paperclip đã tích hợp sẵn 100% hạ tầng điều phối**: Tự theo dõi sub-task, tự kiểm tra điều kiện hoàn tất của tất cả các con, tự đóng gói tóm tắt báo cáo, và tự động gọi Webhook đánh thức CEO với RunId mới.
2. **Không cần sửa code backend của Paperclip**: Toàn bộ logic kiểm soát đều thông qua REST API chuẩn (`POST /api/issues`, `PATCH /api/issues/{id}`).
3. **Cấu hình n8n tinh gọn nhất**: Chỉ cần thêm **1 Node If** phân luồng và **1 Node PATCH** đóng task cha ở nhánh nghiệm thu của CEO là hệ thống vận hành hoàn hảo khép kín.
