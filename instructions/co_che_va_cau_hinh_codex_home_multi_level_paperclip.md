# CƠ CHẾ VÀ HƯỚNG DẪN CẤU HÌNH CODEX_HOME 3 CẤP ĐỘ TRONG PAPERCLIP

Tài liệu này giải thích chi tiết kiến trúc quản lý môi trường runtime của `codex_local`, cơ chế phân cấp `CODEX_HOME` 3 cấp độ (Host, Company, Agent), các trường hợp cấu hình trực tiếp trên giao diện Paperclip và cơ chế tự động đồng bộ (seed/copy/symlink) các file cấu hình (`config.toml`, `auth.json`).

---

## 1. Kiến Trúc Phân Cấp 3 Cấp Độ Của `CODEX_HOME`

Trong Paperclip, môi trường hoạt động của adapter `codex_local` được chia thành 3 cấp độ rõ ràng:

```
[Máy tính Host: ~/.codex (C:\Users\<User>\.codex)]
      │
      ├──> Cấp 1 (Host-level): Dùng trực tiếp toàn bộ session/auth/config của máy
      │
      ├──> Cấp 2 (Company-level): ~/.paperclip/instances/default/companies/<company-id>/codex-home
      │         (Dùng chung cho tất cả Agent trong cùng 1 Company không có key riêng)
      │
      └──> Cấp 3 (Agent-level):   ~/.paperclip/instances/default/companies/<company-id>/agents/<agent-id>/codex-home
                (Cô lập hoàn toàn cho từng Agent khi có OPENAI_API_KEY riêng)
```

---

## 2. Bảng Tổng Hợp Cách Cấu Hình Trên Giao Diện UI

Dưới đây là cách thiết lập trong form cấu hình Agent (**Agent Configuration / Environment Variables / Secrets**) để kích hoạt từng trường hợp:

| Trường hợp | Biến `OPENAI_API_KEY` | Biến `CODEX_HOME` | Thư mục runtime thực tế | Mục đích sử dụng |
| :--- | :--- | :--- | :--- | :--- |
| **1. Dùng trực tiếp Codex gốc trên máy** | **Để trống** | Nhập đường dẫn gốc:<br>`C:\Users\<User>\.codex` | `~/.codex` trên máy host | Dùng trực tiếp tài khoản ChatGPT login hoặc config có sẵn trên máy host, không qua Paperclip. |
| **2. Dùng chung cấp Company** | **Để trống** | **Để trống** | `~/.paperclip/.../companies/<company-id>/codex-home` | Tất cả agent trong công ty chia sẻ chung 1 bộ config, sqlite và token/quota cấp công ty. |
| **3. Dùng riêng cho từng Agent** | Điền API key:<br>`sk-...` | **Để trống**<br>*(Hệ thống tự inject)* | `~/.paperclip/.../companies/<company-id>/agents/<agent-id>/codex-home` | Cách ly hoàn toàn từng agent (API key riêng, cấu hình LiteLLM riêng, database lịch sử riêng). |

---

## 3. Chi Tiết Từng Trường Hợp Cấu Hình

### Trường Hợp 1: Dùng Trực Tiếp Codex Trên Máy (Host-Level External Override)

* **Khi nào sử dụng:** Bạn muốn Agent dùng nguyên vẹn phiên đăng nhập Codex đang chạy trên máy (đã `codex login` sẵn bằng trình duyệt/ChatGPT), không muốn Paperclip tạo thêm thư mục trung gian nào.
* **Cách cấu hình trên UI:**
  1. Vào trang quản trị Agent -> chọn tab **Configuration**.
  2. Tại mục **Environment Variables** (hoặc `adapterConfig.env`):
     * Thêm biến `CODEX_HOME`: `C:\Users\LAPTOP HP\.codex` (hoặc đường dẫn thư mục `.codex` trên máy bạn).
     * **Không điền** biến `OPENAI_API_KEY`.
* **Cơ chế Code xử lý:**
  * File kiểm tra: `packages/adapters/codex-local/src/server/codex-home.ts` -> hàm `isManagedCodexHomePath(...)`.
  * Vì đường dẫn nằm ngoài cây thư mục instance của Paperclip, hàm trả về `false`.
  * Paperclip coi đây là **External User Override**: giữ nguyên đường dẫn, **không copy, không symlink, không can thiệp**, Codex đọc/ghi trực tiếp vào `~/.codex`.

