# HƯỚNG DẪN CHI TIẾT CÁC BƯỚC TRIỂN KHAI: ZERO-HALLUCINATION METADATA PIPELINE & ĐÓNG GÓI TOÀN DIỆN DỮ LIỆU TASK

> **Mục tiêu:**
> 1. Xóa bỏ hoàn toàn việc dùng Regex bóc tách chuỗi text thô.
> 2. Chấm dứt triệt để tình trạng AI Agent tự điền / hallucinate các trường kỹ thuật (`chat_id`, `message_id`, `task_id`).
> 3. Tự động hóa backend (MCP Server): Tự suy diễn `task_id` từ JWT run context, tự parse JSON metadata của Telegram, tự upload file, tự nghiệm thu đóng task thành `done`.
> 4. Trả về n8n Webhook một payload JSON đầy đủ 100% toàn bộ thông tin gốc của Task từ Paperclip (`task`), không thiếu bất kỳ trường nào để các node sau trong n8n xử lý.

---

## TỔNG QUAN LUỒNG DỮ LIỆU CHUẨN HOÁ (ARCHITECTURE)

```text
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ [BƯỚC 1: n8n -> Paperclip] Kẹp khối JSON cô lập ở cuối Task Description                │
│                                                                                        │
│ Yêu cầu của người dùng: "Tạo báo cáo tháng 10"                                         │
│                                                                                        │
│ ```json:telegram_context                                                               │
│ { "chat_id": 8882960938, "message_id": 53 }                                           │
│ ```                                                                                    │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ [BƯỚC 2: AI Agent làm việc] Zero Technical Burden                                      │
│ Agent chỉ tập trung chuyên môn, khi xong CHỈ CẦN GỌI:                                  │
│ finish_task_and_reply_telegram(message="Đã tạo xong báo cáo", file_path="baocao.md")   │
│ 🚫 Không bắt Agent truyền task_id, 🚫 Không bắt Agent truyền chat_id!                  │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ [BƯỚC 3: MCP Server tự động hóa ngầm] Backend Automation                               │
│ 1. Giải mã token JWT -> lấy run_id -> tra Paperclip API -> lấy task_id chuẩn 100%.     │
│ 2. Lấy chi tiết task -> đọc khối ```json:telegram_context``` -> lấy chat_id chuẩn.     │
│ 3. Nếu có file_path -> upload lên Paperclip Attachments -> sinh download URL.          │
│ 4. Post comment nghiệm thu lên Paperclip -> Cập nhật status issue = "done".            │
│ 5. Gọi GET /api/issues/{task_id} để lấy 100% object Task nguyên gốc từ Paperclip.      │
│ 6. Gửi POST HTTP tới N8N_TELEGRAM_WEBHOOK_URL chứa toàn bộ thông tin.                  │
└───────────────────────────────────────────┬────────────────────────────────────────────┘
                                            │
                                            ▼
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ [BƯỚC 4: n8n Webhook đón kết quả] Dữ liệu đầy đủ không thiếu trường nào               │
│ - $json.body.chat_id, $json.body.reply_message -> Gửi trực tiếp sang Telegram.         │
│ - $json.body.task -> Chứa 100% các trường: id, identifier, title, description, status, │
│   attachments, createdAt, updatedAt... -> Cập nhật PostgreSQL & ghi log.               │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## BƯỚC 1: TÁI CẤU TRÚC MCP TOOL `finish_task_and_reply_telegram` (TRONG `server.py`)

File: [`c:\paperclip\paperclip-mcp\src\paperclip_mcp\server.py`](file:///c:/paperclip/paperclip-mcp/src/paperclip_mcp/server.py)

### 1.1. Logic xử lý cần thêm
Chúng ta xây dựng tool này với các hàm phụ trợ chuyên biệt:
1. **`_resolve_current_task_id(api_key, run_id)`**:
   - Lấy claims từ JWT token (`PAPERCLIP_API_KEY`).
   - Nếu có `run_id`, gọi `GET /api/heartbeat-runs/{run_id}` để lấy `contextSnapshot.issueId` hoặc `issueId`.
   - Đảm bảo tìm ra đúng UUID của Task mà Agent đang chạy.
2. **`_extract_telegram_context_from_description(description)`**:
   - Dùng cú pháp tìm kiếm khối code ````json:telegram_context\s*(\{[\s\S]*?\})\s*```` và `json.loads()`.
   - Nếu không có, fallback tìm `chat_id:` / `message_id:` dạng text.
3. **`_upload_task_attachment(company_id, task_id, file_path, headers)`**:
   - Đọc nội dung file cục bộ và gọi `POST /api/companies/{company_id}/issues/{task_id}/attachments` (Multipart form-data).
4. **`finish_task_and_reply_telegram(...)`**:
   - Thực thi trọn gói chu trình và đóng gói 100% object `task` gửi về n8n.

### 1.2. Code triển khai cụ thể

Thêm đoạn mã sau vào cuối file [`c:\paperclip\paperclip-mcp\src\paperclip_mcp\server.py`](file:///c:/paperclip/paperclip-mcp/src/paperclip_mcp/server.py) (ngay phía trên `if __name__ == "__main__":`):

```python
# ── TELEGRAM & ZERO-HALLUCINATION WORKFLOW TOOLS ────────────────────────────────

