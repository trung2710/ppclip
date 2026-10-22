# Cơ chế hai engine ACP và CLI trong adapter `codex_local`

Ngày: 2026-10-22

## 1. Tóm tắt

- Chỉ có **một adapter** là `codex_local`. Adapter này có **hai cách chạy** (engine), chọn bằng `adapterConfig.engine`:
  - `cli`: Paperclip chạy thẳng lệnh `codex exec`, mỗi run một tiến trình mới.
  - `acp`: Paperclip đi qua engine ACPX, thư viện `acpx`, chương trình `codex-acp`, rồi mới tới Codex.
- Không đặt `engine` thì mặc định là `acp`. Nếu ACP không khởi động được thì tự lùi về `cli`.
- **Cả hai đều chạy trên máy đang chạy Paperclip** (với môi trường `Local`) và gọi model OpenAI theo cùng một cách. ACP không có sandbox hay kết nối cloud riêng.
- Khác biệt chính:
  - ACP cho log trực tiếp chi tiết hơn và điều khiển phiên tốt hơn (hủy lượt, đặt cấu hình qua giao thức).
  - CLI đơn giản hơn: cấu hình được truyền lại từ đầu mỗi run, nên resume chỉ cần kiểm tra `cwd`.

## 2. Các thành phần

| Thành phần | Là gì | Nằm ở đâu |
|---|---|---|
| Heartbeat | Bộ điều phối run của server Paperclip | `server/src/services/heartbeat.ts` |
| Adapter `codex_local` | Cầu nối giữa Paperclip và Codex. Chứa cả đường CLI | `packages/adapters/codex-local/src/server/execute.ts` |
| Bộ chọn engine ACP | Chọn engine, dựng cấu hình ACP | `packages/adapters/codex-local/src/server/acp.ts` |
| Engine ACPX | Code của Paperclip điều khiển agent qua ACP, dùng chung cho Codex, Claude, Gemini | `packages/adapter-utils/src/acpx-engine/execute.ts` |
| `acpx` | Gói npm bên ngoài. Engine import thư viện `acpx/runtime` | `node_modules/acpx` (bản 0.12.0) |
| `codex-acp` | Gói npm bên ngoài (`@agentclientprotocol/codex-acp` 1.11.0). **Chỉ là lớp dịch**, không phải lõi: nói ACP với `acpx`, và tự khởi chạy `codex app-server` rồi nói JSON-RPC với nó | `node_modules/@agentclientprotocol/codex-acp`, hàm `startCodexConnection` trong `dist/index.js` |
| Codex | Agent thật: gọi model, chạy công cụ, lưu lịch sử. **Cùng một chương trình cho cả hai đường** (`@openai/codex` 0.153.x) | CLI: chế độ `codex exec` (chạy một lượt rồi thoát). ACP: chế độ `codex app-server` (máy chủ sống lâu) |
| `CODEX_HOME` | Thư mục của Codex: `config.toml`, `auth.json`, `skills/`, `sessions/` | Agent hiện tại đặt `C:\Users\LAPTOP HP\.codex` |
| MCP gateway | Công cụ Paperclip (ví dụ gửi Telegram) cấp cho agent qua MCP | `heartbeat.ts` (`buildPaperclipRuntimeMcpServers`) |

ACP (Agent Client Protocol) là giao thức chuẩn để một chương trình điều khiển nói chuyện với agent: mở phiên, gửi prompt, nhận cập nhật từng bước, hủy, xin quyền. Codex không tự nói ACP, nên cần `codex-acp` làm lớp dịch.

## 3. Sơ đồ kết nối

### 3.1. Đường CLI

