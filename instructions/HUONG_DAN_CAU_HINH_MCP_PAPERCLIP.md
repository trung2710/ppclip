# Hướng Dẫn Cấu Hình MCP Server Cho Paperclip & Codex

Tài liệu này tổng hợp toàn bộ quy trình cấu hình MCP Server (cho cả chế độ Local Host và Quản trị qua Paperclip Tool Access Governance), phân tích bản chất lỗi kết nối HTTP 400 và hướng dẫn các bước khắc phục chi tiết.

---

## 1. Tổng Quan Kiến Trúc MCP Trong Paperclip

Hệ thống có 2 cơ chế sử dụng MCP song song:

```
┌─────────────────────────────────────────────────────────────┐
│                       CODEX RUNTIME                         │
│ (CLI / Local Agent chạy với model GPT-5.6 / Claude / v.v.)   │
└──────────────┬──────────────────────────────▲───────────────┘
               │ (1) Inbound: Thao tác        │ (2) Outbound: Gọi Tool
               │     quản lý Paperclip        │     (FastMCP, n8n, DB...)
               ▼                              │
┌──────────────────────────────┐              │
│   PAPERCLIP CORE PLATFORM    │              │
│ - Quản lý Company / Projects │              │
│ - Issue & Task Management    │              │
│ - Heartbeat Orchestrator     │              │
│ - Tool Access Governance ────┼──────────────┘ (Managed Gateway)
└──────────────────────────────┘
```

1. **Inbound MCP (`paperclip-mcp`)**: Codex đóng vai trò client, dùng tool của Paperclip để: tạo task con, comment, checkout issue, tìm kiếm agent, cập nhật trạng thái dự án.
2. **Outbound MCP (Tool Access Governance & External Tools)**: Codex/Agent cần công cụ đặc thù để hoàn thành task (ví dụ: query database, kích hoạt workflow n8n, đọc file nội bộ). Paperclip quản trị phân quyền (Agent A được gọi tool X, Agent B không được gọi).

---

## 2. Cấu Hình MCP Server Cho Codex (Local Host Stdio)

Khi muốn Codex CLI trên máy tính trực tiếp nhận diện MCP Server (ví dụ `paperclip-mcp`), cấu hình được đặt tại:
`C:\Users\<USER>\.codex\config.toml`

### File Cấu Hình `config.toml` Mẫu:
```toml
model = "gpt-5.6-luna"
model_reasoning_effort = "low"
service_tier = "priority"
personality = "pragmatic"

[projects.'c:\users\laptop hp']
trust_level = "trusted"

[projects.'c:\paperclip']
trust_level = "trusted"

[windows]
sandbox = "elevated"

# Cấu hình MCP Server Paperclip
[mcp_servers.paperclip]
command = "D:\\anaconda\\envs\\ml_env\\python.exe"
args = [
    "C:/paperclip/paperclip-mcp/src/paperclip_mcp/server.py",
    "--transport",
    "stdio"
]
env = { PAPERCLIP_BASE_URL = "http://localhost:3100/api" }
```

> **Lưu ý**:
> - Trên Windows, đường dẫn `command` nên dùng 2 dấu gạch chéo ngược (`\\`).
> - Trong `args`, dùng dấu gạch chéo xuôi (`/`) hoặc `\\`.
> - Khi Paperclip chạy agent qua `codex-local`, nó tự động copy `config.toml` từ máy chủ vào môi trường cách ly của agent (`CODEX_HOME`), giúp agent tự động nhận diện các tool này.

---

## 3. Cấu Hình MCP Qua Giao Diện Quản Trị Paperclip (Tool Access Governance)

Khi triển khai môi trường doanh nghiệp hoặc muốn quản lý quyền hạn của từng Agent (Role-based Tool Access), kết nối MCP Server qua HTTP endpoint thay vì `stdio`.

