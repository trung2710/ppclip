# 📊 Báo Cáo Kỹ Thuật: So Sánh HTTP Bridge vs. External Adapter Plugin Tích Hợp n8n Với Paperclip

- **Ngày lập báo cáo:** 17/08/2026
- **Mục tiêu:** Đánh giá, so sánh kiến trúc và phân tích chi tiết hai hướng tiếp cận kết nối **Paperclip (Control Plane)** với **n8n (Execution Runtime)** để theo dõi log/trace theo thời gian thực.

---

## 1. Bối Cảnh & Mục Tiêu Kỹ Thuật

Paperclip đóng vai trò là **Control Plane** (quản lý Agent, Issue/Task, Heartbeat Runs, Quyền hạn, Chi phí và Audit Logs). n8n đóng vai trò là **Execution Runtime** (thực thi các luồng tự động hoá, tích hợp công cụ bên ngoài và AI Agent).

**Yêu cầu kỹ thuật đặt ra:**
1. Hiển thị tiến trình thực thi của n8n theo thời gian thực (Real-time Trace).
2. Nắm bắt thông tin từng Node trong n8n (Tên node, thời gian chạy `durationMs`, Input/Output tóm tắt, trạng thái lỗi).
3. Không làm thay đổi hay làm bẩn đồ thị Workflow n8n có sẵn (Zero-node modification).
4. Giữ vững các nguyên lý bất biến (Control-plane invariants) của Paperclip: Task checkout, Budget hard-stop, Agent API key authz.

---

## 2. Phân Tích Chi Tiết 2 Giải Pháp Kiến Trúc

```mermaid
graph TD
    subgraph Solution1 [Giải pháp 1: HTTP Bridge (Out-of-Process)]
        PC1[Paperclip Server] -->|HTTP Request /run| BR[Bridge Service Node.js :3005]
        BR -->|Trigger Webhook| N8N1[n8n Workflow Runtime]
        N8N1 -.->|Poll Execution API| BR
        BR -->|HTTP Chunked Stream| PC1
    end

    subgraph Solution2 [Giải pháp 2: External Adapter Plugin (In-Process)]
        PC2[Paperclip Server] -->|In-Memory execute ctx| PL[n8n Adapter Plugin]
        PL -->|Direct API / Webhook| N8N2[n8n Workflow Runtime]
        PL -->|ctx.onEvent & ctx.onLog| PC2
    end
```

---

### 🟢 GIẢI PHÁP 1: HTTP Adapter + Standalone Bridge Service

Duy trì một dịch vụ trung gian độc lập (`bridge.js`) chạy ở cổng riêng (ví dụ `3005`).

#### Cơ chế hoạt động:
1. Paperclip gọi `POST http://localhost:3005/run` qua HTTP Adapter và giữ kết nối mở.
2. Bridge sinh `traceId`, gắn vào payload và kích hoạt n8n Webhook.
3. Bridge tìm `executionId` tương ứng và thực hiện polling `GET /api/v1/executions/{id}?includeData=true` định kỳ `1000ms`.
4. Bridge lọc trùng (`makeNodeRunKey`), làm sạch dữ liệu nhạy cảm (`redact`), tóm tắt output (`summarizeNodeOutput`) và dùng `res.write()` đẩy các dòng JSON Lines (NDJSON) về Paperclip.
5. Paperclip (`server/src/adapters/http/execute.ts`) đọc luồng `res.body.getReader()` và gọi `ctx.onLog("stdout", chunk)` in ra Terminal.

#### Ưu điểm:
- **Thời gian triển khai cực nhanh (Zero Paperclip codebase modifications)**: Không cần sửa hay compile lại mã nguồn Paperclip.
- **Zero Dependencies**: Viết thuần bằng Node.js core modules (`node:http`, `fetch`), dễ chạy và kiểm thử độc lập.
- **Phù hợp tuyệt đối cho giai đoạn Prototype**: Đáp ứng ngay nhu cầu xem log từng node.

#### Hạn chế:
- **Vận hành phân mảnh**: Phải duy trì chạy thêm 1 service phụ (`bridge.js` port 3005), cần quản lý restart/PM2.
- **Giao diện thô**: Dữ liệu chỉ được đưa vào luồng `ctx.onLog`, hiển thị dạng chữ trong cửa sổ đen Terminal; không tạo được thẻ sự kiện Card/Progress Bar.
- **Khó dừng khẩn cấp (Cancel)**: Khi bấm "Stop Run" trên Paperclip UI, Paperclip chỉ ngắt kết nối HTTP với Bridge, n8n bên dưới có thể vẫn chạy ngầm.

---

### 🔵 GIẢI PHÁP 2: External Adapter Plugin Chuyên Dụng

Xây dựng một Package Adapter Plugin bằng TypeScript và nạp trực tiếp vào tiến trình Paperclip (`~/.paperclip/adapter-plugins.json` hoặc `packages/plugins/`).