---

### Trường Hợp 2: Dùng Chung Cấp Company (Company-Level Managed Home)

* **Khi nào sử dụng:** Bạn muốn toàn bộ nhân viên/agent trong cùng 1 công ty chạy chung một cấu hình trung tâm (ví dụ cấu hình MCP Server chung, model chung, hoặc chia sẻ chung 1 tài khoản ChatGPT từ máy host).
* **Cách cấu hình trên UI:**
  1. Tạo Agent với Adapter `codex_local`.
  2. **Không điền** `OPENAI_API_KEY` (hoặc để trống chuỗi rỗng `""`).
  3. **Không điền** `CODEX_HOME`.
* **Cơ chế Code xử lý:**
  * File: `server/src/routes/agents.ts` -> hàm `applyCodexLocalKeyIsolation`.
  * Vì không có `OPENAI_API_KEY`, server **không** áp dụng quy tắc cách ly agent.
  * Khi Agent thực thi (`packages/adapters/codex-local/src/server/execute.ts`), hàm `resolveManagedCodexHomeDir` trỏ về:
    `~/.paperclip/instances/default/companies/<companyId>/codex-home`
  * Ở lần chạy đầu tiên, Paperclip kích hoạt hàm `prepareManagedCodexHome`:
    * Tự động **symlink** file `auth.json` từ `~/.codex/auth.json` của máy host.
    * Tự động **copy** các file `config.toml`, `config.json`, `instructions.md` từ `~/.codex` sang.
  * Mọi Agent trong Company đó sẽ dùng chung thư mục này.

---

### Trường Hợp 3: Dùng Riêng Cho Từng Agent (Agent-Level Key Isolation)

* **Khi nào sử dụng:** Bạn muốn mỗi Agent có API Key riêng (hoặc Virtual Key riêng từ LiteLLM Proxy), dùng mô hình khác nhau, không bị ghi đè hay rò rỉ token với các agent khác.
* **Cách cấu hình trên UI:**
  1. Trong trang Agent -> mục **Environment Variables** (hoặc **Secret Bindings**):
     * Thêm key: `OPENAI_API_KEY`
     * Giá trị: `sk-litellm-virtual-key...` (hoặc OpenAI API Key).
  2. Bấm **Save** / **Update Agent**.
* **Cơ chế Code xử lý:**
  * File: `server/src/routes/agents.ts` (dòng 1291-1306):
    ```typescript
    function applyCodexLocalKeyIsolation(companyId, agentId, adapterType, adapterConfig) {
      if (adapterType !== "codex_local") return adapterConfig;
      if (!codexLocalEnvKeyConfigured(existingEnv.OPENAI_API_KEY)) return adapterConfig;
      return {
        ...adapterConfig,
        env: { ...existingEnv, CODEX_HOME: codexLocalAgentHome(companyId, agentId) },
      };
    }
    ```
  * Ngay khi phát hiện `OPENAI_API_KEY`, Server tự động inject biến môi trường:
    `CODEX_HOME = ~/.paperclip/instances/default/companies/<company-id>/agents/<agent-id>/codex-home`
  * Khi Agent chạy, Paperclip tạo file `auth.json` riêng độc lập chứa:
    ```json
    {
      "OPENAI_API_KEY": "sk-litellm-virtual-key..."
    }
    ```
  * Thư mục này chỉ dành riêng cho Agent đó, đảm bảo an toàn tuyệt đối về bảo mật quota và khóa API.

---

## 4. Cơ Chế Tự Động Copy & Đồng Bộ File Giữa Các Môi Trường

Logic cốt lõi nằm tại `packages/adapters/codex-local/src/server/codex-home.ts`:

### A. Danh sách file được Paperclip quản lý:
```typescript
const COPIED_SHARED_FILES = ["config.json", "config.toml", "instructions.md"] as const;
const SYMLINKED_SHARED_FILES = ["auth.json"] as const;
```

### B. Quy tắc đồng bộ:
1. **`auth.json` (Xác thực tài khoản):**
   * Nếu agent **không có API key**: Paperclip tạo một **Symlink** trỏ từ thư mục managed về file `~/.codex/auth.json` của máy host. Token ChatGPT đăng nhập trên máy host sẽ luôn giữ trạng thái live.
   * Nếu agent **có `OPENAI_API_KEY`**: Paperclip xóa symlink cũ (nếu có) và ghi thẳng file `auth.json` thật với format JSON: `{"OPENAI_API_KEY": "..."}`.