### Các Bước Thực Hiện Trên UI:
1. Mở giao diện Paperclip: `http://localhost:3100/apps`
2. Bấm **Connect an app** (hoặc truy cập `/apps/connect?byo=1`)
3. Chọn **Connect with a link**
4. Điền URL MCP Server: `http://127.0.0.1:9011/mcp`
5. Chọn **Does it need a key?** -> Chọn **No** (nếu server local không yêu cầu API key)
6. Bấm **Check link**: Hệ thống sẽ gửi request `tools/list` để quét toàn bộ tool mà MCP Server cung cấp.
7. Chọn công cụ (Choose actions) và cấp quyền cho từng Agent (Choose access).

---

## 4. Chi Tiết Lỗi `400 Bad Request` & Phân Tích Nguyên Nhân

### Triệu Chứng
- **Trên giao diện Web (UI)**: Hiển thị thông báo đỏ:
  ```
  Couldn't connect
  Remote app returned an error
  ```
- **Trong Terminal chạy Python FastMCP (`server.py`)**:
  ```
  2026-09-21T16:26:12 [INFO] paperclip-mcp Created new transport with session ID: 1ca50a7a3b4942e68316683d22a2c59c
  INFO: 127.0.0.1:56475 - "POST /mcp HTTP/1.1" 400 Bad Request
  ```

### Nguyên Nhân Kỹ Thuật Gốc Rễ (Root Cause)
1. **Cơ chế Discovery của Paperclip**:
   - Khi bấm **Check link**, Paperclip backend (hàm `remoteTools()` trong `server/src/services/tool-access.ts`) gửi một HTTP `POST` đơn lẻ chứa payload JSON-RPC `{"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}}` trực tiếp đến endpoint `http://127.0.0.1:9011/mcp`.
   - Request này là một request HTTP độc lập, **không mang Header `mcp-session-id`** và không trải qua luồng bắt tay SSE khởi tạo session trước đó.

2. **Cơ chế Session của FastMCP 4.x (`streamable-http`)**:
   - Mặc định, FastMCP phiên bản mới quản lý kết nối qua `FastMCPStreamableHTTPSessionManager` với chế độ Stateful (`stateless_http=False`).
   - Ở chế độ Stateful, FastMCP yêu cầu mọi request `POST` phải kèm Header `mcp-session-id` đã được cấp phát. Nếu không có, FastMCP sẽ lập tức từ chối và trả về HTTP `400 Bad Request` (Missing session ID).

---

## 5. Các Cách Khắc Phục (Solutions)

### Cách 1: Bật Chế Độ `stateless_http=True` Trực Tiếp Trong Code Python (Khuyên Dùng)

Mở file `C:\paperclip\paperclip-mcp\src\paperclip_mcp\server.py`, tìm đoạn khởi chạy server ở cuối file (quanh dòng 1280 - 1290) và cập nhật:

```python
# CŨ:
if args.transport == "stdio":
    mcp.run(transport="stdio")
else:
    mcp.run(transport=args.transport, host=args.host, port=args.port)

# MỚI (ĐÃ SỬA):
if args.transport == "stdio":
    mcp.run(transport="stdio")
else:
    mcp.run(
        transport=args.transport,
        host=args.host,
        port=args.port,
        stateless_http=True  # Cho phép Paperclip gọi tools/list trực tiếp không cần session ID
    )
```

---

### Cách 2: Thiết Lập Biến Môi Trường (Không Cần Sửa Code)

Nếu không muốn chỉnh sửa file code `server.py`, FastMCP hỗ trợ đọc cờ này qua biến môi trường.

Trong PowerShell trước khi chạy server:
```powershell
$env:FASTMCP_STATELESS_HTTP = "true"
python C:\paperclip\paperclip-mcp\src\paperclip_mcp\server.py --transport streamable-http --port 9011
```

---

### Cách 3: Chạy Với Transport SSE (Server-Sent Events) Truyền Thống

Nếu FastMCP của bạn hỗ trợ chế độ `sse`:
```powershell
python C:\paperclip\paperclip-mcp\src\paperclip_mcp\server.py --transport sse --port 9011
```
Khi kết nối trên giao diện Paperclip, nhập link:
`http://127.0.0.1:9011/sse`

---

## 6. Kiểm Tra & Xác Nhận Thành Công

