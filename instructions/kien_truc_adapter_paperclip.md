# Kiến Trúc Và Cơ Chế Hoạt Động Của Local Adapters (Gemini, Claude) Trong Paperclip

Tài liệu này tổng hợp chi tiết cách mà Paperclip điều phối, kết nối và giao tiếp với các AI Agent (như Gemini, Claude) thông qua hệ thống Local Adapters.

---

## 1. Vị trí và Vai trò của Adapter
Trong hệ sinh thái Paperclip, các mô hình AI (như Claude, Gemini) không kết nối trực tiếp với Paperclip. Mối quan hệ này được thiết lập thông qua một lớp trung gian gọi là **Adapter** (nằm trong `packages/adapters/gemini-local`, `claude-local`...).

- **Paperclip (Control Plane):** Đóng vai trò Giám đốc. Giao việc, cấp ngân sách (API Key, Task ID), nhưng không biết nói ngôn ngữ của AI.
- **Provider AI (Google Gemini, Anthropic Claude):** Đóng vai trò Bộ não suy nghĩ. Có khả năng đọc hiểu, viết code, nhưng không biết hệ thống Paperclip là gì.
- **Adapter (Người Phiên Dịch):** Là cầu nối. Chuẩn bị môi trường (Sandbox), cung cấp "đồ nghề" (Skills/Bash scripts), và mớm lời (Prompt) để AI biết cách tương tác ngược lại với Paperclip.

---

## 2. Cơ Chế Kết Nối: Sử Dụng Native CLI
Paperclip **KHÔNG** viết ra một CLI riêng để chạy mô hình AI. Thay vào đó, Adapter sẽ gọi trực tiếp đến **Native CLI (CLI gốc)** của từng hãng.

- **Gemini Adapter:** Gọi lệnh `gemini` (hoặc `agy` - Antigravity CLI) với các cờ (flags) như `--output-format stream-json` và `--sandbox`.
- **Claude Adapter:** Gọi lệnh `claude`.

Điều này giúp Paperclip luôn tận dụng được tối đa sức mạnh và các công cụ (Tools) nguyên bản (như `run_shell_command`, `edit_file`) mà các CLI này hỗ trợ sẵn.

---

## 3. Cách Paperclip "Dạy" AI Bằng Prompt & Kỹ Năng (Skills)
Vì các AI CLI mặc định không biết Paperclip là ai, Adapter sẽ áp dụng 2 "vũ khí" thao túng tâm lý:

### A. Tiêm Hướng Dẫn Bằng Môi Trường (System Prompting)
Trước khi chạy lệnh CLI, file `execute.ts` của Adapter sẽ tự động gắn thêm các biến môi trường và ghép một đoạn "Nội quy" vào System Prompt của AI.

**Đoạn mã chứng minh (`execute.ts`):**
```typescript
function renderApiAccessNote(env: Record<string, string>): string {
  // ... Cung cấp API Key và URL ...
  return [
    "Paperclip API access note:",
    "Use run_shell_command with curl to make Paperclip API requests.",
    "GET example:",
    `  run_shell_command({ command: "curl -s -H \"Authorization: Bearer $PAPERCLIP_API_KEY\" \"$PAPERCLIP_API_URL/api/agents/me\"" })`,
    // ...
  ].join("\n");
}
```
Nhờ ví dụ (few-shot) này, AI hiểu rằng nếu nó muốn báo cáo hay tương tác với Paperclip, nó bắt buộc phải gọi Tool `run_shell_command` để gõ lệnh `curl`.

### B. Tiêm Mã Kịch Bản (Bash Scripts / Skills)
Việc ép AI tự viết lệnh `curl` dài dòng (đặc biệt là khi upload file nhị phân) rất dễ sinh ra lỗi. Paperclip giải quyết bằng cách cung cấp các Bash script gọi là **Skills**.

Trước khi chạy, Adapter sẽ copy (symlink) các script này (ví dụ: `paperclip-upload-artifact.sh`) thẳng vào thư mục cấu hình của Agent (vd: `~/.gemini/skills/`). Nhờ đó, AI có thể gọi các script này như những câu lệnh terminal thông thường. Các script này sẽ tự động móc nối với `$PAPERCLIP_API_KEY` để làm các tác vụ HTTP phức tạp thay cho AI.

---

## 4. Nhận Diện Bối Cảnh (Context) và Khám Phá API (ReAct)

Làm sao AI biết nó phải làm gì và biết những API nào tồn tại? Câu trả lời nằm ở sự kết hợp giữa việc "Nhồi sọ" và cơ chế tự khám phá:

### A. Biết bối cảnh nhờ Lệnh Thức Tỉnh (Wake Prompt)
Mỗi khi khởi động, Adapter không chỉ gọi AI dậy mà còn ném cho nó một "Hồ sơ bệnh án" gọi là `wakePrompt`. Gói dữ liệu này bao gồm: Tiêu đề Task, nội dung mô tả, lịch sử comment trước đó và thư mục làm việc hiện tại. Nhờ vậy, ngay khi mở mắt ra, AI đã biết chính xác nó đang đứng ở đâu và cần giải quyết bài toán gì.

