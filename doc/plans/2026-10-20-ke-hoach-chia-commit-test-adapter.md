# Kế hoạch chia commit cho nhánh `test_adapter`

Ngày lập: 2026-10-20
Nhánh: `test_adapter` (commit gần nhất: `f05a35c7c`)
Trạng thái: **chưa commit gì**. Tài liệu này ghi lại kết quả rà soát và các bước thực hiện để không bỏ sót.

## 1. Bối cảnh

Nhiều thay đổi thuộc các chủ đề khác nhau đang dồn trong working tree. Mục tiêu là tách thành các commit nhỏ, mỗi commit một chủ đề, mỗi commit đều typecheck được.

Ba chủ đề chính của code:

| Chủ đề | Nội dung |
|---|---|
| **Symlink / seed cấu hình** | `CODEX_HOME` do Paperclip quản lý cho từng agent: bỏ symlink `auth.json` khi dùng gateway, ghi `config.toml` cho LiteLLM, tắt Guardian approval, đồng bộ khi lưu agent |
| **Cost qua LiteLLM** | Gắn tag theo run, đọc log spend của gateway, tính token và chi phí thật, nhận diện billing là `api`/`litellm` |
| **Log đẹp** | Hiển thị đầu vào (args) và đầu ra (output) của tool trong log run, có che secret |

Ngoài ra có thay đổi nhỏ khác: sửa test của `n8n-runtime`, thêm hướng dẫn Telegram vào `AGENTS.md`, và nhiều tài liệu.

## 2. Bốn việc phải xử lý TRƯỚC khi commit

### 2.1. Board key thật nằm trong file doc

File `instructions/loi_lech_pha_token_runtime_giua_codex_va_mcp_server.md`, quanh dòng 160, có dòng `PAPERCLIP_API_KEY=` kèm một board key thật (tiền tố `pcp_board_`).

- File này **chưa từng được commit** (đã kiểm tra bằng `git log -S`), nên key chưa lộ qua git.
- Việc cần làm: thay bằng placeholder `pcp_board_<your-board-key>`.
- Nên thu hồi (revoke) key đó và tạo key mới, vì nó đã nằm trên đĩa trong file doc.
- Các chuỗi `sk-...` trong code và doc đều là giá trị giả trong test hoặc ví dụ.

Kiểm tra sau khi sửa:

```bash
grep -rn "pcp_board_[0-9a-f]\{16,\}" instructions doc || echo "sạch"
```

### 2.2. Hai file không nên commit

| File | Lý do |
|---|---|
| `instructions/log.txt` | Bản dump transcript của một run agent (8/10), là rác gỡ lỗi |
| `test_ke_hoach_trien_khai.md` (gốc repo) | Giống file do agent sinh ra khi test |

Có thể thêm vào `.git/info/exclude` để không còn hiện trong `git status`.

### 2.3. `paperclip-mcp/` không được git quản lý

- `.gitignore` dòng 51 (`/paperclip-mcp`) bỏ qua cả thư mục.
- Thư mục cũng không có `.git` riêng.
- Hệ quả: code MCP (`server.py`, các test) **không nằm trong bất kỳ commit nào**, kể cả các thay đổi gần đây (tool `finish_task_and_reply_telegram`, xử lý task con bị `blocked`).
- Cần quyết định: `git init` riêng trong thư mục đó, hoặc bỏ dòng ignore nếu muốn quản lý chung (giữ `.env` ngoài git).

### 2.4. Nhiễu khoảng trắng trong `acpx-engine/execute.ts`

Khoảng 60 dòng chỉ là đổi khoảng trắng do formatter (`.catch(() => {})` thành `.catch(() => { })`, thụt dòng lại).

| Cách đo | Dòng thêm | Dòng xóa |
|---|---|---|
| `git diff --numstat` | 327 | 79 |
| `git diff -w --numstat` (bỏ qua khoảng trắng) | 265 | 17 |

Không đưa phần nhiễu này vào commit. Cách bỏ ở mục 5, bước 5.

## 3. Kết quả kiểm tra đã chạy (ngày 2026-10-20)

| Kiểm tra | Kết quả |
|---|---|
| `typecheck`: adapter-utils, adapter-codex-local, adapter-n8n-runtime, server | Cả 4 qua (exit 0) |
| Test mới: `codex-toml`, `litellm-spend`, `tool-output` | Qua hết |
| Test liên quan tính năng mới (LiteLLM, gateway, redact, billing...) | 67 qua, 4 bỏ qua, 1 lỗi |
| 6 file test đã chạm | 196 qua, 40 lỗi, 4 bỏ qua |

Phân loại 40 lỗi (đều giống lỗi môi trường Windows):

