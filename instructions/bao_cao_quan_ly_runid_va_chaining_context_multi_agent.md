# BÁO CÁO NGHIÊN CỨU & ĐỀ XUẤT GIẢI PHÁP KIẾN TRÚC
## 1. QUẢN LÝ GIAO DIỆN RUN ID ĐA TẦNG (MULTI-RUN / MULTI-AGENT TIMELINE)
## 2. CHUYỂN GIAO NGỮ CẢNH & TỔNG HỢP KẾT QUẢ LIÊN CHUỖI (CROSS-RUN RESULT CHAINING)

---

> **Tài liệu tham chiếu & thiết kế giải pháp**  
> **Mục tiêu:** Giải quyết trọn vẹn 2 bài toán vận hành phức tạp trong Paperclip:  
> 1. *Giao diện trực quan hóa toàn bộ chuỗi Run ID của một Task (nhiều agent, nhiều task con, nhiều heartbeat).*  
> 2. *Cơ chế lưu trữ, tổng hợp và chuyển giao `resultJson` / Context giữa các lần chạy kế tiếp hoặc khi Reopen via Comment mà không làm tràn context.*

---

# PHẦN 1: BÀI TOÁN GIAO DIỆN TỔNG HỢP TOÀN BỘ RUN ID CỦA TASK
*(Unified Task Execution & Multi-Agent Run Timeline)*

## 1.1. Đặt vấn đề (Problem Statement)

Trong một hệ thống điều phối đa Agent (Multi-Agent Control Plane) như Paperclip:
- **Tính chất đa tầng (Hierarchical & Multi-step):** Một Task lớn thường chia thành nhiều Task con (Sub-tasks).
- **Tính chất đa Agent (Multi-Agent Collaboration):** Một Task có thể do nhiều Agent lần lượt thực hiện (Ví dụ: `Product Planner` -> `Dev Agent` -> `Tester Agent` -> `Reviewer Agent`).
- **Tính chất phân mảnh thời gian (Multi-Heartbeat Runs):** Ngay cả với một Agent duy nhất, Agent đó cũng phải "thức dậy" (`heartbeat.wakeup`) nhiều lần để hoàn thành các giai đoạn khác nhau (Lần 1: Lập kế hoạch, Lần 2: Viết code, Lần 3: Kiểm thử, Lần 4: Nhận comment từ người dùng và sửa lại).
- **Mỗi lần thức dậy = 1 Run ID (`heartbeat_run_id`).**

### ❌ Thực trạng bất cập hiện tại:
1. **Phân mảnh theo dõi:** Người vận hành (Operator/Dev) muốn xem nhật ký hoạt động phải click chuyển qua lại giữa nhiều nơi: Tab Comments của Issue, Màn hình danh sách Agent Runs, từng Task con riêng lẻ.
2. **Thiếu bức tranh toàn cảnh (Loss of Big Picture):** Không thể nhìn thấy chuỗi nguyên nhân - kết quả (Causal Chain): *"Run này kích hoạt do ai? Run của Subtask B đã chạy xong chưa? Lần Wakeup thứ 3 này xử lý comment nào?"*.
3. **Khó khăn trong Debug & Audit:** Khi một chuỗi xử lý bị lỗi ở giữa chừng, rất khó định vị được Run ID nào sinh ra lỗi, ai chịu trách nhiệm và tiêu tốn bao nhiêu token/chi phí cho toàn bộ quy trình.

---

## 1.2. Các hướng giải pháp đề xuất

### 💡 Hướng 1: Giao diện Dòng thời gian cây thực thi (Unified Execution Tree & Timeline) — *(Khuyên dùng)*

Thiết kế một Tab riêng biệt ngay trong trang chi tiết Task (`IssueDetailView`) mang tên **"Executions"** hoặc **"Run Tree"**.