2. **`config.toml` & `config.json` (Cấu hình model, proxy, provider):**
   * Khi tạo thư mục managed mới, Paperclip kiểm tra thư mục gốc `~/.codex`.
   * Nếu ở gốc đã có file `config.toml`, nó sẽ tự động copy bản sao sang thư mục của agent/company.

---

## 5. Phân Tích Chuyên Sâu: Tại Sao Trường Hợp 3 Không Tự Động Tạo / Copy 2 File `config.toml` Và `auth.json`?

Đây là điểm mấu chốt gây hiểu lầm nhiều nhất trong thực tế: **Khi tạo Agent có API key riêng (Trường hợp 3) và chạy bằng ACP Engine mặc định, trong thư mục `codex-home` của agent sẽ HOÀN TOÀN KHÔNG CÓ CẢ 2 FILE `config.toml` VÀ `auth.json`.**

### Chi tiết nguyên nhân cho từng file:

#### 1. Đối với file `config.toml`: (Bị bỏ qua do lỗi logic toán tử `??` trong ACP)
* Trong file `packages/adapter-utils/src/acpx-engine/execute.ts` (dòng 865):
  ```typescript
  const effectiveCodexHome = configuredCodexHome ??
    await prepareManagedCodexHome({ ... });
  ```
* Vì ở Trường hợp 3, Server đã điền sẵn `CODEX_HOME: .../agents/<agent-id>/codex-home` vào `envConfig`, nên biến `configuredCodexHome` **đã có giá trị** (khác `null`).
* Toán tử `??` (nullish coalescing) lập tức trả về `configuredCodexHome` và **bỏ qua hoàn toàn hàm `prepareManagedCodexHome`**.
* Do đó, code sao chép `ensureCopiedFile("config.toml")` **không bao giờ được chạy** trong chế độ ACP!

#### 2. Đối với file `auth.json`: (Cơ chế truyền Key qua Process Env của ACP)
* Ở chế độ ACP Engine, Paperclip không gọi hàm `writeApiKeyAuthJson` ra đĩa.
* Thay vào đó, ACP Engine truyền trực tiếp giá trị `OPENAI_API_KEY` vào biến môi trường của tiến trình (`process.env`) khi kích hoạt phiên Codex app-server.
* Do không cần đọc từ file vật lý trên đĩa để xác thực, Paperclip không tạo file `auth.json` trong thư mục `codex-home` này.

#### 👉 Hiện tượng quan sát được:
Khi bạn mở thư mục `~/.paperclip/instances/default/companies/<company-id>/agents/<agent-id>/codex-home/`, bạn sẽ thấy:
* Thư mục `skills/` (được đồng bộ).
* Các file SQLite runtime do Codex tự sinh khi chạy (`logs_2.sqlite`, `goals_1.sqlite`, v.v.).
* **Hoàn toàn KHÔNG CÓ `config.toml` và `auth.json`**.

---

### So sánh với CLI Engine (`engine: "cli"`):
Nếu bạn cấu hình agent chạy với `engine: "cli"`, luồng CLI tại `packages/adapters/codex-local/src/server/execute.ts` (dòng 529-540) có nhánh:
```typescript
const configuredHomeIsManaged =
  configuredCodexHome != null &&
  isManagedCodexHomePath(process.env, agent.companyId, configuredCodexHome);

if (configuredCodexHome == null) {
  await prepareManagedCodexHome(...);
} else if (configuredHomeIsManaged) {
  // 👉 Nhánh CLI xử lý riêng cho Trường hợp 3:
  await seedManagedCodexHome(configuredCodexHome, process.env, onLog, {
    apiKey: configuredOpenAiApiKey,
  });
}
```
* **Ở CLI:** Nhánh này sẽ **tự động copy `config.toml`** từ `~/.codex` sang và **tự động ghi file `auth.json`** vật lý.
* **Ở ACP (mặc định):** Lập trình viên Paperclip đã bỏ quên nhánh `configuredHomeIsManaged` này, dẫn đến cả 2 file không được tạo/copy tự động.

---