| Nhóm lỗi | Số test | Nguyên nhân |
|---|---|---|
| `Failed to start command "sh"` | 31 | Máy không có `sh` trong PATH, ảnh hưởng test sandbox |
| Quyền file Unix `0600/0700` | 6 | Windows không hỗ trợ `chmod` kiểu Unix (`expected 438 to be 384`) |
| `gemini --acp` | 1 | Phụ thuộc phiên bản CLI `gemini` cục bộ |
| `tar` (STACK_TRACE_ERROR) | 1 | Phụ thuộc `tar` của hệ điều hành |
| Còn lại | 1 | Cùng nhóm `sh` |

Lưu ý:

- Đây là suy luận từ nội dung lỗi. Chưa chạy lại trên bản `HEAD` sạch để so sánh. Nên chạy trên WSL hoặc CI trước khi merge.
- 4 test về **symlink bị bỏ qua** trên Windows, nên cơ chế symlink cấu hình chưa được test tự động ở máy này.
- Chưa chạy: `pnpm build`, toàn bộ `pnpm test:run`, e2e. AGENTS.md yêu cầu chạy bộ đầy đủ trước khi mở PR.

Cách chạy lại các test:

```powershell
pnpm exec vitest run packages/adapter-utils/src/codex-toml.test.ts packages/adapter-utils/src/litellm-spend.test.ts packages/adapter-utils/src/acpx-engine/tool-output.test.ts packages/adapter-utils/src/acpx-engine/execute.test.ts packages/adapters/codex-local/src/server/codex-home.test.ts packages/adapters/codex-local/src/server/acp.test.ts
```

Chạy trong PowerShell hoặc `uv run --with httpx python -m unittest discover -s tests` cho phần Python của MCP (Python hệ thống thiếu `httpx`).

## 4. Kế hoạch commit

Ba file mới (`codex-toml.ts`, `litellm-spend.ts`, `tool-output.ts`) không import lẫn nhau, nên commit nền tảng trước, tính năng sau.

| # | Message | File |
|---|---|---|
| C1 | `feat(adapter-utils): add codex-toml helpers for LiteLLM gateway config` | `packages/adapter-utils/src/codex-toml.ts`, `codex-toml.test.ts` |
| C2 | `feat(adapter-utils): add litellm-spend per-run usage collector` | `packages/adapter-utils/src/litellm-spend.ts`, `litellm-spend.test.ts` |
| C3 | `feat(codex): managed CODEX_HOME seeding for LiteLLM gateway agents` | `codex-home.ts`, `codex-home.test.ts`, `codex-args.ts`, `index.ts` (cùng thư mục `packages/adapters/codex-local/src/server/`), `server/src/routes/agents.ts`, và hunk của hai file `execute.ts` |
| C4 | `feat(codex): attribute run cost and tokens via LiteLLM gateway` | `acp.ts`, `acp.test.ts`, `packages/adapter-utils/src/acpx-engine/execute.test.ts`, và hunk của hai file `execute.ts` |
| C5 | `feat(acpx): show tool args and output in run logs` | `acpx-engine/tool-output.ts`, `tool-output.test.ts`, `cli.ts`, `ui.ts`, và hunk của `acpx-engine/execute.ts` |
| C6 | `fix(n8n-runtime): treat redacted n8n API key as masked in env test` | `packages/adapters/n8n-runtime/src/server/test.ts` |
| C7 | `docs(agents): add Telegram task completion guidelines` | `AGENTS.md` |
| C8 | `docs: add Telegram/n8n/LiteLLM design notes and plans` | `instructions/*.md` (trừ `log.txt`, sau khi xóa key), `doc/plans/*.md` |

Có thể **gộp C3 và C4** thành một commit "LiteLLM gateway support for Codex agents" vì hai phần dùng chung cấu hình gateway. Khi đó chỉ phải tách `execute.ts` thành hai nhóm (gateway và log) thay vì ba.

### 4.1. Bản đồ hunk của `packages/adapter-utils/src/acpx-engine/execute.ts`

Thứ tự theo file, số dòng là dòng mới (gần đúng).

| Vùng | Nội dung | Commit |
|---|---|---|
| 86-112 | 3 khối `import` | khối `tool-output` vào C5, `codex-toml` vào C3, `litellm-spend` vào C4 |
| 640-725 | `isManagedCodexHomePath`, `prepareManagedCodexHome` (seed, symlink, auth.json) | C3 |
| 940-1025 | `prepareCodexSkillRuntime`: home hiệu lực và `promptInstructions` cho Codex | C3 |
| 1125-1170 | `buildCodexStartupConfig`: provider, tắt guardian | C3 |
| 1537-1575 | `buildRuntime` cho codex | **trộn**: gán `LITELLM_TAGS_ENV` vào C4; `modelProvider`, `INITIAL_AGENT_MODE` vào C3 |
| 1612-1615 | `skillPromptInstructions = preparedSkills.promptInstructions` | C3 |
| 2287-2345, 2352-2356 | `captureRawToolEvent`, `ToolOutputCarry`, `emitRuntimeEvent` | C5 |
| 2507-2514 | `resolveGatewaySpendClient` | C4 |
| 3159-3165, 3203-3245 | Đo spend trước và sau turn | C4 |
| Còn lại | `.catch(() => { })`, thụt dòng | **không commit** |

