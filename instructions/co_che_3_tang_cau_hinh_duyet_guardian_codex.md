# Cơ chế 3 tầng cấu hình duyệt (Guardian) của agent Codex trong Paperclip

Cập nhật: 2026-10-20. Đối chiếu với mã nguồn codex-acp `@agentclientprotocol/codex-acp@1.11.0` và repo Paperclip nhánh `test_adapter`.

## 1. Bối cảnh

Khi agent Codex cần làm việc có rủi ro (chạy lệnh, gọi MCP tool), Codex có thể yêu cầu **duyệt** trước. Người duyệt có thể là:

- **Guardian** (`auto_review`): một lượt model riêng tự đánh giá rủi ro rồi đồng ý hoặc từ chối. Mỗi lần mất khoảng 2 đến 5 giây và tốn thêm token/quota.
- **user**: chuyển cho client ACP. Trong Paperclip, client là acpx chạy chế độ `approve-all`, nên tự đồng ý ngay.

Cấu hình duyệt đến từ **3 tầng chồng lên nhau**. Tầng sau đè tầng trước.

```
Tầng 1: config.toml trong codex-home        <- thấp nhất
Tầng 2: CODEX_CONFIG (biến môi trường JSON)
Tầng 3: chế độ phiên của codex-acp           <- cao nhất (gửi kèm mỗi lượt)
```

## 2. Luồng tổng thể

```
Giao diện Paperclip --Save--> DB (bảng agents, cột adapter_config)
                                   |
             mỗi run, engine ACPX đọc adapter_config
                                   |
   +-------------------------------+-------------------------------+
   |                               |                               |
Tầng 1                          Tầng 2                          Tầng 3
config.toml (file)              env CODEX_CONFIG (JSON)         env INITIAL_AGENT_MODE (tên chế độ)
   |                               |                               |
Codex đọc lúc khởi động       codex-acp chuyển cho Codex      codex-acp chọn bộ soạn sẵn,
                              lúc tạo phiên                    gửi kèm MỖI lượt
```

## 3. Chi tiết từng tầng

### Tầng 1: `config.toml`

| Mục | Nội dung |
|---|---|
| Là gì | File trên đĩa trong codex-home của agent |
| Nguồn | Copy từ `~/.codex/config.toml` của máy một lần lúc seed, sau đó Paperclip vá thêm |
| Ai đọc | Codex, lúc khởi động |
| Chứa gì | Cấu hình nền lâu dài: MCP server, `env_vars`, provider LiteLLM, tuỳ chỉnh tự sửa tay |
| Khoá liên quan duyệt | `approval_policy`, `approvals_reviewer`, `[features] guardian_approval` |

Paperclip ghi các khoá tắt duyệt bằng `ensureCodexApprovalsDisabled` (`packages/adapter-utils/src/codex-toml.ts`, khoảng dòng 264):

```toml
approval_policy = "never"
approvals_reviewer = "user"

[features]
guardian_approval = false
```

Chỗ gọi:

- Engine ACPX lúc seed codex-home: `packages/adapter-utils/src/acpx-engine/execute.ts`, khoảng dòng 663 đến 677.
- Agent gateway: hàm vá LiteLLM (`applyLiteLlmGatewayToml` / `patchCodexTomlForLiteLlmGateway`) ghi luôn các khoá này.
- Không có base URL nhưng bật cờ: `disableCodexApprovalsInHome`.

### Tầng 2: `CODEX_CONFIG`

| Mục | Nội dung |
|---|---|
| Là gì | Biến môi trường dạng JSON, cùng tên khoá với `config.toml` |
| Nguồn | Engine Paperclip **tính lại mỗi run** từ `adapter_config` trong DB (model, effort, fast mode, provider) và trộn với `CODEX_CONFIG` mà agent tự đặt trong `env` (nếu có) |
| Ai đọc | codex-acp đọc lúc khởi động (`process.env["CODEX_CONFIG"]`), rồi chuyển cho Codex làm cấu hình **lúc tạo phiên** |
| Mặc định | Không có. Không đặt thì codex-acp không ghi đè gì |
| Tài liệu codex-acp | "`CODEX_CONFIG` - JSON object merged into the Codex session config." |

