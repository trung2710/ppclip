# Tổng quan: báo cáo tổng hợp các thay đổi của nhánh `test_adapter`

- Phạm vi: 48 commit của `test_adapter` so với `main` (211 file), từ 17/08 đến 29/10/2026.
- Gồm **9 phần**, mỗi phần là một file trong thư mục này. Mỗi file mở đầu bằng khối "Tóm tắt phần này", sau đó mới trình bày chi tiết.
- Code được trích dẫn bằng link GitHub theo commit [`f6c9d6bfc`](https://github.com/trung2710/ppclip/tree/f6c9d6bfc1225895047151d99f8d4002dacee482), nên số dòng không bị lệch.

---

## Nội dung 9 phần

| # | Phần | Trình bày gì |
|---|---|---|
| 1 | [Cấu hình Codex 3 tầng và chế độ xác thực](01-cau-hinh-codex-3-tang-va-che-do-xac-thuc.md) | Ba tầng `CODEX_HOME` (dùng chung, company, riêng agent); khi nào agent dùng tầng nào; bảng chọn chế độ LiteLLM, API key hay Codex cloud; cách chuyển qua lại và reconcile |
| 2 | [Tích hợp LiteLLM và trace theo run](02-tich-hop-litellm-va-trace-theo-run.md) | Kiến trúc Codex → LiteLLM → model; đoạn provider trong `config.toml`; tag `paperclip_run` để trace và gom token, cost của từng run |
| 3 | [Cost và budget](03-cost-va-budget.md) | Đổi cost sang `double`; đường đi của cost; cộng dồn; hiển thị; hard-stop ngân sách và lỗi với số cent lẻ |
| 4 | [Bỏ lượt LLM guardrail của Codex](04-bo-luot-llm-guardian-cua-codex.md) | Guardian là gì; ba tầng cấu hình duyệt; công tắc `isGateway`; agent nào được tắt; đánh đổi an toàn |
| 5 | [Giữ session Codex cũ](05-giu-session-codex-cu-fingerprint.md) | Fingerprint hai lớp; bốn nguyên nhân session bị bỏ oan và cách sửa; tỷ lệ dùng lại session đo trên dữ liệu thật |
| 6 | [Log run và giao diện transcript](06-log-run-va-giao-dien-transcript.md) | Tham số và output của tool trong log acpx; cột Time; định dạng log n8n |
| 7 | [MCP server, app và gateway](07-mcp-server-app-va-gateway.md) | Tiến trình cha/con của MCP server (stdio và HTTP); app kết nối MCP; gateway gửi header danh tính và JWT của run |
| 8 | [Context khi đánh thức agent n8n](08-context-va-prompt-khi-danh-thuc-agent-n8n.md) | Trường `paperclip` trong body webhook; dùng lại hàm của `adapter-utils`; `fullPrompt`; các mẫu prompt |
| 9 | [Một agent chạy nhiều task cùng lúc](09-agent-chay-nhieu-task-cung-luc.md) | `maxConcurrentRuns`; luồng queue → claim → chạy; khóa một task một run; tài nguyên dùng chung; kết quả thử |

Cấu trúc chung của mỗi phần: tóm tắt, cơ chế kèm sơ đồ và code trích dẫn, đối chiếu dữ liệu thật trên máy, rủi ro, kết luận, và cách tự kiểm tra ở phụ lục.

---

## Các phát hiện đáng chú ý nhất

| Phần | Phát hiện | Mức |
|---|---|---|
| 3 | Migration 0195 bỏ sót 3 cột của hệ thống budget: số cent lẻ làm hard-stop tự động không pause được agent (đã tái hiện) | Cao |
| 2 | Hai chuỗi dạng virtual key nằm trong tài liệu đã push lên GitHub; nên thu hồi nếu còn hiệu lực | Cao |
| 6 | Bộ che secret trong log chưa che `Authorization: Basic`, `ghp_…`, khóa AWS, chuỗi kết nối có mật khẩu | Trung bình |
| 5 | Task có workspace lấy từ `agent_home` vẫn mất session ở mọi run, nguyên nhân chưa xác định | Trung bình |
| 7 | Các chốt chặn "run phải đúng agent và công ty" của gateway chưa có test | Trung bình |
| 8 | Body gửi sang n8n chứa đường dẫn cục bộ và dữ liệu thừa; có lỗi nhỏ ở dòng `pending comments` | Trung bình |
| 9 | Các run không gắn project của một agent dùng chung một thư mục làm việc | Trung bình |
| 4 | Cờ `dangerouslyBypass…` chỉ có tác dụng ở lane CLI nhưng giao diện hiện cho mọi lane | Trung bình |

---

## Lưu ý khi đọc

- Các phần được viết từ ngày 29/10 đến 13/11/2026. Số liệu đo trên máy là số liệu tại thời điểm đó.
- Database và server của Paperclip không chạy ở các lần kiểm tra sau, nên Phần 6 đến 9 dùng log run trên đĩa thay cho database.
- Các file test thăm dò tạm đã được xóa. Bản tái hiện lỗi ngân sách của Phần 3 được giữ ở [repro/](repro/budget-fractional-cents.repro.test.ts.txt).
- Chưa có thay đổi code nào của dự án; các báo cáo này chỉ mô tả và đánh giá.
