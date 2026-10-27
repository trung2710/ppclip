# Truyền danh tính run cho MCP server `paperclip` và giảm token của tool

Ngày lập: 2026-10-27
Trạng thái: **kế hoạch, đã chọn hướng 2 (gateway)**, chưa triển khai. Nối tiếp [2026-10-20-trien-khai-mcp-tool-tren-paperclip-apps.md](./2026-10-20-trien-khai-mcp-tool-tren-paperclip-apps.md), thay phần "API key dùng chung" ở mục 4.3 của file đó.

## 1. Bài toán

MCP server `paperclip` (`paperclip-mcp/src/paperclip_mcp/server.py`) cần bốn thứ của **đúng run đang gọi tool**: API key, run id, task id, company id.

- Chạy **stdio** (cách cũ): Codex khởi động một tiến trình server cho mỗi run và chuyển biến môi trường của run (`PAPERCLIP_API_KEY`, ...) qua `env_vars`. Đúng danh tính, nhưng không có profile, policy, audit của Paperclip.
- Chạy **HTTP qua mục Apps** (đang thử): một tiến trình chung cho mọi run, Codex gọi qua gateway của Paperclip. Có profile, policy, audit, nhưng server không còn biến môi trường của từng run.

Yêu cầu: API key mà server dùng phải là **key do harness tạo cho chính run đó** (JWT theo run), không phải một key cố định dùng chung.

Mục tiêu phụ: giảm token gửi lên model mỗi lượt (bài toán chi phí đang theo dõi).

## 2. Hiện trạng (2026-10-27)

| Việc | Kết quả |
|---|---|
| Gỡ `[mcp_servers.paperclip]` khỏi `~/.codex/config.toml`, chạy server HTTP ở `127.0.0.1:9011/mcp` | Đã làm. Gateway gọi tới server được (`POST /mcp 200`), agent gọi được tool |
| Gọi tool cần danh tính qua gateway | **Lỗi**: thiếu `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_TASK_ID`, `PAPERCLIP_API_KEY` (log 14:16 ngày 27/10) |
| `server.py` đọc danh tính từ header `x-paperclip-*` và `Authorization` của từng request, thiếu thì dùng env | Đã làm trên nhánh `feat/mcp-header-identity`, **chưa commit**. 107 test pass, có test HTTP thật với 3 request chồng nhau |
| Gửi Telegram thật qua agent Front-Desk | **Đang hỏng** vì đã gỡ cấu hình stdio. `finish_task_and_reply_telegram` không đóng được task |

> Việc cần làm ngay, độc lập với mọi lựa chọn bên dưới: nếu agent Front-Desk đang phục vụ người dùng thật, khôi phục `[mcp_servers.paperclip]` từ bản sao lưu cho tới khi đường mới chạy được.

## 3. Sự thật đã kiểm chứng trong code

| Điều | Bằng chứng |
|---|---|
| Key của run là JWT tạo lúc run bắt đầu, từ `agentId, companyId, adapterType, runId, responsibleUserId, keyScope` | `server/src/agent-auth-jwt.ts:116` (`createLocalAgentJwt`), gọi ở `server/src/services/heartbeat.ts:13537` |
| JWT ký bằng khoá dẫn xuất theo instance và công ty, nên token của công ty A không dùng được cho công ty B | `agent-auth-jwt.ts:84` |
| Gateway **không lưu** JWT của run. Session chỉ có `companyId, agentId, runId, issueId, projectId` và hash của token gateway | Bảng `tool_gateway_sessions` (`packages/db/src/schema`), `createSession` ở `tool-gateway.ts:4791` |
| Gateway **chủ động bỏ** header nhạy cảm của phía gọi: `authorization`, mọi `x-paperclip-*`, và tên khớp `auth/cookie/secret/session/token/api-key` | `tool-gateway.ts:289-302`, `:2268` |
| Header gửi sang server ngoài gồm: header được phép đi qua, header tĩnh, header metadata (`x-paperclip-<khoá>`), header credential từ secret | `buildRemoteHeaders`, `tool-gateway.ts:2232-2323` |
| Giá trị metadata lấy từ session trong DB, không từ Codex hay model, nên agent không giả mạo được | `metadataHeadersForSession`, `tool-gateway.ts:2214-2230` |
| `runId` của session chỉ có khi token gateway thuộc loại `heartbeat_run`. Token loại khác thì không có `x-paperclip-run-id` | `tool-gateway.ts:3596-3600` |
| `issueId` lấy từ `contextSnapshot` của run, có kiểm tra run đúng công ty, đúng agent, đang chạy | `resolveRunContext`, `tool-gateway.ts:1036-1072` |
| `headerPolicy` của connection nằm trong `connection.config.headerPolicy`. Tab Advanced của app **không có** ô nhập nó | `tool-gateway.ts:2131`, `ui/src/pages/apps/app-detail/AdvancedPanel.tsx` |
| `connection.config` là bản ghi tự do nhưng bị lọc bởi `rejectSensitiveConfigKeys` | `packages/shared/src/validators/tool-access.ts` (`toolTransportConfigSchema`) |
| Mỗi lời gọi tool ghi activity `tool_gateway.call_completed` kèm `headerSummary.metadataHeaderNames` (chỉ tên, credential bị che) | `server/src/__tests__/tool-gateway.test.ts:1697-1717` |
| API Paperclip từ chối nếu `X-Paperclip-Run-Id` khác `run_id` trong JWT | `server/src/middleware/auth.ts:293` |
| FastMCP 4.0.2 ẩn được tool bằng `mcp.disable(names=...)`, tool bị ẩn không xuất hiện trong `tools/list` | Đã chạy thử: 38 còn 37 |