N8N_TELEGRAM_WEBHOOK_URL_DEFAULT = "http://host.docker.internal:5678/webhook/paperclip-telegram-reply"


def _extract_telegram_context_from_description(description: str) -> dict[str, Any]:
    """Trích xuất khối JSON telegram_context từ description một cách an toàn."""
    if not description:
        return {}
    
    # Ưu tiên 1: Khối Fenced JSON chuẩn ```json:telegram_context ... ```
    match = re.search(r"```json:telegram_context\s*([\s\S]*?)\s*```", description)
    if match:
        try:
            data = json.loads(match.group(1).strip())
            if isinstance(data, dict):
                return data
        except Exception as e:
            log.warning("Lỗi parse khối json:telegram_context: %s", e)

    # Ưu tiên 2: Khối JSON thường có chứa chat_id
    match_json = re.search(r"```json\s*(\{[\s\S]*?\"chat_id\"[\s\S]*?\})\s*```", description)
    if match_json:
        try:
            data = json.loads(match_json.group(1).strip())
            if isinstance(data, dict):
                return data
        except Exception:
            pass

    # Fallback cuối cùng: Regex dòng text nếu là task cũ
    chat_match = re.search(r"(?:chat_id|Chat ID)[:=\s]+(\d+)", description, re.IGNORECASE)
    msg_match = re.search(r"(?:message_id|Message ID)[:=\s]+(\d+)", description, re.IGNORECASE)
    res: dict[str, Any] = {}
    if chat_match:
        res["chat_id"] = int(chat_match.group(1))
    if msg_match:
        res["message_id"] = int(msg_match.group(1))
    return res


async def _resolve_current_task_id(api_key: str = "", run_id: str = "") -> str:
    """Tự động suy diễn Task ID từ JWT claims của lượt chạy hiện tại."""
    token = api_key.strip() or os.environ.get("PAPERCLIP_API_KEY", "").strip() or API_KEY
    active_run_id = run_id.strip()

    if not active_run_id and token:
        claims = _decode_jwt_claims(token)
        active_run_id = str(claims.get("run_id") or claims.get("runId") or "")

    if active_run_id:
        # Gọi Heartbeat API để lấy Issue ID chính xác của Run này
        run_data = await _get(f"/heartbeat-runs/{active_run_id}")
        if isinstance(run_data, dict):
            # Các cấu trúc snapshot phổ biến trong Paperclip
            snapshot = run_data.get("contextSnapshot") or {}
            task_id = (
                snapshot.get("issueId")
                or run_data.get("issueId")
                or run_data.get("targetIssueId")
            )
            if task_id:
                return str(task_id)

    return ""


