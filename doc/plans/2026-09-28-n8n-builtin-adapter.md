# Plan Triển Khai n8n Runtime Thành Built-in Core Adapter

- **Ngày lập:** 2026-09-28
- **Mục tiêu:** Chuyển đổi module prototype `n8n-runtime-adapter` thành adapter tích hợp sẵn (**Built-in Core Adapter**) tại `packages/adapters/n8n-runtime` bên trong Paperclip monorepo.
- **Trạng thái:** Kế hoạch thực thi (Ready for Implementation)

---

## 1. Bối cảnh & Lý do chọn Built-in Adapter (Cách 1)

Thay vì tách thành repository riêng hoặc build thành 2 Docker container độc lập (gây phức tạp trong CI/CD, phân mảnh mạng và khó truyền stream log in-process):
- Đưa trực tiếp vào `packages/adapters/n8n-runtime` giúp adapter được biên dịch đồng bộ cùng Paperclip.
- Docker image của Paperclip chỉ cần build 1 lần là có sẵn adapter cho toàn bộ tổ chức sử dụng.
- Giao diện Paperclip hiển thị ngay lựa chọn **"n8n Runtime"** khi tạo hoặc cấu hình Agent.
- Dữ liệu log/event từ n8n được truyền qua context trực tiếp (`ctx.onLog`, `ctx.onEvent`) với độ trễ thấp và độ tin cậy cao nhất.

---

## 2. Các Bước Tiến Hành Chi Tiết

### Bước 1: Khởi tạo Git Branch riêng để thử nghiệm
Tạo và chuyển sang nhánh mới để cô lập toàn bộ thay đổi:
```bash
git checkout -b feat/n8n-builtin-adapter
```

---

### Bước 2: Di chuyển và chuẩn hóa cấu trúc Package (`packages/adapters/n8n-runtime`)
1. **Di chuyển thư mục:**
   - Chuyển toàn bộ nội dung từ `n8n-runtime-adapter/` sang `packages/adapters/n8n-runtime/`.
   - Xóa `node_modules` và `dist` cũ trước khi chuyển để tránh rác build.
2. **Cập nhật `packages/adapters/n8n-runtime/package.json`:**
   - Đổi tên: `"@paperclipai/adapter-n8n-runtime"`
   - Thiết lập chuẩn xuất khẩu (`exports`):
     - `.` -> `./src/index.ts`
     - `./server` -> `./src/server/index.ts`
     - `./ui` -> `./src/ui/index.ts`
     - `./ui-parser` -> `./dist/ui-parser.cjs`
   - Phụ thuộc: `"@paperclipai/adapter-utils": "workspace:*"`
3. **Cập nhật `pnpm-workspace.yaml`:**
   - Bỏ dòng `- n8n-runtime-adapter` ở root (vì pattern `packages/adapters/*` đã tự động nhận diện).

---

### Bước 3: Đấu nối Monorepo & TypeScript References
1. **Root `tsconfig.json`:**
   - Thêm project reference:
     ```json
     { "path": "./packages/adapters/n8n-runtime" }
     ```
2. **`server/package.json`:**
   - Thêm dependency: `"@paperclipai/adapter-n8n-runtime": "workspace:*"`
3. **`ui/package.json`:**
   - Thêm dependency: `"@paperclipai/adapter-n8n-runtime": "workspace:*"`

---

### Bước 4: Đăng ký Adapter vào Hệ Thống (Shared, Server, UI)

#### 4.1. Khai báo kiểu trong `@paperclipai/shared`
- File: [packages/shared/src/constants.ts](file:///c:/paperclip/packages/shared/src/constants.ts)
  - Thêm `"n8n_runtime"` vào hằng số `AGENT_ADAPTER_TYPES`.

#### 4.2. Đăng ký trên Server
- File: [server/src/adapters/builtin-adapter-types.ts](file:///c:/paperclip/server/src/adapters/builtin-adapter-types.ts)
  - Thêm `"n8n_runtime"` vào `BUILTIN_ADAPTER_TYPES`.
- File: [server/src/adapters/registry.ts](file:///c:/paperclip/server/src/adapters/registry.ts)
  - Import `execute`, `testEnvironment` từ `@paperclipai/adapter-n8n-runtime/server`.
  - Import `agentConfigurationDoc`, `models`, `type` từ `@paperclipai/adapter-n8n-runtime`.
  - Thêm đối tượng adapter vào mảng `serverAdapters`.

#### 4.3. Đăng ký trên UI
- File: [ui/src/adapters/adapter-display-registry.ts](file:///c:/paperclip/ui/src/adapters/adapter-display-registry.ts)
  - Đăng ký metadata hiển thị:
    ```ts
    n8n_runtime: {
      label: "n8n Runtime",
      description: "Trigger and monitor n8n workflows with real-time execution logs",
      icon: Workflow, // hoặc Bot/Cpu từ lucide-react
    }
    ```
- Thư mục: `ui/src/adapters/n8n-runtime/`
  - Tạo cấu hình UI adapter tương ứng (`index.ts`, `config-fields.tsx` hoặc tận dụng parser).
- File: [ui/src/adapters/registry.ts](file:///c:/paperclip/ui/src/adapters/registry.ts)
  - Đăng ký `n8nRuntimeUIAdapter` vào danh sách `registerBuiltInUIAdapters()`.

---

### Bước 5: Kiểm thử và Xác nhận (Verification)
1. Cài đặt lại liên kết workspace:
   ```bash
   pnpm install
   ```
2. Kiểm tra typecheck toàn dự án:
   ```bash
   pnpm -r typecheck
   ```
3. Build adapter:
   ```bash
   pnpm --filter @paperclipai/adapter-n8n-runtime build
   ```
4. Chạy môi trường dev và kiểm chứng thực tế:
   - Chạy server/UI Paperclip.
   - Mở modal **Create Agent** / **Edit Agent**: Xác nhận xuất hiện tuỳ chọn **"n8n Runtime"**.
   - Cấu hình Agent với Webhook URL và API Key của n8n.
   - Kích hoạt Run / Task: Xác nhận log từng Node của n8n nhảy thời gian thực trên tab Run của Paperclip.

---

## 3. Quản lý Rủi ro & Rollback
- Do toàn bộ thử nghiệm diễn ra trên nhánh `feat/n8n-builtin-adapter`, nhánh hiện tại và nhánh chính hoàn toàn không bị ảnh hưởng.
- Nếu cần hoàn tác, chỉ cần chuyển lại nhánh cũ hoặc xóa nhánh thử nghiệm.