Luồng đầy đủ từ lúc bật công tắc tới lúc server MCP đọc được định danh, kèm code và cách kiểm tra từng bước: xem **mục 12**.

## 4. Số đo token của tool

Đo bằng `tools/list` của server (tên, mô tả, schema tham số), ngày 27/10:

| Tập tool | Ký tự | Token ước lượng (ký tự / 3.5) |
|---|---|---|
| Cả 38 tool | 21 692 | khoảng 6 200 |
| 7 tool Front-Desk cần (`finish_task_and_reply_telegram`, `list_issues`, `get_issue`, `list_agents`, `get_recent_tasks_by_chat`, `delegate_contract_review`, `delegate_task_to_agent`) | 5 640 | khoảng 1 600 |

Phần schema tool nằm trong prefix của **mọi** request trong một run. Bớt 31 tool không dùng sẽ tiết kiệm khoảng **4 600 token mỗi lượt gọi model**, nhân với số lượt trong run. Đây là khoản lớn hơn nhiều so với phần trùng lặp description trong prompt (khoảng 700 đến 900 token). Ước lượng là thô: tiếng Việt thường tốn token hơn tiếng Anh, nên con số thật có thể cao hơn.

Lọc tool làm được ở cả hai đường: với stdio bằng `mcp.disable(...)`, với gateway bằng profile (gateway chỉ trả tool mà quyết định của profile và policy cho phép hoặc cần duyệt, `tool-gateway.ts:1863`). Vì đã chọn gateway, profile ở giai đoạn 3 vừa là nhóm quyền vừa là cách giảm token.

## 5. Các phương án đã cân nhắc

| | Phương án | Key theo run | Profile, policy, audit | Đổi lõi Paperclip | Kết luận |
|---|---|---|---|---|---|
| **S** | Giữ stdio, server tự ẩn tool theo danh sách của từng agent | Có | Không | Không | **Làm ngay** (hướng 1) |
| **A** | Gateway + một key cố định trong `credentialRefs` | Không | Có | Không | Chỉ để thử đường ống. Mọi agent chung quyền của key. Nếu là board key thì hành động nhiều khả năng đứng tên board, không phải agent (chưa kiểm chứng) |
| **B** | Gateway + server giữ bảng `agent_id → key dài hạn của agent` | Không (theo agent) | Có | Không | Phải quản lý nhiều key dài hạn. Không đúng yêu cầu "key theo run" |
| **D** | Gateway tự tạo JWT của run lúc gọi tool, gắn vào `Authorization` cho connection được bật | **Có** | Có | Có, vừa phải | **Chọn nếu cần quản trị** (hướng 2) |
| **E** | Gateway chỉ gửi `gateway_session_id`, server đổi lấy JWT của run qua một endpoint mới, chứng minh bằng secret của connection | Có | Có | Có, nhiều hơn D | Thêm endpoint và một vòng gọi. Cuối cùng server vẫn cầm JWT như D, nên không đáng thêm độ phức tạp |
| **F** | Codex tự gửi `PAPERCLIP_API_KEY` qua một header tự đặt tên | Có | Có | Không | **Loại**. Muốn qua gateway phải đặt tên né bộ lọc header nhạy cảm, tức lách rào chắn bảo mật có chủ đích |