1. Khởi động lại MCP Server:
   ```powershell
   python C:\paperclip\paperclip-mcp\src\paperclip_mcp\server.py --transport streamable-http --port 9011
   ```
2. Thử nghiệm gửi request kiểm tra bằng PowerShell:
   ```powershell
   $body = '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
   Invoke-RestMethod -Uri "http://127.0.0.1:9011/mcp" -Method Post -ContentType "application/json" -Body $body
   ```
   Nếu trả về HTTP `200 OK` kèm danh sách các tool (`paperclip_create_task`, `paperclip_comment`, ...), server đã sẵn sàng.
3. Quay lại trình duyệt Paperclip UI, bấm **Check link**:
   - Trạng thái sẽ chuyển sang màu xanh lá cây hoặc tự động nhảy sang **Step 3: Choose actions**.
   - Tick chọn các tool cần dùng và bấm **Finish / Install tools**.

---

## 7. Quản Trị Phân Quyền Rủi Ro Cho Tool (Allow vs Ask First vs Block)

Khi kết nối các Tool MCP (từ `paperclip-mcp`, `n8n`, hay bên thứ ba), Paperclip cung cấp hệ thống kiểm soát quyền gọi tool (Tool Access Governance) với 3 mức độ:

### 7.1. Ý Nghĩa & Cơ Chế Hoạt Động Của 3 Mức
| Phân loại | Hành vi Gateway của Paperclip | Trải nghiệm thực tế |
| :--- | :--- | :--- |
| **`Allow`** *(Cho phép)* | Request đi thẳng đến MCP Server và thực thi ngay lập tức mà không có rào cản nào. | **Agent chạy tự động 100%** từ đầu đến cuối mà không bị gián đoạn hay chờ đợi con người. |
| **`Ask First`** *(require_approval)* | Gateway chặn request lại, ghi nhận vào bảng `approval_requests` và tạm dừng Agent (`paused / waiting`). | **Task bị treo lại.** Người dùng phải truy cập Paperclip UI và bấm **"Approve"** thì Agent mới chạy tiếp. |
| **`Block`** *(Từ chối)* | Gateway lập tức từ chối và trả về mã lỗi JSON-RPC: `"Tool execution blocked by policy"`. | Agent nhận được thông báo không được phép dùng và phải tìm phương án khác. |

---

### 7.2. Có Thể Chuyển Tất Cả Các Tool Thành `Allow` Được Không?
**CÂU TRẢ LỜI: HOÀN TOÀN ĐƯỢC.**

Trong các trường hợp sau, chuyển toàn bộ sang `Allow` là lựa chọn tối ưu:
1. **Muốn Agent tự hành 100% (Full Autonomy)**: Khi để Agent chạy ngầm, chạy qua đêm xử lý task lớn, bạn không thể ngồi trực để bấm Approve mỗi khi Agent gọi tool.
2. **Môi trường Phát triển (Dev / PoC / Local Testing)**: Cần tốc độ phản hồi nhanh, không sợ ảnh hưởng tới dữ liệu khách hàng thực tế.
3. **Các Tool nội bộ an toàn**: Bộ công cụ `paperclip-mcp` (tạo task con, comment, tìm kiếm, cập nhật trạng thái...) vốn sinh ra để phục vụ chính Agent điều phối công việc, nên việc để `Allow` là hoàn toàn bình thường và khuyến khích.

---

### 7.3. Hướng Dẫn Cách Chuyển Tất Cả Sang `Allow`

#### Cách 1: Trên Giao Diện Web Paperclip UI (Tool Access Governance)
1. **Khi mới kết nối App**:
   - Tại **Step 3 (Choose actions)**: Bấm nút **Select All** để chọn tất cả tool.
   - Tại **Step 4 (Choose access)**: Ở mục **Default Policy**, chọn **Allow** (hoặc gán quyền `Allow` cho nhóm Agent / All Agents).
2. **Đối với App đã kết nối trước đó**:
   - Vào menu bên trái: **Apps** ➔ **Connections** ➔ Chọn kết nối MCP mong muốn.
   - Vào tab **Rules / Tools**: Chọn tất cả các tool và cập nhật trạng thái thành **Allow**.