```
Server Paperclip (heartbeat.ts)
   │  adapter.execute(ctx)
   ▼
codex_local/execute.ts  (đường CLI)
   │  spawn:  codex exec --json [...] [resume <thread_id>] -
   │  stdin:  prompt
   │  env:    PAPERCLIP_RUN_ID, PAPERCLIP_TASK_ID, PAPERCLIP_API_KEY (JWT của run), CODEX_HOME, ...
   ▼
Tiến trình codex (MỚI mỗi run) ───HTTPS───► OpenAI API
   │  đọc CODEX_HOME: config.toml (model, MCP gateway), auth.json
   │  resume: nạp lịch sử từ CODEX_HOME/sessions/rollout-*.jsonl
   │  chạy lệnh (shell) với env của chính tiến trình này
   │  stdout: JSONL (thread.started, item.*, turn.completed)
   ▼
execute.ts đọc stdout → log run → giao diện ; parse.ts → kết quả, thread_id
   (tiến trình codex kết thúc khi run xong)
```

### 3.2. Đường ACP

```
Server Paperclip (heartbeat.ts)
   │  adapter.execute(ctx)
   ▼
codex_local/execute.ts ──► acp.ts (createCodexAcpExecutor)
   ▼
Engine ACPX (adapter-utils/acpx-engine/execute.ts)
   │  dùng thư viện acpx/runtime (chạy trong tiến trình Node của server)
   ▼
acpx runtime ──spawn + giao thức ACP qua stdio──► codex-acp   (lớp dịch, Node)
                                                    │  spawn: codex app-server  (env truyền lúc khởi chạy)
                                                    │  JSON-RPC (vscode-jsonrpc)
                                                    ▼
                                    codex app-server ───HTTPS───► OpenAI API
                                                    │  lưu CODEX_HOME/sessions/rollout-*.jsonl (originator "acpx")
   ◄──── sự kiện ACP (text, tool_call, status, usage) ────┘
Engine ghi mỗi sự kiện thành một dòng `acpx.*` vào log run → giao diện
```

## 4. Phần chung: server chuẩn bị run (trước khi gọi adapter)

Áp dụng cho cả hai engine. Số dòng là của `server/src/services/heartbeat.ts`.

| Bước | Việc | Vị trí |
|---|---|---|
| S1 | Có wake (giao task, comment, timer...) thì tạo bản ghi `heartbeat_runs` | nhiều nơi trong `routes/issues.ts` và `heartbeat.ts` |
| S2 | Xác định `taskKey` (thường là `issueId`) | `deriveTaskKeyWithHeartbeatFallback`, dòng 11913 |
| S3 | Đọc session đã lưu của task trong bảng `agent_task_sessions` | `getTaskSession`, dòng 12087 (định nghĩa 6293) |
| S4 | Dựng cấu hình adapter: env, giải mã secret, env của project/routine | `resolveExecutionRunAdapterConfig`, dòng 12384 |
| S5 | Tính fingerprint cấu hình ở server, quyết định có bỏ session cũ không | `buildEffectiveRunSessionConfigMetadata` dòng 12432; `resolveTaskSessionConfigFreshness` dòng 12493; theo `wakeReason`: `shouldResetTaskSessionForWake` dòng 3016 |
| S6 | Chuẩn bị workspace (thư mục làm việc) và thư mục scratch riêng của run (ghi vào env) | dòng 12944 |
| S7 | Dựng `runtimeForAdapter = { sessionId, sessionParams, taskKey }` | dòng 13130 |
| S8 | Cấp JWT riêng cho run (`authToken`, gắn `run_id`) | `createLocalAgentJwt`, dòng 13483 |
| S9 | Dựng danh sách MCP gateway kèm token ngắn hạn cho run | `buildPaperclipRuntimeMcpServers`, dòng 13684 |
| S10 | Gọi `adapter.execute(ctx)` | dòng 13701 |

## 5. Quy trình đường CLI (một request)

Số dòng là của `packages/adapters/codex-local/src/server/execute.ts`, trừ khi ghi khác.