Vì sao key theo run (D) tốt hơn key chung (A, B), ngoài chuyện quyền: với JWT của run, API nhận đúng agent và đúng run như khi chạy stdio. Comment do `finish_task_and_reply_telegram` ghi được tính là của run, nên không sinh run bàn giao mới. Ranh giới công ty được giữ bằng chữ ký JWT.

## 6. Quyết định

**2026-10-27: dùng gateway (hướng 2, phương án D).** Lý do: cần nhóm quyền theo agent (profile, binding), policy và audit, là tính năng Paperclip đã có sẵn. Thực hiện theo các giai đoạn ở mục 8, dừng lại sau mỗi giai đoạn.

Hướng 1 ở mục 7 chỉ còn là **phương án tạm**: dùng nếu cần Telegram chạy lại trong lúc xây hướng 2, hoặc nếu hướng 2 bị chặn ở giai đoạn 0. Thay đổi đọc header trong `server.py` (nhánh `feat/mcp-header-identity`) dùng được cho cả hai, vì không có header thì server vẫn đọc env như cũ.

Lưu ý khi chạy song song: khối `PAPERCLIP MANAGED MCP` do Paperclip ghi vào `~/.codex/config.toml` (CODEX_HOME của Front-Desk). Nếu khôi phục `[mcp_servers.paperclip]` mà khối gateway vẫn còn, Front-Desk sẽ thấy hai bản của cùng một tool. Muốn thử gateway trong lúc Front-Desk chạy stdio, nên thử bằng agent có CODEX_HOME riêng (ví dụ DW VT), và kiểm tra bỏ app khỏi profile của Front-Desk có làm Paperclip gỡ khối đó không (chưa kiểm chứng).

## 7. Phương án tạm: stdio + lọc tool theo agent

1. Khôi phục `[mcp_servers.paperclip]` trong `~/.codex/config.toml` từ bản sao lưu.
2. Trong `server.py`: đọc biến `PAPERCLIP_MCP_TOOLS` (danh sách tên tool, phân cách bằng dấu phẩy). Khi có giá trị, gọi `mcp.disable(...)` cho mọi tool không nằm trong danh sách trước khi `mcp.run(...)`. Không đặt thì giữ nguyên 38 tool. Tên lạ trong danh sách thì ghi cảnh báo, không dừng server.
   - Chỉ áp dụng cho stdio. Ở chế độ HTTP, việc ẩn tool có hiệu lực cho cả tiến trình chung, nên ở đó dùng profile của gateway.
3. Thêm `PAPERCLIP_MCP_TOOLS` vào `env_vars` của `[mcp_servers.paperclip]`, rồi đặt giá trị trong `adapterConfig.env` của từng agent (Front-Desk: 7 tool ở mục 4). Cần kiểm tra biến môi trường của agent có đi tới tiến trình Codex rồi tới tiến trình MCP như kỳ vọng.
4. Test: danh sách lọc đúng, tên lạ bị bỏ qua có cảnh báo, không đặt biến thì đủ 38 tool.
5. Đo lại: so cột Input và Cached của một run Front-Desk trước và sau.

## 8. Hướng 2: gateway với JWT theo run

### Giai đoạn 0. Xác nhận đường ống (không sửa lõi)

Đã tra DB (chỉ đọc) ngày 27/10:

- Connection `0bcc4463-...`: `config = { url: "http://127.0.0.1:9011/mcp", quarantineNewEntries: true }`, **chưa có** `headerPolicy`, `credential_refs = []`. Đây chính là lý do server không nhận được danh tính. `health_status = error / fetch failed` là trạng thái cũ, từ lúc server chưa chạy.
- Gateway `4a4ec069-...` cấp **mỗi run hai token**, cả hai loại `heartbeat_run` (`subject_id` là run id), hết hạn sau 1 giờ và bị thu hồi khi run kết thúc. Vậy `x-paperclip-run-id` sẽ có trong header.
- Hai token trong khối `PAPERCLIP MANAGED MCP` của `~/.codex/config.toml` là của run `181c8577-...` ngày 22/10, **đã bị thu hồi**. Khối này là dư thừa từ lần trước. Run hiện tại nhận token mới qua đường khác (danh sách `mcpServers` truyền cho codex-acp).
- Profile `app:0bcc4463-...` tồn tại, `default_action = deny`.

Các bước:

1. Bật công tắc **Send run identity** ở tab Advanced của app (đã thêm ngày 27/10, xem giai đoạn 1). Công tắc ghi `config.headerPolicy.metadata.forward = ["run_id", "issue_id", "company_id", "agent_id"]`. Cách cũ không cần giao diện: gọi API `PATCH` connection. Gửi kèm đủ các khoá đang có (`url`, `quarantineNewEntries`) phòng khi `PATCH` thay cả `config`. Xác nhận API chấp nhận trường này qua `rejectSensitiveConfigKeys`.
2. Không cần key tạm: mục tiêu giai đoạn này là xem header có đến hay không. Tool sẽ báo 401 vì thiếu key, đó là kết quả đã biết.
3. Gọi một tool chỉ đọc (`list_issues`) qua agent thử.
4. Kiểm tra `headerSummary` trong activity `tool_gateway.call_completed` và log của server: có đủ `x-paperclip-run-id`, `x-paperclip-issue-id` không. Thiếu run id nghĩa là Codex đang dùng token không thuộc loại `heartbeat_run`. Phải làm rõ Codex dùng mục nào trong khối `PAPERCLIP MANAGED MCP` (`paperclip-mcp-server` hay `runtime-paperclip-mcp-server-0bcc4463`).
5. Ghi lại tên tool mà agent nhìn thấy qua gateway.

**Điều kiện đi tiếp:** có đủ run id và issue id trong header. Nếu không, dừng và xem lại cách cấp token cho run trước khi sửa lõi.

**Kết quả giai đoạn 0 (27/10, 09:48 UTC): đạt.** Activity `tool_gateway.call_completed` ghi đủ bốn header `x-paperclip-*`. Log server: `finish_task` đọc được Task ID từ header, chỉ còn lỗi 401 thiếu key. Phát hiện thêm: `finish_task_and_reply_telegram` vẫn in "HOÀN TẤT THÀNH CÔNG" dù bước 4 và 5 lỗi 401, cần sửa riêng.

### Giai đoạn 1. Gateway tạo JWT của run (nhánh riêng `feat/gateway-run-token`)

**Trạng thái (27/10): đã code xong, chưa commit, chưa chạy thật.** Tóm tắt:

- `server/src/services/tool-gateway.ts`: thêm `runCredential` vào `HeaderPolicyConfig`, hàm `resolveRunCredentialHeaders` tạo JWT theo run trong `executeRemoteHttpTool` (áp dụng cho cả ba đường gọi: gọi thường, tab Test, lời gọi đã duyệt). Cấu hình là giá trị bật/tắt `headerPolicy.runCredential: true`, luôn gửi ở `Authorization: Bearer`.
- `server/src/services/remote-http-endpoint-guard.ts`: `isLoopbackHttpEndpoint`, xét tên máy theo chữ, không tra DNS.
- `server/src/agent-auth-jwt.ts`: `localAgentJwtScopeForIssue`, dùng chung cho heartbeat và gateway.
- UI: công tắc "Send run token" trong tab Advanced, chỉ bật được với địa chỉ trên máy và khi không có key `Authorization` lưu sẵn.
- Tài liệu: mục "Run identity and run token for your own local MCP server" trong `doc/MCP-ACCESS-GOVERNANCE.md`.
- Hạn chế đã biết: tab Test và lời gọi được duyệt sau khi run đã kết thúc sẽ bị từ chối khi `runCredential` bật, vì không còn run đang chạy.

**Chạy thật (27/10, 10:24 UTC): đạt.** Task KHT-121 (tạo tay, agent Codex, run `ef5f6e96`), connection bật cả `metadata.forward` và `runCredential`:

- Server MCP gọi API Paperclip bằng JWT của run: `list_agents`, `GET /issues`, `PATCH /issues` (200), `POST /comments` (201). Hết lỗi 401.
- `finish_task_and_reply_telegram` đủ 5 bước. Bước 2 bỏ qua Telegram là đúng vì task không đến từ Telegram.
- DB: task `done`; comment do **agent Codex** viết, `created_by_run_id` đúng run `ef5f6e96`; không sinh run bàn giao nào sau đó.
- Còn phải thử: một task đến từ Telegram để kiểm tra cả đường gửi webhook.

