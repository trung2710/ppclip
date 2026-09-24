# Đề Xuất Giải Pháp: Tự Động Nhận Token Cho MCP Server Ngay Từ Lần Gọi Đầu Tiên

> **Ngày ghi nhận:** 18/09/2026  
> **Trạng thái:** Chờ xử lý (Pending Implementation)  
> **Phạm vi:** `paperclip-mcp` (External Python FastMCP Server) & Codex Agent Runner  

---

## 1. Bối Cảnh & Vấn Đề (Problem Statement)

### 1.1. Hiện tượng
Khi Codex Agent được giao nhiệm vụ cần điều phối (ví dụ: thẩm định hợp đồng cho nhân sự mới), Agent luôn gọi tool native `mcp.paperclip.delegate_contract_review` 2 lần:
* **Lần 1 (Bị lỗi 401 Unauthorized):** Agent gọi hàm với các tham số nghiệp vụ mặc định, không truyền `api_key`. Tool MCP bị thiếu token xác thực và trả về lỗi 401.
* **Lần 2 (Thành công):** Agent đọc thông báo lỗi, tự gõ lệnh PowerShell `$env:PAPERCLIP_API_KEY` để lấy JWT token động của turn hiện tại, rồi gọi lại tool kèm tham số `api_key`.

### 1.2. Nguyên nhân kỹ thuật
* **Tiến trình độc lập qua stdio:** MCP Server (`server.py`) được Codex khởi động ngầm một lần lúc mở session. Trong hệ điều hành, một tiến trình con **không thể tự động cập nhật** các biến môi trường mới được nạp vào terminal sau đó.
* **Token động theo từng turn:** Paperclip sinh token JWT mới cho mỗi turn và inject vào session PowerShell của Agent (`$env:PAPERCLIP_API_KEY`). Nhưng tiến trình Python MCP đang chạy ngầm thì không nhận được biến này (`os.environ.get("PAPERCLIP_API_KEY")` bị rỗng).

---

## 2. Các Cải Tiến Đã Thực Hiện Thành Công (Đã làm)

1. **Sửa lỗi định tuyến Base URL:** Hàm `_get_base_url()` trong `server.py` đã được ưu tiên đọc `PAPERCLIP_API_URL` (cổng động của instance, ví dụ port 3101) trước `PAPERCLIP_BASE_URL` (cổng tĩnh trong `.env`), giải quyết triệt để lỗi `404 Issue not found`.
2. **Tự động chuyển đổi Identifier sang UUID:** Cả 2 tool `delegate_contract_review` và `delegate_task_to_agent` đã được cập nhật để tự động bóc tách `parent_uuid` từ kết quả fetch task cha. Dù Agent truyền mã nhân diện `"KHT-39"` hay `UUID`, trường `parentId` gửi lên API vẫn luôn là UUID chuẩn.
3. **Chuẩn hóa Type Hinting:** Sửa cảnh báo Mypy strict mode trong `_decode_jwt_claims` bằng `cast(dict[str, Any], claims)` kèm kiểm tra an toàn `isinstance(claims, dict)`.

---

## 3. Ba Phương Án Khắc Phục Lỗi Token Ở Lần Gọi Đầu Tiên

Dưới đây là 3 phương án để khi bắt tay vào xử lý, bạn có thể lựa chọn theo mức độ ưu tiên:

---

### 🟢 Phương Án 1: Bổ sung chỉ dẫn vào System Prompt / `SKILL.md` (Đơn giản nhất)
* **Nguyên lý:** Hướng dẫn Codex luôn luôn truyền `api_key=$env:PAPERCLIP_API_KEY` ngay từ lần gọi tool đầu tiên.
* **Các file cần sửa:**
  * `C:\Users\LAPTOP HP\.codex\skills\paperclip\SKILL.md`
  * `c:\paperclip\instructions\kien_truc_va_trien_khai_he_thong_dieu_phoi_codex_router.md`
* **Nội dung bổ sung:**
  ```markdown
  ### QUY TẮC BẮT BUỘC KHI GỌI MCP DELEGATION TOOL:
  Trước khi gọi `delegate_contract_review` hoặc `delegate_task_to_agent`:
  1. Luôn đọc token hiện tại: `$token = $env:PAPERCLIP_API_KEY`.
  2. Truyền tham số tường minh: `delegate_contract_review(..., api_key=$token)`.
  ```
