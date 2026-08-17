# BÁO CÁO TỔNG HỢP TRẢI NGHIỆM THỰC TẾ
# NỀN TẢNG QUẢN LÝ AGENT AI TỰ CHỦ — PAPERCLIP

> **Ngày thực hiện:** 28/07/2026  
> **Môi trường thử nghiệm:** Windows 11 (Local), Node.js, pnpm  
> **Mô hình AI sử dụng:** OpenAI Codex (`o4-mini`, `gpt-4o`), Gemini 2.0 Flash  
> **Phiên bản Paperclip:** Source code tự build (pnpm dev)

---

## MỤC LỤC

1. [Giới thiệu tổng quan về Paperclip](#1-giới-thiệu-tổng-quan)
2. [Kiến trúc hệ thống](#2-kiến-trúc-hệ-thống)
3. [Hướng dẫn cài đặt và chạy](#3-hướng-dẫn-cài-đặt-và-chạy)
4. [Cấu hình Agent AI](#4-cấu-hình-agent-ai)
5. [Thực nghiệm và kết quả](#5-thực-nghiệm-và-kết-quả)
6. [Các lỗi gặp phải và cách khắc phục](#6-các-lỗi-gặp-phải-và-cách-khắc-phục)
7. [Đánh giá ưu điểm và hạn chế](#7-đánh-giá-ưu-điểm-và-hạn-chế)
8. [So sánh các Execution Engine](#8-so-sánh-các-execution-engine)
9. [Kết luận và đề xuất](#9-kết-luận-và-đề-xuất)

---

## 1. GIỚI THIỆU TỔNG QUAN

### 1.1 Paperclip là gì?

**Paperclip** là một nền tảng mã nguồn mở cho phép xây dựng và vận hành một **"Công ty AI tự chủ" (Autonomous AI Company)** ngay trên máy tính cá nhân hoặc máy chủ của người dùng. Thay vì chỉ là một chatbot đơn giản trả lời câu hỏi, Paperclip cho phép:

- **Tạo ra nhiều Agent AI** đóng vai trò như các nhân sự trong công ty (CEO, Kỹ sư, Thiết kế viên...).
- **Giao Task (Nhiệm vụ)** cho từng Agent, theo dõi tiến độ thực thi và nhận báo cáo.
- **Tích hợp nhiều mô hình AI** khác nhau trên cùng một hệ thống: OpenAI Codex, Google Gemini, Anthropic Claude.
- Vận hành theo vòng lặp **"Agentic Loop"** — Agent tự suy nghĩ, tự lên kế hoạch, tự viết code, tự kiểm tra kết quả và báo cáo cho người dùng.

### 1.2 Mục tiêu của báo cáo

Báo cáo này tổng hợp toàn bộ quá trình cài đặt, cấu hình, chạy thử nghiệm thực tế Paperclip trên môi trường Windows, bao gồm:

- Ghi lại các bước thiết lập chi tiết từ đầu.
- Mô tả các lỗi thực tế phát sinh và cách xử lý.
- Đánh giá khả năng thực tế của hệ thống Agent AI tự chủ.

---

## 2. KIẾN TRÚC HỆ THỐNG

### 2.1 Sơ đồ tổng thể

```
┌─────────────────────────────────────────────────────────────┐
│                    PAPERCLIP PLATFORM                       │
│                                                             │
│  ┌──────────┐    ┌──────────────┐    ┌───────────────────┐  │
│  │  Web UI  │───▶│  API Server  │───▶│  PostgreSQL (DB)  │  │
│  │ :3100    │    │  (Node.js)   │    │  (Embedded)       │  │
│  └──────────┘    └──────────────┘    └───────────────────┘  │
│                         │                                   │
│              ┌──────────┼──────────┐                        │
│              ▼          ▼          ▼                        │
│       ┌────────┐  ┌────────┐  ┌────────┐                   │
│       │Codex   │  │Gemini  │  │Process │                   │
│       │Adapter │  │Adapter │  │Adapter │                   │
│       └────────┘  └────────┘  └────────┘                   │
│           │           │                                     │
│           ▼           ▼                                     │
│    ┌──────────┐  ┌──────────┐                              │
│    │OpenAI API│  │Google API│                              │
│    └──────────┘  └──────────┘                              │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Các thành phần chính

| Thành phần | Mô tả | Vai trò |
|---|---|---|
| **Web UI** | Giao diện quản lý tại `localhost:3100` | Bảng điều khiển trung tâm |
| **API Server** | Node.js, chạy bằng `tsx`/`pnpm dev` | Điều phối mọi hoạt động |
| **PostgreSQL** | Cơ sở dữ liệu nhúng (Embedded) | Lưu Agent, Task, Artifact |
| **Codex Adapter** | `packages/adapters/codex-local` | Kết nối OpenAI Codex CLI |
| **Gemini Adapter** | `packages/adapters/gemini-local` | Kết nối Google Gemini CLI |
| **ACP (Agent Client Protocol)** | Giao thức JSON-RPC qua stdin/stdout | Cầu nối giữa Server và CLI |

### 2.3 Mối quan hệ giữa các thành phần cốt lõi

```
Người dùng (Board)
      │
      ▼ (Giao task qua Web UI)
Paperclip Server
      │
      ├──▶ Codex Adapter ──▶ codex-acp (JSON-RPC) ──▶ OpenAI API
      │                             │
      │                      CODEX_HOME/auth.json
      │                      (Lưu OPENAI_API_KEY)
      │
      └──▶ Gemini Adapter ──▶ gemini-acp (JSON-RPC) ──▶ Google API
                                     │
                              GEMINI_API_KEY (env var)
```

**Điểm quan trọng:**
- `OPENAI_API_KEY` được truyền vào Codex thông qua file `auth.json` trong thư mục `CODEX_HOME`, **không phải** qua biến môi trường trực tiếp (từ phiên bản Codex >= 0.122).
- `GEMINI_API_KEY` được truyền trực tiếp qua biến môi trường.

---

## 3. HƯỚNG DẪN CÀI ĐẶT VÀ CHẠY

### 3.1 Yêu cầu tiên quyết

| Phần mềm | Phiên bản tối thiểu | Ghi chú |
|---|---|---|
| Node.js | >= 18.x | Cần cho toàn bộ hệ thống |
| pnpm | >= 9.x | Package manager chính |
| Git | Bất kỳ | Để clone source code |
| OpenAI API Key | - | Tài khoản có số dư credits |
| Gemini API Key | - | Tùy chọn, miễn phí |

> ⚠️ **LƯU Ý QUAN TRỌNG VỀ WINDOWS:** Tuyệt đối **không** đặt thư mục dự án ở đường dẫn có khoảng trắng (ví dụ: `C:\Users\LAPTOP HP\...`). Khoảng trắng trong đường dẫn sẽ gây lỗi trên các file `.cmd` wrapper mà `npm/pnpm` tạo ra, khiến các lệnh CLI bị vỡ khi chạy qua `cmd.exe`. Đây là lỗi phổ biến nhất trên môi trường Windows.

### 3.2 Bước 1 — Clone dự án vào thư mục sạch (Không khoảng trắng)

```powershell
# Tạo thư mục mới không có khoảng trắng
mkdir C:\paperclip

# Clone source code vào thư mục vừa tạo
git clone https://github.com/paperclip-ai/paperclip C:\paperclip
```

### 3.3 Bước 2 — Cài đặt các thư viện phụ thuộc

```powershell
cd C:\paperclip
pnpm install
```

**Kết quả mong đợi:**
```
Packages: +1308
Progress: resolved 1308, reused 1297, downloaded 0, added 1308, done
```

> **Lưu ý:** Các dòng `WARN Failed to create bin...` xuất hiện là **CẢNH BÁO bình thường**, không phải lỗi. Chúng liên quan đến các plugin mẫu chưa được build sẵn và không ảnh hưởng đến chức năng chính của Paperclip.

### 3.4 Bước 3 — Cài đặt công cụ CLI cho Agent

Để Agent AI có thể thực thi lệnh thực tế, cần cài thêm các công cụ CLI toàn cục:

```powershell
# Cài đặt Codex ACP (Bắt buộc cho Codex Agent)
npm install -g @agentclientprotocol/codex-acp @openai/codex

# Kiểm tra cài đặt thành công
where.exe codex-acp
codex-acp --version
```

### 3.5 Bước 4 — Đăng nhập Codex toàn cục (Một lần duy nhất)

Thay vì phải nhập API Key thủ công cho từng Agent, hãy đăng nhập toàn cục một lần:

```powershell
codex login
```

Lệnh này tạo file `C:\Users\<TenNguoiDung>\.codex\auth.json` chứa `OPENAI_API_KEY`, giúp tất cả Agent tự động xác thực mà không cần cấu hình thêm.

### 3.6 Bước 5 — Khởi động Paperclip

```powershell
cd C:\paperclip
pnpm dev
```

**Kết quả mong đợi sau 15-30 giây:**
```
[paperclip] dev mode: local_trusted (default)
[paperclip] Server listening at http://127.0.0.1:3100
```

Mở trình duyệt truy cập: **`http://localhost:3100`**

---

## 4. CẤU HÌNH AGENT AI

### 4.1 Tạo Company Secret (Chìa khóa toàn công ty)

Đây là bước **quan trọng nhất** để tất cả các Agent mới được bổ nhiệm sau này tự động thừa hưởng API Key mà không cần cấu hình thủ công:

1. Vào **Company Settings → Secrets**.
2. Nhấn **+ Create Secret**.
3. Điền:
   - **Who provides the value:** `Company`
   - **Name:** `OPENAI_API_KEY` (hoặc `GEMINI_API_KEY`)
   - **Value:** Dán mã key tương ứng.
4. Nhấn **Create**.

> Sau bước này, Secret sẽ hiển thị nhãn **`Company` + `Active`** — chứng tỏ đã là chìa khóa toàn cục cấp Công ty.

### 4.2 Cấu hình Agent (Ví dụ: Agent CEO dùng Codex)

| Trường | Giá trị khuyên dùng |
|---|---|
| **Adapter type** | `codex_local` (Codex) hoặc `gemini_local` (Gemini) |
| **Execution engine** | `Auto (ACP preferred)` |
| **Model** | `Default` hoặc `gpt-4o-mini` (tiết kiệm) |
| **Fast mode** | Tắt nếu muốn tiết kiệm token |
| **OPENAI_API_KEY** | Liên kết tới Secret `openai_api_key` (chọn kiểu `🔑`) |

### 4.3 Cấu hình Agent dùng Gemini (Miễn phí, khuyến nghị)

| Trường | Giá trị |
|---|---|
| **Adapter type** | `gemini_local` |
| **Execution engine** | `Auto (ACP preferred)` |
| **GEMINI_API_KEY** | Dán trực tiếp mã key `AIzaSy...` (chọn kiểu `T`) |
| **GEMINI_MODEL** | `gemini-2.0-flash` |

---

## 5. THỰC NGHIỆM VÀ KẾT QUẢ

### 5.1 Thử nghiệm 1: Giao nhiệm vụ "Tuyển dụng" cho Agent CEO

**Nhiệm vụ giao:** `TRU-1 — Hire your first engineer and create a hiring plan`

**Hành vi thực tế của Agent CEO:**

Agent CEO (chạy bằng OpenAI Codex) đã thực hiện các bước sau hoàn toàn tự động:

1. ✅ **Phân tích yêu cầu**: Đọc Task, xác định mục tiêu là tạo bản kế hoạch tuyển dụng.
2. ✅ **Tạo tài liệu `plan`**: Viết bản kế hoạch tuyển dụng chi tiết và lưu vào hệ thống dưới dạng Artifact.
3. ✅ **Bổ nhiệm nhân viên mới**: Tự động tạo Agent mới tên `Founding Engineer`.
4. ✅ **Ủy thác công việc (Delegation)**: Tự động tạo ra 4 Sub-task con và phân công cho `Founding Engineer`:
   - `TRU-2`: Draft technical roadmap (Lộ trình kỹ thuật 30 ngày)
   - `TRU-3`: Build MVP content operations pipeline
   - `TRU-4`: Define content analytics schema and dashboard
   - `TRU-5`: Automate first repeatable distribution workflow
5. ✅ **Báo cáo kết quả**: Viết comment tổng kết lên Task `TRU-1` và đánh dấu `Done`.

**Kết quả:** Agent CEO đã hoàn thành nhiệm vụ cấp cao một cách cực kỳ chuyên nghiệp — đúng như vai trò một Giám đốc điều hành thực sự.

### 5.2 Thử nghiệm 2: Cơ chế tự khôi phục (Auto-Recovery)

**Tình huống phát sinh:** Trong lúc Agent đang thực thi, lượt chạy bị ngắt do lỗi xác thực OpenAI (Quota exceeded / Authentication required).

**Hành vi của hệ thống:**

1. Paperclip **tự động phát hiện** lượt chạy bị ngắt giữa chừng.
2. Hệ thống **tự động thử chạy lại (Auto-Retry)** một lần để cứu lượt thực thi.
3. Nếu lần thử lại cũng thất bại, hệ thống tự động **chuyển Task về `Blocked`** và gửi thông báo tới người dùng.
4. Agent CEO khi nhận được thông báo sẽ **tự kiểm tra lại kho tài liệu (Artifacts)** — nếu sản phẩm đã có sẵn thì CEO chủ động khôi phục Task về `Done` mà **không chạy lại thừa**.

**Nhận xét:** Đây là một cơ chế tự chủ cực kỳ thông minh và tiết kiệm tài nguyên. Agent không chỉ đơn thuần thực thi mà còn biết tự kiểm tra kết quả và đưa ra quyết định phù hợp.

### 5.3 Thử nghiệm 3: Cơ chế quay lại cập nhật Task cũ

**Tình huống:** Agent đang làm Sub-task mới nhưng phát hiện cần cập nhật thông tin cho Sub-task cũ đã `Done`.

**Kết quả xác nhận:** Agent có đầy đủ quyền truy cập API để quay lại bình luận và cập nhật bất kỳ Task cũ nào trong cùng dự án. Ví dụ thực tế: CEO đã nhiều lần quay lại Task `TRU-2` để xác nhận và cập nhật trạng thái.

---

## 6. CÁC LỖI GẶP PHẢI VÀ CÁCH KHẮC PHỤC

### 6.1 Lỗi khoảng trắng trong đường dẫn Windows

| Thông tin | Chi tiết |
|---|---|
| **Thông báo lỗi** | `Failed to spawn agent command: ...\codex-acp.cmd` |
| **Nguyên nhân** | Đường dẫn `C:\Users\LAPTOP HP\...` có khoảng trắng khiến file `.cmd` của npm bị vỡ khi chạy qua `cmd.exe` |
| **Giải pháp** | Chuyển toàn bộ dự án sang thư mục không có khoảng trắng: `C:\paperclip` |
| **Mức độ** | ⚠️ Nghiêm trọng — Không thể vận hành nếu chưa xử lý |

### 6.2 Lỗi Authentication required (Không tìm thấy auth.json)

| Thông tin | Chi tiết |
|---|---|
| **Thông báo lỗi** | `Authentication required / no Codex credentials available` |
| **Nguyên nhân** | Agent mới được tạo chưa có file `auth.json` trong thư mục `CODEX_HOME`. Codex CLI >= 0.122 bắt buộc phải đọc file này thay vì dùng biến môi trường đơn thuần |
| **Giải pháp** | Chạy `codex login` một lần duy nhất trên Terminal, hoặc gán Secret `OPENAI_API_KEY` theo đúng kiểu `🔑` trong cấu hình Agent |
| **Mức độ** | ⚠️ Phổ biến — Xảy ra với mọi Agent mới |

### 6.3 Lỗi Quota exceeded (Hết số dư OpenAI)

| Thông tin | Chi tiết |
|---|---|
| **Thông báo lỗi** | `Quota exceeded. Check your plan and billing details.` |
| **Nguyên nhân** | Tài khoản OpenAI hết credits hoặc chưa bật thanh toán |
| **Giải pháp 1** | Nạp thêm tiền tại `platform.openai.com` |
| **Giải pháp 2** | Chuyển Agent sang dùng Gemini 2.0 Flash (Miễn phí) |
| **Mức độ** | ℹ️ Tài khoản — Không liên quan đến lỗi phần mềm |

### 6.4 Lỗi Process adapter missing command

| Thông tin | Chi tiết |
|---|---|
| **Thông báo lỗi** | `Process adapter missing command` |
| **Nguyên nhân** | Agent đang chọn loại Adapter là `process` nhưng chưa điền câu lệnh vào ô `Command` |
| **Giải pháp** | Vào Configuration, đổi Adapter type từ `process` sang `codex_local` hoặc `gemini_local` |
| **Mức độ** | ℹ️ Cấu hình nhầm — Dễ xử lý |

### 6.5 Lỗi Failed to start embedded PostgreSQL

| Thông tin | Chi tiết |
|---|---|
| **Thông báo lỗi** | `Failed to start embedded PostgreSQL... could not open file pg_control` |
| **Nguyên nhân** | Thư mục dữ liệu PostgreSQL (`~/.paperclip/...`) bị xóa dở dang trong khi tiến trình Postgres còn đang chạy ngầm, khiến dữ liệu bị thiếu file khởi tạo |
| **Giải pháp** | Tắt tiến trình Postgres ngầm, xóa sạch thư mục `~/.paperclip` và khởi động lại `pnpm dev` |
| **Mức độ** | ⚠️ Cần xử lý đúng trình tự |

---

## 7. ĐÁNH GIÁ ƯU ĐIỂM VÀ HẠN CHẾ

### 7.1 Ưu điểm nổi bật

✅ **Kiến trúc Agent tự chủ thực sự**: Agent không chỉ trả lời câu hỏi mà còn tự lên kế hoạch, tự tạo Sub-task, tự ủy quyền, tự báo cáo — đúng như một nhân viên thực thụ.

✅ **Hỗ trợ đa mô hình AI**: Có thể dùng OpenAI Codex, Google Gemini và Claude trên cùng một hệ thống mà không cần thay đổi code dự án.

✅ **Cơ chế tự khôi phục (Auto-Recovery) thông minh**: Hệ thống tự phát hiện lỗi, tự thử lại và tự chuyển Task về trạng thái phù hợp với thông báo rõ ràng cho người dùng.

✅ **Theo dõi chi phí Token thực tế**: Ghi lại chính xác số lượng Input / Output / Cached token cho từng lượt chạy.

✅ **Hệ thống Secret quản lý an toàn**: Secret được mã hóa (`Local encrypted`) và có thể chia sẻ cấp Công ty hoặc cấp Cá nhân.

✅ **Giao diện Web UI trực quan**: Dashboard tổng quan, lịch sử chạy, nhật ký đầy đủ, bộ lọc thông minh.

✅ **Mã nguồn mở hoàn toàn**: Có thể tự build, chỉnh sửa và mở rộng theo nhu cầu.

### 7.2 Hạn chế và điểm cần cải thiện

❌ **Khó cài đặt trên Windows**: Vấn đề khoảng trắng trong đường dẫn, thiếu `sh` shell, lỗi file `.cmd` wrapper là những rào cản kỹ thuật đáng kể với người dùng Windows chưa có kinh nghiệm lập trình.

❌ **Mỗi Agent mới phải cấu hình thủ công**: Dù đã có Company Secret, việc liên kết Secret vào từng Agent mới vẫn phải thực hiện thủ công trong lần đầu.

❌ **Hiện tượng "Auto-Ack Loop"**: Khi Task đã hoàn thành nhưng hệ thống vẫn tiếp tục gửi thông báo và đánh thức Agent, dẫn đến vòng lặp xác nhận qua lại lãng phí token (đặc biệt rõ ở Task `TRU-2`).

❌ **Codex sinh ra văn bản suy luận dài dòng**: Model Codex có xu hướng "nói nhẩm" toàn bộ Chain of Thought vào nhật ký, khiến log bị rối. Cần thêm instruction ngắn gọn trong System Prompt.

❌ **Phụ thuộc vào số dư tài khoản**: Tất cả tính năng AI phụ thuộc hoàn toàn vào tài khoản OpenAI/Gemini có số dư. Hết credits là toàn bộ hệ thống dừng.

---

## 8. SO SÁNH CÁC EXECUTION ENGINE

| Tiêu chí | Auto (ACP preferred) | Codex CLI | Gemini CLI |
|---|---|---|---|
| **Cách thức** | Node.js gọi ACP JSON-RPC qua stdin/stdout | Gọi trực tiếp lệnh `codex` | Gọi trực tiếp lệnh `gemini` |
| **Khởi động** | Nhanh, không qua `cmd.exe` | Phụ thuộc shell `sh` (không có trên Windows) | Phụ thuộc shell `sh` |
| **Phù hợp Windows** | ✅ Tốt nhất | ❌ Lỗi thiếu `sh` | ❌ Lỗi thiếu `sh` |
| **Khuyến nghị** | ✅ **Dùng cái này** | ⚠️ Chỉ trên Linux/Mac | ⚠️ Chỉ trên Linux/Mac |

### Khuyến nghị Engine

> **Trên Windows:** Luôn chọn **`Auto (ACP preferred)`** — Đây là lựa chọn duy nhất hoạt động ổn định 100% trên Windows vì không yêu cầu shell `sh`.

---

## 9. KẾT LUẬN VÀ ĐỀ XUẤT

### 9.1 Kết luận chung

Sau quá trình trải nghiệm thực tế, Paperclip đã chứng minh được khả năng vận hành một hệ thống Agent AI tự chủ ở mức độ thực tế và ấn tượng. Đặc biệt, tính năng CEO tự động phân công công việc, tạo tài liệu, ủy quyền cho nhân viên cấp dưới và tự khôi phục lỗi là những điểm nhấn kỹ thuật xuất sắc.

Tuy nhiên, trải nghiệm cài đặt và cấu hình trên **Windows** còn nhiều rào cản kỹ thuật cần cải thiện đáng kể, đặc biệt là:

1. Vấn đề khoảng trắng trong đường dẫn.
2. Cơ chế tự động seed `auth.json` cho Agent mới còn thiếu nhất quán.

### 9.2 Đề xuất cho môi trường Production

| Đề xuất | Mô tả |
|---|---|
| **Dùng Linux/Docker** | Môi trường Linux hoàn toàn không gặp vấn đề khoảng trắng và `sh` shell. Paperclip hoạt động mượt mà nhất trên Linux. |
| **Dùng Gemini 2.0 Flash** | Miễn phí, phản hồi ngắn gọn hơn Codex, không có hiện tượng "nói nhẩm" dài dòng. |
| **Thiết lập Company Secret ngay từ đầu** | Tạo `OPENAI_API_KEY` hoặc `GEMINI_API_KEY` ở cấp Company trước khi tạo bất kỳ Agent nào. |
| **Thêm instruction ngắn gọn** | Thêm câu `Be concise and direct. Keep status updates under 2 sentences.` vào System Prompt của mọi Agent. |
| **Giới hạn số lượng Heartbeat** | Đặt `timeoutSec` phù hợp để tránh Agent chạy vòng lặp vô tận tốn token. |

### 9.3 Đánh giá tổng thể

| Tiêu chí | Điểm (10) |
|---|---|
| Khả năng Agent tự chủ | 9/10 |
| Tính năng quản lý Task | 8/10 |
| Dễ cài đặt (Windows) | 5/10 |
| Dễ cài đặt (Linux) | 8/10 |
| Tích hợp đa mô hình AI | 9/10 |
| Cơ chế bảo mật Secret | 8/10 |
| Giao diện Web UI | 8/10 |
| Tài liệu hướng dẫn | 6/10 |
| **Tổng bình quân** | **7.6/10** |

---

## PHỤ LỤC

### A. Danh sách lệnh thường dùng

```powershell
# Khởi động Paperclip
pnpm dev

# Xóa dữ liệu cũ và reset hoàn toàn
Remove-Item -Path "$env:USERPROFILE\.paperclip" -Recurse -Force

# Đăng nhập Codex toàn cục (1 lần duy nhất)
codex login

# Kiểm tra codex-acp đã cài chưa
where.exe codex-acp
codex-acp --version

# Cài đặt lại codex-acp nếu cần
npm install -g @agentclientprotocol/codex-acp @openai/codex
```

### B. Cấu trúc thư mục dữ liệu Paperclip

```
C:\Users\<TenNguoiDung>\.paperclip\
└── instances\
    └── default\
        ├── db\                  # PostgreSQL data
        ├── secrets\             # Mã hóa secrets (master.key)
        └── companies\
            └── <companyId>\
                ├── codex-home\  # auth.json của Company
                └── agents\
                    └── <agentId>\
                        └── codex-home\  # auth.json của Agent
```

### C. Cấu trúc file `auth.json`

```json
{
  "OPENAI_API_KEY": "sk-proj-..."
}
```

---

*Báo cáo được tổng hợp dựa trên trải nghiệm thực tế ngày 28/07/2026.*  
*Mọi thông tin trong báo cáo phản ánh đúng trạng thái hệ thống tại thời điểm thử nghiệm.*
