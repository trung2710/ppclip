# 📋 Tổng Hợp Kiến Trúc Hệ Thống Paperclip AI

> Tài liệu ghi chép chi tiết cơ chế hoạt động của các Agent trong hệ thống Paperclip dựa trên phân tích mã nguồn thực tế.

---

## 1. Cơ Chế Ngủ / Thức Dậy của Agent (Event-Driven Architecture)

### Tại sao Agent cần "ngủ"?

Bình thường khi không có việc, các Agent hoàn toàn ở trạng thái **Nghỉ/Tĩnh (Idle/Sleep)**. Mục tiêu:

- **Tiết kiệm tiền Token API:** Nếu Agent chạy liên tục 24/7, nó sẽ gửi request không ngừng lên OpenAI/Gemini → chi phí khổng lồ.
- **Tiết kiệm tài nguyên máy:** Khi Agent "ngủ", tiến trình CLI tắt hoàn toàn, giải phóng RAM và CPU.

> **Mô hình của Paperclip là Event-Driven (Kiến trúc theo sự kiện):** Agent chỉ thức dậy khi có "Sự kiện" (giao Task mới, Task con làm xong, được nhắc tên...), làm xong việc thì tự động "ngủ" lại.

---

### Cơ chế Heartbeat – Đánh thức Agent

Khi có sự kiện xảy ra, hệ thống chạy hàm **`enqueueWakeup`** (trong `server/src/services/heartbeat.ts` dòng 15239):

1. Kiểm tra xem Agent có bị **paused/inactive** không.
2. **Đóng gói ngữ cảnh thức dậy:** `agentId`, lý do thức dậy, ID Task liên quan...
3. **Tạo một lượt chạy mới** vào hàng đợi (Status: `queued`).
4. **Bật tiến trình CLI** chạy ngầm trên OS (Status: `running`).

---

### Cơ chế thức dậy khi 1 Task hoàn thành

```
[Agent con hoàn thành Task - Status: "done"]
            |
            v
[Server nhận sự kiện Task Done]
  Gọi: enqueueWakeup(agentChaId, { reason: "child_issue_completed" })
            |
            v
[Đóng gói context + Bật tiến trình CLI cho Agent Cha]
  Agent Cha thức dậy -> Đọc context -> Thấy Task con vừa xong -> Tiến hành nghiệm thu!
```

---

### Tính năng Heartbeat định kỳ (Heartbeat on Interval)

Trong phần cấu hình Agent có tùy chọn **"Heartbeat on interval"**:
- Cứ sau N giây (mặc định 300 giây = 5 phút), hệ thống **tự động đánh thức Agent dậy** dù không có sự kiện mới.

**Khi thức dậy định kỳ, Agent sẽ:**
- **Quét Inbox & Gỡ kẹt:** Kiểm tra các Task cấp dưới đang bị đứng yên, kẹt lỗi, quá hạn.
- **Kiểm tra tiến độ tổng thể:** Cập nhật báo cáo dự án.
- **Thực hiện công việc lặp đi lặp lại:** Quét lỗi, tổng hợp chi phí...

> **Nên BẬT** cho Agent Quản lý (CEO, PM, DevOps). **Nên TẮT** cho Agent chuyên trách (Coder, Tester) để tiết kiệm Token.

---

### Khi bạn ấn nút "Run Heartbeat" thủ công

Hệ thống gửi yêu cầu với `triggerDetail: "manual"` và `source: "on_demand"`. Agent sẽ ưu tiên:

1. **Ưu tiên 1 – Đọc Comment mới nhất của bạn:** Nếu bạn vừa comment vào Task → Agent đọc ngay và giải quyết.
2. **Ưu tiên 2 – Xử lý Task đang dở dang:** Nếu bấm tại giao diện của Task cụ thể → Agent tập trung toàn bộ vào Task đó.
3. **Ưu tiên 3 – Quét Inbox:** Nếu bấm ở trang cá nhân Agent → Agent mở Inbox, tìm Task `todo`/`in_progress`, hoặc đi tuần kiểm tra cấp dưới theo SKILL `issue-triage`.

---

## 2. Cơ Chế Gọi và Sử Dụng SKILL (task-planning)

### Luồng Agent đọc và áp dụng SKILL

1. Khi một Task được tạo và gán cho Agent, hệ thống **lọc các SKILL phù hợp** trong bộ SKILL của Agent đó.
2. Hệ thống **gom nội dung SKILL** + thông tin Task vào một **Prompt tổng hợp** và gửi cho LLM.
3. LLM **đọc các SKILL** và tự chọn ra hướng dẫn phù hợp để thực thi Task cụ thể đó.

### Đầu ra của AI Agent

Sau khi LLM suy nghĩ (thinking), đầu ra **bắt buộc phải ở dạng Tool Call** (được quy định trong Output Schema của hệ thống). Ví dụ: `issues.create`, `issues.update`, `bash`,...

### Kiểm tra quyền và năng lực Agent