Hàm dựng: `buildCodexStartupConfig` trong `packages/adapter-utils/src/acpx-engine/execute.ts` (khoảng dòng 1122). Với agent gateway, nó thêm:

```json
{"approval_policy": "never", "approvals_reviewer": "user",
 "features": {"guardian_approval": false, "guardian": false}}
```

JSON tự đặt bị sai thì engine bỏ qua và ghi cảnh báo `Ignoring invalid user CODEX_CONFIG`.

### Tầng 3: chế độ phiên (`INITIAL_AGENT_MODE`)

| Mục | Nội dung |
|---|---|
| Là gì | **Tên** của một trong 3 bộ cài đặt soạn sẵn trong mã codex-acp |
| Nguồn | Biến môi trường `INITIAL_AGENT_MODE` của tiến trình codex-acp |
| Ai đọc | codex-acp, **một lần** lúc khởi động (`getInitialAgentMode()`) |
| Áp dụng | codex-acp **gửi kèm mỗi lượt** 3 giá trị của chế độ đang chọn tới Codex |
| Phạm vi | **Chỉ 3 giá trị**: `approvalPolicy`, `approvalsReviewer`, sandbox |
| Mặc định | Không đặt thì dùng `agent` (có Guardian) |

Bảng 3 chế độ (lấy từ mã codex-acp 1.11.0):

| `INITIAL_AGENT_MODE` | Tên hiển thị | `approvalPolicy` | `approvalsReviewer` | Sandbox |
|---|---|---|---|---|
| `read-only` | Ask for approval | `on-request` | `user` | `workspace-write`, không mạng |
| `agent` (mặc định) | Approve for me | `on-request` | `auto_review` (Guardian) | `workspace-write`, không mạng |
| `agent-full-access` | Full access | `never` | `user` | `danger-full-access` (mọi file, có mạng) |

Lưu ý:

- Tên `read-only` dễ gây hiểu nhầm. Thực tế nó dùng **cùng sandbox ghi được** như `agent`, chỉ khác người duyệt.
- Không đặt riêng từng giá trị được, chỉ chọn một trong ba bộ.
- `agent-full-access` mở toàn quyền máy, không khuyến nghị cho agent nhận nội dung từ Telegram.

Chỗ Paperclip đặt biến (`packages/adapter-utils/src/acpx-engine/execute.ts`, khoảng dòng 1566 đến 1570):

```ts
const acpInitialMode = resolveCodexAcpInitialMode({
  isGateway: isLiteLlm,
  existingMode: env.INITIAL_AGENT_MODE,
});
if (acpInitialMode) env.INITIAL_AGENT_MODE = acpInitialMode;
```

- Agent LiteLLM, chưa tự đặt biến: engine gán `read-only`.
- Agent đã tự đặt biến trong `env`: giữ nguyên giá trị đó.
- Agent thường không đặt: không làm gì, codex-acp dùng `agent` (có Guardian).

## 4. So sánh ba tầng

| | Tầng 1 | Tầng 2 | Tầng 3 |
|---|---|---|---|
| Hình thức | File `config.toml` | Biến môi trường JSON | Biến môi trường chứa tên chế độ |
| Nguồn | Copy một lần từ máy, Paperclip vá | Engine tính lại mỗi run từ DB | Engine đặt mỗi run (hoặc giữ giá trị tự đặt) |
| Ai đọc | Codex | codex-acp chuyển cho Codex | codex-acp |
| Thời điểm áp dụng | Codex khởi động | Lúc tạo phiên | **Mỗi lượt** |
| Phạm vi | Mọi khoá cấu hình | Mọi khoá cấu hình | Chỉ duyệt và sandbox |
| Có trong đường CLI không | Có | Không (CLI dùng cờ `-c`) | Không (CLI không qua codex-acp) |

### Vì sao tầng 3 thắng