async def _upload_task_attachment(company_id: str, task_id: str, file_path: str, headers: dict[str, str]) -> dict[str, Any] | None:
    """Upload tệp kết quả vào Attachments của Paperclip Issue."""
    p = Path(file_path).resolve()
    if not p.is_file():
        log.warning("File đính kèm không tồn tại trên đĩa: %s", file_path)
        return None

    filename = p.name
    content_type, _ = mimetypes.guess_type(str(p))
    content_type = content_type or "application/octet-stream"

    url = f"{_get_base_url()}/companies/{company_id}/issues/{task_id}/attachments"
    async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
        with open(p, "rb") as f:
            files = {"file": (filename, f, content_type)}
            r = await client.post(url, headers=headers, files=files)
            if r.status_code in (200, 201):
                return r.json()
            else:
                log.error("Lỗi upload attachment (%d): %s", r.status_code, r.text)
                return None


@mcp.tool()
async def finish_task_and_reply_telegram(
    message: str,
    file_path: str = "",
    api_key: str = "",
    run_id: str = "",
    task_id: str = "",
    chat_id: int | None = None,
) -> dict[str, Any]:
    """Hoàn thành task hiện tại, đính kèm kết quả và tự động gửi phản hồi về Telegram cho người dùng.

    QUAN TRỌNG DÀNH CHO AGENT:
    - Bạn CHỈ CẦN truyền `message` (lời giải thích/kết quả) và `file_path` (nếu có file xuất ra).
    - KHÔNG CẦN truyền `task_id` hay `chat_id`! Hệ thống sẽ tự động xác định chính xác từ phiên làm việc.

    Args:
        message: Lời nhắn phản hồi kết quả trực tiếp cho người dùng Telegram.
        file_path: Đường dẫn tệp tin kết quả nếu công việc có tạo ra file (báo cáo, hình ảnh, file dữ liệu...).
        api_key: (Tùy chọn) API key, mặc định tự lấy từ môi trường Agent.
        run_id: (Tùy chọn) ID của heartbeat run hiện tại.
        task_id: (Tùy chọn) ID của task, mặc định hệ thống tự phát hiện 100%.
        chat_id: (Tùy chọn) Telegram Chat ID, mặc định tự trích xuất từ dữ liệu task.
    """
    token = api_key.strip() or os.environ.get("PAPERCLIP_API_KEY", "").strip() or API_KEY
    req_headers = {"Authorization": f"Bearer {token}"} if token else {}
    company_id = _get_company_id(api_key=token)

    # 1. Tự động suy ra Task ID nếu Agent không truyền
    resolved_task_id = task_id.strip()
    if not resolved_task_id:
        resolved_task_id = await _resolve_current_task_id(api_key=token, run_id=run_id)

    if not resolved_task_id:
        return _err("Không thể tự động xác định task_id của lượt chạy này. Vui lòng cung cấp task_id.")

    # 2. Lấy thông tin chi tiết hiện tại của Task từ Paperclip
    issue_data = await _get(f"/issues/{resolved_task_id}", headers=req_headers)
    if isinstance(issue_data, dict) and "error" in issue_data:
        return _err(f"Lỗi truy vấn task {resolved_task_id}: {issue_data.get('error')}")

    issue_obj = issue_data if isinstance(issue_data, dict) else {}
    task_description = issue_obj.get("description", "")
    task_identifier = issue_obj.get("identifier", resolved_task_id)

    # 3. Trích xuất Telegram Context an toàn (không lo bị vỡ regex)
    tg_ctx = _extract_telegram_context_from_description(task_description)
    final_chat_id = chat_id if chat_id else tg_ctx.get("chat_id")
    final_msg_id = tg_ctx.get("message_id")

    # 4. Upload file đính kèm nếu có file_path
    uploaded_attachment_info = None
    if file_path and file_path.strip() and company_id:
        uploaded_attachment_info = await _upload_task_attachment(
            company_id=company_id,
            task_id=resolved_task_id,
            file_path=file_path.strip(),
            headers=req_headers,
        )

    # 5. Đăng comment nghiệm thu vào Issue trên Paperclip
    comment_body = f"🏁 **[HOÀN THÀNH CÔNG VIỆC]**\n\n{message}"
    if uploaded_attachment_info:
        comment_body += f"\n\n📎 File kết quả: `{uploaded_attachment_info.get('filename')}`"
    await _post(f"/issues/{resolved_task_id}/comments", {"body": comment_body}, headers=req_headers)

    # 6. Cập nhật trạng thái Issue sang 'done'
    await _patch(f"/issues/{resolved_task_id}", {"status": "done"}, headers=req_headers)

    # 7. Lấy lại toàn bộ Object Task MỚI NHẤT từ Paperclip (chứa status: done & attachments mới)
    refreshed_issue = await _get(f"/issues/{resolved_task_id}", headers=req_headers)
    full_task_object = refreshed_issue if isinstance(refreshed_issue, dict) and "id" in refreshed_issue else issue_obj
    full_task_object["status"] = "done"

    # 8. Chuẩn bị đường dẫn download file
    file_info = None
    if uploaded_attachment_info:
        att_id = uploaded_attachment_info.get("id")
        fname = uploaded_attachment_info.get("filename")
        base_dl = _get_base_url().replace("localhost", "host.docker.internal")
        dl_url = f"{base_dl}/attachments/{att_id}/content" if att_id else ""
        file_info = {
            "filename": fname,
            "attachment_id": att_id,
            "download_url": dl_url,
            "byte_size": uploaded_attachment_info.get("byteSize"),
            "content_type": uploaded_attachment_info.get("contentType"),
        }

    # 9. Đóng gói PAYLOAD TOÀN DIỆN 100% gửi về n8n Webhook
    webhook_url = os.environ.get("N8N_TELEGRAM_WEBHOOK_URL", N8N_TELEGRAM_WEBHOOK_URL_DEFAULT)
    payload = {
        # Object task 100% nguyên bản từ Paperclip
        "task": full_task_object,
        # Metadata Telegram chuẩn
        "telegram": {
            "chat_id": final_chat_id,
            "message_id": final_msg_id,
        },
        # Thông tin phản hồi
        "reply": {
            "message": message,
            "file": file_info,
        },
        # Các trường shortcut phẳng để node n8n đọc trực tiếp siêu tiện lợi
        "chat_id": final_chat_id,
        "message_id": final_msg_id,
        "task_id": resolved_task_id,
        "task_identifier": task_identifier,
        "task_status": "done",
        "reply_message": message,
        "download_url": file_info.get("download_url") if file_info else None,
        "filename": file_info.get("filename") if file_info else None,
    }

    # 10. Gửi POST sang Webhook n8n
    webhook_sent = False
    webhook_status_code = None
    if webhook_url:
        try:
            async with httpx.AsyncClient(timeout=_HTTP_TIMEOUT) as client:
                res = await client.post(webhook_url, json=payload)
                webhook_status_code = res.status_code
                webhook_sent = (res.status_code in (200, 201, 204))
        except Exception as ex:
            log.warning("Không thể gửi dữ liệu tới n8n webhook (%s): %s", webhook_url, ex)

    return {
        "ok": True,
        "task_id": resolved_task_id,
        "task_identifier": task_identifier,
        "status": "done",
        "chat_id": final_chat_id,
        "webhook_sent": webhook_sent,
        "webhook_status_code": webhook_status_code,
        "attachment_uploaded": bool(uploaded_attachment_info),
        "message": "Đã hoàn tất task và chuyển dữ liệu trọn vẹn về n8n thành công."
    }
