# Triển khai MCP tool trên Paperclip qua mục Apps

Ngày lập: 2026-10-20
Trạng thái: **kế hoạch, chưa triển khai**. Tài liệu này ghi lại kết quả tìm hiểu và các bước định làm để không bỏ sót.

Cập nhật 2026-10-27: đã thử và đã sửa bước 1. Cách truyền API key (mục 4.3) và các phương án thay thế xem [2026-10-27-truyen-danh-tinh-run-cho-mcp-server.md](./2026-10-27-truyen-danh-tinh-run-cho-mcp-server.md).

## 1. Mục tiêu

Hiện tại MCP server `paperclip` (`paperclip-mcp/src/paperclip_mcp/server.py`) được Codex khởi động như tiến trình con (stdio) theo mục `[mcp_servers.paperclip]` trong `~/.codex/config.toml`. Mỗi run Codex tạo một tiến trình mới và truyền biến môi trường qua `env_vars`.

Muốn thử một cách khác:

- Chạy **một MCP server cố định bên ngoài** (HTTP).
- Khai báo nó trong mục **Apps** của Paperclip (màn hình "Paperclip MCP Server").
- Dùng cơ chế **Profile và Binding** của Paperclip để phân quyền agent nào được dùng tool nào.
- Không dùng `[mcp_servers.paperclip]` trong `config.toml` nữa.
- Kiểm tra agent có gọi được tool qua đường này hay không.

## 2. Hiện trạng của app trên giao diện

Màn hình `Apps / Paperclip MCP Server / Setup` hiện:

- Trạng thái **Needs attention**, nội dung **"This app needs reconnecting: fetch failed"**.
- **35 actions available**: đây là danh mục tool đã lưu từ lần kết nối trước. Server hiện có 38 tool.
- Công tắc **"Agents can use this app"** đang bật.

`fetch failed` nghĩa là Paperclip không kết nối được tới URL của server ngoài. Nguyên nhân có thể là server chưa chạy, hoặc URL hay cổng trong connection sai. Cần mở tab **Advanced** của app để xem URL đang cấu hình (chưa kiểm tra).

Connection id của app này, thấy trong log server: `0bcc4463-5d92-4da4-a443-210bcd4597d7`.

## 3. Cách tính năng Apps hoạt động (đã đọc code và doc)

Nguồn: `doc/MCP-ACCESS-GOVERNANCE.md`, `server/src/services/tool-gateway.ts`, `server/src/services/heartbeat.ts`, `packages/adapter-utils/src/acpx-engine/execute.ts`.

### 3.1. Luồng gọi tool

```
Agent (Codex) ----> Gateway của Paperclip ----> MCP server ngoài của bạn
   token riêng        chọn tool theo profile       (URL trong connection,
   của run            kiểm tra policy, ghi audit    loại mcp_remote)
```

- Codex **không gọi thẳng** server ngoài. Mỗi run, Paperclip tự tạo danh sách endpoint gateway cho các connection mà agent được phép dùng, bằng hàm `buildPaperclipRuntimeMcpServers` (`server/src/services/heartbeat.ts`, khoảng dòng 2171).
- Danh sách đó được truyền cho codex-acp dạng `mcpServers` kiểu `http`, kèm header `Authorization: Bearer <token của run>` (`packages/adapter-utils/src/acpx-engine/execute.ts`, khoảng dòng 1445).
- Vì vậy mục `[mcp_servers.paperclip]` trong `config.toml` **không cần** khi dùng đường này. Nên bỏ nó đi, nếu không agent có hai đường tới cùng một tool.
- Điều kiện để connection được đưa vào run: connection đang `active`, `enabled`, loại `mcp_remote`, và nằm trong tập connection mà profile hiệu lực của agent cho phép.

### 3.2. Phân quyền

| Khái niệm | Vai trò |
|---|---|
| Application | Nhóm logic (ví dụ "Paperclip MCP Server") |
| Connection | Một endpoint MCP, loại `remote_http` (nên dùng) hoặc `local_stdio` (bị hạn chế) |
| Catalog entry | Một tool khám phá được trên connection, có mức rủi ro `read`, `write`, `destructive` và trạng thái `active`, `quarantined`, `disabled` |
| Profile | Gói quy tắc allow/deny chọn tool nào agent **thấy** |
| Binding | Gắn profile vào phạm vi: `company`, `agent`, `project`, `routine`, `issue` (hẹp nhất thắng) |
| Policy | Quy tắc **tại lúc gọi**: `allow`, `block`, `require_approval`, `rate_limit`, `trust_rule`. Chặn luôn thắng cho phép |