#### Cấu trúc hiển thị:
- **Dạng Cây phân cấp (Hierarchy Tree) kết hợp Timeline dọc:**
  - **Cột mốc Task cha:**
    - 🟢 `Run #101` [Agent: Planner] (Wake reason: `issue_assigned`) -> Output: Plan & 2 Subtasks
      - ├── 🟢 Subtask 1 [Agent: Backend Dev]
      - │     ├── `Run #102` (Code API) -> Thành công (8.2k tokens, 12s)
      - │     └── `Run #103` (Fix Linter) -> Thành công (3.1k tokens, 5s)
      - └── 🟢 Subtask 2 [Agent: Frontend Dev]
      -       └── `Run #104` (Build UI) -> Thành công (11.5k tokens, 20s)
    - 🟡 `Run #105` [Agent: Tester] (Wake reason: `issue_children_completed`) -> Phát hiện 1 bug
    - 💬 User Comment: *"Nút bấm bị lệch 5px"* -> Kích hoạt Reopen
    - 🔵 `Run #106` [Agent: Frontend Dev] (Wake reason: `issue_reopened_via_comment`) -> Đang chạy...

#### Các thành phần chính trên mỗi Card Run:
1. **Badge trạng thái & Thời gian:** `Success` (Xanh), `Failed` (Đỏ), `Running` (Xanh dương chớp nháy), kèm thời lượng (Duration) và Chi phí ($ / Token).
2. **Actor Badge:** Tên Agent, Model (Claude 3.7 / Gemini 2.5 / GPT-4o), Avatar.
3. **Trigger Source (Lý do chạy):** `Cron`, `Manual Run`, `Comment Wakeup`, `Child Done`.
4. **Quick Actions:**
   - 📜 *Xem Live Transcript / Log:* Bấm mở Modal xem console log realtime.
   - 📦 *Xem Output Artifacts / resultJson:* Bấm xem file sinh ra hoặc JSON output.
   - 🔄 *Rerun / Retry:* Nút kích hoạt chạy lại riêng Run đó.

---

### 💡 Hướng 2: Giao diện Làn bơi đa Agent (Multi-Agent Swimlane Matrix)

Mô hình hóa chuỗi thực thi theo dạng biểu đồ luồng Gantt/Swimlane nằm ngang:
- Mỗi Agent là 1 hàng (Làn bơi).
- Trục ngang là Thời gian (Timeline).
- Các Run ID hiển thị dưới dạng các khối Block nối tiếp nhau bằng mũi tên phụ thuộc (Dependency Arrows).
- **Ưu điểm:** Cực kỳ trực quan khi có 3 - 5 Agent hoạt động song song hoặc bàn giao kết quả cho nhau.
- **Nhược điểm:** Tốn diện tích màn hình hơn, phù hợp cho màn hình Dashboard tổng quan cấp dự án.

---

### 💡 Hướng 3: Sơ đồ tương tác dạng đồ thị có hướng (Interactive DAG Graph)

- Tự động vẽ đồ thị DAG (Direct Acyclic Graph) các Node tương tự luồng Airflow / n8n canvas.
- Mỗi Node biểu diễn 1 Run ID, màu sắc thể hiện trạng thái. Bấm vào Node nào sẽ mở thanh Drawer bên phải chứa toàn bộ context, log và output của Run đó.

---

## 1.3. Kiến trúc dữ liệu đề xuất hỗ trợ UI (Backend Schema)

Để giao diện trên load cực nhanh chỉ với 1 API query duy nhất:

```typescript
// GET /api/issues/:id/execution-tree
interface TaskExecutionTreeResponse {
  issueId: string;
  issueTitle: string;
  totalCost: number;
  totalDurationMs: number;
  runs: Array<{
    runId: string;
    parentRunId?: string;       // Cho phép tạo cây phân cấp
    subtaskId?: string;         // Nếu run này thuộc về 1 subtask
    agent: {
      id: string;
      name: string;
      role: string;
      icon: string;
    };
    triggerReason: string;      // "issue_commented" | "heartbeat_cron" | ...
    status: "running" | "succeeded" | "failed" | "cancelled";
    startedAt: string;
    finishedAt?: string;
    tokensUsed: { input: number; output: number };
    resultSummary?: string;     // Tóm tắt kết quả 1-2 dòng
    artifactsProduced: string[];// Danh sách file/link tạo ra
  }>;
}
```