* **Đánh giá:**
  * ✅ Ưu điểm: Không cần sửa code Python hay thay đổi kiến trúc hệ thống.
  * ⚠️ Nhược điểm: Vẫn dựa vào việc Agent tuân thủ prompt, thỉnh thoảng Agent có thể quên nếu ngữ cảnh quá dài.

---

### 🟢 Phương Án 2: Đồng bộ Token qua File tạm Workspace (Chuẩn mực & Tự động 100%)
* **Nguyên lý:** Paperclip khi chạy luôn gắn với một thư mục làm việc (Agent Home Workspace hoặc Scratch Dir). Ta có thể cho Paperclip hoặc script khởi động ghi token hiện tại vào một file tạm (ví dụ `.paperclip_token` hoặc đọc file `.paperclip-run-scratch.json`).
* **Cách thực hiện trong code MCP (`server.py`):**
  Khi `api_key` truyền vào bị rỗng và `os.environ` cũng rỗng, hàm `_headers()` sẽ tự động tìm đọc file token gần nhất trong thư mục workspace:
  ```python
  def _resolve_runtime_token() -> str:
      # 1. Đọc từ env
      token = os.environ.get("PAPERCLIP_API_KEY", "").strip()
      if token:
          return token
      # 2. Quét file token động từ workspace hiện tại
      token_file = Path.cwd() / ".paperclip_token"
      if token_file.exists():
          return token_file.read_text("utf8").strip()
      return ""
  ```
* **Đánh giá:**
  * ✅ Ưu điểm: Hoàn toàn trong suốt (Transparent). Agent chỉ cần gọi `delegate_contract_review(parent_issue_id=...)` ngắn gọn, MCP tự lấy được token mới nhất mà không sợ lỗi 401.
  * ⚠️ Nhược điểm: Cần cấu hình Paperclip ghi file token ra workspace trước mỗi run.

---

### 🟢 Phương Án 3: Dùng Static Agent API Key cố định trong `.env` (Ổn định nhất)
* **Nguyên lý:** Thay vì dùng token JWT động ngắn hạn (vốn được sinh mới theo từng turn), hãy cấp một API Key tĩnh dài hạn cho Agent Codex (dạng `pcp_xxxxxxxx...` từ Paperclip UI $\rightarrow$ Agent Settings $\rightarrow$ API Keys).
* **Cách thực hiện:**
  Điền trực tiếp key này vào file `paperclip-mcp/.env`:
  ```env
  PAPERCLIP_API_KEY=pcp_1305bc09851c001a4830228b8c36f99664814ff5244fe268
  ```
* **Đánh giá:**
  * ✅ Ưu điểm: Đơn giản, cực kỳ ổn định. Tiến trình Python MCP luôn luôn có quyền hợp lệ 24/7 ngay từ lúc khởi động. Agent gọi lần 1 là thành công ngay 100%.
  * ⚠️ Nhược điểm: Tất cả các thao tác gọi qua MCP sẽ mang danh nghĩa Agent sở hữu key tĩnh đó (trừ phi Agent truyền kèm `run_id` để map vào lượt chạy cụ thể).

---

## 4. Bảng So Sánh Các Phương Án

| Tiêu chí | Phương án 1 (Prompt / Skill) | Phương án 2 (File Sync Workspace) | Phương án 3 (Static API Key .env) |
| :--- | :---: | :---: | :---: |
| **Độ phức tạp triển khai** | Rất thấp (chỉ sửa markdown) | Trung bình (code thêm 10 dòng) | Rất thấp (copy paste key) |
| **Tính tự động với Agent** | Thấp (Agent phải tự truyền param) | **Tuyệt đối (100% tự động)** | **Tuyệt đối (100% tự động)** |
| **Độ tin cậy** | 90% (tùy thuộc vào model) | 99% | **100%** |
| **Tính an toàn / Scope** | Token động hết hạn theo turn | Token động hết hạn theo turn | Key tĩnh dài hạn |

---

## 5. Khuyến Nghị Khi Triển Khai (Action Plan)

1. **Khuyến nghị tức thì (Quick-win):** Triển khai **Phương án 3** (cấp Static API Key cho Codex vào file `.env`). Vừa nhanh, vừa chấm dứt hoàn toàn hiện tượng gọi 2 lần.
2. **Khuyến nghị lâu dài (Long-term architecture):** Nếu hệ thống yêu cầu quản lý chặt chẽ chi phí và dấu vết (audit log) theo từng Turn JWT, hãy triển khai **Phương án 2** (đồng bộ token qua file tạm trong Workspace).