Hệ thống có code logic để kiểm tra:
- **Quyền hạn (Permissions):** Agent có được phép thực hiện tool call này không?
- **Tính năng (Capabilities):** Agent có năng lực phù hợp không (budget, status, role)?

---

## 3. Cơ Chế Tạo Task Con và Phân Chia Công Việc

### SKILL `task-planning` – Bộ não Phân công Việc

Khi Agent nhận 1 Task lớn, nó **dựa hoàn toàn vào file SKILL `task-planning`** để chia Task. Không có bất kỳ logic code hardcode nào hướng dẫn chia Task thành Sub-task.

SKILL này được nạp vào **System Prompt**. AI đọc hướng dẫn và tự suy luận ra ma trận công việc:
- Task nào làm trước, Task nào làm sau.
- Giao cho Agent con nào.
- Các ràng buộc `blockedByIssueIds` giữa các Task.

### Gán Task con cho Agent con ngay khi chia

Khi chia Task, SKILL `task-planning` yêu cầu xác định ngay:

| Trường | Ý nghĩa |
|--------|---------|
| `title` | Tiêu đề Task con |
| `owner` | Agent con chịu trách nhiệm (chính là `assigneeAgentId`) |
| `parentId` | ID Task cha |
| `blockedByIssueIds` | Các Task phải hoàn thành trước Task này |
| `status` | Trạng thái khởi tạo (thường là `todo`) |

---

### Các Agent con có thể chạy Song Song không?

- **Có thể chạy SONG SONG** nếu 2 Task không có `blockedByIssueIds` ràng buộc nhau → Paperclip spawn 2 tiến trình CLI riêng biệt chạy đồng thời.
- **Phải chạy TUẦN TỰ** nếu Task B có `blockedByIssueIds: ["Task-A"]` → Task B chỉ được mở khóa khi Task A `done`.
- Nếu 1 Agent được giao nhiều Task, nó thực hiện tuần tự theo thứ tự: **Trạng thái** (`in_progress` trước) → **Độ ưu tiên** (`priority`) → **Thời gian tạo**.

---

## 4. Cơ Chế Kiểm Tra và Nghiệm Thu Task (Parent Review)

### Khi tất cả Task con hoàn thành

```
Tất cả Task con -> Status: "done"
        |
        v
Hệ thống đánh thức Agent Cha
        |
        v
Agent Cha đọc lại kết quả -> Thử nghiệm, kiểm tra
        |
        |-- OK (ĐẠT YÊU CẦU): issues.update(parentId, { status: "done" }) -> Hoàn tất!
        |
        |-- FAIL (CHƯA ĐẠT): Viết comment chỉ rõ lỗi sai
                |
                v
            issues.update(subTaskId, { status: "todo", reopen: true })
                |
                v
            Đánh thức Agent con dậy -> Làm lại theo comment!
```

---

### Cơ chế Phân phối lại Task cho Agent khác (Reassign)

Dựa vào hướng dẫn từ SKILL `issue-triage/SKILL.md`, Agent Cha có **6 quyết định xử lý** Task kẹt/lỗi:

| Quyết định | Hành động |
|-----------|----------|
| **Resume** | Tiến trình vẫn sống, để tiếp tục |
| **Wake-needed** | Comment chỉ dẫn → Đưa Task về `todo` cho làm lại |
| **Reassign** | Đổi `assigneeAgentId` sang Agent khác phù hợp hơn |
| **Unblock** | Task chặn đã xong, mở khóa |
| **Escalate** | Báo cáo vượt cấp lên Board hoặc CEO |
| **Close** | Đóng Task (done/cancelled) |

---

## 5. Cơ Chế Tiếp Quản Khi Agent Con Bị Lỗi (Manager Takeover)

### Hạ tầng Code tự động phát hiện và xử lý

Khi Agent con bị `failed`, `timed_out`, hoặc `stalled`:

```
[Agent con bị lỗi/kẹt]
        |
        v
[issue-graph-liveness.ts]
  Phân tích đồ thị Task -> Tìm danh sách ứng viên:
    1. Sếp trực tiếp (reportsTo)
    2. Người tạo Task (createdByAgentId)
    3. CEO/CTO (fallback cuối cùng)
        |
        v
[recovery/service.ts]
  Kiểm tra ngân sách và trạng thái của từng ứng viên
  -> Chọn Agent hợp lệ đầu tiên
  -> Gán Task bị lỗi cho Sếp
  -> Gọi enqueueWakeup(sếpId) để Sếp thức dậy xử lý!
        |
        v
[Sếp thức dậy + đọc SKILL issue-triage]
  -> Tự làm thay, HOẶC chuyển cho Agent khác phù hợp hơn!
```

**Phân vai 2 file Code chính:**
- **`issue-graph-liveness.ts`** → Bác sĩ Chẩn đoán: Phát hiện Task kẹt, lập danh sách ứng viên.
- **`recovery/service.ts`** → Đội Cứu hộ Thực thi: Kiểm tra budget, gán lại Task, gọi Sếp dậy.

---

## 6. Cơ Chế Agent Biết Năng Lực của Agent Con