---

## 1.4. Đề xuất bổ sung đối tượng `TaskSession` (Quản lý phiên chạy)

Để quản lý trọn vẹn tất cả các lượt chạy (`heartbeat_runs`) của nhiều agent giải quyết 1 Task mà không làm xáo trộn logic state hiện tại của Task (`todo`, `in_progress`, `blocked`, `done`), ta bổ sung một bảng/đối tượng trung gian gọi là **`TaskSession`** (Phiên thực thi).

**Vòng đời hoạt động của `TaskSession`:**
1. **Khởi tạo:** Khi Task bắt đầu chuyển sang trạng thái `in_progress` $\rightarrow$ Sinh ra 1 `TaskSession` mới.
2. **Thu thập Runs & Context:** Tất cả các Agent thức dậy làm việc cho Task này sẽ gắn `run_id` của chúng vào `TaskSession` này. Khi Agent chạy xong, kết quả (`resultJson`) được đắp chung vào trường `shared_context` của `TaskSession`.
3. **Đóng Session:** Khi Task chuyển sang `done`, `blocked` hoặc `cancelled` $\rightarrow$ `TaskSession` này đóng lại.
4. **Xử lý Reopen (Chạy lại/Nghiệm thu):** Nếu Task đã đóng, nhưng sau đó user comment yêu cầu sửa lại (Reopen), hệ thống sẽ **tạo ra một `TaskSession` mới tinh** (Lần chạy thứ 2). Mọi `AgentRun` cho đợt sửa lỗi này sẽ được lưu vào Session mới. Nhờ đó, lịch sử đợt chạy 1 không bị ghi đè, và UI có thể tách bạch rõ ràng giữa "Đợt chạy làm mới" và "Đợt chạy sửa lỗi".

**Lợi ích đối với 2 bài toán trên:**
- **Giải quyết Bài toán 1 (UI Timeline):** Frontend chỉ cần lấy `TaskSession` hiện tại là có ngay toàn bộ danh sách AgentRun để vẽ timeline trọn vẹn từ lúc Task mở đến lúc đóng.
- **Giải quyết Bài toán 2 (Chaining Context):** Các Agent giao tiếp, truyền kết quả bàn giao cho nhau thông qua việc đọc/ghi vào trường `shared_context` nằm gọn trong `TaskSession`.

---
---

# PHẦN 2: BÀI TOÁN KẾT NỐI NGỮ CẢNH & TỔNG HỢP KẾT QUẢ ĐA LẦN CHẠY
*(Cross-Run Result Chaining & Multi-Agent Context Aggregation)*

## 2.1. Đặt vấn đề & Thách thức kỹ thuật

Khi 1 Task trải qua **Nhiều lần Run** và **Nhiều Agent khác nhau**:
- Ví dụ luồng:
  - **Run 1 (Agent Phân tích):** Bóc tách yêu cầu -> Tạo ra Danh sách API Specs.
  - **Run 2 (Agent Backend):** Đọc API Specs -> Viết code server, tạo database migration.
  - **Run 3 (Agent Frontend):** Đọc code server -> Tạo giao diện gọi API.
  - **Run 4 (Reopen via Comment):** User nhận xét *"Đổi trường `fullName` thành `name`"* -> Agent Backend hoặc Frontend cần thức dậy để sửa tiếp.

### ❓ Câu hỏi hóc búa:
1. *Làm sao để Run 2, Run 3 hoặc Run 4 biết được những gì các Run trước đã làm mà **không cần đọc lại toàn bộ hàng nghìn dòng log/chat transcript cũ**?*
2. *Nếu nhét toàn bộ lịch sử thô (Raw log) vào Prompt:* Sẽ gây **Tràn Context Window**, tốn chi phí token khủng khiếp, và khiến LLM bị "loãng" thông tin quan trọng (Hiện tượng *Lost in the Middle*).
3. *Nếu không truyền gì cả:* Agent sau bị "mất trí nhớ hoàn toàn", làm việc chệch hướng hoặc ghi đè, phá hủy kết quả của Agent trước.