#### Cách 2: Khi Dùng Qua File `config.toml` Của Codex (Local Mode)
Nếu bạn cấu hình Codex gọi trực tiếp MCP Server qua `config.toml`:
```toml
[projects.'c:\paperclip']
trust_level = "trusted"

[windows]
sandbox = "elevated"

[mcp_servers.paperclip]
...
```
Ở chế độ này, Codex xem MCP Server là công cụ cục bộ đáng tin cậy và **mặc định sẽ chạy ở chế độ `Allow` 100%**, không có bất kỳ bước dừng lại hỏi duyệt nào.

---

### 7.4. Các Biện Pháp An Toàn (Safety Rails) Khi Để `Allow` 100%

Khi cho phép Agent tự do gọi tool không cần hỏi duyệt, bạn nên thiết lập các chốt chặn an toàn trên Paperclip để tránh rủi ro:
1. **Chống Vòng Lặp Vô Tận (Infinite Loop)**:
   - Nếu Agent gặp lỗi và gọi liên tục một webhook n8n hoặc spam comment trong task, nó sẽ tốn token và tài nguyên.
   - *Cách phòng ngừa*: Trong cấu hình Agent trên Paperclip, thiết lập **`Budget Cents`** (ngân sách tối đa cho mỗi run) và **`Max Turns`** (ví dụ: giới hạn 20-30 turns/task) để Agent tự dừng nếu vượt ngưỡng.
2. **Bảo Vệ Các Tác Vụ Hủy Diệt (Destructive Actions)**:
   - Với 95% các tool (đọc dữ liệu, truy vấn, comment, tạo task, kích hoạt luồng thông thường) ➔ Đặt **`Allow`**.
   - Riêng các tool có tính chất không thể hoàn tác (như: `Xóa Database`, `Hủy tài khoản khách hàng`, `Gửi email ra bên ngoài cho khách thật`) ➔ Chỉ đặt riêng các tool này thành **`Ask First`**.

---

## 8. Cơ Chế Tự Động Hóa Của Paperclip: Managed MCP Gateway (Không Cần Cấu Hình Thủ Công)

Khi bạn chuyển sang sử dụng mô hình **Tool Access Governance**, bạn **KHÔNG CẦN** phải cấu hình thủ công khối `[mcp_servers.paperclip]` trong file `config.toml` của Codex nữa. Paperclip sẽ tự động đảm nhiệm toàn bộ vòng đời của MCP Server qua cơ chế **Managed Gateway**.

### 8.1. Vị Trí Code Logic Trong Codebase Paperclip
Quy trình tự động hóa này được triển khai tại 3 tầng chính trong mã nguồn Paperclip:

1. **Tầng 1: Đọc & Lọc Danh Sách Tool Theo Quyền Của Agent**
   - **File:** `server/src/services/tool-access.ts` (kết hợp `server/src/services/trust-preset-resolver.ts` và `packages/db/src/schema/tool_access.ts`).
   - **Hàm:** `resolveAgentToolAccess(...)`
   - **Cơ chế:** Khi Agent thức dậy nhận nhiệm vụ (Heartbeat), hệ thống xác định danh tính Agent, quét các bảng `tool_access_grants` và `tool_access_policies` để lấy chính xác danh sách các Tool mà Agent đó được phép gọi (`Allow` hoặc `Ask First`).

2. **Tầng 2: Dựng Gateway Tạm Thời & Tiêm Cấu Hình (`# BEGIN PAPERCLIP MANAGED MCP`)**
   - **File:** `server/src/services/heartbeat.ts` và `server/src/services/execute.ts` (hoặc adapter `server/src/adapters/codex-local.ts`).
   - **Hàm:** `prepareCodexHome(...)` / `injectManagedMcpConfig(...)`
   - **Cơ chế:** 
     - Paperclip khởi tạo một thư mục môi trường cách ly riêng cho lượt chạy đó (`CODEX_HOME`).
     - Dựng một cổng Gateway MCP ảo nội bộ trỏ vào chính Paperclip Backend, kèm theo token xác thực dùng một lần cho lượt chạy đó (`Ephemeral Run Token`).
     - Tự động chèn khối cấu hình động vào file config tạm của lượt chạy:
       ```toml
       # BEGIN PAPERCLIP MANAGED MCP
       [mcp_servers.paperclip_gateway]
       url = "http://127.0.0.1:3100/api/mcp/gateway"
       headers = { Authorization = "Bearer <EPHEMERAL_RUN_TOKEN>" }
       # END PAPERCLIP MANAGED MCP
       ```
     - Khi tiến trình `codex` khởi động, nó tự động nhận diện Gateway này mà không cần người dùng can thiệp cấu hình.