Tầng 1 và 2 chỉ được đọc lúc khởi động hoặc lúc tạo phiên. Tầng 3 được gửi kèm **mỗi yêu cầu lượt**, nên tham số theo lượt luôn đè cấu hình phiên.

Ví dụ: tầng 2 ghi `approvals_reviewer: "user"` nhưng chế độ là `agent`:

```
Tạo phiên: Codex nhận CODEX_CONFIG -> reviewer = user
Lượt 1:    codex-acp gửi kèm reviewer = auto_review -> Codex dùng Guardian
Lượt 2:    lại gửi kèm auto_review -> vẫn Guardian
```

Đây là lỗi gặp lúc đầu: chỉ sửa tầng 1 và 2 thì Guardian vẫn chạy. Phải thêm tầng 3 (`read-only`) mới tắt hẳn.

Hình dung: tầng 2 là bản hợp đồng ký lúc nhận việc, tầng 3 là lời dặn kèm theo mỗi lần giao việc. Khi mâu thuẫn, làm theo lời dặn mới nhất.

### Vì sao vẫn cần tầng 1 và 2 dù tầng 3 thắng

- Đường CLI (`codex_local` chạy lệnh `codex` trực tiếp, không qua codex-acp) không có tầng 3. Ở đó tầng 1 và cờ `-c` trong `packages/adapters/codex-local/src/server/codex-args.ts` quyết định.
- Cờ tính năng như `features.guardian_approval` không được gửi theo lượt, chỉ đến từ tầng 1 và 2.
- Dự phòng nếu codex-acp đổi cách gửi chế độ trong phiên bản sau.

### Vì sao tầng 1 và 2 tách riêng dù cùng định dạng khoá

- Thay đổi trên giao diện (đổi model, effort) phải có hiệu lực ngay ở run sau. `config.toml` chỉ copy một lần nên không phản ánh được; `CODEX_CONFIG` tính lại mỗi run.
- Agent có thể dùng chung codex-home của máy (`~/.codex`). Ghi đè qua biến môi trường thì không phá file cấu hình cá nhân.
- Cấu hình nền lâu dài (MCP server, `env_vars`) hợp với file, không cần tính lại mỗi run.
- Riêng các khoá tắt duyệt thì tầng 1 và 2 trùng nhau, ghi cả hai chỗ để chắc chắn.

## 5. Khi bấm Save trên giao diện

```
Giao diện --PATCH /api/agents/{id}--> server --> DB: bảng agents, cột adapter_config (JSON)
```

Mọi cài đặt (model, effort, `env`) nằm trong `adapter_config`. Mỗi run engine đọc lại từ DB để dựng tầng 2 và tầng 3.

Ngoại lệ với agent `codex_local`: server chạy thêm `reconcileCodexLocalAgentOnSave` (`server/src/routes/agents.ts`, khoảng dòng 1315), rồi gọi `reconcileManagedCodexHome` (`packages/adapters/codex-local/src/server/codex-home.ts`, khoảng dòng 758):

| Trường hợp | `config.toml` có bị sửa không |
|---|---|
| Agent không đặt `CODEX_HOME` trong `env` | Không (`no_managed_home`) |
| `CODEX_HOME` trỏ ra ngoài vùng Paperclip quản lý (ví dụ `~/.codex`) | Không (`external_override`) |
| `CODEX_HOME` là thư mục do Paperclip quản lý (`.paperclip/instances/.../codex-home`) | Có: vá provider LiteLLM, model, effort, tắt duyệt nếu là gateway |

## 6. Công tắc hiện tại: chỉ agent LiteLLM được tắt Guardian

`resolveCodexGatewayConfig(adapterConfig)` trong `packages/adapter-utils/src/codex-toml.ts` (khoảng dòng 460 đến 485):

- Đọc `env` của adapter: có `LITELLM_API_KEY` / `OPENAI_API_KEY` kèm `LITELLM_BASE_URL` / `OPENAI_BASE_URL` thì `isGateway = true`.
- Trả về `disableApprovalGuardian = isGateway`. Đây là công tắc duy nhất.
- Test `codex-toml.test.ts` (khoảng dòng 156) cố ý bỏ qua khoá `disableApprovalGuardian` tự ghi trong cấu hình, tức hiện chỉ gateway mới tắt được.