```

---

## BƯỚC 2: CẬP NHẬT SYSTEM PROMPT TRONG `AGENTS.MD`

File: [`c:\paperclip\AGENTS.md`](file:///c:/paperclip/AGENTS.md)

Cần bổ sung một khối chỉ dẫn rõ ràng để Agent biết rằng **Agent không cần và không được phép điền các ID kỹ thuật**, chỉ cần gọi hàm phản hồi kết quả:

```markdown
### QUY TẮC HOÀN THÀNH CÔNG VIỆC & PHẢN HỒI KẾT QUẢ CHO NGƯỜI DÙNG:
Khi bạn đã hoàn thành yêu cầu công việc hoặc đã tạo xong tài liệu/file được yêu cầu, bạn **BẮT BUỘC** gọi tool:

```python
finish_task_and_reply_telegram(
    message="<Nội dung giải thích kết quả chi tiết, lịch sự cho người dùng>",
    file_path="<đường dẫn tệp tin kết quả nếu có, ví dụ: baocao.md, data.csv>"
)
```

⚠️ **LƯU Ý QUAN TRỌNG:**
- Bạn **KHÔNG CẦN** điền `task_id`, `chat_id` hay `run_id`. Hệ thống Paperclip MCP sẽ tự động nhận diện và gửi kết quả về đúng Telegram của khách hàng!
- Không kết thúc lượt chạy chỉ bằng text thông thường nếu công việc đó được giao từ Telegram, hãy luôn gọi tool `finish_task_and_reply_telegram`.
```

---

## BƯỚC 3: CẬP NHẬT NODE TẠO TASK TRONG n8n (ĐÓNG GÓI JSON CONTEXT)

Tại workflow n8n (Node chuẩn bị dữ liệu trước khi tạo Task trên Paperclip):

### 3.1. Code Node đóng gói Description: `Chuẩn Bị Description Kẹp Telegram Context`

Dán đoạn code JavaScript sau vào Node Code của n8n:

```javascript
// 1. Lấy thông tin tin nhắn hiện tại từ Telegram Trigger
const tgMsg = $('Telegram Trigger').first().json.message;
const userText = tgMsg.text || tgMsg.caption || 'Yêu cầu không có nội dung chữ';
const chatId = tgMsg.chat.id;
const messageId = tgMsg.message_id;