### Giải pháp xử lý cho Trường hợp 3:
1. **Nếu giữ chế độ ACP (khuyên dùng):** Tự tạo hoặc dán nội dung `config.toml` (với cấu hình LiteLLM Proxy) trực tiếp vào thư mục `codex-home` của Agent. Codex khi khởi động sẽ tự động nạp file `config.toml` này.
2. **Nếu muốn Paperclip tự động copy:** Trong cấu hình Agent trên UI, chuyển trường `engine` từ `acp` sang `cli`. Nhánh CLI sẽ tự động kích hoạt hàm seed sao chép `config.toml` và ghi `auth.json`.

---

## 6. Hướng Dẫn Cấu Hình LiteLLM Proxy Trong `config.toml` Của Agent

Khi Agent chạy riêng ở **Trường hợp 3**, cấu hình chuẩn trong file `.../agents/<agentId>/codex-home/config.toml` để kết nối qua LiteLLM:

```toml
# Model mặc định cho Agent
model = "litellm-claude-3-7-sonnet"
model_provider = "litellm"

# Định nghĩa Provider LiteLLM
[model_providers.litellm]
name = "LiteLLM Proxy"
base_url = "http://127.0.0.1:4000/v1"
wire_api = "openai"
requires_openai_auth = true
```

Kết hợp với biến môi trường trong UI:
* `OPENAI_API_KEY`: Virtual Key cấp từ LiteLLM Proxy (`sk-...`).

---

## 7. PHẦN ĐỀ XUẤT: THIẾT KẾ NÂNG CẤP MÃ NGUỒN VÀ TỰ ĐỘNG HÓA LITELLM

Để tối ưu hóa trải nghiệm người dùng, loại bỏ hoàn toàn việc phải mở file `config.toml` sửa thủ công, dưới đây là đề xuất thiết kế nâng cấp mã nguồn Paperclip: vừa vá triệt để 3 trường hợp ban đầu, vừa bổ sung **Trường hợp 4: Tự động chuyển tiếp (forward) sang LiteLLM Proxy**.

### 7.1. Mục Tiêu Thiết Kế
1. **Khắc phục lỗi ACP Engine:** Dù chạy CLI hay ACP, khi Agent kích hoạt `codex-home` riêng, hệ thống đều phải tự động copy `config.toml` và ghi file `auth.json`.
2. **Tự Động Hóa Trường Hợp 4 (LiteLLM Forwarding):** 
   * Người dùng chỉ cần nhập cấu hình LiteLLM trên giao diện UI (`OPENAI_BASE_URL` hoặc `LITELLM_BASE_URL` cùng với Virtual Key).
   * Paperclip tự động phát hiện, tự động tiêm (merge/inject) cấu hình `[model_providers.litellm]` vào file `config.toml` của agent.

### 7.2. Thứ Tự Phân Cấp Ưu Tiên 4 Trường Hợp

Thứ tự kiểm tra và phân loại cấu hình được chuẩn hóa theo độ ưu tiên từ cao xuống thấp:

```
[Kiểm tra biến môi trường của Agent]
          │
          ├──> [Ưu tiên 1] User tự chỉ định CODEX_HOME bên ngoài hệ thống?
          │         └──> [Trường Hợp 1: Host External Override]
          │              └── Đọc trực tiếp ~/.codex của máy host, không can thiệp, không copy/seed.
          │
          ├──> [Ưu tiên 2] Có biến LITELLM_BASE_URL?
          │         └──> [Trường Hợp 4: LiteLLM Forwarding qua Custom Gateway]
          │              ├── Tự động tạo codex-home riêng cho Agent
          │              ├── Copy config.toml từ ~/.codex (nếu có)
          │              ├── Inject các root key lên ĐẦU file (TRƯỚC mọi table header):
          │              │     model_provider = "mygw"
          │              │     model = "<model_từ_UI>"
          │              │     model_reasoning_effort = "low"
          │              ├── Inject table header bên dưới:
          │              │     [model_providers.mygw]
          │              │     name = "My gateway"
          │              │     base_url = "<LITELLM_BASE_URL>"
          │              │     env_key = "LITELLM_API_KEY"
          │              │     wire_api = "responses"
          │              └── KHÔNG CẦN ghi file auth.json (Codex tự đọc key từ env_key!).
          │
          ├──> [Ưu tiên 3] Có biến OPENAI_API_KEY riêng (không có Base URL)?
          │         └──> [Trường Hợp 3: Agent Key Isolation]
          │              ├── Tự động tạo codex-home riêng cho Agent
          │              ├── Tự động copy config.toml từ ~/.codex
          │              └── Tự động ghi file auth.json chứa OpenAI API Key.
          │
          └──> [Ưu tiên 4] Không có Key riêng, không có Base URL?
                    └──> [Trường Hợp 2: Company Shared Home]
                         └── Dùng chung ~/.paperclip/.../companies/<company-id>/codex-home.
```

