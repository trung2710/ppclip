# Việc cần làm tiếp theo: luồng Telegram, MCP server, LiteLLM

Cập nhật: 2026-10-15

Tài liệu này ghi lại những gì đã xong và những gì còn lại, để không bỏ sót.

## 1. Đã hoàn thành

### MCP server (`paperclip-mcp/src/paperclip_mcp/server.py`)

- [x] Gỡ tool `api_request` (đường vòng gây lỗi 403/400 và rủi ro bảo mật).
- [x] Bỏ tham số `api_key`, `run_id`, `company_id` khỏi các tool. Danh tính chỉ đọc từ biến môi trường (`_api_key()`, `_run_id()`, `_get_company_id()`).
- [x] Middleware bỏ qua `api_key` / `run_id` / `company_id` thừa nếu agent cũ vẫn truyền.
- [x] Mặc định `--transport` là `stdio`, cảnh báo nếu chạy HTTP/SSE.
- [x] `finish_task_and_reply_telegram`:
  - [x] Bóc `chat_id` / `message_id` từ JSON n8n nối cuối description (chống giả mạo: lấy khối cuối cùng).
  - [x] Gửi `run_id` trong payload webhook; comment kèm `X-Paperclip-Run-Id` để không sinh run bàn giao mới.
  - [x] Thiếu `chat_id` thì không lỗi: bỏ qua Telegram, vẫn comment (có ghi chú) và đóng task, trả `telegram_skipped: true`.
  - [x] Chọn attachment theo `originalFilename` (không phân biệt hoa thường), trùng tên lấy bản mới nhất, bỏ nhánh "lấy attachment cuối".
  - [x] Không tìm được file thì báo lỗi trước khi gọi webhook, kèm danh sách attachment hiện có.
- [x] Test: 69 test đều pass (`python -m unittest discover -s tests`).

### Hướng dẫn agent (`AGENTS.md` của agent 4919b15f)

- [x] Bỏ `api_key=$env:...` trong ví dụ gọi tool, bỏ bản sao trùng (313 xuống 129 dòng).
- [x] Thêm quy tắc "không truyền danh tính cho MCP tool".
- [x] Bỏ bước upload PowerShell. Agent chỉ ghi file ra ổ đĩa và truyền `file_path`; tool tự upload.

### Cost / token theo run (LiteLLM)

- [x] Lấy token và cost theo run từ `/spend/logs` (tag `paperclip_run:<runId>`).
- [x] Tắt Guardian cho agent dùng LiteLLM gateway.
- [x] Sửa phân loại billing (gateway thì `api`, cost không bị về 0).
- [x] Chuyển biến môi trường run sang tiến trình MCP qua `env_vars`.

## 2. Việc cần làm (theo thứ tự ưu tiên)

### Bước 1: Commit và bảo vệ code

- [ ] Commit code repo Paperclip, chia 2 đến 3 commit (adapter-utils/LiteLLM, codex-local, server/routes). Xem file và message trước khi commit.
- [ ] Quyết định cách lưu `paperclip-mcp` (đang bị gitignore nên không nằm trong commit). Hiện chỉ có bản sao lưu trong `paperclip-mcp/backup/`. Bản đúng mới nhất: `server.py.after-attachment-fix`.
- [ ] Cẩn thận khi mở `server.py` trong IDE: từng bị lưu đè về bản cũ một lần. Dùng File, Revert File nếu tab hiện nội dung cũ.

### Bước 2: Nhiều file trong payload (#7)

Nhu cầu thật: run KHT-80 tạo 2 file, trong khi tool chỉ gửi được 1 (`file_path` đơn).

- [ ] Cho `file_path` nhận danh sách (hoặc thêm tham số `file_paths`).
- [ ] Payload giữ nguyên `fileName`, `downloadPath`, `attachmentId` cho file đầu (n8n cũ không hỏng), thêm mảng `attachments` gồm id, filename, content_type, byte_size, download_path.
- [ ] Phía n8n: lặp qua mảng `attachments`, tải từng file, gửi Telegram.
- [ ] **Cần quyết:** gửi mỗi file một tin riêng, hay gộp thành nhóm tài liệu (media group)?
- [ ] Test: nhiều file, một file lỗi, trùng tên.