#### Cơ chế hoạt động:
1. Khi khởi động, Paperclip nạp Plugin trực tiếp vào bộ nhớ RAM (`createServerAdapter`).
2. Khi giao việc, Paperclip gọi thẳng `adapter.execute(ctx)`.
3. Plugin trực tiếp kích hoạt n8n, theo dõi tiến độ và gọi trực tiếp các hàm Native của Paperclip:
   - `ctx.onLog(stream, chunk)`: Stream log thô.
   - `ctx.onEvent(structuredEvent)`: Lưu sự kiện có cấu trúc vào bảng `heartbeat_run_events` trong Database.
   - `ctx.onRuntimeProgress(progress)`: Cập nhật thanh % tiến độ trực tiếp trên UI.
4. Cung cấp hàm `cancelRun()`: Khi người dùng bấm Stop trên UI, Plugin gọi API n8n để hủy (`abort`) ngay lập tức execution đang chạy.

#### Ưu điểm:
- **Trải nghiệm Native cao cấp**: Hiển thị Card, Step, Accordion, Progress Bar theo thời gian thực tương tự như các Agent tích hợp sẵn (Codex, Gemini, Claude, Hermes).
- **Hạ tầng gọn nhẹ**: 1 tiến trình duy nhất (Paperclip Server), không cần service ngoài, không lo đứt gãy kết nối giữa chừng.
- **Kiểm soát toàn diện**: Hỗ trợ đầy đủ vòng đời Run: Bắt đầu, Tạm dừng, Hủy bỏ, Phân tích lỗi, Retry tự động.

#### Hạn chế:
- **Độ phức tạp kỹ thuật cao hơn**: Đòi hỏi lập trình TypeScript theo đúng chuẩn Plugin System của Paperclip (`@paperclipai/adapter-utils`).

---

## 3. Bảng Ma Trận So Sánh Toàn Diện (Comparison Matrix)

| Tiêu chí đánh giá | Giải pháp 1: HTTP Bridge (Hiện tại) | Giải pháp 2: External Adapter Plugin |
| :--- | :--- | :--- |
| **Kiến trúc triển khai** | Out-of-Process (2 services độc lập) | **In-Process (Nhúng trực tiếp trong Paperclip)** |
| **Quản lý hạ tầng** | Phải quản lý thêm tiến trình `bridge.js` (Port 3005) | **Gọn nhẹ**: Đi kèm Paperclip, không cần mở port phụ |
| **Giao diện hiển thị (UI)** | Text thô trong cửa sổ đen Terminal (Transcript) | **Giao diện giàu tính năng**: Card, Steps, Progress Bar |
| **Sự kiện có cấu trúc** | ❌ Không (`ctx.onEvent` không khả dụng) | ✅ **Có** (Lưu vào bảng DB `heartbeat_run_events`) |
| **Thanh tiến độ Live** | ❌ Không có | ✅ **Có** (Thông qua `ctx.onRuntimeProgress`) |
| **Xử lý nút "Stop Run"** | ⚠️ Khó dừng n8n khi ngắt kết nối HTTP | ✅ **Hủy tức thì**: Gọi API n8n abort execution ngay |
| **Độ trễ truyền log** | Độ trễ polling (khoảng `1000ms`) | **Tối ưu**: Giao tiếp nội bộ trực tiếp |
| **Mức độ phụ thuộc** | Dễ vỡ nếu Bridge crash | Rất ổn định, theo sát vòng đời của Paperclip |
| **Mức độ sẵn sàng** | **Đã hoàn thành và chạy được ngay** | Cần thời gian viết và đóng gói package |

---

## 4. Đánh Giá & Khuyến Nghị Kỹ Thuật (Recommendations)

### 📌 Giai đoạn 1 (Ngắn hạn - Khuyên dùng hiện tại):
- **Tiếp tục sử dụng giải pháp HTTP Bridge** mà bạn vừa hoàn thành tại thư mục [`C:\paperclip\n8n-bridge\`](file:///C:/paperclip/n8n-bridge/).
- Giải pháp này đã xử lý trọn vẹn 95% nghiệp vụ (Deduplication, TraceId matching, Redaction, Output Summarization) và cho phép bạn nghiệm thu ngay luồng hiển thị log n8n trên Paperclip.

### 📌 Giai đoạn 2 (Dài hạn - Nâng cấp sản phẩm hoàn chỉnh):
- Chuyển đổi mã nguồn xử lý từ `bridge.js` sang một Package **External Adapter Plugin** (`packages/adapters/n8n`).
- Tận dụng các hàm `ctx.onEvent` và `cancelRun` để đưa n8n trở thành một Agent Adapter chuẩn mực của Paperclip với trải nghiệm người dùng cao cấp nhất.