| Việc | Chi tiết |
|---|---|
| Cấu hình | Tuỳ chọn mới trong `config.headerPolicy`, ví dụ `runCredential: { header: "Authorization", prefix: "Bearer " }`, **mặc định tắt**. Chọn tên khoá không bị `rejectSensitiveConfigKeys` chặn và kiểm tra bằng test |
| Tạo token | Trong `executeRemoteHttpTool` (`tool-gateway.ts:3004`): khi bật, đọc `adapterType` (bảng `agents`) và `responsibleUserId` (bảng `heartbeat_runs`), gọi `createLocalAgentJwt(...)` cho `session.runId`. Tạo mới mỗi lần gọi, không lưu |
| Phạm vi key | Tách cách chọn `keyScope` (`skill_test` hay `standard`) ở `heartbeat.ts:13533` thành hàm dùng chung cho run và gateway, tránh hai nơi lệch nhau |
| Chặn | Từ chối nếu endpoint không phải loopback (`127.0.0.0/8`, `::1`, `localhost`). Từ chối nếu `session.runId` rỗng. Từ chối nếu thiếu JWT secret, không âm thầm gửi request thiếu key. Mỗi trường hợp có `reasonCode` riêng |
| Va chạm | Từ chối cấu hình có cả `runCredential` và `credentialRefs` cùng nhắm một header |
| Không rò rỉ | Token không được xuất hiện trong activity, audit, `headerSummary`, log lỗi. Chỉ ghi tên header |
| Đồng bộ các tầng | Kiểu dữ liệu trong `packages/shared` nếu thêm kiểu cho `headerPolicy`. Không đổi schema DB vì cấu hình nằm trong `config` |
| Giao diện | **Đã làm (27/10):** công tắc "Send run identity" trong tab Advanced (`ui/src/pages/apps/app-detail/AdvancedPanel.tsx`, hàm xử lý cấu hình ở `ui/src/pages/apps/run-identity.ts`). Mặc định tắt, chỉ hiện cho connection `mcp_remote`, gộp vào `config` hiện có vì API thay cả `config`, báo khác nhau cho địa chỉ trên máy và ngoài máy. **Còn lại:** công tắc "Send run token" đặt cạnh nó, làm cùng phần sửa gateway |
| Tài liệu | Thêm mục vào `doc/MCP-ACCESS-GOVERNANCE.md`: tuỳ chọn mới, vì sao chỉ cho loopback, rủi ro. Cập nhật file kế hoạch này |

Test, theo mẫu `server/src/__tests__/tool-gateway.test.ts:1640-1720`:

1. Bật cờ: server giả nhận `Authorization` là JWT qua được `verifyLocalAgentJwt`, có đúng `run_id`, `sub` (agent), `company_id`.
2. Tắt cờ: không có header đó.
3. Endpoint không phải loopback: bị từ chối với đúng `reasonCode`.
4. Session không có run id: bị từ chối.
5. Run của issue `skill_test`: token mang `key_scope` tương ứng.
6. Toàn bộ activity và audit đã lưu không chứa chuỗi token.
7. Header của phía gọi tên `authorization` vẫn bị bỏ như trước.

Kiểm tra trước khi coi là xong (AGENTS.md mục 7): `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`. PR theo `.github/PULL_REQUEST_TEMPLATE.md`.

### Giai đoạn 2. Server MCP

- Commit nhánh `feat/mcp-header-identity` (đã có code đọc header).
- Bỏ `credentialRefs` tạm của giai đoạn 0, bật `runCredential`.
- Thử tích hợp thật: `finish_task_and_reply_telegram` chạy đủ 5 bước, comment tính cho đúng run, không sinh run bàn giao.

### Giai đoạn 3. Phân quyền và đưa vào dùng

1. Tạo profile `front-desk.telegram` (mặc định `deny`, 7 tool ở mục 4) và gắn vào agent Front-Desk. Kiểm tra bằng `GET /api/companies/{companyId}/tools/profiles/effective/agents/{agentId}`.
2. Xem mức rủi ro của từng tool sau khi làm mới danh mục. Tool `write` mặc định cần duyệt, nên đặt policy `allow` cho tool agent tự động cần, nếu không run sẽ treo chờ duyệt.
3. Chạy task Telegram thật. Nếu tên tool qua gateway khác tên trong AGENTS.md (đã thấy Gemini gọi nhầm `mcp__paperclip__...`), sửa AGENTS.md.
4. So token, thời gian và số lượt gọi với hướng 1.
5. Gỡ cấu hình stdio chỉ khi hướng 2 ổn định.

## 9. Rủi ro và điều chưa biết