### Bước 3: Giới hạn `file_path` (#5)

- [ ] Chỉ cho phép file nằm trong workspace hoặc scratch dir của run (`PAPERCLIP_TASK_SCRATCH_DIR`, thư mục làm việc).
- [ ] Chặn đường dẫn thoát thư mục (`..`) và symlink trỏ ra ngoài.
- [ ] Lý do: agent nhận nội dung từ người dùng Telegram nên prompt injection có thể bắt upload file như `.env` hoặc `config.toml`.
- [ ] Test: đường dẫn hợp lệ, `..`, đường dẫn tuyệt đối ngoài workspace, symlink.

### Bước 4: In lỗi tool ra transcript (#6)

- [x] Engine ACPX ghi THÊM trường `output` (nội dung kết quả/lỗi từ `rawOutput`/`content`) vào dòng log `acpx.tool_call`; UI và CLI nối nó sau nội dung cũ. Không bỏ trường nào đang có. Module: `acpx-engine/tool-output.ts` (12 test).
- [x] Che Bearer token, JWT, khóa `sk-`, giá trị `api_key`/`password`; cắt ở 4000 ký tự.
- [ ] Chạy thử một run thật để xác nhận codex-acp có điền `rawOutput`/`content` cho lỗi MCP (chưa kiểm chứng với dữ liệu thật).
- [ ] Log từng bước bên trong MCP tool (`[finish_task] [Step n/5]`) không đi qua ACP, nên chưa hiện trong transcript. Xem phần "Log từng bước của MCP tool" ngay dưới đây.

- [x] Trace mọi tool (MCP, lệnh shell, đọc file, sửa/tạo file của Codex): engine ghi thêm `args` (đầu vào thật, khi có), `kind`, và `output` gồm exit code + output lệnh, nội dung file tạo mới (trích 60 dòng đầu), file bị sửa (số dòng trước/sau, dòng thêm/bớt), vị trí file. 22 test trong `tool-output.test.ts`.
- [x] Cờ debug `PAPERCLIP_ACPX_DEBUG_TOOL_EVENTS_DIR`: ghi sự kiện tool thô (đã che secret) ra `<thư mục>/<runId>.ndjson`.
- [x] Đã chạy run với cờ debug (run 36d8ed8b): các dòng `tool call` không tiêu đề là cập nhật rỗng (không trạng thái, không dữ liệu), engine giờ không ghi chúng (`isEmptyToolUpdate`). Diff sửa/tạo file chỉ có ở sự kiện bắt đầu nên engine mang nó sang sự kiện kết thúc (`ToolOutputCarry`). Phát lại file debug: giữ 9 dòng, bỏ 26 dòng rỗng / 36. 29 test.

#### Log từng bước của MCP tool: các phương án

Vấn đề: MCP server ghi `[finish_task] [Step 3/5 SUCCESS] ...` ra stderr của chính nó. Transcript của run chỉ nhận dữ liệu qua kênh ACP, nên các dòng này không hiện. Trong lúc tool chạy, kênh ACP chỉ báo `in_progress` rồi `completed` hoặc `failed`, không có dòng nào ở giữa.

| Phương án | Hiện lúc nào | Khi tool bị treo | Độ khó | Ghi chú |
|---|---|---|---|---|
| **A. Tool trả `steps` trong kết quả** (đề xuất) | Một lượt, sau khi tool kết thúc | Không thấy gì | Thấp | Chỉ sửa tool finish. Khi lỗi thì đính danh sách bước vào thông báo lỗi để biết dừng ở bước nào |
| **B. MCP progress/log notification** (`ctx.info(...)` trong FastMCP) | Realtime, nếu được chuyển tiếp | Thấy các bước đã chạy | Trung bình | **Chưa kiểm chứng** Codex và codex-acp có chuyển tiếp thông báo này sang ACP hay không (nhiều khả năng là không) |
| **C. MCP ghi log ra file theo run, engine đọc đuôi file** | Gần realtime | Thấy các bước đã chạy | Cao | Phải thống nhất đường dẫn file theo `run_id`, đồng bộ giữa MCP và engine, dọn dẹp file sau run |

