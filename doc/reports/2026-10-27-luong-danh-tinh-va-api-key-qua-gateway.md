# Luồng danh tính run và API key từ Paperclip qua gateway sang MCP server: trước và sau thay đổi

Ngày: 27/10/2026. Nhánh: `feat/gateway-run-token`. Kế hoạch gốc và nhật ký làm việc: [doc/plans/2026-10-27-truyen-danh-tinh-run-cho-mcp-server.md](../plans/2026-10-27-truyen-danh-tinh-run-cho-mcp-server.md).

## 1. Tóm tắt

- **Trước:** MCP server `paperclip` (`paperclip-mcp/src/paperclip_mcp/server.py`) chạy bằng stdio. Codex khởi động một tiến trình server cho mỗi run và đưa biến môi trường của run (API key, run id, task id, company id) vào tiến trình đó. Không có phân quyền, policy hay audit của Paperclip.
- **Lần thử đầu qua gateway (sáng 27/10):** server chạy HTTP, một tiến trình dùng chung, gọi qua mục Apps. Gateway không gửi danh tính và không gửi key, nên tool lỗi thiếu `PAPERCLIP_TASK_ID`, `PAPERCLIP_COMPANY_ID` và lỗi 401.
- **Sau:** gateway gắn danh tính của run vào header (`x-paperclip-*`) và tự tạo **JWT của chính run đó** để gắn vào `Authorization`. Server đọc các header này cho từng request. Kết quả: tool qua gateway hoạt động như stdio (đúng agent, đúng run), và có thêm phân quyền, policy, audit. Đã chạy thật thành công với task KHT-121.

## 2. Các thành phần

| Thành phần | Là gì | Ở đâu |
|---|---|---|
| Heartbeat | Phần của server Paperclip chạy một run: chuẩn bị prompt, biến môi trường, token, rồi gọi adapter | `server/src/services/heartbeat.ts` |
| Adapter acpx | Cầu nối giữa Paperclip và Codex, khởi động Codex và truyền danh sách MCP server | `packages/adapter-utils/src/acpx-engine/execute.ts` |
| Codex (codex-acp) | Tác tử chạy model, gọi tool | Tiến trình riêng |
| Gateway | Cổng trung gian trong server Paperclip cho tool MCP: kiểm tra quyền, ghi audit, ghép header, chuyển lời gọi | `server/src/services/tool-gateway.ts` |
| MCP server `paperclip` | Server Python có các tool như `finish_task_and_reply_telegram`, `list_issues`. Gọi ngược API Paperclip | `paperclip-mcp/src/paperclip_mcp/server.py` |
| API Paperclip | REST `/api/...`, kiểm tra key, ghi activity | `server/src/routes`, `server/src/middleware/auth.ts` |
| n8n | Nhận webhook để gửi tin Telegram | Ngoài Paperclip |

Ba khái niệm hay nhầm:

| Khái niệm | Ý nghĩa | Sống bao lâu |
|---|---|---|
| **JWT của run** (`PAPERCLIP_API_KEY`) | API key thật để gọi API Paperclip dưới tên agent và run. Tạo bằng `createLocalAgentJwt` | Hết hạn sau 1 giờ (`PAPERCLIP_AGENT_JWT_TTL_SECONDS`) |
| **Token gateway** (`pcgw_...`) | "Vé" để Codex vào gateway. **Không** gọi được API Paperclip | Mỗi run một vé, hết hạn sau 1 giờ, bị thu hồi khi run kết thúc |
| **Session gateway** | Object tạm trong bộ nhớ, gateway dựng ra từ vé ở mỗi lần gọi tool, chứa run, agent, công ty, task | Một lần gọi tool |

## 3. Trước thay đổi

### 3.1. Cách cũ: stdio (`[mcp_servers.paperclip]` trong `~/.codex/config.toml`)