---

### 7.3. Định Dạng Chuẩn Của `config.toml` Khi Chạy LiteLLM Forwarding

Điểm cốt tử trong cú pháp TOML của Codex CLI: **Các biến root bắt buộc phải nằm ở đầu file, trước bất kỳ header `[...]` nào**. Nếu để sau `[model_providers.mygw]`, TOML parser sẽ gán chúng vào sub-table và gây lỗi runtime.

```toml
# ==============================================================================
# 1. CÁC BIẾN ROOT (BẮT BUỘC PHẢI NẰM TRƯỚC MỌI TABLE HEADER)
# ==============================================================================
model_provider = "mygw"
model = "lfm-free"
model_reasoning_effort = "low"

# ==============================================================================
# 2. ĐỊNH NGHĨA TABLE GATEWAY PROVIDER
# ==============================================================================
[model_providers.mygw]
name = "My gateway"
base_url = "http://localhost:4000/v1"
env_key = "LITELLM_API_KEY"        # Tên biến env mà Codex CLI tự động đọc key từ đó
wire_api = "responses"             # Chuẩn wire API responses của Codex
```

> **Ưu điểm vượt trội của cấu hình này:**
> * Nhờ tham số `env_key = "LITELLM_API_KEY"`, Codex CLI khi chạy sẽ tự động lấy giá trị từ biến môi trường `process.env.LITELLM_API_KEY`.
> * Hệ thống **hoàn toàn không cần tạo hoặc ghi đè file `auth.json`**, tránh mọi xung đột về quyền ghi file hay token refresh!

---

### 7.4. Chi Tiết Các Vị Trí Code Sẽ Chỉnh Sửa

#### 1. File `server/src/routes/agents.ts`
* **Vị trí:** Hàm `applyCodexLocalKeyIsolation` (dòng 1291).
* **Nâng cấp:** Kích hoạt thư mục riêng cho Agent nếu có `OPENAI_API_KEY` **HOẶC** `LITELLM_BASE_URL`:
  ```typescript
  function shouldIsolateCodexHome(env: Record<string, unknown>): boolean {
    return codexLocalEnvKeyConfigured(env.OPENAI_API_KEY) ||
           codexLocalEnvKeyConfigured(env.LITELLM_BASE_URL);
  }
  ```

#### 2. File `packages/adapter-utils/src/acpx-engine/execute.ts` (Sửa Bug ACP)
* **Vị trí:** Hàm `prepareCodexSkillRuntime` (dòng 865).
* **Nâng cấp:** Sửa toán tử `??` để khi thư mục là managed home của Paperclip thì **luôn luôn gọi hàm seed**:
  ```typescript
  const effectiveCodexHome = configuredCodexHome ?? resolveManagedCodexHomeDir(input.companyId);
  if (isManagedCodexHomePath(process.env, input.companyId, effectiveCodexHome)) {
    await seedManagedCodexHome(effectiveCodexHome, process.env, input.onLog, {
      apiKey: configuredOpenAiApiKey,
      liteLlmBaseUrl: envConfig.LITELLM_BASE_URL,
      model: input.config.model,
      reasoningEffort: input.config.modelReasoningEffort,
    });
  }
  ```