### Truy vấn động từ Database (Runtime)

Trong luồng thực thi thực tế, trước mỗi lượt chạy, hệ thống chạy câu SQL **trực tiếp** vào PostgreSQL để lấy danh sách Agent mới nhất (`heartbeat.ts` dòng 11814):

```typescript
const companyAgents = await listCompanyAgentOrgRows(agent.companyId);
// SQL: SELECT id, name, role, title, reportsTo FROM agents WHERE companyId = ?
```

**Dù Agent con mới được tạo cách đó 1 giây, Agent Sếp VẪN BIẾT và GIAO VIỆC được ngay lập tức!**

Agent Sếp dựa vào các trường sau để biết giao việc cho ai:

| Trường | Ý nghĩa |
|--------|---------|
| `role` | Vai trò (engineer, designer, qa, devops...) |
| `title` | Chức danh chi tiết |
| `reportsTo` | Ai là cấp trên trực tiếp |
| `capabilities` | Tập hợp kỹ năng/quyền hạn được cấp |

---

## 7. Cơ Chế Phân Quyền Task

### Agent cấp thấp (Low-trust Agent) bị giới hạn phạm vi

Trong `server/src/routes/issues.ts` dòng 7050-7060:

```typescript
if (!companyScopeDecision.allowed) {
  res.status(403).json({
    error: "Low-trust agents must create child issues inside their assigned boundary"
  });
}
```

- **Agent nhân viên cấp thấp:** Chỉ được tạo Task con **nằm trong ranh giới** công việc được giao.
- **Agent cấp cao (CEO, CTO):** Được tạo Task gốc (`parentId: null`) ở mức toàn công ty.

### Phân biệt Task gốc và Task con

| Loại Task | `parentId` | `requestDepth` |
|----------|-----------|---------------|
| Task gốc (Root) | `null` | `0` |
| Task con cấp 1 | `"uuid-task-cha"` | `1` |
| Task cháu cấp 2 | `"uuid-task-con"` | `2` |

---

## 8. HTTP Adapter và SKILL

### HTTP Adapter KHÔNG tự động đính kèm SKILL

Trong `server/src/adapters/http/execute.ts` dòng 13:

```typescript
const body = { ...payloadTemplate, agentId: agent.id, runId, context };
// Chỉ gửi Task Context (tiêu đề, mô tả, workspace), KHÔNG có SKILL!
```

**Để n8n sử dụng được SKILL `task-planning`:**

**Cách 1 (Khuyên dùng):** Trong n8n Workflow, thêm HTTP Request Node gọi:
```
GET /api/agents/{agentId}/instructions-bundle
```
Sau đó ghép nội dung SKILL này vào System Prompt của AI Node.

**Cách 2:** Copy trực tiếp nội dung `SKILL.md` dán vào System Message của AI Node trong n8n.

---

## 9. File AGENTS.md của từng Agent

### Mỗi Agent có 1 file AGENTS.md riêng

**Đường dẫn trên ổ đĩa:**
```
.paperclip/instances/default/companies/{companyId}/agents/{agentId}/instructions/
   AGENTS.md              <- File hướng dẫn riêng của Agent
   (các file SKILL được cấp cho Agent này)
```

**Khi tạo Agent mới, hệ thống:**
1. Kiểm tra `role` của Agent vừa tạo.
2. Copy file mẫu từ `onboarding-assets`:
   - `default` → chỉ `AGENTS.md`
   - `ceo` → `AGENTS.md` + `HEARTBEAT.md` + `SOUL.md` + `TOOLS.md`
3. Ghi ra thư mục của Agent trên ổ đĩa.

**Cách Custom file AGENTS.md:**
- Sửa trực tiếp trên VS Code (đường dẫn ổ đĩa ở trên).
- Qua Web UI (tab Instructions của Agent).
- Truyền vào API khi tạo Agent qua trường `instructionsBundle.files["AGENTS.md"]`.
- **Lưu ý:** Chỉ hỗ trợ cho **Local Adapters** (`codex_local`, `claude_local`, `gemini_local`...). **HTTP Adapter chưa hỗ trợ** tính năng này.

---

## 10. Các API Hữu Ích khi Dùng HTTP Adapter + n8n

| API Endpoint | Mục đích |
|-------------|---------|
| `GET /api/agents/{id}/instructions-bundle` | Lấy danh sách các file hướng dẫn của Agent |
| `GET /api/agents/{id}/instructions-bundle/file?path=AGENTS.md` | Lấy nội dung chi tiết 1 file hướng dẫn |
| `PATCH /api/agents/{id}/instructions-bundle` | Cập nhật bộ file hướng dẫn |
| `POST /api/issues` | Tạo Task mới (kèm `assigneeAgentId`, `parentId`) |
| `PATCH /api/issues/{id}` | Cập nhật Task (status, assignee, reopen...) |
| `GET /api/agents` | Lấy danh sách toàn bộ Agent trong công ty |

---

*Tài liệu được tổng hợp từ phân tích mã nguồn thực tế của dự án Paperclip – Tháng 08/2026*