```
 Heartbeat (lúc run bắt đầu)
   │  createLocalAgentJwt(agent, company, adapter, run, user, scope)  → JWT của run
   │  đặt env cho Codex: PAPERCLIP_API_KEY=<JWT>, PAPERCLIP_RUN_ID, PAPERCLIP_TASK_ID,
   │                     PAPERCLIP_COMPANY_ID, PAPERCLIP_API_URL, ...
   ▼
 Codex (tiến trình của run)
   │  đọc config.toml: [mcp_servers.paperclip] command = python server.py --transport stdio
   │                   env_vars = [PAPERCLIP_API_KEY, PAPERCLIP_RUN_ID, PAPERCLIP_TASK_ID, ...]
   │  khởi động server.py làm tiến trình con, chép các env trên sang
   ▼
 server.py (một tiến trình riêng cho run này)
   │  os.environ["PAPERCLIP_API_KEY"], ["PAPERCLIP_TASK_ID"], ...
   ▼
 API Paperclip  ← Authorization: Bearer <JWT của run>, X-Paperclip-Run-Id: <run>
```

- **Danh tính đúng**, vì mỗi run có tiến trình server riêng với env riêng.
- **Không có** phân quyền theo agent, policy, duyệt, audit của Paperclip. Codex gọi thẳng server, Paperclip không thấy lời gọi.
- Mỗi run phải khởi động lại tiến trình Python (khoảng 2,4 đến 3 giây nạp `server.py`, làm chậm lúc khởi động run khoảng 0,9 giây).
- Agent thấy đủ 38 tool, khoảng 6 200 token schema trong mỗi lượt gọi model.

### 3.2. Lần thử đầu qua gateway (sáng 27/10, chưa sửa code)

Đã gỡ `[mcp_servers.paperclip]`, chạy `server.py --transport streamable-http` ở `127.0.0.1:9011`, khai báo trong Apps.

```
 Heartbeat
   │  tạo JWT của run → env PAPERCLIP_API_KEY ... cho Codex   (như cũ, nhưng không còn ai chép sang server)
   │  tạo token gateway pcgw_… cho run
   ▼
 Codex ──Authorization: Bearer pcgw_…──▶ Gateway
                                           │  dựng session từ token (biết run, agent, task)
                                           │  bỏ header nhạy cảm của Codex (authorization, x-paperclip-*)
                                           │  headerPolicy rỗng  → không gắn danh tính
                                           │  credentialRefs rỗng → không gắn Authorization
                                           ▼
                                   server.py (một tiến trình chung cho mọi run)
                                           │  os.environ: không có key, run, task, company của run nào
                                           ▼
                                   ✗ "PAPERCLIP_TASK_ID / COMPANY_ID is not configured"
                                   ✗ 401 "Missing PAPERCLIP_API_KEY"
```

Lý do gốc:

- Gateway **biết** danh tính (trong session) nhưng chỉ gửi khi connection bật `headerPolicy.metadata.forward`. Chưa bật, và giao diện không có chỗ bật.
- Gateway **không có** JWT của run: bảng `tool_gateway_sessions` và token gateway không chứa nó, và gateway cố ý không chuyển credential của agent cho server ngoài. Cách duy nhất có sẵn là `credentialRefs`, tức một key cố định dùng chung cho mọi agent.
- `server.py` chỉ đọc `os.environ`, vốn chỉ đúng khi mỗi run có tiến trình riêng.

## 4. Đã thay đổi những gì