---

## 2.2. Các hướng giải pháp đề xuất

### 🌟 Hướng 1: Mô hình Bảng trạng thái chung (Shared Task State Board / Blackboard Architecture) — *(Khuyên dùng)*

Thay vì truyền toàn bộ lịch sử hội thoại dạng văn bản dài, ta chuẩn hóa **Trạng thái tích lũy (Cumulative State)** của Task vào một Object JSON duy nhất nằm trong bảng CSDL của Task (`issues.execution_state`).

#### Quy tắc hoạt động:
1. **Chuẩn hóa Output sau mỗi Run (`resultJson`):**
   Mọi Agent khi kết thúc 1 Run (`run.finish` / `heartbeat.drain`) đều phải trả về một Payload cấu trúc:
   ```json
   {
     "status": "completed",
     "summary": "Đã thiết kế xong CSDL và tạo 2 API /login, /register",
     "keyOutputs": {
       "dbTables": ["users", "sessions"],
       "createdFiles": ["server/src/auth.ts", "packages/db/schema/users.ts"],
       "apiEndpoints": ["POST /api/login", "POST /api/register"]
     },
     "nextRecommendedAction": "Frontend Agent có thể bắt đầu tạo form đăng nhập"
   }
   ```

2. **Cơ chế Hợp nhất Trạng thái (State Merging & Accumulation):**
   Backend Server tự động gộp (Merge) `keyOutputs` của các Run vào trường `taskStateBoard`:
   ```json
   {
     "lastUpdatedBy": "agent_backend_01",
     "completedRunsCount": 3,
     "accumulatedArtifacts": [
       "packages/db/schema/users.ts",
       "ui/src/pages/LoginPage.tsx"
     ],
     "runHistorySummaries": [
       "Run 1 (Planner): Đã lập plan 3 bước.",
       "Run 2 (Backend): Đã tạo DB và API Auth.",
       "Run 3 (Frontend): Đã tạo màn hình Login."
     ],
     "currentSharedState": {
       "apiBaseUrl": "/api/v1",
       "authSchemaVersion": "v2"
     }
   }
   ```

3. **Inject vào Context khi Reopen hoặc Trigger Run mới:**
   Khi có bình luận mới (`issue_reopened_via_comment`), Prompt Builder chỉ cần inject một block cực kỳ tinh gọn:
   ```markdown
   ## CONTEXT FROM PREVIOUS RUNS
   - **Tóm tắt tiến độ đã đạt được:**
     1. [Run 1 - Planner]: Đã lập plan.
     2. [Run 2 - Backend]: Đã tạo DB và API Auth.
     3. [Run 3 - Frontend]: Đã tạo màn hình Login.
   - **Tài nguyên/File đã tạo:** `schema/users.ts`, `LoginPage.tsx`
   - **Trạng thái hiện tại:** AuthSchemaVersion = v2

   ## YÊU CẦU MỚI TỪ BÌNH LUẬN CỦA NGƯỜI DÙNG:
   User vừa bình luận: "Đổi nút Submit màu xanh sang màu tím và thêm icon Lock".
   👉 Hãy tiếp tục hoàn thiện trên nền các file đã tạo ở trên, không làm lại từ đầu.
   ```
   👉 **Ưu điểm:** Context chỉ tốn **dưới 400 tokens**, nhưng Agent hiểu 100% toàn bộ quá khứ của Task!

---

### 💡 Hướng 2: Bộ nhớ nén tự động (Rolling Memory & Auto-Compactor)