3. **Tầng 3: Tự Động Thu Hồi & Dọn Dẹp Sau Khi Xong Việc**
   - **File:** `server/src/services/execute.ts` (trong khối `try ... finally`).
   - **Hàm:** `cleanupRunEnvironment(...)`
   - **Cơ chế:** Ngay khi tiến trình Agent kết thúc (hoặc gặp lỗi, timeout, hoàn thành task), Paperclip sẽ:
     1. Vô hiệu hóa (Revoke) ngay lập tức `Ephemeral Run Token`.
     2. Đóng session MCP Gateway của lượt chạy đó.
     3. Cắt bỏ khối `# BEGIN PAPERCLIP MANAGED MCP ... # END PAPERCLIP MANAGED MCP` để trả file cấu hình về trạng thái sạch ban đầu, hoặc hủy bỏ thư mục sandbox tạm của lượt chạy.

---

### 8.2. Bảng So Sánh Giữa 2 Cách Cấu Hình

| Tiêu chí | Cách 1: Cấu hình thủ công trong `config.toml` (Cũ) | Cách 2: Qua Paperclip Managed Gateway (Mới) |
| :--- | :--- | :--- |
| **Đường đi của lệnh gọi Tool** | `Codex CLI` ➔ Kết nối thẳng vào tiến trình `python server.py` qua `stdio`. | `Codex CLI` ➔ `Paperclip Gateway` ➔ `server.py (HTTP)` / `n8n`. |
| **Cấu hình `config.toml`** | **Bắt buộc tự gõ tay**: Đường dẫn python, file server, env... | **Không cần gõ gì cả**: Paperclip tự tiêm và tự dọn dẹp. |
| **Phân quyền Agent (RBAC)** | ❌ **Không**: Mọi Agent đều dùng chung và gọi được 100% mọi tool. | ✅ **Có**: Agent A chỉ thấy Tool A, Agent B chỉ thấy Tool B. |
| **Hỏi duyệt (Ask First)** | ❌ Không hỗ trợ. | ✅ Có thể chặn lệnh nhạy cảm chờ người duyệt trên Web. |
| **Nhật ký kiểm toán (Audit)** | ❌ Chỉ có log thô trên console. | ✅ Xem toàn bộ lịch sử Agent gọi tool trực tiếp trên Web UI. |

---

### 8.3. Hướng Dẫn Chuyển Đổi Thực Tế
1. **Dọn dẹp `config.toml`**: Bạn có thể xóa hoặc comment (`#`) khối `[mcp_servers.paperclip]` trong `C:\Users\LAPTOP HP\.codex\config.toml` để tránh trùng lặp công cụ.
2. **Chạy MCP Server làm dịch vụ nền**:
   ```powershell
   python C:\paperclip\paperclip-mcp\src\paperclip_mcp\server.py --transport streamable-http --port 9011
   ```
3. **Kết nối trên giao diện Paperclip**:
   Truy cập `http://localhost:3100/apps/connect`, kết nối tới link `http://127.0.0.1:9011/mcp`, chọn tool và cấp quyền cho Agent. Từ đây, Paperclip sẽ tự động quản lý mọi lượt gọi công cụ!

---

## 9. Ý Nghĩa Của Mục "Key" (API Key / Auth Credential) Khi Kết Nối App

Khi kết nối một ứng dụng MCP tùy chỉnh (BYO App) trên giao diện Paperclip, bạn sẽ thấy mục **Key** (*"Your key is stored securely. Replace it if it stopped working or you rotated it"*).