| Commit | Phần | Thay đổi |
|---|---|---|
| `6b4311e59` | MCP server | `server.py` đọc API key, run id, task id, company id từ header `Authorization` và `x-paperclip-*` **của request đang xử lý**, thiếu thì mới dùng env. Thêm `_header()`, `_task_id()`. Không lưu vào biến toàn cục, nên nhiều run gọi cùng lúc không lẫn nhau. Chạy stdio thì hành vi không đổi |
| `8a9e6048b` | Gateway | Tuỳ chọn mới `headerPolicy.runCredential`. Khi bật, mỗi lần gọi tool gateway gọi `createLocalAgentJwt` cho run của session và gắn `Authorization: Bearer <JWT>`. Có các chốt chặn (mục 6). Tách `localAgentJwtScopeForIssue` để heartbeat và gateway tạo key giống nhau. Thêm `isLoopbackHttpEndpoint` |
| `6ab6078f8` | Giao diện | Tab Advanced của app có hai công tắc, mặc định tắt: **Send run identity** (ghi `headerPolicy.metadata.forward`) và **Send run token** (ghi `headerPolicy.runCredential`). Gộp vào `config` hiện có vì API thay cả `config` |
| `19378f7ca`, `8bad749a7` | Tài liệu | Mục mới trong `doc/MCP-ACCESS-GOVERNANCE.md`, file kế hoạch |
| `5108822ea` | MCP server | `finish_task_and_reply_telegram` trả `ok: false` khi đóng task hoặc ghi comment thất bại (trước đây vẫn báo thành công) |
| `a7e6a5ca4` | Script | `pnpm build` (server) và `pnpm test:run` chạy được trên Windows |

Không đổi schema DB: cấu hình nằm trong trường `config` (JSON) có sẵn của connection.

## 5. Sau thay đổi

### 5.1. Sơ đồ tổng quát

```
 ┌───────────────────────── Paperclip server ─────────────────────────────────────────┐
 │                                                                                     │
 │  [A] Board bật 2 công tắc (một lần)                                                 │
 │      tool_connections.config.headerPolicy = {                                       │
 │        metadata: { forward: [run_id, issue_id, company_id, agent_id] },             │
 │        runCredential: true }                                                        │
 │                                                                                     │
 │  [B] Heartbeat bắt đầu run R của agent X, task T                                    │
 │      ├─ JWT của run → env PAPERCLIP_API_KEY cho Codex (như trước, dùng cho shell)   │
 │      └─ token gateway pcgw_… (subject = run R, hết hạn 1 giờ)                       │
 │             │                                                                       │
 └─────────────┼───────────────────────────────────────────────────────────────────────┘
               ▼
 [C] Adapter acpx → Codex: mcpServers = [{ url: .../gateways/<id>/mcp,
                                           Authorization: Bearer pcgw_… }]
               │
               │  model gọi tool, ví dụ finish_task_and_reply_telegram
               ▼
 ┌───────────────────────── Gateway (trong Paperclip) ────────────────────────────────┐
 │ [D] Tra token trong DB → dựng session: run R, agent X, công ty C, task T           │
 │     kiểm tra: token còn hạn, chưa thu hồi; run R đang chạy, đúng agent, công ty     │
 │ [E] Profile + policy: agent X có được dùng tool này không                          │
 │ [F] Ghép header gửi đi                                                              │
 │     • bỏ authorization, x-paperclip-* do Codex gửi lên (chống giả mạo)              │
 │     • metadata.forward  → x-paperclip-run-id: R, -issue-id: T, -company-id: C,      │
 │                           -agent-id: X        (lấy từ session, tức từ DB)           │
 │     • runCredential     → kiểm tra (mục 6) → createLocalAgentJwt(X, C, adapter,     │
 │                           R, user, scope) → Authorization: Bearer <JWT của R>       │
 │ [G] Ghi audit, activity (chỉ tên header, credential bị che)                         │
 └──────────────┬──────────────────────────────────────────────────────────────────────┘
                │  POST http://127.0.0.1:9011/mcp
                ▼
 ┌───────────────────────── server.py (tiến trình chung) ─────────────────────────────┐
 │ [H] _api_key()        ← header Authorization   (thiếu → env → rỗng)                │
 │     _run_id()         ← x-paperclip-run-id     (thiếu → env → claim trong JWT)      │
 │     _task_id()        ← x-paperclip-issue-id   (thiếu → env PAPERCLIP_TASK_ID)      │
 │     _get_company_id() ← x-paperclip-company-id (thiếu → env → claim trong JWT)      │
 └──────────────┬──────────────────────────────────────────────────────────────────────┘
                │  Authorization: Bearer <JWT của R>, X-Paperclip-Run-Id: R
                ▼
 [I] API Paperclip: xác thực JWT (đúng instance, đúng công ty), kiểm tra run id khớp
     claim trong JWT → hành động được ghi dưới tên agent X, run R
                │
                ▼
 [J] Kết thúc run R: thu hồi mọi token gateway của R. Gateway không tạo JWT cho R nữa.
```