Ví dụ nội dung `steps` của phương án A:

```
steps: [
  "Task: KHT-80",
  "chat_id: 8882960938 (nguồn: description_json)",
  "Upload: bao_cao.md OK (attachment id f7074f2c)",
  "Webhook n8n: HTTP 200",
  "PATCH status done: OK",
  "Comment: OK"
]
```

Quyết định hiện tại: chọn phương án A. Tool finish chỉ mất vài giây (upload, webhook, PATCH, comment) nên chờ đến lúc xong là chấp nhận được. Chỉ chuyển sang B hoặc C nếu thực sự cần xem lúc tool bị treo.

Việc cần làm cho phương án A:

- [x] Gom các mốc chính trong `finish_task_and_reply_telegram` vào danh sách `steps` (mỗi bước một dòng ngắn).
- [x] Trả `steps` trong kết quả thành công; mọi lỗi cứng của tool đều đính "Các bước đã chạy" vào thông báo lỗi.
- [x] Không đưa secret hay nội dung `message` vào `steps` (có test).
- [x] Test: 9 test trong `tests/test_finish_steps.py` (thành công, bỏ qua Telegram, upload, lỗi PATCH/comment, lỗi chọn file, lỗi webhook, không lộ message, giữ nguyên các trường cũ).
- [ ] Chạy một run thật để xác nhận `steps` hiện trong `RESULT` của transcript (phụ thuộc acpx và codex-acp chuyển tiếp nội dung kết quả của tool).

- [x] Gom phần ghi bước thành lớp dùng chung `StepLog` (`paperclip-mcp/src/paperclip_mcp/step_log.py`): một lời gọi ghi cả stderr và `steps`, tự sinh tiền tố `[Step n/total ...]`, `detail` chỉ ghi stderr, `fail()` raise ToolError kèm "Các bước đã chạy". `finish_task_and_reply_telegram` đã chuyển sang dùng; tool khác khi cần chỉ thêm một dòng khởi tạo. 8 test trong `tests/test_step_log.py`.

### Hiển thị thời gian trong transcript của run (đang làm dở)

- [x] **A. Cột giờ** `HH:MM:SS` ở đầu mỗi dòng transcript (cả chế độ nice và raw), tooltip hiện mili giây; nút **Time** bật/tắt trong thanh công cụ (mặc định bật). `ui/src/components/transcript/RunTranscriptView.tsx` (prop `showTimestamps`) và `ui/src/pages/AgentDetail.tsx`. 4 test mới.
- [ ] **B. Thời lượng từng tool call** (tính ở UI: `ts` kết thúc trừ `ts` bắt đầu cùng `toolUseId`), hiện cạnh tên tool.
- [ ] **C. Khoảng chờ giữa các tool** (thời gian model nghĩ), tô màu cảnh báo khi trên 10 giây; thanh tóm tắt đầu run (tổng, model, Guardian, tool).

### Bước 5: Idempotency và secret cho webhook n8n (#8)

- [ ] Gửi `Idempotency-Key` theo run (ví dụ `run_id` + `task_id`) để n8n bỏ qua yêu cầu trùng khi retry.
- [ ] Thêm secret trong header webhook; n8n kiểm tra trước khi xử lý.
- [ ] Cần sửa cả phía n8n.

### Bước 6: Dọn dẹp

- [ ] Xoá định nghĩa trùng trong `server.py`: `list_issue_documents`, `get_issue_document`, `upsert_issue_document`, `upload_issue_attachment`, `_upload_file_to_issue`.
- [ ] Xoá hàm chết `_resolve_current_task_id`.
- [ ] Sửa docstring còn nhắc `$env:PAPERCLIP_API_KEY`.
- [ ] Cập nhật `instructions/thay_doi_litellm_guardian_cost_token_theo_run.md`: billing fix, parser Telegram, `run_id` trong payload, gỡ `api_request`, bỏ tham số danh tính.
- [ ] Xoá khỏi `doc/plans` hoặc đánh dấu các mục đã xong khi hoàn tất.