| Bước | Việc | Vị trí |
|---|---|---|
| C1 | Chọn engine. Có `engine: "cli"` (hoặc ACP không khả dụng) thì đi tiếp đường CLI | dòng 455-471; `acp.ts:81`, lý do lùi về CLI ở `acp.ts:461` |
| C2 | Xác định thư mục làm việc `cwd` | dòng 508-529 |
| C3 | Xác định `CODEX_HOME` (cấu hình riêng hoặc thư mục quản lý của công ty), kiểm tra có credential | dòng 521-582 |
| C4 | Ghi các MCP gateway (kèm token của run) vào khối `[mcp_servers.*]` trong `config.toml` | dòng 604-627; `codex-home.ts:315` |
| C5 | Đưa skills vào `CODEX_HOME/skills` | dòng 630-638 |
| C6 | Nếu chạy từ xa: đồng bộ workspace và `CODEX_HOME` lên máy đích. Chạy local thì bỏ qua | dòng 647-713 |
| C7 | Dựng env cho tiến trình: `PAPERCLIP_RUN_ID`, `PAPERCLIP_TASK_ID`, `PAPERCLIP_WAKE_*`, `CODEX_HOME`, `PAPERCLIP_API_KEY` = JWT của run (S8) | dòng 734-821 |
| C8 | Quyết định resume: có `sessionId`, `cwd` đã lưu trùng `cwd` hiện tại, đích chạy trùng | dòng 910-932 |
| C9 | Dựng prompt: instructions (`AGENTS.md`), bootstrap (chỉ khi phiên mới), wake prompt (comment mới...). Khi resume chỉ gửi phần thay đổi | dòng 933-1053 |
| C10 | Dựng đối số lệnh: `exec --json [--search] [--dangerously-bypass-approvals-and-sandbox] [--model X] [-c ...] (resume <id> - \| -)` | `codex-args.ts:54-75` |
| C11 | Khởi chạy tiến trình `codex`, đưa prompt qua stdin. Stdout được đẩy liên tục vào log run. Monitor kiểm tra treo | dòng 1103-1183 |
| C12 | Trong tiến trình Codex: đọc `config.toml` và `auth.json`, nạp thread cũ nếu resume, gọi OpenAI, chạy lệnh và công cụ MCP, ghi `rollout-*.jsonl`, in sự kiện JSONL, rồi thoát | ngoài repo (chương trình Codex) |
| C13 | Đọc JSONL: `thread.started` cho `thread_id`, `item.completed` cho câu trả lời, `turn.completed` cho usage | `parse.ts:30-105` |
| C14 | Dựng kết quả: `sessionParams = { sessionId: thread_id, cwd, ... }`, mã lỗi, usage | dòng 1270-1380 |
| C15 | Nếu resume báo "unknown thread/session" thì chạy lại một lần không có `resume` | dòng 1383-1397 |

## 6. Quy trình đường ACP (một request)

Số dòng là của `packages/adapter-utils/src/acpx-engine/execute.ts`, trừ khi ghi khác.