- Sau mỗi Run, nếu tổng lượng text trao đổi vượt quá 4000 tokens, một Agent phụ (hoặc mô hình nhỏ tốc độ cao như Gemini 2.5 Flash / Haiku) sẽ tự động chạy ngầm để "nén" (Summarize) toàn bộ log của các Run trước thành 1 đoạn Executive Summary (Tóm tắt điều hành) tối đa 200 từ.
- Mỗi lần có Run mới hoặc Reopen, chỉ nạp: `[Executive Summary cũ] + [Kết quả Run liền kề trước] + [Comment mới]`.

---

### 💡 Hướng 3: Kiến trúc Tham chiếu File (Artifact-First Chaining)

- Thay vì nhét data vào JSON hay Prompt, Agent trước lưu toàn bộ kết quả vào 1 file Markdown/JSON nằm trong thư mục workspace (ví dụ: `.paperclip/runs/run-102-result.json` hoặc `doc/tasks/TASK-123-HANDOFF.md`).
- Run sau được truyền đường dẫn file: *"Kết quả lần trước nằm tại file `TASK-123-HANDOFF.md`, hãy đọc file này nếu cần thông tin chi tiết"*.
- **Ưu điểm:** Token ban đầu bằng 0, Agent tự quyết định dùng tool đọc file khi thực sự cần.

---

## 2.3. Bảng tổng kết so sánh các phương án truyền Context

| Tiêu chí | Truyền Raw Transcript (Cũ) | Bảng trạng thái chung (State Board - Hướng 1) | Nén tự động (Rolling Summary - Hướng 2) | Tham chiếu File (Artifact - Hướng 3) |
| :--- | :--- | :--- | :--- | :--- |
| **Tiêu tốn Token** | 🔴 Cực cao (hàng chục nghìn) | 🟢 Cực thấp (~300 - 500 tokens) | 🟡 Thấp (~500 - 800 tokens) | 🟢 Rất thấp (~50 tokens) |
| **Độ chính xác dữ liệu** | 🟡 Dễ bị nhiễu log rác | 🟢 Rất cao (Có cấu trúc JSON) | 🟡 Phụ thuộc vào chất lượng nén | 🟢 Rất cao (Đọc nguyên gốc) |
| **Đa Agent hiểu nhau** | 🔴 Kém (Agent B khó đọc log Agent A) | 🟢 Xuất sắc (Schema JSON chuẩn hóa) | 🟡 Khá (Văn bản tóm tắt) | 🟢 Tốt (Tự đọc file bàn giao) |
| **Độ phức tạp triển khai** | 🟢 Đơn giản nhất | 🟡 Trung bình (Cần chuẩn hóa Schema) | 🔴 Cao (Tốn thêm 1 lượt gọi LLM) | 🟡 Dễ - Trung bình |

---

# PHẦN 3: LỘ TRÌNH TRIỂN KHAI ĐỀ XUẤT (IMPLEMENTATION ROADMAP)

### Giai đoạn 1: Chuẩn hóa Dữ liệu (Foundation)
1. Bổ sung trường `executionState` (JSONB) và `parentRunId` vào bảng `runs` và `issues` trong `@paperclipai/db`.
2. Định nghĩa TypeScript Interface chuẩn cho `ExecutionResult` trong `@paperclipai/shared`.

### Giai đoạn 2: Nâng cấp Backend Engine & Adapter
1. Khi Agent gọi kết thúc run (`heartbeat.drain` hoặc webhook return trong n8n), bóc tách `resultJson` và cập nhật vào `issues.execution_state`.
2. Sửa hàm `renderPaperclipWakePrompt` (và n8n payload builder) để tự động chèn `Lịch sử tóm tắt các Run trước` vào Prompt khi có cờ `issue_reopened_via_comment` hoặc `issue_children_completed`.

### Giai đoạn 3: Xây dựng Giao diện Frontend (UI)
1. Thêm Component `TaskExecutionTimeline.tsx` trong thư mục `ui/src/components/issues/`.
2. Tích hợp Accordion mở rộng xem từng Run: log, chi phí, artifacts và nút trigger lại run.
