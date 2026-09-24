# Hướng Dẫn Thực Chiến: Test Codex Agent & Cơ Chế Quản Lý Workspace Trong Paperclip

> **Tài liệu tham khảo kỹ thuật và hướng dẫn thực hành**  
> **Áp dụng cho:** Paperclip Control Plane (V1) & Codex Local Adapter (Engine ACP/CLI) trên môi trường Windows.

---

## MỤC LỤC

1. [Tổng Quan & Kiến Trúc Kết Nối Codex Agent](#1-tổng-quan--kiến-trúc-kết-nối-codex-agent)
2. [Các Lỗi Môi Trường Thực Tế & Cách Xử Lý (Windows)](#2-các-lỗi-môi-trường-thực-tế--cách-xử-lý-windows)
   - [2.1. Lỗi CLI Mode với đường dẫn có dấu cách (`.CMD`)](#21-lỗi-cli-mode-với-đường-dẫn-có-dấu-cách-cmd)
   - [2.2. Cảnh báo "No Codex ACP credentials were detected" dù đã `codex login`](#22-cảnh-báo-no-codex-acp-credentials-were-detected-dù-đã-codex-login)
3. [Ca Thực Hành: Tạo Task Nhẹ & Phân Tích Hành Động Của Agent](#3-ca-thực-hành-tạo-task-nhẹ--phân-tích-hành-động-của-agent)
   - [3.1. Kịch bản test (Tối ưu token)](#31-kịch-bản-test-tối-ưu-token)
   - [3.2. Phân tích chi tiết Tool Call & Lệnh PowerShell mà Agent đã chạy](#32-phân-tích-chi-tiết-tool-call--lệnh-powershell-mà-agent-đã-chạy)
4. [Cơ Chế Quản Lý Workspace Trong Paperclip](#4-cơ-chế-quản-lý-workspace-trong-paperclip)
   - [4.1. Workspace là gì?](#41-workspace-là-gì)
   - [4.2. Workspace có cố định cho mọi Task không?](#42-workspace-có-cố-định-cho-mọi-task-không)
   - [4.3. Ba cấp độ Workspace của Paperclip](#43-ba-cấp-độ-workspace-của-paperclip)
   - [4.4. Vị trí thực tế của file `codex_test.txt` vừa tạo](#44-vị-trí-thực-tế-của-file-codex_testtxt-vừa-tạo)
5. [Hướng Dẫn Cấu Hình Workspace Cho Dự Án Thực Tế](#5-hướng-dẫn-cấu-hình-workspace-cho-dự-án-thực-tế)
6. [Ca Thực Hành Nâng Cao: Phân Rã Kế Hoạch & Điều Phối Task Con (Subtask Orchestration)](#6-ca-thực-hành-nâng-cao-phân-rã-kế-hoạch--điều-phối-task-con-subtask-orchestration)
   - [6.1. Kịch bản bài toán: Tech Lead Agent & Subtask Tree](#61-kịch-bản-bài-toán-tech-lead-agent--subtask-tree)
   - [6.2. Luồng thực thi Pha 1: Agent Think ➔ Tạo Task con (Child Issue)](#62-luồng-thực-thi-pha-1-agent-think-➔-tạo-task-con-child-issue)
   - [6.3. Luồng thực thi Pha 2: Đánh thức bằng Comment ở Task cha (Wake by Comment)](#63-luồng-thực-thi-pha-2-đánh-thức-bằng-comment-ở-task-cha-wake-by-comment)
   - [6.4. Cơ chế vòng đời: Tại sao Task con tạo mới ở trạng thái `todo` & `unassigned`?](#64-cơ-chế-vòng-đời-tại-sao-task-con-tạo-mới-ở-trạng-thái-todo--unassigned)
   - [6.5. Hướng dẫn mở rộng: Tự động hóa hoàn toàn (Auto-assign & Auto-run)](#65-hướng-dẫn-mở-rộng-tự-động-hóa-hoàn-toàn-auto-assign--auto-run)
7. [Phân Tích Chuyên Sâu: Cơ Chế Dò Mò API, Ranh Giới Workspace & Chế Độ Approve-All](#7-phân-tích-chuyên-sâu-cơ-chế-dò-mò-api-ranh-giới-workspace--chế-độ-approve-all)
   - [7.1. Cơ chế "Mò mẫm & Thử sai" (API Discovery Loop) của Agent trong `transcript.json`](#71-cơ-chế-mò-mẫm--thử-sai-api-discovery-loop-của-agent-trong-transcriptjson)
   - [7.2. Phạm vi đọc file thực tế: Workspace riêng vs Toàn bộ Repo](#72-phạm-vi-đọc-file-thực-tế-workspace-riêng-vs-toàn-bộ-repo)
   - [7.3. Ý nghĩa thực sự của chế độ `approve-all`](#73-ý-nghĩa-thực-sự-của-chế-độ-approve-all)
   - [7.4. Nguyên tắc đọc file chọn lọc tối ưu Token (Selective Reading)](#74-nguyên-tắc-đọc-file-chọn-lọc-tối-ưu-token-selective-reading)
   - [7.5. Hiện tượng 2 lượt Run liên tiếp & Cơ chế tự động Reopen Task (`done -> todo`) khi Người dùng Comment](#75-hiện-tượng-2-lượt-run-liên-tiếp--cơ-chế-tự-động-reopen-task-done---todo-khi-người-dùng-comment)

---

## 1. TỔNG QUAN & KIẾN TRÚC KẾT NỐI CODEX AGENT

Paperclip hỗ trợ tích hợp các AI Coding Agent cục bộ (Local Adapters) như Codex, Claude, Cursor, OpenCode... Đối với adapter `codex-local`, Paperclip cung cấp 2 chế độ thực thi (Execution Engine):

1. **Codex CLI Lane (`engine: "cli"`):**
   * Paperclip gọi trực tiếp binary `codex exec` qua tiến trình con.
   * Giao tiếp qua stdin/stdout dạng JSON lines thô.
2. **Codex ACP Engine (`engine: "acp"`) — Khuyên dùng:**
   * Dựa trên chuẩn **Agent Client Protocol (ACP)** do Paperclip và Anthropic/OpenAI phát triển.
   * Server Paperclip khởi chạy `@agentclientprotocol/codex-acp`.
   * Giao tiếp hai chiều qua stream chuẩn hóa (`acpx.text_delta`, `acpx.tool_call`, `acpx.status`), hỗ trợ **Persistent Session** (giữ context ấm qua nhiều turn mà không cần load lại từ đầu).

---

## 2. CÁC LỖI MÔI TRƯỜNG THỰC TẾ & CÁCH XỬ LÝ (WINDOWS)

Trong quá trình cài đặt và bấm **Test Agent** trên hệ điều hành Windows, có 2 trường hợp phổ biến:

### 2.1. Lỗi CLI Mode với đường dẫn có dấu cách (`.CMD`)

* **Hiện tượng khi test:**
  ```text
  error · Primary model test (gpt-5.4-mini): Codex hello probe failed.
  ('\"C:\Users\LAPTOP HP\AppData\Roaming\npm\codex.CMD\"' is not recognized as an internal or external command,)
  ```
* **Nguyên nhân:**
  1. Thư mục người dùng trên Windows chứa khoảng trắng (`LAPTOP HP`).
  2. Binary của Codex là file batch wrapper của npm (`codex.CMD`).
  3. Khi Node.js gọi `cmd.exe /d /s /c` trên Windows và escape nháy kép `\"...\"`, `cmd.exe` bị lỗi cú pháp nhận diện đường dẫn.
* **Cách khắc phục:**
  * Chuyển sang **Execution Engine: ACP** (ACP sử dụng server Node.js chuyên dụng, không phụ thuộc wrapper `.CMD`).

---

### 2.2. Cảnh báo "No Codex ACP credentials were detected" dù đã `codex login`

* **Hiện tượng:**
  * Trong PowerShell, bạn đã gõ `codex login` và nhận thông báo:
    ```text
    Starting local login server on http://localhost:1455.
    Successfully logged in
    ```
  * Nhưng khi bấm **Test Agent** ở chế độ ACP trên web UI thì hiện:
    ```text
    WARN · Primary model test (gpt-5.4-mini): No Codex ACP credentials were detected.
    Hint: Set OPENAI_API_KEY or run `codex login` before starting a Codex ACP agent.
    ```
* **Nguyên nhân kỹ thuật:**
  1. **Đường dẫn `$HOME` trên Windows:**  
     Trong file `packages/adapters/codex-local/src/server/acp.ts`:
     ```typescript
     const codexHome = isNonEmpty(envConfig.CODEX_HOME)
       ? envConfig.CODEX_HOME
       : path.join(process.env.HOME ?? "", ".codex");
     ```
     Trên Windows, `process.env.HOME` bị `undefined` (Windows dùng `%USERPROFILE%`). Do đó hàm probe tìm kiếm sai thư mục thay vì tìm tại `C:\Users\LAPTOP HP\.codex\auth.json`.
  2. **Cấu trúc OAuth Token mới:**  
     `codex login` lưu token vào object con `record.tokens` (`access_token`, `refresh_token`), trong khi hàm kiểm tra `hasCodexNativeCredentials` lại kiểm tra `refresh_token` ở root level.
* **Xử lý:**
  * **Đây chỉ là WARNING (màu vàng), KHÔNG PHẢI ERROR (màu đỏ).** Nút **Create agent** vẫn sáng và cho phép bấm tạo bình thường.
  * Khi Agent chạy thật, Paperclip sử dụng module `resolveSharedCodexHomeDir` (dùng chuẩn `os.homedir()`), nên lúc chạy task nó vẫn tự tìm thấy file đăng nhập của bạn.
  * *(Tùy chọn)*: Để hết chữ vàng, tại mục **Environment variables** của Agent, thêm:
    * Key: `CODEX_HOME`
    * Value: `C:\Users\LAPTOP HP\.codex`

---

## 3. CA THỰC HÀNH: TẠO TASK NHẸ & PHÂN TÍCH HÀNH ĐỘNG CỦA AGENT

### 3.1. Kịch bản test (Tối ưu token)

* **Mục tiêu:** Kiểm tra Agent nhận task, tự động tạo file, tự động comment và tự hoàn thành task.
* **Tiêu đề Task:** `[Test] Tạo file codex_test.txt để kiểm tra kết nối`
* **Mô tả Task:**
  > *"Hãy tạo một file văn bản mới tên là `codex_test.txt` ở thư mục gốc của project với nội dung: 'Codex Agent kết nối Paperclip thành công vào ngày 08/09/2026.' Sau khi tạo xong, hãy để lại comment báo cáo và hoàn thành task."*

---

### 3.2. Phân tích chi tiết Tool Call & Lệnh PowerShell mà Agent đã chạy

Khi kiểm tra tab **Live Transcript / Runs**, bạn nhận được log sự kiện:

```json
{
  "type": "acpx.tool_call",
  "name": "$env:PAPERCLIP_API_BASE = $env:PAPERCLIP_API_URL.TrimEnd('/') -replace '/api$',''; Set-Content -LiteralPath 'codex_test.txt' -Value 'Codex Agent kết nối Paperclip thành công vào ngày 08/09/2026.' -Encoding UTF8; $body = @{ body = \"Created `codex_test.txt` at the project root with the requested content.`n`nDispo: done.\" } | ConvertTo-Json; curl -s -X POST -H \"Authorization: Bearer ***REDACTED***\" -H \"Content-Type: application/json\" -H \"X-Paperclip-Run-Id: $env:PAPERCLIP_RUN_ID\" -d $body \"$env:PAPERCLIP_API_BASE/api/issues/$env:PAPERCLIP_TASK_ID/comments\"; $patch = @{ status = 'done' } | ConvertTo-Json; curl -s -X PATCH -H \"Authorization: Bearer ***REDACTED***\" -H \"Content-Type: application/json\" -H \"X-Paperclip-Run-Id: $env:PAPERCLIP_RUN_ID\" -d $patch \"$env:PAPERCLIP_API_BASE/api/issues/$env:PAPERCLIP_TASK_ID\"; Get-Content -LiteralPath 'codex_test.txt'",
  "toolCallId": "call_OHCSpXOpd6hR1jvTJYcBphkA",
  "status": "in_progress"
}
```

#### Phân rã chuỗi hành động thông minh của Agent:

Thay vì gọi từng công cụ tốn nhiều turn mạng, Codex Agent gom toàn bộ logic vào **1 chuỗi lệnh PowerShell liên hoàn**:

```powershell
# Bước 1: Chuẩn hóa base URL của hệ thống Paperclip
$env:PAPERCLIP_API_BASE = $env:PAPERCLIP_API_URL.TrimEnd('/') -replace '/api$','';

# Bước 2: Tạo file codex_test.txt đúng nội dung tiếng Việt và bảng mã UTF-8
Set-Content -LiteralPath 'codex_test.txt' -Value 'Codex Agent kết nối Paperclip thành công vào ngày 08/09/2026.' -Encoding UTF8;

# Bước 3: Đóng gói nội dung báo cáo dạng JSON và gọi REST API đăng comment lên task
$body = @{ body = "Created `codex_test.txt` at the project root with the requested content.`n`nDispo: done." } | ConvertTo-Json;
curl -s -X POST -H "Authorization: Bearer $AGENT_TOKEN" -H "Content-Type: application/json" -H "X-Paperclip-Run-Id: $env:PAPERCLIP_RUN_ID" -d $body "$env:PAPERCLIP_API_BASE/api/issues/$env:PAPERCLIP_TASK_ID/comments";

# Bước 4: Gọi REST API đổi trạng thái task sang hoàn thành ('done')
$patch = @{ status = 'done' } | ConvertTo-Json;
curl -s -X PATCH -H "Authorization: Bearer $AGENT_TOKEN" -H "Content-Type: application/json" -H "X-Paperclip-Run-Id: $env:PAPERCLIP_RUN_ID" -d $patch "$env:PAPERCLIP_API_BASE/api/issues/$env:PAPERCLIP_TASK_ID";

# Bước 5: Đọc lại nội dung file để in ra output kiểm chứng kết quả
Get-Content -LiteralPath 'codex_test.txt'
```

---

## 4. CƠ CHẾ QUẢN LÝ WORKSPACE TRONG PAPERCLIP

### 4.1. Workspace là gì?

**Workspace** trong Paperclip là **thư mục làm việc hiện tại (`cwd` - current working directory)** mà hệ thống cấp phát cho Agent trong một lượt chạy (Heartbeat Run).
* Tất cả thao tác file tương đối (`./codex_test.txt`, `src/index.ts`) hay các lệnh Git, npm, terminal đều được thực thi tại thư mục này.
* Mục tiêu của Workspace là **cô lập môi trường (Isolation)**, ngăn chặn việc Agent can thiệp nhầm vào mã nguồn máy chủ Paperclip hoặc dữ liệu nhạy cảm của hệ điều hành.

---

### 4.2. Workspace có cố định cho mọi Task không?

👉 **MẶC ĐỊNH LÀ KHÔNG CỐ ĐỊNH, mà phụ thuộc vào việc Task có thuộc Project hay không và cấu hình chiến lược Workspace của Project đó.**

Paperclip vận hành theo **3 cấp độ Workspace**:

```
                              ┌───────────────────────────────────┐
                              │     Paperclip Task Dispatch       │
                              └─────────────────┬─────────────────┘
                                                │
                     ┌──────────────────────────┴──────────────────────────┐
                     ▼                                                     ▼
           Task KHÔNG có Project                                 Task THUỘC một Project
                     │                                                     │
                     ▼                                                     ▼
        【 CẤP ĐỘ 1: Agent Home 】                              Kiểm tra Workspace Strategy
    ~/.paperclip/.../workspaces/<agent-id>                                 │
     (Cố định theo từng Agent)                       ┌─────────────────────┴─────────────────────┐
                                                     ▼                                           ▼
                                        【 CẤP ĐỘ 2: Git Worktree 】                  【 CẤP ĐỘ 3: Shared FS 】
                                      Mỗi Task 1 thư mục riêng biệt                   Trỏ cố định 1 thư mục repo
                                     (paperclip/task-A, task-B...)                    (D:\my-project)
```

---

### 4.3. Ba cấp độ Workspace của Paperclip

#### Cấp độ 1: Agent Home Workspace (Trường hợp Task thử nghiệm vừa rồi)
* **Khi nào kích hoạt:** Khi tạo Task độc lập, **không gắn với Project nào**.
* **Đường dẫn mặc định:**
  ```text
  C:\Users\<Tên_User>\.paperclip\instances\default\workspaces\<agent-id>\
  ```
* **Tính chất:** **Cố định theo từng Agent**. Mọi task không thuộc project của Agent này đều sẽ thao tác chung trên thư mục này. File tạo ở Task 1 sẽ vẫn tồn tại khi Agent làm Task 2.

#### Cấp độ 2: Git Worktree Workspace (Cách ly theo Task - Chuẩn Production)
* **Khi nào kích hoạt:** Khi Task thuộc một Project có liên kết Git repo và bật chiến lược `git_worktree`.
* **Đặc điểm:**
  * **Mỗi task là MỘT thư mục hoàn toàn độc lập.**
  * Agent nhận **Task 101**: Paperclip tự động tạo nhánh `paperclip/task-101` và cấp thư mục riêng.
  * Agent nhận **Task 102**: Paperclip tạo nhánh `paperclip/task-102` ở thư mục khác.
* **Lợi ích:** Nhiều Agent lập trình song song trên cùng một codebase mà **không bao giờ bị xung đột (conflict) mã nguồn**.

#### Cấp độ 3: Shared Local Workspace (Cố định toàn Project)
* **Khi nào kích hoạt:** Khi Project được cấu hình dùng chung thư mục cục bộ (`local_fs` / `shared`), hoặc bạn chỉ định rõ `Working Directory` trong phần cài đặt của Agent.
* **Tính chất:** Cố định 100% vào một thư mục được chỉ định trước trên ổ cứng (ví dụ: `D:\projects\my-app`).

---

### 4.4. Vị trí thực tế của file `codex_test.txt` vừa tạo

Vì lệnh của Agent là `Set-Content -LiteralPath 'codex_test.txt'`, file được tạo ngay trong Workspace cấp độ 1 của Agent:

👉 **Đường dẫn thư mục trên máy của bạn:**
```text
C:\Users\LAPTOP HP\.paperclip\instances\default\workspaces\<ID-của-Agent>\codex_test.txt
```

#### Cách kiểm tra:
1. Nhấn tổ hợp phím **`Windows + R`** trên máy tính.
2. Nhập lệnh sau rồi nhấn Enter:
   ```text
   %USERPROFILE%\.paperclip\instances\default\workspaces
   ```
3. Mở thư mục con mang mã ID của Agent, bạn sẽ thấy file **`codex_test.txt`** với nội dung:
   ```text
   Codex Agent kết nối Paperclip thành công vào ngày 08/09/2026.
   ```

---

## 5. HƯỚNG DẪN CẤU HÌNH WORKSPACE CHO DỰ ÁN THỰC TẾ

Khi muốn Agent làm việc trực tiếp trên dự án thật của bạn (chẳng hạn một website hay repo mã nguồn):

1. **Tạo Project trên Paperclip:**
   * Vào menu bên trái chọn **Projects** ➔ Bấm **New Project**.
   * Đặt tên Project (ví dụ: `My Web Project`).
   * Điền đường dẫn thư mục mã nguồn tại mục **Working Directory / Local Path** (ví dụ: `C:\my-project` hoặc `D:\workspace\ecommerce`).
2. **Giao Task gắn với Project:**
   * Khi tạo Task mới (New Task), tại ô **Project**, chọn dự án bạn vừa tạo.
   * Gán Assignee cho **Codex Agent**.
3. **Kết quả:**
   * Mọi file Agent đọc, sửa hay tạo mới sẽ xuất hiện trực tiếp ngay trong thư mục mã nguồn thật của bạn!

---

## 6. CA THỰC HÀNH NÂNG CAO: PHÂN RÃ KẾ HOẠCH & ĐIỀU PHỐI TASK CON (SUBTASK ORCHESTRATION)

### 6.1. Kịch bản bài toán: Tech Lead Agent & Subtask Tree

Thay vì chỉ thực hiện một lệnh đơn lẻ, bài toán này kiểm tra năng lực cao cấp hơn của Agent: **Đóng vai trò Tech Lead nhận yêu cầu tổng quát ➔ Tự suy nghĩ lập kế hoạch (Think) ➔ Tự dùng công cụ gọi Paperclip API để tạo các Task con (Child Issues/Subtasks) ➔ Nhận phản hồi qua Comment để điều phối tiếp.**

* **Task cha ban đầu (Parent Task):**
  * **Title:** `[Kế hoạch] Phân tích và tạo task con triển khai module Calculator`
  * **Mô tả:**
    > *"Bạn đang đóng vai trò là Tech Lead: Hãy lập kế hoạch ngắn gọn triển khai module calculator.js (gồm 2 hàm: cộng và trừ). Sau đó tự tạo một Task con (Child Issue) với parentId là task hiện tại này, rồi comment báo cáo và cập nhật task cha thành done."*

---

### 6.2. Luồng thực thi Pha 1: Agent Think ➔ Tạo Task con (Child Issue)

1. **Nhận diện ngữ cảnh:**
   Codex Agent được Paperclip cấp các biến môi trường quan trọng:
   * `$env:PAPERCLIP_TASK_ID`: Định danh UUID của Task cha hiện tại.
   * `$env:PAPERCLIP_COMPANY_ID`: Định danh Công ty.
   * `$env:PAPERCLIP_API_URL` & Bearer Token: Đường dẫn và token xác thực để gọi ngược lại Control Plane.
2. **Suy nghĩ (Reasoning):**
   Agent phân rã bài toán Calculator thành các gạch đầu dòng kỹ thuật.
3. **Gọi Paperclip API tạo Task con:**
   Agent gọi tool `paperclipCreateIssue` (hoặc REST API POST `/api/companies/:companyId/issues`) với payload:
   ```json
   {
     "title": "[Triển khai] Viết code cho module calculator.js",
     "parentId": "<ID_CỦA_TASK_CHA>",
     "description": "Yêu cầu tạo file calculator.js gồm 2 hàm add(a, b) và subtract(a, b)..."
   }
   ```
4. **Kết quả hiển thị trên UI:**
   * Ngay trên trang Task cha, mục **Subtasks** xuất hiện task con mới.
   * Cây phả hệ phân cấp công việc (Issue Hierarchy Tree) được thiết lập tự động.

---

### 6.3. Luồng thực thi Pha 2: Đánh thức bằng Comment ở Task cha (Wake by Comment)

* **Tình huống thực tế:** Người quản lý (User) muốn thay đổi/bổ sung yêu cầu vào kế hoạch.
* **Hành động của User:** Comment trực tiếp vào Task cha:
  > *"Kế hoạch cần bổ sung thêm hàm `multiply(a, b)` (phép nhân). Bạn hãy tạo thêm một task con mới chuyên biệt cho hàm nhân này nhé."*

#### Diễn biến hệ thống và Agent:
1. **Wake Event:** Task cha (dù đang ở trạng thái `done`) ngay lập tức được Paperclip đánh thức (Wake on comment) và sinh ra một Run mới.
2. **Context Ingestion:** Agent đọc toàn bộ lịch sử (bao gồm kế hoạch cũ, task con đã tạo trước đó và comment yêu cầu bổ sung hàm nhân).
3. **Tự động sinh Task con thứ 2:**
   Agent tiếp tục gọi API tạo thêm task con:
   * **Title:** `[Triển khai] Viết code cho hàm nhân multiply trong calculator.js`
   * **`parentId`:** Trỏ tiếp vào Task cha.
4. **Phản hồi:** Agent comment xác nhận đã bổ sung task con thành công và chuyển lại status về `done`.

---

### 6.4. Cơ chế vòng đời: Tại sao Task con tạo mới ở trạng thái `todo` & `unassigned`?

Một câu hỏi rất thực tế trong bài test: *"Tại sao task con vừa tạo chỉ mới ở trạng thái `todo` và chưa được gán (`unassigned`) cho Agent nào, cũng chưa chạy `in_progress`?"*

Đây là **nguyên tắc thiết kế bất biến (Invariants) của Paperclip Control Plane**:

1. **Tách bạch giữa Lập kế hoạch (Planning/Triaging) và Thực thi (Execution):**
   * Người lập kế hoạch (Lead Agent) chỉ phân rã bài toán và đưa ra danh mục công việc cần làm (`Backlog / Todo`).
   * Không được tự ý ép buộc tài nguyên chạy ngay lập tức khi chưa có sự phân công rõ ràng.
2. **Quyền điều phối của Operator (Human-in-the-loop):**
   * Quản trị viên có thể xem xét danh sách task con vừa tạo, quyết định giao task 1 cho Agent Codex, task 2 cho Agent Claude, hoặc điều chỉnh độ ưu tiên (`Priority`) trước khi bắt đầu.
3. **Quy tắc Atomic Issue Checkout:**
   * Một task chỉ chuyển sang `in_progress` khi có một Agent chính thức thực hiện hành động **Checkout** (`POST /api/issues/:id/checkout`).
   * Điều này đảm bảo **Single-assignee task model**: Mỗi thời điểm chỉ có duy nhất 1 Agent chịu trách nhiệm và làm việc trên task, loại bỏ hoàn toàn race condition hoặc xung đột tài nguyên.

---

### 6.5. Hướng dẫn mở rộng: Tự động hóa hoàn toàn (Auto-assign & Auto-run)

Nếu bạn muốn chuỗi hoạt động tự động 100% (Agent tạo task con, tự gán cho chính nó và nhảy vào code luôn), bạn chỉ cần ra lệnh cụ thể trong mô tả hoặc comment:

> *"Hãy tạo task con cho hàm `multiply(a, b)`, **gán luôn task con đó cho chính bạn (`assigneeId`) và tiến hành checkout thực hiện code luôn**."*

Khi đó Agent sẽ:
1. Tạo task con với `assigneeId` = ID của chính nó.
2. Gọi `checkoutIssue` trên task con ➔ Trạng thái chuyển thành `in_progress`.
3. Sinh mã nguồn `calculator.js` trong Workspace ➔ Đổi trạng thái thành `done`!

---

## 7. PHÂN TÍCH CHUYÊN SÂU: CƠ CHẾ DÒ MÒ API, RANH GIỚI WORKSPACE & CHẾ ĐỘ APPROVE-ALL

> **Phân tích dựa trên dữ liệu thực thi thực tế từ file log [`transcript.json`](file:///c:/paperclip/instructions/transcript.json)**

---

### 7.1. Cơ chế "Mò mẫm & Thử sai" (API Discovery Loop) của Agent trong `transcript.json`

Khi Agent không có sẵn tài liệu API hoặc OpenAPI Schema chính xác trong hệ thống prompt, nó diễn giải bài toán theo vòng lặp **Suy luận & Thử nghiệm (Reasoning & Feedback Loop)** qua 4 bước thực tế:

1. **Đoán mò URL ban đầu (Line 473):**
   Agent suy luận theo chuẩn RESTful thông thường và chạy lệnh `curl` gửi request `POST /api/issues` với payload chứa `parentId`.
2. **Nhận biết dự đoán sai (Lines 498-500):**
   Server Paperclip từ chối request (`Collection read-only`). Trong suy luận nội bộ (đoạn `thinking` line 500), Agent tự ghi nhận:
   > *"The direct `POST /api/issues` guess was wrong, so I’m locating the actual route in the local Paperclip codebase..."*
3. **Mò mẫm mã nguồn nội bộ (Lines 508 & 593):**
   Agent chạy lệnh `rg` (ripgrep) để tìm kiếm các cụm từ khóa `api/issues`, `children`, `parentId` trong các file mã nguồn local nhằm tra cứu định nghĩa route.
4. **Thử nghiệm có hệ thống bằng lệnh OPTIONS (Lines 701-704):**
   Đây là bước dò đường bằng Terminal rất đặc trưng của Agent. Nó phát một chuỗi lệnh PowerShell lặp qua các endpoint tiềm năng:
   ```powershell
   foreach ($p in @('children', 'child-issues', 'subissues', 'sub-issues', 'related-work', 'work-products')) {
       curl -s -X OPTIONS "$base/api/issues/$env:PAPERCLIP_TASK_ID/$p"
   }
   ```
   Sau khi nhận được phản hồi hợp lệ cho `/children`, Agent mới chốt và thực hiện request chính thức `POST /api/issues/$env:PAPERCLIP_TASK_ID/children`.

---

### 7.2. Phạm vi đọc file thực tế: Workspace riêng vs Toàn bộ Repo

Một câu hỏi quan trọng trong vận hành: *"Agent trong lượt chạy đó đang đọc ở Workspace riêng hay đọc toàn bộ Repo `C:\paperclip`?"*

👉 **Dẫn chứng từ log [`transcript.json`](file:///c:/paperclip/instructions/transcript.json):**
1. **Workspace bị khóa hoàn toàn (Line 3):**
   Ngay từ đầu session, Paperclip chỉ định rõ đường dẫn làm việc cách ly:
   `Using fallback workspace "C:\Users\LAPTOP HP\.paperclip\instances\default\workspaces\4919b15f-2218-475c-ae83-76bd6ab43a2e"`
2. **Phạm vi đọc/ghi file (Lines 165, 175 & 450):**
   Tất cả thao tác đọc (`Get-Content`), ghi (`Set-Content`) và so sánh (`diff`) của Agent chỉ diễn ra trên các file nằm trong thư mục `4919b15f-...` (như `calculator.js`, `codex_test.txt`).
3. **Lý do tìm kiếm bằng `rg` thất bại (Lines 508, 593):**
   Khi Agent chạy `rg -n "api/issues" -S .`, kí tự `.` trỏ tới Workspace riêng. Vì Workspace riêng này **không chứa mã nguồn backend Paperclip** (`server/src/routes/issues.ts`), lệnh `rg` không trả về kết quả nào. Đó là lý do Agent phải chuyển sang dò bằng HTTP OPTIONS qua mạng!

---

### 7.3. Ý nghĩa thực sự của chế độ `approve-all`

* Trong log `transcript.json` hiển thị: `model=codex (persistent / approve-all)`.
* **Ý nghĩa:** `approve-all` chỉ có tác dụng **miễn trừ việc hiển thị nút bấm xác nhận (Confirm Gate) đối với người dùng** khi Agent gọi các tool hay lệnh Terminal TRONG phạm vi Workspace của nó.
* **Quy tắc an toàn:** `approve-all` **KHÔNG** đồng nghĩa với việc cấp quyền cho Agent tự ý "vượt rào" truy cập hoặc đọc/ghi dữ liệu ra ngoài thư mục Workspace đã được giao.

---

### 7.4. Nguyên tắc đọc file chọn lọc tối ưu Token (Selective Reading)

* **Giới hạn Context Window:** AI Agent bị giới hạn bởi dung lượng ngữ cảnh (ví dụ: 256,000 tokens). Do đó, nó **KHÔNG BAO GIỜ nạp toàn bộ Repo hay toàn bộ Workspace vào bộ nhớ cùng lúc**.
* **Luồng đọc chọn lọc (Selective Reading Flow):**
  1. **Quét danh sách:** Dùng lệnh nhẹ (`ls`, `Get-ChildItem`) để nhìn cấu trúc cây thư mục.
  2. **Lọc từ khóa:** Dùng lệnh tìm kiếm (`rg`, `grep`) để khoanh vùng các file có khả năng chứa thông tin.
  3. **Mở file đích:** Chỉ mở đọc đúng đoạn mã/nội dung file cần thiết thông qua các công cụ `view_file` hoặc `Get-Content`.

---

### 7.5. Hiện tượng 2 lượt Run liên tiếp & Cơ chế tự động Reopen Task (`done -> todo`) khi Người dùng Comment

> **Hiện tượng:** Khi người dùng gửi comment ở chế độ **Ask mode** (ví dụ: *"hiển thị nội dung file code..."*) trên một Task đã đóng (`done`), Agent lập tức chạy **Run 1** (khoảng vài chục giây) để in nội dung code ra chat. Nhưng ngay sau đó, một **Run 2** (chạy vài phút) tự động xuất hiện để phân rã subtask và đổi status!

👉 **Bản chất kỹ thuật & Nguyên nhân cốt lõi:**

1. **Cơ chế tự động Reopen của Server Paperclip ([`server/src/routes/issues.ts#L10081`](file:///C:/paperclip/server/src/routes/issues.ts#L10081)):**
   Trong API tạo comment (`POST /api/issues/:id/comments`), Paperclip thực thi quy tắc bất biến:
   ```typescript
   if (isClosed) {
       // Mỗi khi người dùng comment vào Task đã Closed/Done, hệ thống tự động đổi status về todo
       const reopenedIssue = await svc.update(id, { status: "todo" });
       reopened = true;
   }
   ```
2. **Triết lý thiết kế Control Plane (Wake on Comment):**
   Paperclip coi mọi comment mới của Người dùng trên Task đã đóng là một chỉ thị/yêu cầu điều chỉnh mới. Do đó Server tự động đổi trạng thái `done ➔ todo` và kích hoạt sự kiện `issue_reopened_via_comment`.
3. **Giải thích luồng thực thi 2 Run liên tiếp:**
   - **Run 1 (Ask Mode - Ngắn hạn):** Khi comment được gửi đi ở `Ask mode`, Agent ưu tiên xử lý directive tạm thời: đọc file và in kết quả trả lời trực tiếp ra cửa sổ chat trong Run 1.
   - **Run 2 (Reopened Execution - Tiếp tục Task):** Vì ở Bước 1 Server đã tự động đổi status Task thành `todo`, ngay khi Run 1 vừa kết thúc, hệ thống Heartbeat kiểm tra thấy Task đang ở trạng thái `todo` và chưa hoàn tất mục tiêu chính ➔ Tự động kích hoạt **Run 2** để Agent tiếp tục làm nốt công việc (tạo subtask, viết code...) cho đến khi Task chuyển lại thành `done`.