| Bước | Việc | Vị trí |
|---|---|---|
| A1 | Chọn engine: không có `engine` hoặc `engine: "acp"` thì gọi `executeCodexAcp`. Nếu khởi động lỗi và `engine` không đặt rõ thì lùi về CLI | `codex-local/.../execute.ts:108`, `457-467` |
| A2 | Dựng cấu hình ACP: `agent: codex`, `mode: persistent`, `permissionMode: approve-all`, `nonInteractivePermissions: deny`, `warmHandleIdleMs: 0`, rồi gọi engine ACPX | `acp.ts:135-160`, `acp.ts:343-358`; engine bắt đầu ở dòng 2860 |
| A3 | `buildRuntime`: xác định `cwd` | dòng 1366-1430 |
| A4 | Dựng env: cùng nhóm biến `PAPERCLIP_*`, env của cấu hình, `PAPERCLIP_API_KEY` = JWT của run | dòng 1462-1526 |
| A5 | Riêng Codex: đặt `CODEX_CONFIG` (model, effort, fast mode) và `INITIAL_AGENT_MODE` | dòng 1536-1571 |
| A6 | Chuẩn bị `CODEX_HOME` và skills, ghi `CODEX_HOME` vào env | dòng 1597-1616; `prepareCodexSkillRuntime` ở dòng 923 |
| A7 | Dựng danh sách MCP server truyền qua giao thức ACP (không ghi vào `config.toml`) | dòng 1439-1450 |
| A8 | Tìm lệnh `codex-acp` | dòng 1636-1643; `acp.ts:435` |
| A9 | Tính fingerprint (agent, lệnh, cwd, mode, quyền, model, skills, MCP, secret, env cấu hình) và `sessionKey = paperclip:<company>:<agent>:<taskKey>:<fingerprint>` | dòng 1684-1716 |
| A10 | Kiểm tra session cũ có tương thích không: fingerprint, sessionKey, agent, mode, cwd, đích từ xa | dòng 2901-2904; `isCompatibleSession` ở dòng 1174 |
| A11 | Tạo runtime từ `acpx/runtime` (`createAcpRuntime`). Không tương thích thì ghi log "does not match ... starting fresh" | dòng 2939-2952 |
| A12 | `runtime.ensureSession({ sessionKey, cwd, mode, resumeSessionId, sessionOptions: { env } })`: acpx khởi chạy `codex-acp`, bắt tay ACP, rồi mở phiên mới (`session/new`) hoặc nạp phiên cũ (`session/load`) | dòng 2969-2976 |
| A13 | Nạp phiên cũ lỗi thì thử lại bằng phiên mới | dòng 2987-3015 |
| A14 | Đặt cấu hình phiên qua giao thức (model, mức suy nghĩ...) | `applySessionConfigOptions` dòng 3057; `setConfigOption` dòng 2079 |
| A15 | Dựng prompt (giống CLI, thêm hướng dẫn skills) và ghi dòng `acpx.session` vào log | dòng 3101-3115 |
| A16 | `runtime.startTurn({ text: prompt, requestId: runId, timeoutMs, signal })` | dòng 3173-3183 |
| A17 | Nhận từng sự kiện và ghi thành `acpx.text_delta`, `acpx.tool_call`, `acpx.status`... vào log | dòng 3184-3191; `emitRuntimeEvent` ở dòng 2311 |
| A18 | Trong `codex-acp` và Codex: gọi OpenAI, chạy công cụ, trả lời yêu cầu quyền theo `permissionMode`, ghi `rollout-*.jsonl` | ngoài repo |
| A19 | Tính usage (trạng thái trước và sau lượt). Agent dùng gateway LiteLLM thì đọc spend log theo tag của run | dòng 3195-3244 |
| A20 | Đóng runtime. Chỉ giữ ấm nếu `warmIdleMs > 0` (mặc định 0, nên luôn đóng) | dòng 3245-3303 |
| A21 | Dựng `sessionParams = { sessionKey, acpSessionId, runtimeSessionName, configFingerprint, cwd, mode, ... }` | `buildSessionParams` dòng 1188 |

## 7. Phần chung: sau khi adapter trả kết quả

| Bước | Việc | Vị trí (`heartbeat.ts`) |
|---|---|---|
| E1 | Xác định kết quả run (thành công, lỗi, hết giờ) | dòng 13817-13827 |
| E2 | Tính trạng thái session kế tiếp từ `sessionParams`/`clearSession` của adapter | `resolveNextSessionState`, dòng 13829 (định nghĩa 5332) |
| E3 | Lưu hoặc xóa session của task trong `agent_task_sessions` | `upsertTaskSession`, dòng 14105 |
| E4 | Cập nhật `agent_runtime_state`, chi phí, `heartbeat_runs.session_id_after` | nhiều chỗ quanh dòng 13940-14120 |

Bộ mã hóa session của `codex_local` tự nhận hai kiểu: có `sessionId` thì là kiểu CLI, không có thì dùng bộ mã hóa ACPX (`codex-local/src/server/index.ts:50`).

## 8. Resume: vì sao CLI kiểm tra ít còn ACP kiểm tra nhiều