### 9.1. Cái "Key" Này Là Gì Và Để Làm Gì?
Cái **Key** này chính là **API Key / Secret Token** dùng để **xác thực (Authentication)** khi Paperclip kết nối tới MCP Server từ xa (Remote MCP Server).

* **Cách hoạt động:** Khi bạn nhập một Key vào đây, mỗi lần Paperclip gửi yêu cầu sang MCP Server (để lấy danh sách công cụ `tools/list` hoặc kích hoạt công cụ `tools/call`), Paperclip sẽ tự động gắn Key này vào HTTP Header:
  ```http
  Authorization: Bearer <API_KEY_CỦA_BẠN>
  ```
* **Bảo mật:** Key này được mã hóa và lưu trữ an toàn trong Database của Paperclip (Secret Store `app_credentials`), chỉ có hệ thống Gateway mới giải mã ra để dùng khi gửi request.

### 9.2. Khi Nào Mới CẦN Dùng Đến Key Này?
Bạn **chỉ cần** dùng Key này khi:
1. **MCP Server đặt trên Cloud / Mạng ngoài:**
   - Ví dụ: Bạn deploy MCP Server hoặc n8n lên server VPS, AWS, Render... và bật bảo mật bằng API Key để tránh người lạ ngoài Internet quét và gọi trộm.
2. **MCP Server của các dịch vụ bên thứ ba:**
   - Ví dụ: Khi kết nối MCP của GitHub (cần GitHub Personal Access Token), Notion API Key, Slack Token, hoặc API Key của n8n.

### 9.3. Đối Với `paperclip-mcp` Hiện Tại Của Bạn:
- **Server của bạn đang chạy ở đâu?** 
  Nó đang chạy trực tiếp trên máy của bạn tại `http://127.0.0.1:9011/mcp` (Localhost).
- **Code `server.py` có bắt mật khẩu không?** 
  Mặc định FastMCP trong code `server.py` của bạn **không yêu cầu xác thực API Key**.
- **Tại sao trên màn hình vẫn có mục Key?** 
  Lúc ở bước 2 (*"Does it need a key?"*), có thể bạn đã chọn *Yes* và nhập một ký tự/token nào đó vào.
- **Có ảnh hưởng gì không?** 
  **Hoàn toàn KHÔNG ảnh hưởng!** FastMCP khi nhận được request có Header Authorization nhưng không cấu hình middleware chặn auth thì nó sẽ bỏ qua header đó và xử lý bình thường.
- 👉 **Bằng chứng:** Trên hình của bạn đã hiện màu xanh lá: **`Connected: 34 actions available`** — tức là Paperclip đã kết nối thành công và đọc được toàn bộ 34 công cụ của bạn rồi!

> **Tóm lại:** Bạn không cần bận tâm hay bấm nút *"Replace key"* làm gì cả, cứ để nguyên như vậy là hệ thống đã sẵn sàng 100% để cấp quyền cho Agent sử dụng.

---

## 10. Cơ Chế Phân Quyền & Phân Biệt Tool Cho Từng Agent (Agent-Level RBAC)

Một câu hỏi quan trọng: *Làm thế nào Paperclip biết Agent nào đang gọi tool, Agent nào được cài tool nào và ngăn chặn việc gọi sai quyền?*

Hệ thống xử lý thông qua quy trình 2 lớp: **Nhận diện danh tính lượt chạy** và **Lọc quyền tại Gateway**.

```
                        ┌──────────────────────────────┐
                        │      AGENT A (DEV AGENT)     │
                        └──────────────┬───────────────┘
                                       │
                  1. Gửi lệnh gọi tool (kèm Run Token A)
                                       ▼
                        ┌──────────────────────────────┐
                        │   PAPERCLIP MCP GATEWAY      │
                        └──────────────┬───────────────┘
                                       │
              2. Tra cứu Database: (Agent A + Tool X) = ?
                                       │
          ┌────────────────────────────┼────────────────────────────┐
          ▼                            ▼                            ▼
       [ALLOW]                  [ASK FIRST]                      [BLOCK]
       Chuyển tiếp sang         Tạm dừng Agent,                  Chặn đứng ngay,
       FastMCP Server 9011      báo lên Web chờ bạn duyệt       báo lỗi: "Policy Denied"
```