Công tắc này điều khiển cả ba tầng:

```
adapterConfig.env có LiteLLM -> isGateway = true -> disableApprovalGuardian = true
                                                     |- Tầng 1: config.toml (approval_policy, guardian_approval)
                                                     |- Tầng 2: CODEX_CONFIG lúc chạy (cùng các khoá)
                                                     |- Tầng 3: INITIAL_AGENT_MODE = read-only  <- quyết định
                                                     |- CLI: cờ -c trong codex-args
```

## 7. Muốn tắt Guardian cho agent Codex thường (không dùng LiteLLM)

### Cách 1: không sửa code

Thêm vào `env` trong cấu hình adapter của agent trên giao diện:

```
INITIAL_AGENT_MODE = read-only
```

- Có tác dụng ở tầng 3, tức đường ACP.
- Tầng 1 và 2 của agent đó vẫn bật Guardian, nên không có tác dụng với đường CLI.
- Chế độ được đọc lúc khởi động codex-acp. Agent `persistent` nạp lại phiên cũ, chưa kiểm chứng phiên nạp lại có nhận chế độ mới hay không; muốn chắc thì thử với task mới.
- Chưa chạy thử với agent không dùng LiteLLM.

### Cách 2: thêm tuỳ chọn cấu hình rõ ràng (đề xuất, chưa làm)

- Thêm `disableApprovalGuardian: true/false` trong `adapter_config` của từng agent.
- Mặc định: agent LiteLLM là `true` (như hiện nay), agent khác giữ Guardian trừ khi bật.
- Sửa `resolveCodexGatewayConfig` và các chỗ đang dùng `isGateway` cho việc này: engine ACPX (`execute.ts`), `codex-args.ts`, seed `config.toml`, `reconcileCodexLocalAgentOnSave`. Cập nhật test `codex-toml.test.ts`.
- Ba tầng sẽ tự áp dụng theo vì cùng đọc một công tắc.

### Đánh đổi khi tắt

| Được | Mất |
|---|---|
| Bớt 2 đến 5 giây cho mỗi lời gọi cần duyệt (một run đo được mất 6 giây cho 2 lần duyệt) | Mất lớp kiểm tra rủi ro tự động trước khi agent chạy lệnh hoặc tool |
| Không tốn thêm lượt model cho Guardian (với gói thuê bao, Guardian cũng ăn quota) | Agent nhận nội dung từ Telegram dễ bị prompt injection; không có Guardian thì mọi yêu cầu duyệt đều tự được chấp nhận |

Nếu tắt cho agent Front-Desk, nên giữ các giới hạn khác: đã gỡ tool `api_request`, chỉ còn tool cụ thể; nên làm thêm việc giới hạn `file_path` trong workspace của run (mục #5 trong `doc/plans/2026-10-15-viec-can-lam-tiep-theo.md`).

## 8. Tra cứu nhanh

| Câu hỏi | Trả lời |
|---|---|
| Tầng nào quyết định có Guardian hay không ở đường ACP? | Tầng 3 (`INITIAL_AGENT_MODE`) |
| Đặt `INITIAL_AGENT_MODE` ở đâu? | `env` trong cấu hình adapter của agent (lưu trong DB), hoặc engine tự đặt cho agent LiteLLM |
| Biến này được đọc khi nào? | Một lần, lúc tiến trình codex-acp khởi động (mỗi run Paperclip tạo tiến trình mới) |
| Nó ghi đè những gì? | Chỉ `approvalPolicy`, `approvalsReviewer`, sandbox |
| `CODEX_CONFIG` có lấy từ `config.toml` không? | Không. Engine tính từ `adapter_config` trong DB mỗi run |
| Bấm Save có ghi `config.toml` không? | Chỉ khi `CODEX_HOME` là thư mục do Paperclip quản lý; còn lại chỉ ghi DB |
| Đường CLI có tầng 3 không? | Không; dùng `config.toml` và cờ `-c` |