Một câu để nhớ: **profile nói agent có thấy tool không, policy nói lời gọi cụ thể này có được chạy ngay không.**

Lưu ý về mức rủi ro: tool `write` mặc định cần duyệt, tool `destructive` bị cách ly (quarantined) ngay lần đầu thấy cho tới khi người vận hành bật lại. Tool trong `server.py` như `finish_task_and_reply_telegram`, `delete_issue`, `approve` có thể bị phân loại là `write` hoặc `destructive`, cần xem lại danh mục sau khi làm mới.

## 4. Vấn đề danh tính (run id, task id, company id)

### 4.1. Vì sao có vấn đề

Cách hiện tại dựa vào `os.environ` của tiến trình MCP (`_api_key()`, `_run_id()`, `_get_company_id()`, `PAPERCLIP_TASK_ID`). Server chạy sẵn chỉ có **một bộ biến môi trường** của lúc nó khởi động, dùng chung cho mọi agent và mọi run, nên cách này sai ngay từ run thứ hai.

`env` và `env_vars` trong `config.toml` chỉ có nghĩa với MCP server kiểu stdio, vì lúc đó Codex là bên tạo ra tiến trình. Với server HTTP chạy sẵn, Codex chỉ kết nối tới, không có gì để gắn biến môi trường.

### 4.2. Cách giải quyết có sẵn: header metadata của gateway

Gateway có thể chuyển thông tin của run sang server ngoài qua header HTTP, nhưng **mặc định không bật**. Phải khai báo trong cấu hình connection (`tool-gateway.ts`, hàm `readHeaderPolicy`, khoảng dòng 2131):

```json
"headerPolicy": {
  "metadata": { "forward": ["run_id", "issue_id", "company_id", "agent_id"] }
}
```

Khi bật, mỗi lời gọi tới server ngoài có thêm:

| Header | Giá trị | Dùng thay cho |
|---|---|---|
| `x-paperclip-run-id` | Run đang chạy | `PAPERCLIP_RUN_ID` |
| `x-paperclip-issue-id` | Task đang xử lý | `PAPERCLIP_TASK_ID` |
| `x-paperclip-company-id` | Công ty | `PAPERCLIP_COMPANY_ID` |
| `x-paperclip-agent-id` | Agent | (mới) |

Các giá trị cho phép trong danh sách `forward`: `company_id`, `agent_id`, `issue_id`, `project_id`, `run_id`, `gateway_session_id`, `correlation_id`.

### 4.3. API key để gọi ngược lại API Paperclip

Gateway **không** chuyển JWT của agent sang server ngoài. Server ngoài cần một thông tin xác thực riêng, lấy từ `credentialRefs` của connection (lưu trong secret, gateway tự gắn vào header khi gọi). Ví dụ:

```json
"credentialRefs": [
  { "name": "Authorization", "secretId": "<id secret>", "placement": "header", "key": "Authorization", "prefix": "Bearer " }
]
```

Hệ quả:

- Server gọi API Paperclip bằng **một key cố định** (board key hoặc key riêng), không phải key của từng agent.
- Để comment và hành động vẫn được tính cho đúng run, server gửi kèm `X-Paperclip-Run-Id` lấy từ header `x-paperclip-run-id` (board key kèm header này đặt được `runId` cho hành động, như đã dùng khi comment trong tool `finish_task_and_reply_telegram`).
- Cần cân nhắc quyền của key này, vì mọi agent đi qua gateway sẽ dùng chung nó.

## 5. Kế hoạch triển khai

Mỗi bước nhỏ, có thể quay lại.

### Bước 1: Sửa server để lấy danh tính từ header khi chạy HTTP