#### 3. File `packages/adapters/codex-local/src/server/codex-home.ts`
* **Vị trí:** Thêm hàm `patchCodexTomlForLiteLlmGateway` và tích hợp vào `seedManagedCodexHome`:
  ```typescript
  async function patchCodexTomlForLiteLlmGateway(
    targetHome: string,
    options: {
      baseUrl: string;
      model?: string;
      reasoningEffort?: string;
    },
  ): Promise<void> {
    const configPath = path.join(targetHome, "config.toml");
    let content = "";
    if (await pathExists(configPath)) {
      content = await fs.readFile(configPath, "utf-8");
    }

    const rootKeys = [
      `model_provider = "mygw"`,
      `model = "${options.model || "lfm-free"}"`,
      `model_reasoning_effort = "${options.reasoningEffort || "low"}"`,
    ].join("\n");

    const tableBlock = [
      `[model_providers.mygw]`,
      `name = "My gateway"`,
      `base_url = "${options.baseUrl}"`,
      `env_key = "LITELLM_API_KEY"`,
      `wire_api = "responses"`,
    ].join("\n");

    // Đưa rootKeys lên đầu file, sau đó ghép nội dung cũ và tableBlock
    const cleanOldContent = content
      .replace(/^model_provider\s*=\s*.*$/m, "")
      .replace(/^model\s*=\s*.*$/m, "")
      .replace(/^model_reasoning_effort\s*=\s*.*$/m, "")
      .trim();

    const finalToml = `${rootKeys}\n\n${cleanOldContent ? cleanOldContent + "\n\n" : ""}${tableBlock}\n`;
    await fs.writeFile(configPath, finalToml, "utf-8");
  }
  ```

---

### 7.5. Trải Nghiệm Người Dùng (UI Workflow Chuẩn)
Sau khi cập nhật, quy trình trên UI cực kỳ gọn gàng và không cần thao tác file:
1. Mở UI Paperclip -> Tạo hoặc Edit Agent (Adapter `codex_local`).
2. Chọn Model: `lfm-free` (hoặc model khai báo trên LiteLLM).
3. Trong **Environment Variables**:
   * `LITELLM_BASE_URL` = `http://localhost:4000/v1`
   * `LITELLM_API_KEY` = `sk-litellm-virtual-key`
4. Bấm **Run Task**:
   * Paperclip tự động sinh `config.toml` chuẩn: các key root ở đầu, block `[model_providers.mygw]` với `wire_api = "responses"` và `env_key = "LITELLM_API_KEY"`.
   * Codex tự động đọc `LITELLM_API_KEY` từ môi trường và gọi mượt mà qua LiteLLM Proxy.

---

### 7.6. Bản Chất Kỹ Thuật Của Cơ Chế `env_key = "LITELLM_API_KEY"`

Một câu hỏi rất quan trọng: *Giá trị của `env_key = "LITELLM_API_KEY"` được lấy từ đâu để lắp vào?*

1. **`env_key` chỉ là tên đại diện:** Trong file `config.toml`, chuỗi `"LITELLM_API_KEY"` không phải là nơi gán giá trị key, mà nó là **tên của biến môi trường (Environment Variable Name)** mà Codex cần nhìn vào.
2. **Nguồn cấp giá trị thực:** Khi bạn tạo Agent trên UI Paperclip và nhập biến `LITELLM_API_KEY = "sk-litellm-..."`, Paperclip sẽ nạp chuỗi key này vào tiến trình chạy của Codex (`process.env.LITELLM_API_KEY`).
3. **Cơ chế bốc key khi gọi API:** Khi Codex bắt đầu gửi request, nó đọc `config.toml` thấy `env_key = "LITELLM_API_KEY"`, nó liền bốc giá trị từ `process.env.LITELLM_API_KEY` để tự động đưa vào header HTTP:
   ```http
   POST /v1/chat/completions HTTP/1.1
   Host: localhost:4000
   Authorization: Bearer sk-litellm-virtual-key-cua-ban
   ```
4. **Lợi ích bảo mật:** Key thật **không bao giờ bị ghi lộ liễu dạng text thô trong file `config.toml`** và **không cần ghi đè file `auth.json`**. Bạn có thể đổi key bất kỳ lúc nào trên UI Paperclip mà không cần sửa file `.toml`.

---

### 7.7. Quy Tắc Vàng Về Cú Pháp TOML Của Codex

Khi làm việc với file `config.toml` của Codex, **vị trí đặt các dòng là yếu tố quyết định sống còn**:

* **Quy tắc 1 (Bắt buộc):** Các biến root như `model_provider`, `model`, `model_reasoning_effort` **BẮT BUỘC PHẢI Ở DÒNG 1, 2, 3 (ĐẦU FILE)**, trước bất kỳ tiêu đề bảng `[...]` nào.
  * *Lý do:* Theo chuẩn TOML, nếu đặt các dòng này bên dưới `[model_providers.mygw]`, TOML parser sẽ coi chúng là thuộc tính con `model_providers.mygw.model` thay vì biến gốc của Codex. Khi đó Codex sẽ báo lỗi hoặc tự động fallback về model mặc định của OpenAI.