| Điều | Ảnh hưởng | Cách làm rõ |
|---|---|---|
| Codex dùng token gateway loại nào | Không có run id thì hướng 2 không áp dụng được | **Đã rõ (27/10):** token loại `heartbeat_run`, có run id |
| Tên tool qua gateway | Phải sửa AGENTS.md, model có thể gọi nhầm | Giai đoạn 0, bước 5 |
| Đưa JWT ra ngoài tiến trình Paperclip | Ai sửa được URL connection sẽ lấy được token | Chỉ cho loopback, mặc định tắt, chỉ board bật |
| Hạn dùng JWT (mặc định 1 giờ) | Tool chạy lâu vẫn ổn vì token tạo mới mỗi lần gọi | Test |
| Bộ lọc `rejectSensitiveConfigKeys` | Có thể chặn tên khoá cấu hình mới | Test ở giai đoạn 1 |
| Biến môi trường của agent có tới tiến trình MCP stdio | Hướng 1 bước 3 không có tác dụng | Thử với một agent |
| Server HTTP nghe ở loopback | Mọi tiến trình trên máy gọi được và tự khai header | Chấp nhận cho máy cá nhân, không mở ra mạng |
| Ba tool định nghĩa hai lần trong `server.py` (`get_issue_document`, `upsert_issue_document`, `upload_issue_attachment`) | Bản sau đè bản trước, cảnh báo lúc khởi động | Dọn riêng, ngoài phạm vi kế hoạch này |

## 10. Cần quyết định

- [x] Có cần profile, policy, audit không: **có**, dùng gateway (2026-10-27).
- [ ] Trong lúc xây: khôi phục stdio cho Front-Desk (phương án tạm), hay chấp nhận Telegram ngừng.
- [ ] Agent dùng để thử gateway (đề xuất DW VT, có CODEX_HOME riêng).
- [ ] Đồng ý giới hạn loopback, và tên khoá cấu hình `runCredential`.
- [x] Key tạm cho giai đoạn 0: không cần (xem giai đoạn 0, bước 2).

## 11. Tham chiếu

| Nội dung | Vị trí |
|---|---|
| Tạo JWT của run | `server/src/agent-auth-jwt.ts`, `server/src/services/heartbeat.ts:13533-13557` |
| Gateway: session, header, gọi server ngoài | `server/src/services/tool-gateway.ts` (`createSession`, `namedGatewaySessionFromBearer`, `resolveRunContext`, `buildRemoteHeaders`, `executeRemoteHttpTool`) |
| Kiểm tra endpoint | `server/src/services/remote-http-endpoint-guard.ts` |
| Validator connection | `packages/shared/src/validators/tool-access.ts` |
| Test mẫu cho header | `server/src/__tests__/tool-gateway.test.ts:1640-1720` |
| Server MCP, đọc danh tính | `paperclip-mcp/src/paperclip_mcp/server.py` (`_header`, `_api_key`, `_run_id`, `_task_id`, `_get_company_id`) |
| Test danh tính | `paperclip-mcp/tests/test_header_identity.py`, `paperclip-mcp/tests/test_identity_resolution.py` |
| Hướng dẫn quản trị MCP | `doc/MCP-ACCESS-GOVERNANCE.md` |
| Công tắc "Send run identity" | `ui/src/pages/apps/app-detail/AdvancedPanel.tsx` (`RunIdentitySection`), `ui/src/pages/apps/run-identity.ts` |
| Cấp và thu hồi token gateway theo run | `server/src/services/heartbeat.ts` (`buildPaperclipRuntimeMcpServers` :2171, `createManagedMcpRunConfig` :2334, `revokeHeartbeatRunGatewayTokens` :2154) |
| Chuyển endpoint và token gateway cho Codex | `packages/adapter-utils/src/acpx-engine/execute.ts:1441-1452` |

## 12. Luồng truyền định danh từ run sang MCP server

Phần này mô tả điều xảy ra khi công tắc **Send run identity** đang bật, từ lúc run bắt đầu tới lúc `server.py` đọc được run id. Cái được truyền là **bốn định danh** (run, task, company, agent), **không có API key**. Mọi số dòng là theo code ngày 27/10.

### 12.1. Sơ đồ