### B. Biết API nhờ Ví dụ và Tự khám phá
AI **KHÔNG** hề thuộc lòng toàn bộ API của Paperclip. Thay vào đó:
- **Học qua ví dụ (Few-shot):** Paperclip chỉ dạy cho nó 1-2 API cơ bản (như lệnh `curl` ở Phần 3) làm ví dụ mẫu để nó tự bắt chước.
- **Dùng Skills:** Thay vì bắt AI tự nhớ API upload file phức tạp, Paperclip cung cấp sẵn các Bash script (`paperclip-upload-artifact.sh`) để AI gọi lệnh đơn giản.
- **Vừa làm vừa suy nghĩ (ReAct):** Cơ chế lõi của AI là ReAct (Reasoning and Acting). Nếu AI không biết API, nó sẽ tự dùng công cụ `run_shell_command` để gõ lệnh `ls` hoặc đọc file tài liệu trong dự án để tìm đường đi. Nó thực hiện vòng lặp: Đọc ngữ cảnh -> Suy nghĩ -> Gọi Tool (chạy lệnh) -> Đọc kết quả lệnh -> Suy nghĩ tiếp... cho đến khi xong việc.

---

## 5. Bảo Mật Thực Thi: Cơ Chế Sandbox

Khi Paperclip khởi chạy AI ở chế độ `--approval-mode yolo` (không cần người phê duyệt lệnh), điều này tiềm ẩn rủi ro rất lớn. Để đảm bảo an toàn, Adapter luôn tự động kích hoạt cờ `--sandbox` khi gọi Native CLI.

Tuy nhiên, **Paperclip không tự viết mã nguồn Sandbox**. Việc quản lý Sandbox tuân theo nguyên tắc ủy quyền:

### A. Môi trường Local (Máy cá nhân)
Paperclip chỉ truyền cờ `--sandbox` cho Native CLI (ví dụ: Antigravity CLI). CLI gốc này sẽ tự đảm nhận việc cô lập tiến trình ở tầng hệ điều hành:
- **Cô lập ổ đĩa (Filesystem Jail):** AI chỉ được đọc/ghi trong thư mục dự án (Workspace). Mọi lệnh chỉnh sửa file hệ thống đều bị chặn và báo lỗi Access Denied.
- **Cô lập mạng (Network Isolation):** Chặn AI tự ý kết nối Internet tải mã độc, chỉ mở các cổng nội bộ hợp lệ để giao tiếp.
- **Giới hạn quyền hạn (Privilege Drop):** Ngăn AI dùng các lệnh cần quyền quản trị cao cấp (sudo/admin).

### B. Môi trường Remote (Cloud)
Nếu triển khai ở môi trường doanh nghiệp thông qua các Plugin (ví dụ: `sandbox-providers/novita` hoặc `E2B`), Paperclip sẽ quản lý việc cấp phát các máy ảo (VM/Container) biệt lập hoàn toàn trên Cloud, đảm bảo môi trường thực thi của AI cách ly 100% khỏi máy chủ chính.

---

## 6. Luồng Thực Thi Chi Tiết (The Execution Flow)

Dưới đây là vòng đời của một Task từ lúc giao việc cho đến lúc AI hoàn thành:

1. **Khởi tạo (Paperclip UI):** Người dùng tạo một Issue trên giao diện (Vd: *"Tạo file README.md"*). Paperclip ném thông tin này cho `gemini-local` adapter.
2. **Chuẩn bị (Adapter `execute.ts`):** 
   - Lấy `PAPERCLIP_TASK_ID`, sinh ra `PAPERCLIP_API_KEY`.
   - Copy (symlink) các script kỹ năng (Skills) vào Sandbox của AI.
   - Ghép prompt yêu cầu của người dùng (`wakePrompt`) + prompt hướng dẫn dùng `curl`.
3. **Kích hoạt (CLI Start):** Adapter gõ lệnh khởi động Native CLI: `gemini --prompt "..." --output-format stream-json --sandbox`.
4. **Suy nghĩ (AI API - Google/Anthropic):** 
   - CLI gửi Prompt lên máy chủ AI.
   - AI đọc prompt, phân tích ngữ cảnh, thấy cần phải tạo file. Nó trả về JSON gọi Tool: `{"functionCall": {"name": "run_shell_command", "args": {"command": "echo '# Hello' > README.md"}}}`.
5. **Thực thi Công cụ (Sandbox):** CLI ở dưới máy tính nhận JSON, tự động mở Bash và chạy lệnh `echo`. Xong báo lại kết quả cho AI để nó nghĩ tiếp (Vòng lặp ReAct).
6. **Báo cáo lại Paperclip (Cập nhật Web):** 
   - Sau khi xong xuôi, AI nhớ lời dặn trong Prompt. Nó tự động gọi tiếp lệnh: `run_shell_command("scripts/paperclip-upload-artifact.sh README.md")` hoặc gõ `curl POST`.
   - Lệnh Bash này bắn một HTTP Request về lại Server Paperclip (cổng 3100). Paperclip nhận lệnh, đánh dấu Task Hoàn thành trên giao diện Web.
7. **Kết thúc:** Trả về tín hiệu `[DONE]`. Adapter đóng phiên làm việc.

---

## 7. Cấu trúc thư mục liên quan
- **`packages/adapters/<adapter-name>/src/server/execute.ts`**: Trái tim của việc cấu hình lệnh CLI, sinh biến môi trường, nhồi prompt (bao gồm cả `wakePrompt`) và tiêm Skills.
- **`packages/adapters/<adapter-name>/src/cli/format-event.ts`**: Nơi hứng và "phiên dịch" dòng dữ liệu JSON nhả ra từ AI thành log đẹp đẽ cho con người đọc trên Terminal.
- **`skills/paperclip/scripts/`**: Chứa các đoạn mã Bash làm nhiệm vụ "Tạp vụ" (Shipper) kết nối AI ngược về Paperclip API (như `paperclip-upload-artifact.sh`).