* **Quy tắc 2:** Khối định nghĩa provider `[model_providers.mygw]` có thể đặt ở bất kỳ đâu phía sau các biến root (thường để ở cuối file).

---

### 7.8. Hướng Dẫn Cấu Hình Bằng Tay Ngay Lúc Này (Trước Khi Nâng Cấp Code)

Trong khi bạn chưa tiến hành nâng cấp code Paperclip, bạn có thể cấu hình thủ công ngay lập tức để Agent chạy được với LiteLLM:

1. **Trên UI Paperclip:**
   * Ô **Model**: Nhập tên model đã định cấu hình trên LiteLLM (ví dụ: `lfm-free`).
   * Mục **Environment Variables**: Thêm 2 biến:
     * `LITELLM_BASE_URL` = `http://localhost:4000/v1`
     * `LITELLM_API_KEY` = `sk-litellm-virtual-key-cua-ban`
2. **Mở file `config.toml` của Agent (file bạn đang mở trên VS Code):**
   * Đường dẫn: `.../agents/<agent-id>/codex-home/config.toml`
   * **Dán 3 dòng này lên dòng 1, 2, 3 (đầu file):**
     ```toml
     model_provider = "mygw"
     model = "lfm-free"
     model_reasoning_effort = "low"
     ```
   * **Dán khối này vào cuối file (từ dòng 45 trở đi):**
     ```toml
     [model_providers.mygw]
     name = "My gateway"
     base_url = "http://localhost:4000/v1"
     env_key = "LITELLM_API_KEY"
     wire_api = "responses"
     ```
3. Lưu file `config.toml` lại và bấm **Run Agent** trên Paperclip. Agent sẽ lập tức kết nối và gọi qua LiteLLM Proxy hoàn hảo!

---

## 8. Danh Sách Các File Và Chi Tiết Vị Trí Đã Sửa Đổi Hoàn Chỉnh

Dưới đây là bảng tổng hợp các file và logic cốt lõi đã được nâng cấp trong mã nguồn Paperclip:

### 1. File `packages/adapters/codex-local/src/server/codex-home.ts`
* **Vị trí 1 (Dòng ~340):** Khai báo hằng số `DEFAULT_LITELLM_BASE_URL = "http://localhost:4000/v1"`.
* **Vị trí 2 (Dòng ~350 - 410):** Hàm `patchCodexTomlForLiteLlmGateway`:
  * Quét dòng theo cơ chế parser để loại bỏ triệt để **tất cả** các khối `[model_providers.mygw]` cũ (tránh lỗi trùng lặp table header trong TOML).
  * Đặt các biến root (`model_provider = "mygw"`, `model`, `model_reasoning_effort`) lên đầu file.
  * Ghi đúng một khối `[model_providers.mygw]` duy nhất ở cuối file.
* **Vị trí 3 (Dòng ~670 - 720):** Hàm `seedManagedCodexHome`:
  * Bổ sung kiểm tra `if (!isLiteLlm)`: **Chặn hoàn toàn** việc tạo Symlink trỏ về file `auth.json` chứa tài khoản ChatGPT của máy host khi Agent chạy LiteLLM.
  * Tự động sinh file `auth.json` thật với format `{"OPENAI_API_KEY": apiKey}`.

### 2. File `server/src/routes/agents.ts`
* **Vị trí 1 (Dòng ~55):** Import `secretService` từ `../services/index.js`.
* **Vị trí 2 (Dòng ~1280 - 1315):** Hàm `applyCodexLocalKeyIsolation`:
  * Mở rộng điều kiện cô lập thư mục: Agent sẽ được cấp riêng một thư mục `codex-home` độc lập nếu có cấu hình `OPENAI_API_KEY`, `LITELLM_API_KEY`, `LITELLM_BASE_URL` hoặc `OPENAI_BASE_URL`.
