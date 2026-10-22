# Báo Cáo Kỹ Thuật: Sự Cố Lệch Pha Biến Môi Trường (Runtime Token Gap) Giữa Tiến Trình Codex Agent & FastMCP Server

Tài liệu này giải thích chi tiết nguyên nhân gốc rễ, cơ chế cô lập tiến trình và các giải pháp khắc phục triệt để cho hiện tượng: **Codex Agent trong Terminal/PowerShell có API Token nhưng khi gọi MCP Tool thì bị lỗi `401 Unauthorized` hoặc `tool call (failed)`**.

---

## 1. Sơ Đồ Kiến Trúc Lệch Pha Tiến Trình (ASCII Box Diagram)

```text
┌─────────────────────────────────────────────────────────────────────────────────┐
│                           1. PAPERCLIP CONTROL PLANE                            │
│                                                                                 │
│  - Mỗi lượt chạy (Run) sinh 1 Ephemeral Runtime JWT Token mới.                 │
│  - Token gắn liền với run_id và agent_id, tự động hủy khi run kết thúc.         │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                     2. TIẾN TRÌNH THỰC THI CODEX (TERMINAL/SHELL)               │
│                                                                                 │
│  - Paperclip bơm Token vào biến môi trường Shell:                              │
│      $env:PAPERCLIP_API_KEY = "eyJhbGciOi..."                                   │
│      $env:PAPERCLIP_RUN_ID  = "run-4919b15f-..."                                │
│                                                                                 │
│  => Kết quả: Lệnh PowerShell / curl.exe CÓ TOKEN và CHẠY THÀNH CÔNG!          │
└────────────────────────────────────────┬────────────────────────────────────────┘
                                         │
                   ══════════════════════╪══════════════════════
                   RANH GIỚI GIAO TIẾP STDIO (JSON-RPC PROTOCOL)
                   (Chuẩn MCP không tự đồng bộ turn-level env)
                   ══════════════════════╪══════════════════════
                                         │
                                         ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                  3. TIẾN TRÌNH CON PYTHON MCP SERVER (DAEMON PROCESS)           │
│                                                                                 │
│  - Được bật lên từ trước khi chạy Task (từ lúc Codex khởi động qua config.toml). │
│  - Chạy ngầm vĩnh viễn và chỉ lắng nghe qua luồng stdin/stdout.                │
│                                                                                 │
│  - ❌ KHÔNG tự động cập nhật được biến môi trường của từng lượt chạy mới!       │
│                                                                                 │
│      os.environ.get("PAPERCLIP_API_KEY")  ──► RỖNG (Hoặc giá trị cũ lúc bật máy)│
│      Header gửi đi: Authorization: Bearer <RỖNG>                               │
│                                                                                 │
│  => Kết quả: Paperclip API chặn lại -> HTTP 401 Unauthorized                    │
│              FastMCP ném lỗi -> Báo đỏ trên màn hình: [tool call (failed)]     │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Phân Tích Nguyên Nhân Gốc Rễ (Root Cause Analysis)

### 2.1. Bản chất hai tiến trình sống ở hai "thế giới" độc lập

Trong kiến trúc Agent của Paperclip, có 2 thực thể tiến trình hệ điều hành hoàn toàn khác nhau:

1. **Tiến trình Codex Turn Execution:**
   * Mỗi khi có lượt đánh thức (Heartbeat Wakeup), Paperclip tạo ra một phiên chạy thực thi (Run).
   * Paperclip tạo một **Ephemeral Token (JWT)** tạm thời, mang theo quyền hạn của Agent và `runId` của phiên đó.
   * Token này được inject trực tiếp vào môi trường thực thi lệnh của Agent (Process Environment của shell/terminal).
   * Do đó, bất kỳ lệnh shell nào như `curl.exe` hay script PowerShell đều đọc được `$env:PAPERCLIP_API_KEY` dễ dàng.

2. **Tiến trình FastMCP Server (`python -m paperclip_mcp`):**
   * Được cấu hình trong `~/.codex/config.toml`:
     ```toml
     [mcp_servers.paperclip]
     command = "python"
     args = ["-m", "paperclip_mcp"]
     ```
   * Codex khởi chạy tiến trình Python này **ngay từ lúc khởi động ứng dụng**, độc lập với các lượt chạy task sau này.
   * Giao thức Model Context Protocol (MCP) truyền nhận dữ liệu hoàn toàn thông qua các gói tin JSON-RPC trên luồng **stdin / stdout**.
   * **Giao thức MCP tiêu chuẩn không có cơ chế "bơm biến môi trường mới" vào tiến trình con đang chạy sẵn theo từng turn.**

### 2.2. Hậu quả thực tế (Triệu chứng lỗi)

Khi Codex nhận task và quyết định gọi một công cụ MCP (ví dụ: `update_issue`, `get_issue`, `upload_issue_attachment`):

```text
Codex gọi MCP Tool -> Python MCP server đọc os.environ -> Thấy rỗng
-> Gửi HTTP Request sang Paperclip API với Header rỗng: "Authorization: Bearer "
-> Paperclip API trả về HTTP 401 Unauthorized
-> Python FastMCP ném ToolError("HTTP 401 from Paperclip API")
-> Transcript của Codex hiển thị: "tool call (failed)"
```

**Nghịch lý từng xảy ra:**
* Agent mở PowerShell chạy `curl.exe` $\rightarrow$ **Thành công** (vì Shell có key).
* Agent gọi tool MCP $\rightarrow$ **Thất bại / Failed** (vì tiến trình Python không có key).

---

## 3. Ba Giải Pháp Kỹ Thuật Khắc Phục Triệt Để

Để đảm bảo tiến trình Python luôn có Token hợp lệ trong mọi hoàn cảnh, hệ thống áp dụng chiến lược 3 lớp bảo vệ:

```text
┌─────────────────────────────────────────────────────────────────────────────────┐
│                    CHIẾN LƯỢC 3 LỚP BẢO VỆ TOKEN TRONG MCP                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  LỚP 1: Mở tham số api_key & run_id trên từng Tool MCP                          │
│         (Agent có thể truyền thẳng $env:PAPERCLIP_API_KEY vào đối số hàm)       │
│                                │                                                │
│                                ▼ (Nếu để trống)                                 │
│  LỚP 2: Tự động giải mã JWT Claims (_decode_jwt_claims)                         │
│         (Trích xuất run_id & company_id động trực tiếp từ payload base64)       │
│                                │                                                │
│                                ▼ (Nếu môi trường rỗng)                          │
│  LỚP 3: Phao cứu sinh Static Key trong file .env của MCP Server                 │
│         (Fallback sang Agent API Key hoặc Board Key cấu hình sẵn)               │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 3.1. Lớp 1: Bổ sung tham số `api_key` và `run_id` trực tiếp vào hàm Tool
Trong tất cả các tool MCP của [`server.py`](file:///c:/paperclip/paperclip-mcp/src/paperclip_mcp/server.py), chúng ta đã thêm các tham số tùy chọn:

```python
@mcp.tool()
async def update_issue(
    issue_id: str,
    status: str = "",
    comment: str = "",
    api_key: str = "",  # Cho phép caller truyền token của run hiện tại
    run_id: str = "",   # Cho phép caller truyền run_id hiện tại
) -> Any: ...
```

Khi Agent gọi tool, nếu Agent truyền giá trị, MCP server sẽ ưu tiên sử dụng token này thay vì đọc biến môi trường tĩnh.

### 3.2. Lớp 2: Tự động giải mã JWT Claims (`_decode_jwt_claims`)
Token của Paperclip là một JWT gồm 3 phần (`header.payload.signature`). Chúng ta đã viết hàm giải mã phần Payload Base64 mà không cần verify chữ ký:

```python
def _decode_jwt_claims(token: str) -> dict[str, Any]:
    """Trích xuất claims từ JWT payload không cần chữ ký."""
    if not token or token.count(".") != 2:
        return {}
    try:
        import base64
        payload_b64 = token.split(".")[1]
        payload_b64 += "=" * ((4 - len(payload_b64) % 4) % 4)
        claims = json.loads(base64.urlsafe_b64decode(payload_b64))
        return claims if isinstance(claims, dict) else {}
    except Exception:
        return {}
```

Nhờ đó, khi có token, hệ thống tự động rút trích được:
* `run_id`: Định danh lượt chạy để ghi log kiểm toán.
* `company_id`: Định danh công ty để tránh lỗi `company boundary`.

### 3.3. Lớp 3: Cấu hình Fallback Static Key trong `.env` (Phao cứu sinh an toàn nhất)
Trong thư mục `paperclip-mcp/.env`, ta có thể cấu hình một Static API Key:

```ini
# paperclip-mcp/.env
PAPERCLIP_BASE_URL=http://localhost:3100/api
PAPERCLIP_API_KEY=pcp_board_<your-board-key>
PAPERCLIP_COMPANY_ID=""
**Cơ chế hoạt động:**
* Khi tiến trình Python khởi động, nó nạp sẵn key tĩnh này vào bộ nhớ.
* Trong mỗi tool call, logic hàm `_headers()` sẽ hoạt động theo thứ tự ưu tiên:
  $$\text{Key hiệu lực} = \text{Tham số caller truyền} \;\longrightarrow\; \text{Biến môi trường OS} \;\longrightarrow\; \text{Key tĩnh trong .env}$$
* Nhờ vậy, ngay cả khi Codex không truyền key và biến môi trường bị rỗng, MCP server vẫn luôn có chìa khóa dự phòng để gọi Paperclip API thành công 100%!

---

## 4. Bảng So Sánh & Hướng Dẫn Vận Hành

| Tình huống gọi | Tham số `api_key` | Biến `os.environ` | File `.env` | Kết quả | Ghi chú |
| :--- | :---: | :---: | :---: | :---: | :--- |
| **Trước khi sửa** | Rỗng | Rỗng | Commented out | ❌ **Lỗi 401 (Failed)** | Header rỗng, API từ chối. |
| **Dùng Key động (Lớp 1)** | Có truyền | Không quan tâm | Không quan tâm |  **Thành công (Dynamic)** | Mutation được ghi nhận chuẩn theo từng Run ID. |
| **Dùng Phao cứu sinh (Lớp 3)**| Rỗng | Rỗng | Có key tĩnh |  **Thành công (Static Fallback)** | An toàn tuyệt đối, không sợ Agent quên truyền tham số. |

### Khuyến nghị cho Production:
1. **Luôn bật file `.env` với một Static Key hợp lệ** cho MCP server để đảm bảo các tool cơ bản (tra cứu, đọc task, đọc comment) luôn hoạt động ổn định.
2. **Trong prompt của Agent**, hướng dẫn Agent truyền `api_key=$env:PAPERCLIP_API_KEY` khi thực hiện các tác vụ mutating quan trọng để Paperclip gắn đúng `run_id` vào lịch sử hoạt động.

---

## 5. Phân Tích Chuyên Sâu: Vấn Đề Tiến Trình & Ý Tưởng Tự Động Quét File `.paperclip-run-env.json`

### 5.1. MCP Server có phải tiến trình khác với tiến trình của Agent không?

**CÓ, CHÍNH XÁC 100%.** MCP Server và Agent là hai tiến trình hệ điều hành (OS processes) hoàn toàn riêng biệt:

1. **Tiến trình Agent (Codex Run Shell):**
   * Được tạo ra theo từng lượt chạy (Ephemeral Process).
   * Môi trường thực thi lệnh (PowerShell/Bash) có CWD trỏ vào thư mục làm việc riêng biệt của Agent (ví dụ: `~/.paperclip/instances/default/workspaces/<agent-uuid>`).
   * Biến môi trường `$env:PAPERCLIP_API_KEY` và `$env:PAPERCLIP_RUN_ID` được nạp trực tiếp vào phiên Shell này.
2. **Tiến trình MCP Server (`python -m paperclip_mcp`):**
   * Là một tiến trình ngầm (Daemon Process) chạy dài hạn, được Codex bật lên một lần duy nhất lúc khởi động thông qua `config.toml`.
   * Giao tiếp với Codex duy nhất qua 2 đường ống chuẩn: **`stdin` (nhận request) / `stdout` (trả response)**.
   * CWD của tiến trình Python MCP thường là **thư mục gốc dự án (`C:\paperclip`)** hoặc thư mục cấu hình toàn cục, **hoàn toàn không thay đổi khi Agent chuyển workspace**.

### 5.2. Ý tưởng: "Nếu `os.environ` rỗng $\rightarrow$ MCP tự động quét file `.paperclip-run-env.json` trong workspace" — Có khả thi không?

Ý tưởng này rất sáng tạo nhằm tự động hóa việc lấy token, **nhưng trong thực tế kiến trúc đa Agent sẽ gặp 2 cạm bẫy chí tử**:

```text
┌─────────────────────────────────────────────────────────────────────────────────┐
│              CẠM BẪY 1: LỆCH THƯ MỤC LÀM VIỆC (CWD MISMATCH)                    │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│   Tiến trình MCP Server (Python)          Tiến trình Agent (Codex Shell)       │
│   ┌───────────────────────────────┐       ┌───────────────────────────────┐     │
│   │ CWD = C:\paperclip            │       │ CWD = .../workspaces/agent-01 │     │
│   │                               │       │                               │     │
│   │ Quét: open(".paperclip-       │       │ Ghi: .paperclip-run-env.json  │     │
│   │             run-env.json")    │       │      (Nằm trong workspace!)   │     │
│   └──────────────┬────────────────┘       └──────────────┬────────────────┘     │
│                  │                                       │                      │
│                  ▼                                       ▼                      │
│        Tìm tại: C:\paperclip\...               Nằm tại: .../workspaces/agent-01 │
│        ===> KẾT QUẢ: FILE NOT FOUND! (Lệch đường dẫn tuyệt đối)                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

#### Cạm bẫy 1: Lệch thư mục làm việc (CWD Mismatch)
* Khi hàm MCP gọi `open(".paperclip-run-env.json")`, Python sẽ tìm file theo thư mục hiện hành của **tiến trình Python MCP** (`C:\paperclip`).
* Trong khi đó, file `.paperclip-run-env.json` (nếu do Agent tạo ra) lại nằm trong workspace riêng của Agent (`~/.paperclip/.../workspaces/<agent-uuid>`).
* Do đó, MCP Server **không thể tìm thấy file** nếu chỉ dùng đường dẫn tương đối.

#### Cạm bẫy 2: Xung đột đa Agent (Multi-Agent Concurrency & Race Condition)
* Trong Paperclip, **nhiều Agent có thể chạy đồng thời song song** (ví dụ: Lead Agent giao việc cho 2 Sub-agent phân tích dữ liệu cùng lúc).
* Nếu dùng cơ chế ghi file dùng chung:
  * Agent A (Lead) ghi token A vào file.
  * Agent B (Worker) vừa khởi động lại ghi đè token B vào file.
  * Khi Agent A gọi MCP Tool, MCP Tool đọc file và lấy nhầm token B của Agent B!
  * **Hậu quả:** Gãy vỡ cơ chế kiểm toán (Audit Trail), vi phạm phân quyền doanh nghiệp (Company Boundary / Permission Violations).

> [!WARNING]
> Cơ chế đọc file chỉ an toàn nếu đường dẫn file chứa `run_id` duy nhất (ví dụ: `~/.paperclip/runs/{run_id}/env.json`). Nhưng để MCP biết mở file của run nào, thì **Agent vẫn bắt buộc phải truyền `run_id` qua tham số tool**!

---

## 6. Tại Sao Agent Lại "Quên" Truyền Key & Phải Retry Nhiều Lần?

Hiện tượng Agent gọi tool lần đầu tiên bị lỗi (failed), sau đó mới tự sửa sai và truyền đủ `$env:PAPERCLIP_API_KEY` ở lần thứ 2 **không hoàn toàn là lỗi của Agent**, mà là hệ quả từ sự kết hợp của 3 yếu tố kiến trúc:

```text
┌─────────────────────────────────────────────────────────────────────────────────┐
│                       3 NGUYÊN NHÂN KHIẾN AGENT "QUÊN" KEY                      │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│  1. THÓI QUEN HUẤN LUYỆN (LLM PRIOR)                                            │
│     Hầu hết MCP Tool trên thế giới đều giấu auth ở tầng transport/server config.│
│     LLM mặc định cho rằng việc xác thực là việc của hệ thống ngầm, không phải   │
│     việc của nó trong từng hàm logic.                                           │
│                                                                                 │
│  2. TOOL SCHEMA ĐỂ THAM SỐ TÙY CHỌN (OPTIONAL ARGUMENTS)                        │
│     Hàm khai báo: `api_key: str = ""`                                          │
│     => Schema JSON sinh ra: `api_key` KHÔNG nằm trong danh sách `required`.     │
│     => LLM đánh giá tham số này không quan trọng và tự động bỏ qua.             │
│                                                                                 │
│  3. RANH GIỚI NGỮ CẢNH (SHELL PROCESS vs JSON-RPC PAYLOAD)                      │
│     Agent chạy trong Shell có biến $env:PAPERCLIP_API_KEY, nhưng gọi MCP là     │
│     thao tác sinh chuỗi JSON. Agent cần tốn 1 bước suy luận bổ sung:            │
│     "Đọc biến từ Shell" ──► "Chuyển thành string nhét vào JSON argument".       │
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

### 6.1. Chi Tiết Nguyên Nhân 1: Thói quen huấn luyện của LLM (LLM Prior)
* Các mô hình ngôn ngữ lớn (Codex, Claude, GPT-4) được fine-tune trên hàng triệu mẫu gọi hàm (Function Calling / Tool Calling).
* Hầu hết các tool chuẩn (như `read_file`, `web_search`, `bash`, `git`) không đòi hỏi phải truyền token trong từng cú gọi hàm.
* Do đó, khi nhìn vào một danh sách tham số, LLM luôn ưu tiên chỉ điền các tham số mang tính nghiệp vụ trực tiếp (như `issue_id`, `comment`, `file_path`).

### 6.2. Chi Tiết Nguyên Nhân 2: Tool Signature định nghĩa tham số Optional
* Nếu định nghĩa hàm trong Python là:
  ```python
  async def upload_issue_attachment(
      issue_id: str,
      file_path: str,
      api_key: str = "",   # Default value rỗng
      run_id: str = "",    # Default value rỗng
  )
  ```
* FastMCP sẽ sinh JSON Schema với:
  ```json
  {
    "type": "object",
    "properties": {
      "issue_id": {"type": "string"},
      "file_path": {"type": "string"},
      "api_key": {"type": "string"},
      "run_id": {"type": "string"}
    },
    "required": ["issue_id", "file_path"]
  }
  ```
* Vì `api_key` không nằm trong mảng `required`, LLM coi đó là tham số phụ tùy chọn và **bỏ qua ở lần gọi đầu tiên**.

### 6.3. Chi Tiết Nguyên Nhân 3: Vòng Lặp Phản Hồi Lỗi (Feedback Loop Retry)
* Khi Agent gọi lần 1 không có key:
  1. MCP Server ném lỗi: `ToolError: HTTP 401 Unauthorized - Missing PAPERCLIP_API_KEY...`
  2. Lỗi này quay ngược lại ngữ cảnh chat của Agent.
  3. LLM đọc thấy thông báo lỗi tường minh $\rightarrow$ lúc này nó mới nhận ra: *"À, tool này bắt buộc phải có api_key!"*.
  4. Agent tự động retry lần 2 bằng cách đọc biến môi trường `$env:PAPERCLIP_API_KEY` và truyền vào tham số.

---

## 7. Giải Pháp Tối Ưu Triệt Để (Không Cần Retry, Chạy Chuẩn 100%)

Để loại bỏ hoàn toàn việc Agent phải retry và đảm bảo hệ thống vận hành trơn tru:

### 7.1. Chuyển `api_key` thành tham số bắt buộc (Required) trong Tool Schema
Trong [`server.py`](file:///c:/paperclip/paperclip-mcp/src/paperclip_mcp/server.py), loại bỏ giá trị mặc định cho `api_key` đối với các tool bắt buộc bảo mật:
```python
@mcp.tool()
async def upload_issue_attachment(
    issue_id: str,
    file_path: str,
    api_key: str,  # Bắt buộc (Không có default value ""), ép LLM phải sinh ra giá trị ngay từ đầu
    run_id: str = "",
) -> Any:
    """Upload attachment to Paperclip issue.
    
    CRITICAL: api_key MUST be passed directly from your current environment
    ($env:PAPERCLIP_API_KEY or os.environ['PAPERCLIP_API_KEY']). Never leave it blank.
    """
```

### 7.2. Cập nhật chỉ dẫn Agent trong System Prompt (`AGENTS.md`)
Bổ sung một quy tắc chuẩn vào [`AGENTS.md`](file:///c:/paperclip/AGENTS.md) của dự án:
```markdown
### MCP Tool Calling Rule:
When calling any Paperclip MCP tool (such as update_issue, upload_issue_attachment, finish_task_and_reply_telegram):
- ALWAYS pass `api_key=$env:PAPERCLIP_API_KEY` (or `os.environ.get("PAPERCLIP_API_KEY")`).
- ALWAYS pass `run_id=$env:PAPERCLIP_RUN_ID`.
This ensures your task execution is properly authenticated and tied to your active run.
```

### 7.3. Tổng Kết Kiến Trúc
* **Phương án truyền trực tiếp qua tham số (`api_key`, `run_id`)** là phương án kiến trúc chuẩn mực nhất, an toàn nhất cho môi trường đa Agent, loại bỏ hoàn toàn nguy cơ lệch thư mục (CWD) và xung đột tài nguyên (Race Condition).
* **Phao cứu sinh `.env` (Lớp 3)** đóng vai trò bảo hiểm dự phòng khi các lệnh đọc/tra cứu cơ bản không cần định danh lượt chạy.

---

## 8. Vai Trò Của `task_id` / `issue_id` & `company_id`: Ràng Buộc Bắt Buộc Trong Tool Schema

### 8.1. Cơ Chế: Docstring trong MCP chính là Prompt chỉ dẫn trực tiếp cho AI Agent!

Nhiều lập trình viên nghĩ docstring chỉ là tài liệu tham khảo cho người đọc code, **nhưng trong kiến trúc MCP (Model Context Protocol), docstring chính là System Prompt cho AI Agent**.

```text
┌─────────────────────────────────────────────────────────────────────────────────┐
│               DÒNG CHẢY BIẾN ĐỔI: TỪ DOCSTRING THÀNH PROMPT CỦA AI              │
├─────────────────────────────────────────────────────────────────────────────────┤
│                                                                                 │
│   1. CODE PYTHON TRONG SERVER.PY                                                │
│      @mcp.tool()                                                                │
│      async def upload_issue_attachment(issue_id: str, file_path: str, ...):     │
│          """CRITICAL: api_key MUST be passed from $env:PAPERCLIP_API_KEY..."""   │
│                                │                                                │
│                                ▼                                                │
│   2. GIAO THỨC MCP ĐÓNG GÓI JSON-RPC (tools/list)                               │
│      {                                                                          │
│        "name": "upload_issue_attachment",                                       │
│        "description": "CRITICAL: api_key MUST be passed from $env...",         │
│        "inputSchema": { "required": ["issue_id", "file_path", "api_key"] }      │
│      }                                                                          │
│                                │                                                │
│                                ▼                                                │
│   3. CODEX INJECT VÀO NGỮ CẢNH LLM (SYSTEM CONTEXT / TOOL INSTRUCTIONS)        │
│      AI Agent đọc description này trước khi quyết định gọi hàm:                 │
│      => LLM hiểu nguồn gốc dữ liệu: "Đọc $env:PAPERCLIP_API_KEY rồi truyền vào!"│
│      => LLM không đoán mò, không sinh dummy value, tỷ lệ gọi đúng ngay lần 1: 100%│
│                                                                                 │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

### 8.2. `task_id` / `issue_id` — Bắt buộc 100% cho mọi Mutating Tool

* **Tại sao bắt buộc?**
  * Các công cụ mutating như `update_issue`, `upload_issue_attachment`, `finish_task_and_reply_telegram`, `add_comment` nếu thiếu `issue_id` thì Paperclip REST API hoàn toàn không biết phải cập nhật vào đâu, đính kèm file vào task nào.
* **Nguồn lấy dữ liệu của Agent:**
  * Lấy từ **Context giao việc (Task Prompt)** hoặc từ biến môi trường **`PAPERCLIP_TASK_PAYLOAD` / `PAPERCLIP_WAKE_PAYLOAD_JSON`** do Paperclip bơm vào khi đánh thức Agent.
* **Quy chuẩn định nghĩa trong Docstring:**
  ```python
  @mcp.tool()
  async def upload_issue_attachment(
      issue_id: str,     # Bắt buộc (Required parameter)
      file_path: str,    # Bắt buộc (Required parameter)
      api_key: str,      # Bắt buộc (Required parameter)
      run_id: str = "",
  ) -> Any:
      """Upload attachment to a Paperclip issue.

      CRITICAL INSTRUCTIONS FOR AGENT:
      - issue_id: MUST be the exact UUID or identifier of the current task assigned to you
        (extracted from your prompt or PAPERCLIP_TASK_PAYLOAD). Never use mock strings.
      - file_path: MUST be the absolute path to the local deliverable file on disk.
      - api_key: MUST be passed from $env:PAPERCLIP_API_KEY.
      """
  ```

---

### 8.3. `company_id` — Ranh Giới Bảo Mật Cốt Lõi (Company Boundary)

* **Tại sao bắt buộc hoặc đặc biệt quan trọng?**
  * Theo nguyên tắc kiến trúc số 1 của Paperclip (`AGENTS.md`): **"Keep changes company-scoped"**. Mọi Agent, Task, Attachment và Ngân sách (Budget) đều bị cô lập chặt chẽ theo từng Công ty.
  * Các công cụ tạo mới hoặc tra cứu danh mục như `create_issue`, `list_company_agents`, `get_company_goals` bắt buộc phải có `company_id` trong URL (`/api/companies/:companyId/issues`). Nếu thiếu sẽ bị từ chối với mã lỗi `400 Bad Request` hoặc `403 Forbidden`.
* **Nguồn lấy dữ liệu của Agent:**
  1. Biến môi trường hệ thống: `$env:PAPERCLIP_COMPANY_ID`.
  2. Tự động bóc tách từ JWT Token: Hàm `_decode_jwt_claims(api_key)` giải mã claim `company_id` trong token được cấp.
* **Quy chuẩn định nghĩa trong Docstring:**
  ```python
  @mcp.tool()
  async def create_issue(
      title: str,
      description: str,
      api_key: str,
      company_id: str = "",  # Nếu để trống, server tự rút trích từ JWT token
  ) -> Any:
      """Create a new issue/subtask in Paperclip.

      CRITICAL INSTRUCTIONS FOR AGENT:
      - company_id: Pass from $env:PAPERCLIP_COMPANY_ID if available. If left empty,
        it will be automatically extracted from your api_key token.
      - api_key: MUST be passed from $env:PAPERCLIP_API_KEY.
      """
  ```

---

### 8.4. Bảng Tổng Hợp Ma Trận Tham Số Chuẩn MCP Cho AI Agent

| Tham số | Mức độ bắt buộc | Nguồn Agent lấy dữ liệu | Tác dụng đối với hệ thống Paperclip |
| :--- | :---: | :--- | :--- |
| **`api_key`** | **BẮT BUỘC** | `$env:PAPERCLIP_API_KEY` (Shell Environment) | Xác thực danh tính Agent, kiểm tra quyền hạn thực thi. |
| **`issue_id`** / **`task_id`** | **BẮT BUỘC** | Task Prompt / `PAPERCLIP_TASK_PAYLOAD` | Xác định đối tượng Task cần cập nhật, comment hoặc đính kèm file. |
| **`company_id`** | **RẤT QUAN TRỌNG** | `$env:PAPERCLIP_COMPANY_ID` hoặc rút từ JWT | Đảm bảo tuân thủ ranh giới công ty (Company Boundary), không truy cập chéo dữ liệu. |
| **`run_id`** | **KHUYẾN KHÍCH** | `$env:PAPERCLIP_RUN_ID` (Shell Environment) | Ghi nhận lịch sử kiểm toán (Audit Trail) chính xác cho từng lượt chạy của Agent. |
| **`file_path`** | **BẮT BUỘC** *(khi upload)* | Đường dẫn file trên ổ đĩa local | Chỉ định file kết quả cần upload lên Paperclip Storage & gửi Telegram. |

> **Quy tắc vàng khi thiết kế MCP Tool:**  
> Đừng bao giờ trông chờ Agent "tự đoán" các tham số hệ thống. Hãy biến tham số thành **bắt buộc trong Schema (`required`)** và dùng từ khóa **`CRITICAL` trong Docstring** để chỉ rõ tên biến môi trường hoặc nguồn context cần trích xuất.