// 2. Định dạng nội dung hiển thị thân thiện cho Agent đọc
let readableDescription = `### 📋 YÊU CẦU CỦA NGƯỜI DÙNG:
${userText}
`;

// Nếu có tóm tắt ngữ cảnh các task cũ (từ logic khôi phục ngữ cảnh)
if (typeof oldTasksSummary !== 'undefined' && oldTasksSummary) {
  readableDescription += `\n### 🕒 TÓM TẮT NGỮ CẢNH CÁC CÔNG VIỆC LIÊN QUAN TRƯỚC ĐÓ:
${oldTasksSummary}
`;
}

// 3. ĐÓNG GÓI KHỐI METADATA CÔ LẬP CHUẨN XÁC 100%
// Khối này nằm ở cuối description, máy đọc cực kỳ chuẩn xác, không bao giờ lo regex bị gãy!
const telegramContext = {
  chat_id: chatId,
  message_id: messageId,
  source: "telegram",
  created_at: new Date().toISOString()
};

const finalDescription = `${readableDescription}

---
\`\`\`json:telegram_context
${JSON.stringify(telegramContext, null, 2)}
\`\`\``;

// 4. Trả về cho Node Tạo Task của Paperclip
return {
  title: userText.slice(0, 80).trim() || "Xử lý yêu cầu từ Telegram",
  description: finalDescription,
  chat_id: chatId,
  message_id: messageId
};
```

### 3.2. Cấu hình Node HTTP Request: `Tạo Task Mới Trên Paperclip`
* **Method:** `POST`
* **URL:** `http://localhost:3100/api/companies/{{ $env.PAPERCLIP_COMPANY_ID }}/issues`
* **Headers:**
  * `Authorization`: `Bearer {{ $env.PAPERCLIP_BOARD_API_KEY }}`
  * `Content-Type`: `application/json`