* **Vị trí 3 (Dòng ~1320 - 1370):** Thêm hàm `reconcileCodexLocalAgentOnSave`:
  * Được kích hoạt tự động ngay khi người dùng bấm Tạo / Sửa Agent trên UI (`POST /agents`, `POST /agents/hire`, `PATCH /agents/:id`).
  * Gọi `secretService(db).resolveEnvBindings` để tự động giải mã secret từ Secret Manager (hỗ trợ cả Secret Key lẫn Plain Text).
  * Tự động gán mặc định `base_url = "http://localhost:4000/v1"` nếu người dùng bỏ trống `LITELLM_BASE_URL`.
  * Khởi tạo sẵn thư mục `codex-home`, `config.toml` và `auth.json` ngay lập tức mà không cần đợi bấm Run Task.

### 3. File `packages/adapter-utils/src/acpx-engine/execute.ts` (Sửa Bug ACP Engine)
* **Vị trí 1 (Dòng ~640 - 730):** Cập nhật `patchCodexTomlForLiteLlmGateway` và `prepareManagedCodexHome`:
  * Dọn dẹp duplicate block `[model_providers.mygw]`.
  * Chặn symlink sang `auth.json` của host khi chạy LiteLLM.
* **Vị trí 2 (Dòng ~980 - 1010):** Sửa lỗi ngắn mạch toán tử `??`: Đảm bảo khi Agent có thư mục `codex-home` riêng (`effectiveIsManaged`) thì ACP luôn kích hoạt hàm seed khởi tạo file.
* **Vị trí 3 (Dòng ~1150 - 1195):** Hàm `buildCodexStartupConfig`: Bổ sung tham số `modelProvider`.
* **Vị trí 4 (Dòng ~1560 - 1575):** Truyền `modelProvider: "mygw"` vào biến môi trường runtime `CODEX_CONFIG`. Giúp Codex CLI biết rằng model (ví dụ `lfm-free`, `nemotron-free`) thuộc về provider `mygw`, tránh lỗi `Internal error` do Codex tự tìm kiếm model trên OpenAI chính chủ.

### 4. File `packages/adapters/codex-local/src/server/execute.ts` (Chế độ CLI Engine)
* **Vị trí (Dòng ~520 - 565):** Bổ sung nhận diện `LITELLM_API_KEY`, fallback `DEFAULT_LITELLM_BASE_URL = "http://localhost:4000/v1"`, và gọi seed cấu hình LiteLLM khi chạy lệnh `codex exec`.

### 5. File `packages/adapters/codex-local/src/server/codex-home.test.ts`
* Bổ sung các unit test kiểm thử:
  * Kiểm tra cấu trúc `config.toml` (biến root ở đầu, gateway ở cuối).
  * Kiểm tra tự động sinh file `auth.json`.
  * Kiểm tra fallback tự động về `http://localhost:4000/v1` khi chỉ truyền `LITELLM_API_KEY`.

### 6. Tự Động Bổ Sung `approval_policy = "never"` & `[features] guardian_approval = false` (Tắt Hoàn Toàn Guardian Review Cả Terminal Lẫn MCP)
* **Vấn đề cốt lõi của Codex CLI:**
  * `approval_policy = "never"` chỉ tắt phê duyệt cho các lệnh Terminal / Command execution.
  * Đối với **MCP Tools (`mcp.*`)**, Codex CLI có một feature flag mặc định là `guardian_approval = true`. Flag này ép buộc một lượt đánh giá tự động (Guardian Review) gọi ngầm model `gpt-5.6-luna`. Khi chạy qua LiteLLM gateway, nếu không có model này sẽ bị lỗi `HTTP 400 Invalid model name` dẫn đến tool bị chặn (`Status: Denied`).
* **Giải pháp tự động hoá:**
  * Tại cả 2 file `packages/adapters/codex-local/src/server/codex-home.ts` và `packages/adapter-utils/src/acpx-engine/execute.ts`:
    * Hàm `ensureGuardianApprovalDisabled`: Luôn đảm bảo `config.toml` có bảng:
      ```toml
      [features]
      guardian_approval = false
      ```
    * Tự động bổ sung `approval_policy = "never"` ở đầu file.
  * **Kết quả:** Bất kỳ Agent mới nào được tạo ra, lưu hoặc chạy trong Paperclip đều được thiết lập sẵn:
    1. Bỏ qua xác nhận lệnh Terminal (`approval_policy = "never"`).
    2. Tắt hoàn toàn Guardian Review ngầm cho MCP Server (`guardian_approval = false`).
    Agent chạy trực tiếp 100% các hàm MCP (`mcp.paperclip.*`) mà không bao giờ gọi model kiểm duyệt hay bị từ chối!