```
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ [1] Board bật công tắc (UI, một lần)                                     │
 │     AdvancedPanel → PATCH /api/tool-connections/:id                      │
 │     DB tool_connections.config.headerPolicy.metadata.forward =           │
 │        ["run_id", "issue_id", "company_id", "agent_id"]                  │
 └──────────────────────────────────────────────────────────────────────────┘
                                     │
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ [2] Run bắt đầu (heartbeat, mỗi run)                                      │
 │     buildPaperclipRuntimeMcpServers → token pcgw_… loại heartbeat_run,   │
 │     subject_id = run id, hết hạn sau 1 giờ                                │
 │     (createManagedMcpRunConfig cũng tạo token thứ hai, không được dùng)   │
 └──────────────────────────────────────────────────────────────────────────┘
                                     │  url gateway + token
                                     ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ [3] Adapter acpx → codex-acp: mcpServers kiểu http,                       │
 │     header Authorization: Bearer pcgw_…                                   │
 └──────────────────────────────────────────────────────────────────────────┘
                                     │  model gọi tool
                                     ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ [4] Gateway nhận lời gọi, dựng session từ token (tra DB):                 │
 │     runId     ← token.subject_id                                          │
 │     issueId   ← heartbeat_runs.context_snapshot.issueId                   │
 │     agentId, companyId ← run / gateway                                    │
 │     + kiểm tra: run đúng công ty, đúng agent, còn đang chạy               │
 │     + profile, policy quyết định tool có được gọi không                   │
 └──────────────────────────────────────────────────────────────────────────┘
                                     │
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ [5] Gateway ghép header gửi đi                                            │
 │     readHeaderPolicy(connection)  ← đọc forward ở bước [1]                │
 │     metadataHeadersForSession     ← lấy giá trị ở bước [4]                │
 │     ⇒ x-paperclip-run-id / -issue-id / -company-id / -agent-id            │
 │     credentialRefs (đang rỗng)    ⇒ không có Authorization                │
 └──────────────────────────────────────────────────────────────────────────┘
                                     │  POST http://127.0.0.1:9011/mcp
                                     ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ [6] server.py: _header() đọc header của request đang xử lý                │
 │     _run_id(), _task_id(), _get_company_id() ưu tiên header, thiếu → env  │
 │     _api_key(): không có Authorization, không có env → rỗng               │
 └──────────────────────────────────────────────────────────────────────────┘
                                     │  tool gọi ngược API Paperclip
                                     ▼
 ┌──────────────────────────────────────────────────────────────────────────┐
 │ [7] API Paperclip: thiếu Bearer → 401 (đúng như dự kiến ở giai đoạn 0)    │
 └──────────────────────────────────────────────────────────────────────────┘

 Khi run kết thúc: revokeHeartbeatRunGatewayTokens thu hồi mọi token của run.
```

### 12.2. Từng bước

| Bước | Diễn ra gì | Giá trị lấy từ đâu | Code |
|---|---|---|---|
| 1 | Công tắc gộp bốn khoá vào `config` hiện có rồi gửi `PATCH`. Cần gộp vì API thay cả `config`; nếu không, `url` bị mất | Board bấm công tắc | `ui/src/pages/apps/run-identity.ts` (`configWithRunIdentityForwarding`), `ui/src/pages/apps/AppDetail.tsx:221`, `server/src/services/tool-access.ts:5805` |
| 2 | Mỗi connection mà profile của agent cho phép thì được cấp một token gateway mới, gắn với run | Run id, agent | `server/src/services/heartbeat.ts:2171` và `:2270-2289` (gọi ở `:13739`) |
| 3 | Adapter đưa danh sách server cho codex-acp, kèm header `Authorization: Bearer <token gateway>`. Token này chỉ để vào gateway, không phải API key của Paperclip | Kết quả bước 2 | `packages/adapter-utils/src/acpx-engine/execute.ts:1441-1452` |
| 4 | Gateway tra token, kiểm tra hạn, thu hồi, trạng thái run, rồi dựng session | DB: `tool_mcp_gateway_tokens`, `heartbeat_runs` | `server/src/services/tool-gateway.ts:3540` (`namedGatewaySessionFromBearer`), `:3596-3600`, `resolveRunContext` `:1036-1072` |
| 5 | Ghép header: được phép đi qua, tĩnh, metadata, credential. Header nhạy cảm từ phía gọi (`authorization`, `x-paperclip-*`) luôn bị bỏ | Cấu hình bước 1 và session bước 4 | `tool-gateway.ts:2131` (`readHeaderPolicy`), `:2214-2230` (`metadataHeadersForSession`), `:2232-2323` (`buildRemoteHeaders`), `:3015-3043` (gửi `fetch`) |
| 6 | Server đọc header theo từng request, không lưu toàn cục, nên các run chạy đồng thời không lẫn nhau | Header bước 5 | `paperclip-mcp/src/paperclip_mcp/server.py` (`_header`, `_run_id`, `_task_id`, `_get_company_id`, `_api_key`) |
| 7 | Tool gọi API Paperclip với `X-Paperclip-Run-Id` nhưng thiếu `Authorization`, nên nhận 401 | | `server.py` (`_request`) |