* **Body (JSON):**
  ```json
  {
    "title": "[Telegram] {{ $json.title }}",
    "description": {{ JSON.stringify($json.description) }},
    "priority": "medium",
    "status": "todo"
  }
  ```

---

## BƯỚC 4: CẤU HÌNH WORKFLOW n8n WEBHOOK ĐÓN KẾT QUẢ ĐẦY ĐỦ

### 4.1. Cấu hình Webhook Node (`Paperclip Finish Webhook`)
* **Webhook Path:** `paperclip-telegram-reply` (URL thực tế: `http://localhost:5678/webhook/paperclip-telegram-reply`)
* **HTTP Method:** `POST`
* **Respond:** `Immediately` với `{"status": "received"}`

### 4.2. Cấu hình Node Phản Hồi Telegram (`Send Telegram Reply`)
Do MCP server gửi cả trường shortcut phẳng, bạn chỉ cần gán:
* **Chat ID:** `{{ $json.body.chat_id }}`
* **Text:** `{{ $json.body.reply_message }}`
* **Reply To Message ID (Tùy chọn):** `{{ $json.body.message_id }}`

*(Nếu có file kèm theo: `{{ $json.body.download_url }}` $\rightarrow$ dùng node Telegram `Send Document` tải URL và gửi thẳng file cho người dùng).*

### 4.3. Cấu hình Node Cập Nhật Database PostgreSQL (`Update Database`)
Lúc này n8n có sẵn 100% dữ liệu chi tiết của Task trong `$json.body.task`, không thiếu bất kỳ trường nào!
* **Bảng:** `telegram_messages` (hoặc `tasks_history`)
* **Mapping các trường:**
  * `paperclip_task_id`: `{{ $json.body.task.id }}`
  * `task_identifier`: `{{ $json.body.task.identifier }}`
  * `task_title`: `{{ $json.body.task.title }}`
  * `task_status`: `{{ $json.body.task.status }}`
  * `task_description`: `{{ $json.body.task.description }}`
  * `attachments_count`: `{{ $json.body.task.attachments ? $json.body.task.attachments.length : 0 }}`
  * `updated_at`: `{{ $json.body.task.updatedAt }}`
  * `telegram_chat_id`: `{{ $json.body.chat_id }}`

---

## BƯỚC 5: CHECKLIST KIỂM THỬ TỪNG BƯỚC (STEP-BY-STEP VERIFICATION)

| Bước | Hành động | Kết quả mong đợi |
| :--- | :--- | :--- |
| **1** | Chạy kiểm tra cú pháp Python trong `server.py` | Không có lỗi syntax, server FastMCP khởi động bình thường. |
| **2** | Gửi tin nhắn text từ Telegram: *"Hãy liệt kê 3 điều cần làm hôm nay"* | n8n tạo task chứa ````json:telegram_context````. Agent thực thi xong $\rightarrow$ gọi `finish_task_and_reply_telegram(message="...")` $\rightarrow$ Webhook n8n nhận đầy đủ `task` và `chat_id` $\rightarrow$ Tin nhắn phản hồi lập tức về Telegram. |
| **3** | Gửi yêu cầu xuất file: *"Tạo cho tôi một file danh_sach.csv gồm 5 dòng"* | Agent viết file `danh_sach.csv` $\rightarrow$ gọi `finish_task_and_reply_telegram(file_path="danh_sach.csv", message="Đã xuất danh sách")` $\rightarrow$ File tự upload vào attachments Paperclip $\rightarrow$ Webhook nhận được `download_url` $\rightarrow$ Gửi file về Telegram. |
| **4** | Kiểm tra trường `task` trong n8n Webhook | Kiểm tra JSON tại tab Execution của n8n: chứa đầy đủ `id`, `identifier`, `title`, `description`, `status == "done"`, `attachments`... |