| | CLI | ACP |
|---|---|---|
| Thứ được lưu giữa các run | `thread_id` + `cwd` | `acpSessionId`, `sessionKey`, `configFingerprint`, `cwd`, `mode`... |
| Điều kiện resume ở adapter | `cwd` trùng, đích chạy trùng | Fingerprint, `sessionKey`, agent, mode, `cwd`, đích từ xa đều trùng |
| Lý do | Mọi cấu hình được truyền lại ở mỗi lần gọi `codex exec`, nên đổi cấu hình thì lần sau tự áp dụng | Cấu hình gắn với phiên lúc mở. Code ghi: thay đổi env phải làm mới phiên "so the next launch picks up the latest env" |
| Env khi resume | Luôn mới (tiến trình mới) | Đã quan sát thấy env của run cũ bị giữ lại (mục 9) |

Lưu ý: điều kiện ở server (S5) áp dụng cho **cả hai** engine, trước khi tới adapter.

## 9. Liên hệ với các lỗi đã quan sát ngày 2026-10-22

| Vấn đề | Thuộc | Bằng chứng |
|---|---|---|
| Fingerprint server băm `issues.updated_at`, giá trị đổi ở mỗi comment, nên mọi run đều bỏ session | Server, cả hai engine | `heartbeat.ts:12441`; `result_json.configFreshness.changedCategories = ["workspaceConfig"]` |
| Fingerprint server băm model profile chỉ được yêu cầu mà không áp dụng (`cheap`, `applied: null`) | Server, cả hai engine | Run `source_scoped_recovery_action` có `modelProfile: "cheap"` |
| Fingerprint ACPX băm cả thư mục scratch (mỗi run một đường dẫn `mkdtemp`) | Chỉ ACP | Log: `config fingerprint changed: adapterEnvHash`; `run-scratch.ts:90`, `heartbeat.ts:12944` |
| Sau khi resume được, agent vẫn dùng `PAPERCLIP_API_KEY`/`PAPERCLIP_RUN_ID` của run đầu, nên API báo `Issue run ownership conflict` và `agent_jwt_run_id_mismatch` | Chỉ ACP | File `rollout-...-01a16258-abac-....jsonl`, lượt 2-5 |

Các bản sửa thử nghiệm cho ba dòng đầu đã được hoàn tác. Code hiện tại là bản gốc.

## 10. Cấu hình của agent Codex hiện tại (`4919b15f...`)

| Khóa | Giá trị | Có hiệu lực ở |
|---|---|---|
| `engine` | (không đặt) nên dùng `acp` | |
| `env.CODEX_HOME` | `C:\Users\LAPTOP HP\.codex` | Cả hai. Ngoài cây quản lý của Paperclip nên được coi là tự quản lý |
| `env.INITIAL_AGENT_MODE` | `read-only` | Chỉ ACP (chế độ khởi đầu của `codex-acp`) |
| `dangerouslyBypassApprovalsAndSandbox` | `true` | Chỉ CLI (thêm `--dangerously-bypass-approvals-and-sandbox`). Engine ACPX không đọc khóa này |
| `search` | `true` | CLI (thêm `--search`). Không thấy engine ACPX đọc khóa này |
| `fastMode`, `model` | `true`, `gpt-5.6-luna` | Cả hai |

Hệ quả: đổi sang `engine: "cli"` mà giữ nguyên cấu hình thì agent chuyển từ chế độ `read-only` sang **tắt sandbox và phê duyệt**.

## 11. Chưa kiểm chứng

- Đã xác nhận: `codex-acp` khởi chạy `codex app-server` và truyền env (`spawnEnv`) **lúc khởi chạy**. Chưa xác nhận: tiến trình `codex-acp`/`app-server` có được dùng lại qua nhiều run hay không.
- Cơ chế giữ env cũ ở đường ACP. Nghi vấn là tiến trình bền vững của `acpx` ở chế độ `persistent` (thời gian chờ mặc định `DEFAULT_TTL_MS = 300000`, trong `acpx/dist/cli.js`), giữ sống `codex-acp` và `codex app-server` kèm env của run đầu. Chưa xác nhận thư viện `acpx/runtime` dùng cơ chế đó.
- `codex exec resume` có nạp được thread do đường ACP tạo trong `~/.codex` hay không.
- Thời gian khởi động thực tế của hai đường. Code ACP ghi bước `acp.handshake` khoảng 7 giây, chưa đo đường CLI.