Đoạn code quyết định ở bước 5 (`tool-gateway.ts:2214-2230`):

```ts
const values = {
  company_id: session.companyId,
  agent_id: session.agentId,
  issue_id: session.issueId,
  project_id: session.projectId,
  run_id: session.runId,
  gateway_session_id: session.id,
  correlation_id: randomUUID(),
};
for (const key of policy.metadataHeaders) {          // danh sách forward ở bước 1
  const value = values[key];
  if (value) headers[`x-paperclip-${key.replace(/_/g, "-")}`] = value;
}
```

Đoạn code ở bước 6 (`server.py`):

```python
def _header(name: str) -> str:
    try:
        return get_http_headers(include_all=True).get(name, "").strip()
    except Exception:
        return ""

def _run_id() -> str:
    from_request = _header(HEADER_RUN_ID) or os.environ.get("PAPERCLIP_RUN_ID", "").strip()
    ...
```

### 12.3. Hai token mỗi run

Mỗi run được cấp hai token gateway, cả hai loại `heartbeat_run`:

| Token (tên trong DB) | Tạo ở | Đi tới Codex bằng | Có được dùng |
|---|---|---|---|
| `Run <run> Paperclip MCP Server` | `buildPaperclipRuntimeMcpServers` | Danh sách `mcpServers` của codex-acp (bước 3) | **Có** (có `last_used_at`) |
| `Managed <agent> <run>` | `createManagedMcpRunConfig` | Khối `PAPERCLIP MANAGED MCP` ghi vào `config.toml` | **Không** (10 run gần nhất đều không có `last_used_at`) |

Số liệu tra DB ngày 27/10. Token thứ hai không gây lỗi, nhưng làm `config.toml` chứa token cũ đã bị thu hồi (hai token trong `~/.codex/config.toml` là của run ngày 22/10). Nếu Codex có lúc nạp cả khối đó thì agent sẽ thấy cùng một bộ tool hai lần. Nên kiểm tra riêng, ngoài phạm vi kế hoạch này.

### 12.4. Cách kiểm tra từng bước khi chạy thật

| Bước | Thấy gì là đúng | Ở đâu |
|---|---|---|
| 1 | `config.headerPolicy.metadata.forward` có đủ bốn khoá và `url` vẫn còn | Tab Advanced (công tắc bật) hoặc tra bảng `tool_connections` |
| 2 | Có token mới tên `Run <run> ...` với `subject_id` là run id | Bảng `tool_mcp_gateway_tokens` |
| 4 | Token đó có `last_used_at` | Bảng `tool_mcp_gateway_tokens` |
| 5 | `headerSummary.metadataHeaderNames` có bốn header `x-paperclip-*` | Activity `tool_gateway.call_completed` (tab Activity của app) |
| 6 | Log server không còn "PAPERCLIP_TASK_ID / COMPANY_ID is not configured" | Cửa sổ chạy `server.py` |
| 7 | Lỗi đổi thành 401 thiếu key | Cửa sổ chạy `server.py`, transcript của run |

### 12.5. Tính chất an toàn

- Định danh lấy từ DB (token, run, gateway), không từ thứ Codex hay model gửi lên. Agent không tự khai run id hay task id khác được.
- Token gateway gắn với một run, hết hạn sau 1 giờ, bị thu hồi khi run kết thúc, chỉ cho `tools/list` và `tools/call`.
- Gateway bỏ mọi header nhạy cảm từ phía gọi, nên token gateway không bị chuyển tiếp sang server MCP.
- Công tắc mặc định tắt. Server MCP bên thứ ba không nhận định danh trừ khi board bật cho riêng connection đó.
- Server MCP tin các header này với điều kiện chỉ gateway gọi được nó. Server đang nghe ở `127.0.0.1`, nên mọi tiến trình trên máy cũng gọi được và tự khai header. Chấp nhận được cho máy cá nhân.

### 12.6. Giai đoạn 1 thay đổi gì trong luồng này

Chỉ bước 5 thay đổi: khi connection bật `runCredential`, gateway gọi `createLocalAgentJwt(agentId, companyId, adapterType, runId, responsibleUserId, keyScope)` cho `session.runId` và gắn kết quả vào `Authorization: Bearer <JWT của run>`. Bước 6 không cần sửa, vì `_api_key()` đã đọc `Authorization`. Bước 7 hết 401: API nhận đúng agent và run, đồng thời kiểm tra `X-Paperclip-Run-Id` khớp `run_id` trong JWT (`server/src/middleware/auth.ts:293`).