### 10.1. Nhận Diện Danh Tính Lượt Chạy (Ephemeral Run Token)
Khi Paperclip kích hoạt một Agent thực thi task (Heartbeat Run):
1. Hệ thống tạo một mã xác thực tạm thời (**`Ephemeral Run Token`**) gắn liền với bộ ba: `{ runId, agentId, companyId }`.
2. Token này được tiêm vào Header của Managed Gateway trong môi trường chạy của Agent:
   ```toml
   [mcp_servers.paperclip_gateway]
   url = "http://127.0.0.1:3100/api/mcp/gateway"
   headers = { Authorization = "Bearer <EPHEMERAL_RUN_TOKEN_CỦA_AGENT_A>" }
   ```
3. Mỗi khi Agent gửi request tới Gateway, Paperclip lập tức giải mã token và xác định chính xác 100% Agent nào đang thực hiện cuộc gọi.

### 10.2. Hai Tầng Kiểm Soát Quyền Cụ Thể
1. **Tầng 1: Lọc Danh Sách Công Cụ Ngay Từ Đầu (Tool Visibility)**
   - Khi Agent khởi động và hỏi Gateway *"Tôi có những công cụ gì?"* (`tools/list`):
   - Paperclip đối chiếu bảng phân quyền: Nếu Agent chỉ được cấp 5 tool trong tổng số 34 tool, Gateway **chỉ trả về đúng 5 tool đó**. Agent hoàn toàn không biết sự tồn tại của 29 tool còn lại.
2. **Tầng 2: Kiểm Soát Tại Thời Điểm Gọi (Execution Enforcement)**
   - Khi Agent gọi một tool cụ thể (`tools/call`):
   - Gateway tra cứu chính sách:
     - **`Allow`**: Cho phép chuyển tiếp request đến server Python `127.0.0.1:9011` và nhận kết quả.
     - **`Ask First`**: Tạm dừng Agent, tạo bản ghi `approval_request` chờ người dùng bấm Duyệt trên Web UI.
     - **`Block` / Chưa cấp quyền**: Gateway từ chối ngay lập tức với lỗi `"Tool execution blocked by policy"`, lệnh hoàn toàn không chạm tới server Python.

### 10.3. Hướng Dẫn Thao Tác Cấu Hình Trên Web UI
Bạn có thể cấu hình phân quyền theo 2 góc nhìn:

1. **Cấu hình theo Ứng dụng (App-centric)**:
   - Truy cập **Apps** ➔ **Connections** ➔ Chọn kết nối **Paperclip MCP Server**.
   - **Mục Actions (34 actions)**: Đặt trạng thái `Allow`, `Ask First` hoặc `Block` cho từng tool.
   - **Mục Access / Rules**:
     - *All Agents*: Cho phép mọi Agent trong công ty sử dụng.
     - *Specific Agents*: Chỉ tick chọn các Agent được phép dùng bộ công cụ này (ví dụ chỉ Agent Quản lý hoặc Agent Dev).
2. **Cấu hình theo từng Agent (Agent-centric)**:
   - Truy cập **Agents** ➔ Chọn một Agent cụ thể.
   - Vào tab **Tools / Capabilities**: Bật/tắt các App và các Tool cụ thể mà Agent này được phép sử dụng.

### 10.4. Ví Dụ Kịch Bản Thực Tế
- **Agent Trưởng Nhóm (Dispatcher)**: Được cấp toàn quyền `Allow` với 34 tool của Paperclip để tạo task con, assign nhiệm vụ, checkout issue.
- **Agent Lập Trình Viên (Developer)**: Được cấp các tool thao tác code và comment, nhưng bị `Block` các tool xóa task hoặc đổi người phụ trách.
- **Agent Thử Việc (Intern / Low-Trust)**: Các tool quan trọng bị chuyển sang chế độ `Ask First` để mỗi khi Agent định thực thi thì phải có sự phê duyệt của người quản trị.