### 4.2. Hunk của `packages/adapters/codex-local/src/server/execute.ts`

| Hunk | Commit |
|---|---|
| Import `resolveCodexGatewayConfig`, `LITELLM_TAGS_ENV`, `buildPaperclipLiteLlmTags` | C3 (nguyên khối import) |
| `prepareManagedCodexHome` / `seedManagedCodexHome` với `gateway.*` | C3 |
| `resolveCodexBillingType`, `resolveCodexBiller` | C4 |
| `env[LITELLM_TAGS_ENV] = buildPaperclipLiteLlmTags(...)` | C4 |

Khối import gom nhiều tên có thể vào C3 nguyên khối. Tên chưa dùng chỉ làm thừa import tạm thời, `tsc` không báo lỗi. Vẫn chạy typecheck sau mỗi commit để chắc.

## 5. Các bước thực hiện

**Bước 0: lưới an toàn**

```bash
git branch backup/test_adapter-before-split
```

**Bước 1: xóa key khỏi file doc** (mục 2.1), rồi kiểm tra bằng lệnh `grep` ở trên.

**Bước 2: commit C1, C2** (nguyên file)

```bash
git add packages/adapter-utils/src/codex-toml.ts packages/adapter-utils/src/codex-toml.test.ts
git commit -m "feat(adapter-utils): add codex-toml helpers for LiteLLM gateway config"

git add packages/adapter-utils/src/litellm-spend.ts packages/adapter-utils/src/litellm-spend.test.ts
git commit -m "feat(adapter-utils): add litellm-spend per-run usage collector"
```

**Bước 3: C3**

```bash
git add packages/adapters/codex-local/src/server/codex-home.ts \
        packages/adapters/codex-local/src/server/codex-home.test.ts \
        packages/adapters/codex-local/src/server/codex-args.ts \
        packages/adapters/codex-local/src/server/index.ts \
        server/src/routes/agents.ts
git add -p packages/adapters/codex-local/src/server/execute.ts       # chỉ hunk của C3
git add -p packages/adapter-utils/src/acpx-engine/execute.ts         # chỉ hunk của C3
git diff --cached --stat
pnpm --filter "./packages/adapter-utils" typecheck
pnpm --filter "./packages/adapters/codex-local" typecheck
git commit -m "feat(codex): managed CODEX_HOME seeding for LiteLLM gateway agents"
```

Phím trong `git add -p`: `y` lấy hunk, `n` bỏ, `s` chia nhỏ, `e` sửa tay (cho vùng trộn ở dòng ~1537), `q` thoát. Trong VS Code có thể bôi chọn dòng rồi chuột phải **Stage Selected Ranges**.

**Bước 4: C4 và C5**: lặp lại cách trên. Mỗi lần `git add` các file nguyên vẹn, `git add -p` cho các `execute.ts`, kiểm tra `git diff --cached --stat`, typecheck, rồi commit.

**Bước 5: bỏ phần nhiễu khoảng trắng.** Sau khi C3, C4, C5 đã commit hết phần có ý nghĩa:

```bash
git diff -w --stat packages/adapter-utils/src/acpx-engine/execute.ts     # phải trống
git checkout -- packages/adapter-utils/src/acpx-engine/execute.ts        # chỉ chạy khi dòng trên trống
```

Nếu dòng đầu **không trống**, còn thay đổi thật chưa commit. Không chạy `checkout`.

**Bước 6: C6, C7, C8**

```bash
git add packages/adapters/n8n-runtime/src/server/test.ts
git commit -m "fix(n8n-runtime): treat redacted n8n API key as masked in env test"

git add AGENTS.md
git commit -m "docs(agents): add Telegram task completion guidelines"

git add doc/plans/ instructions/ ':!instructions/log.txt'
git commit -m "docs: add Telegram/n8n/LiteLLM design notes and plans"
```

**Bước 7: kiểm tra cuối**

```bash
git status --short          # chỉ còn log.txt và test_ke_hoach_trien_khai.md
git log --oneline -9
pnpm -r typecheck
```

## 6. Lưu ý

- Cảnh báo `LF will be replaced by CRLF` ở `execute.test.ts` và `n8n-runtime/test.ts` chỉ là chuyển đổi cuối dòng của git trên Windows, không phải lỗi.
- Message commit có thể thêm cuối dòng trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` cho các commit có sự hỗ trợ của Claude.
- Khi mở PR phải điền đủ mọi mục của `.github/PULL_REQUEST_TEMPLATE.md` (xem AGENTS.md mục 10), và chạy bộ kiểm tra đầy đủ ở AGENTS.md mục 7.
- Nhánh `backup/test_adapter-before-split` giữ nguyên trạng thái trước khi tách. Xóa khi chắc chắn đã xong.