## 3. Việc chưa quyết hoặc cần theo dõi

- [ ] **Work product (artifact):** có muốn tool finish tạo luôn work product sau khi upload (để hiện trong giao diện Paperclip) không? Hiện chỉ có attachment. Phương án A: tool tạo luôn. Phương án B: giữ nguyên.
- [ ] **`list_issues` quá nặng:** một lần liệt kê 71 task tốn khoảng 58k token. Rút gọn trường (`id`, `title`, `status`, `assignee`, `updatedAt`) và thêm `count_only`. (Đã hoãn theo yêu cầu.)
- [ ] **Token hiển thị 0 / 0:** run dùng gói thuê bao (không qua LiteLLM) báo `0 / 0 / $0.000000` dù ngữ cảnh đã dùng hơn 40k. Chưa điều tra đường báo token của run này.
- [ ] **Run báo `completed` dù Gemini 429 hết retry:** nên coi là failed.
- [ ] **Comment trùng khi đóng task:** khi agent tự PATCH với `comment` chứa chuỗi nháy đơn, `` `n `` không thành xuống dòng, sau đó phải comment lại. Nên dùng tool finish.
- [ ] **Task tạo tay không đi qua tool finish:** agent làm theo skill Paperclip chuẩn (attachment + work product, không gửi Telegram). Đây là hành vi đúng, nhưng nếu muốn mọi task đều gửi Telegram thì phải đổi quy tắc trong AGENTS.md.
- [ ] **HTTP transport:** nếu sau này chạy MCP bằng HTTP cho nhiều agent, danh tính phải gắn qua header của request (hiện chỉ đọc env của tiến trình).

## 4. An toàn (chỉ người dùng làm được)

- [ ] **Xoay các API key đã lộ:** OpenAI và OpenRouter trong `litellm_config.yaml`, virtual key LiteLLM (bắt đầu bằng `sk-0hq`) đã dán trong chat. Sau khi xoay, cập nhật lại cấu hình.
- [ ] Rà soát `instructions/log.txt` và các file log có chứa prompt, kết quả tool, vì `logs_2.sqlite` của Codex cũng lưu nội dung nhạy cảm.

## 5. Kiểm tra sau mỗi thay đổi

Chạy test MCP:

```
cd C:\paperclip\paperclip-mcp
D:\anaconda\envs\ml_env\python.exe -m unittest discover -s tests
```

Chạy thử đường file đến Telegram (tạo task qua Telegram, hoặc tạo tay có khối JSON ở cuối mô tả):

````
```json:telegram_context
{"chat_id": <số>, "message_id": <số>}
```
````

Cần thấy:

1. Task có đúng một attachment cho mỗi file (không trùng).
2. Log MCP có dòng `[Step 3/5] Phát hiện file`, rồi dòng `[Step 3/5 SUCCESS]` kèm `downloadPath`.
3. Telegram nhận file, không chỉ tin nhắn.
4. Task chuyển `done`, có một comment của run, không sinh run bàn giao mới.

## 6. Vị trí các bản sao lưu

Thư mục `paperclip-mcp/backup/`:

| File | Nội dung |
|---|---|
| `server.py.after-attachment-fix` | Bản `server.py` mới nhất, đúng |
| `server.py.after-telegram-skip` | Sau khi sửa thiếu chat_id |
| `server.py.after-drop-identity-params` | Sau khi bỏ tham số danh tính |
| `agent-4919b15f-AGENTS.md.bak-2026-10-15` | AGENTS.md của agent trước khi dọn |
| `agent-4919b15f-AGENTS.md.bak-before-upload-step-removal` | AGENTS.md trước khi bỏ bước upload PowerShell |