- Trong `paperclip-mcp/src/paperclip_mcp/server.py`, thêm lớp trừu tượng lấy danh tính: ưu tiên header `x-paperclip-*` của request đang xử lý (FastMCP có hàm đọc header của request HTTP), nếu không có thì dùng `os.environ` như hiện nay cho chế độ stdio.
- Cần thay: `_api_key()`, `_run_id()`, `_get_company_id()`, và chỗ đọc `PAPERCLIP_TASK_ID` trong `finish_task_and_reply_telegram`.
- API key trong chế độ HTTP lấy từ header `Authorization` do gateway gắn từ `credentialRefs`.
- Tất cả đọc danh tính phải theo từng request, **không** lưu vào biến toàn cục (server dùng chung nhiều run, lưu toàn cục sẽ lẫn dữ liệu giữa các run).
- Chạy HTTP ở `127.0.0.1:9011`, đường dẫn mặc định `/mcp` (`--transport streamable-http`).
- Thêm test cho: đọc đúng header, không lẫn giữa hai request đồng thời, chế độ stdio không đổi hành vi.

### Bước 2: Sửa connection trên giao diện

- Tab **Advanced** của app: kiểm tra URL, sửa thành `http://127.0.0.1:9011/mcp`.
- Thêm `headerPolicy.metadata.forward` như mục 4.2.
- Tạo secret chứa key rồi khai báo `credentialRefs` như mục 4.3.
- Bấm **Check & reconnect**, rồi làm mới danh mục (catalog refresh). Kỳ vọng thấy 38 tool.
- Kiểm tra mức rủi ro (`read`, `write`, `destructive`) của từng tool, bật lại tool nào bị `quarantined`.

### Bước 3: Phân quyền cho agent

- Tạo profile (ví dụ `front-desk.telegram`), mặc định `deny`, chỉ `include` các tool cần: `finish_task_and_reply_telegram`, `list_issues`, `get_issue`, `list_agents`, `get_recent_tasks_by_chat`, `delegate_contract_review`, `delegate_task_to_agent`.
- Gắn (bind) profile vào agent Front-Desk.
- Xem trước tool hiệu lực bằng API `GET /api/companies/{companyId}/tools/profiles/effective/agents/{agentId}`.
- Với `finish_task_and_reply_telegram` (ghi, gửi Telegram), cân nhắc policy: cho phép thẳng, hay `require_approval`. Agent chạy tự động nên cho phép thẳng, nếu không run sẽ treo chờ duyệt.

### Bước 4: Gỡ cấu hình cũ

- Sao lưu `~/.codex/config.toml`.
- Xoá hoặc comment mục `[mcp_servers.paperclip]` (dòng 34 đến 42 hiện tại).
- Khoan xoá `env_vars` ở các nơi khác (cấu hình seed của codex-home) cho tới khi bước 5 đạt.

### Bước 5: Chạy thử và kiểm tra

- Giao một task (ví dụ tạo báo cáo gửi Telegram), bật cờ debug `PAPERCLIP_ACPX_DEBUG_TOOL_EVENTS_DIR` nếu cần.
- Kiểm tra:
  1. Transcript có thấy tool, tên tool là gì.
  2. Log server nhận đúng `x-paperclip-run-id`, `x-paperclip-issue-id`.
  3. `finish_task_and_reply_telegram` chạy đủ các bước, comment được tính cho đúng run, không sinh run bàn giao mới.
  4. Mục **Activity** của app có ghi lại lời gọi (audit).
  5. So thời gian `init` tới dòng thinking đầu tiên và thời gian mỗi lần gọi tool với cách cũ.

### Bước 6: Quyết định

- Nếu tốt: giữ đường này cho agent Front-Desk, cập nhật tài liệu.
- Nếu có vấn đề: bật lại `[mcp_servers.paperclip]` từ bản sao lưu, server HTTP vẫn giữ để thử tiếp.

## 6. Điều chưa biết, phải thử mới rõ