### 5.2. Mỗi giá trị lấy từ đâu

| Giá trị | Nguồn gốc | Đi tới server.py bằng | Server đọc ở |
|---|---|---|---|
| API key | Gateway gọi `createLocalAgentJwt` mỗi lần gọi tool, dùng agent, công ty, `adapterType` (bảng `agents`), run, `responsibleUserId` (bảng `heartbeat_runs`), `keyScope` (theo `workMode` của task) | `Authorization: Bearer` | `_api_key()` |
| Run id | `subject_id` của token gateway | `x-paperclip-run-id` | `_run_id()` |
| Task id | `heartbeat_runs.context_snapshot.issueId` của run | `x-paperclip-issue-id` | `_task_id()` |
| Company id | Gateway và run | `x-paperclip-company-id` | `_get_company_id()` |
| Agent id | Run | `x-paperclip-agent-id` | (chưa dùng) |
| Địa chỉ API | Env của tiến trình server (`PAPERCLIP_BASE_URL`, mặc định `http://localhost:3100/api`) | Không qua gateway | `_get_base_url()` |

Codex vẫn nhận env `PAPERCLIP_API_KEY` và các biến khác như trước, để agent dùng trong lệnh shell nếu cần. Nhưng các env đó **không còn đi tới** MCP server, vì server không còn là tiến trình con của Codex.

### 5.3. Thứ tự một lần gọi `finish_task_and_reply_telegram`

1. Model gọi tool. Codex gửi `tools/call` tới gateway, kèm token gateway.
2. Gateway dựng session, kiểm tra quyền, tạo JWT của run, ghép header, gửi sang `server.py`.
3. `server.py` lấy task id từ header, gọi `GET /issues/{id}` bằng JWT để đọc description và `telegram_context`.
4. Nếu có `chat_id`: gửi webhook n8n để gửi tin Telegram (bước 3/5).
5. `PATCH /issues/{id}` đổi trạng thái (bước 4/5), `POST /issues/{id}/comments` ghi comment (bước 5/5), cả hai bằng JWT và `X-Paperclip-Run-Id`.
6. API ghi comment dưới tên agent và run. Vì đúng run, Paperclip không sinh run bàn giao mới.
7. Nếu bước 4 hoặc 5 lỗi: tool trả `ok: false`, `status: "partial_failure"` và dặn agent không gọi lại (tránh gửi trùng Telegram).

### 5.4. Kết quả chạy thật

Task KHT-121, agent Codex, run `ef5f6e96`, ngày 27/10 10:24 UTC: `list_agents` và các lời gọi API đều 200 hoặc 201, `finish_task` đủ 5 bước, task `done`, comment do agent Codex viết với `created_by_run_id = ef5f6e96`, không có run bàn giao. Telegram bị bỏ qua đúng vì task tạo tay.

## 6. Chốt chặn an toàn

| Điều kiện | Nếu vi phạm | `reasonCode` |
|---|---|---|
| Địa chỉ server phải trên máy này (`localhost`, `127.0.0.0/8`, `::1`, xét theo tên, không tra DNS) | Từ chối, không gửi gì | `run_credential_requires_loopback` |
| Không đồng thời có key `Authorization` lưu trong `credentialRefs` | Từ chối | `run_credential_conflict` |
| Phải có run gọi tool | Từ chối (ví dụ tab Test) | `run_credential_requires_run` |
| Run phải khớp agent và công ty của session | Từ chối | `run_credential_run_mismatch` |
| Run phải đang chạy | Từ chối | `run_credential_run_inactive` |
| Phải có JWT secret (`PAPERCLIP_AGENT_JWT_SECRET` hoặc `BETTER_AUTH_SECRET`) | Từ chối, không âm thầm gửi thiếu key | `run_credential_unavailable` |