| Câu hỏi | Vì sao quan trọng |
|---|---|
| Tên tool agent nhìn thấy là gì (có tiền tố của gateway, hay kiểu "on-demand tools" chỉ lộ vài tool trung gian)? | AGENTS.md hiện ghi tên tool trần (`finish_task_and_reply_telegram`). Nếu khác phải sửa AGENTS.md. Code gateway có chế độ `onDemandTools` (`isOnDemandRemoteTool`) |
| Có tiết kiệm được thời gian khởi động không? | Đã thử bỏ hẳn MCP server (xem mục 7): chỉ bớt khoảng 0.9 giây. Gateway còn thêm một chặng, mỗi lời gọi có thể chậm hơn một chút |
| FastMCP 4.0.2 đọc header của request thế nào, có an toàn khi nhiều run gọi đồng thời không? | Quyết định cách viết bước 1 |
| Gateway có chấp nhận tool chạy lâu (upload, webhook, khoảng vài giây tới hơn chục giây) không? | Có giới hạn thời gian trong gateway (`AbortController`), cần xem giá trị |
| Tool bị phân loại `write`/`destructive` thì xử lý ra sao với agent chạy tự động? | Có thể treo chờ duyệt hoặc bị quarantine |
| Guardian còn duyệt mỗi lời gọi tool qua gateway không? | Có thể thêm 2 đến 5 giây mỗi lần như hiện tại |

## 7. Số đo thời gian khởi động đã có (để so sánh sau này)

Đo ngày 2026-10-20 trên máy này, agent Front-Desk:

| Phép đo | Kết quả |
|---|---|
| Từ bắt đầu run tới `init` | 1.1 đến 3.1 giây (thường 1.2 đến 2.0) |
| Từ `init` tới dòng thinking đầu tiên (14 run) | 3.8 đến 6.0 giây, trung vị khoảng 4.7 |
| Nạp `server.py` (import) | khoảng 2.4 đến 3.0 giây (đo trực tiếp bằng cách khởi động server và bắt tay qua stdio) |
| Phiên **có** MCP: gửi yêu cầu đầu tiên / model ra chữ đầu | +3.05 giây / +4.43 giây |
| Phiên **không** MCP (đã xoá mục trong config.toml): gửi yêu cầu đầu tiên / model ra chữ đầu | +2.16 giây / +3.49 giây |

Kết luận đã rút ra: MCP server chỉ làm chậm khoảng 0.9 giây (Codex khởi động nó song song với việc khác), phần còn lại gồm kết nối websocket tới chatgpt.com (khoảng 0.8 giây), chuẩn bị yêu cầu (khoảng 1.2 giây) và độ trễ model tới chữ đầu (khoảng 1.3 giây).

## 8. Việc cần bạn xác nhận trước khi làm

- [ ] Làm bản thử với agent **Front-Desk** (`4919b15f-2218-475c-ae83-76bd6ab43a2e`).
- [ ] URL đang cấu hình trong tab **Advanced** của app là gì.
- [ ] Key dùng cho `credentialRefs`: dùng board key hiện có, hay tạo key riêng cho server này.
- [ ] Chấp nhận có thể phải sửa AGENTS.md nếu tên tool qua gateway khác.

## 9. Tài liệu và code liên quan

| Nội dung | Vị trí |
|---|---|
| Hướng dẫn quản trị MCP | `doc/MCP-ACCESS-GOVERNANCE.md` |
| Vận hành runtime MCP | `doc/MCP-RUNTIME-OPERATIONS.md` |
| Mô hình Apps, Connections | `doc/connections/README.md` |
| Gateway (gọi tool, header, policy) | `server/src/services/tool-gateway.ts`, `server/src/routes/tool-gateway.ts` |
| Quyền truy cập tool, profile | `server/src/services/tool-access.ts`, `server/src/services/tool-access-policy.ts` |
| Dựng danh sách MCP cho run | `server/src/services/heartbeat.ts` (`buildPaperclipRuntimeMcpServers`) |
| Truyền `mcpServers` cho codex-acp | `packages/adapter-utils/src/acpx-engine/execute.ts` |
| Giao diện Apps | `ui/src/pages/apps/` (`AppDetail.tsx`, `app-detail/SetupPanel.tsx`, `app-detail/PermissionsPanel.tsx`, `app-detail/AdvancedPanel.tsx`) |
| MCP server hiện tại | `paperclip-mcp/src/paperclip_mcp/server.py` |
| Kế hoạch tổng | `doc/plans/2026-10-15-viec-can-lam-tiep-theo.md` |