Ngoài ra:

- Header `authorization` và `x-paperclip-*` do Codex gửi lên luôn bị gateway bỏ, nên model không chèn được danh tính hay key khác.
- JWT không bao giờ được ghi vào activity, audit, `headerSummary` (có test kiểm tra).
- Hai công tắc mặc định tắt. Server MCP của bên thứ ba không nhận gì trừ khi board bật cho riêng connection đó.

## 7. So sánh nhanh

| | Stdio (trước) | Gateway, lần thử đầu | Gateway (sau) |
|---|---|---|---|
| Danh tính run đúng | Có | Không | Có |
| Key theo run | Có (env) | Không | Có (gateway tạo) |
| Phân quyền theo agent, policy, duyệt | Không | Có | Có |
| Audit lời gọi tool | Không | Có | Có |
| Tiến trình server | Mỗi run một | Một, dùng chung | Một, dùng chung |
| Lọc bớt tool để giảm token | Phải tự viết | Có (profile) | Có (profile) |

## 8. Hạn chế và việc còn lại

- Khi bật **Send run token**, tab Test của app và lời gọi được duyệt **sau khi run đã kết thúc** sẽ bị từ chối, vì không còn run đang chạy.
- Server nghe ở `127.0.0.1`: mọi tiến trình trên máy đều gọi được và tự khai header. Chấp nhận cho máy cá nhân, không mở ra mạng.
- Mỗi run còn được cấp một token gateway thứ hai (`Managed ...`, ghi vào khối `PAPERCLIP MANAGED MCP` của `config.toml`) nhưng không được dùng. Nên xem riêng.
- Chưa thử một task đến từ Telegram (đường webhook n8n) qua gateway.
- Giai đoạn tiếp: làm mới danh mục tool, tạo profile 7 tool cho Front-Desk (giảm khoảng 4 600 token mỗi lượt), đặt policy cho tool ghi.

## 9. Tham chiếu code

| Nội dung | Vị trí |
|---|---|
| Tạo JWT của run, phạm vi key | `server/src/agent-auth-jwt.ts` (`createLocalAgentJwt`, `localAgentJwtScopeForIssue`) |
| Heartbeat tạo JWT, token gateway, thu hồi | `server/src/services/heartbeat.ts` (`buildPaperclipRuntimeMcpServers`, `revokeHeartbeatRunGatewayTokens`) |
| Truyền endpoint và token gateway cho Codex | `packages/adapter-utils/src/acpx-engine/execute.ts` (khoảng dòng 1441-1452) |
| Session từ token, kiểm tra run | `server/src/services/tool-gateway.ts` (`namedGatewaySessionFromBearer`, `resolveRunContext`) |
| Đọc cấu hình, tạo JWT, ghép header, gửi | `server/src/services/tool-gateway.ts` (`readHeaderPolicy`, `resolveRunCredentialHeaders`, `metadataHeadersForSession`, `buildRemoteHeaders`, `executeRemoteHttpTool`) |
| Kiểm tra địa chỉ trên máy | `server/src/services/remote-http-endpoint-guard.ts` (`isLoopbackHttpEndpoint`) |
| Công tắc giao diện | `ui/src/pages/apps/app-detail/AdvancedPanel.tsx` (`RunIdentitySection`), `ui/src/pages/apps/run-identity.ts` |
| MCP server đọc header | `paperclip-mcp/src/paperclip_mcp/server.py` (`_header`, `_api_key`, `_run_id`, `_task_id`, `_get_company_id`) |
| Test | `server/src/__tests__/tool-gateway.test.ts` (`headerPolicy.runCredential`), `server/src/__tests__/remote-http-endpoint-guard.test.ts`, `ui/src/pages/apps/run-identity.test.ts`, `paperclip-mcp/tests/test_header_identity.py`, `paperclip-mcp/tests/test_finish_steps.py` |
| Hướng dẫn vận hành | `doc/MCP-ACCESS-GOVERNANCE.md`, mục "Run identity and run token for your own local MCP server" |
