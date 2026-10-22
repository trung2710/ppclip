# Ghi chép thay đổi: LiteLLM gateway cho `codex_local` (Guardian, cost và token theo run)

Ngày: 2026-10-13 · Nhánh: `test_adapter` · Trạng thái: **chưa commit**

Tài liệu này ghi lại toàn bộ chỉnh sửa trong đợt làm việc với LiteLLM gateway cho adapter `codex_local`: nguyên nhân từng vấn đề, cách sửa, file nào đổi, cách kiểm thử và các giới hạn còn lại.

---

## 1. Tóm tắt

| Vấn đề | Nguyên nhân gốc | Cách sửa |
|---|---|---|
| Logic chỉnh `config.toml` bị copy ở 2 nơi, dùng regex trên cả file | Code LiteLLM ban đầu viết riêng cho lane CLI và lane ACPX | Gom vào một module chung `adapter-utils/src/codex-toml.ts`, chỉnh TOML theo từng table |
| Guardian vẫn chạy (gọi `gpt-5.6-luna`, MCP tool bị `Denied`) dù `config.toml` đã tắt | `codex-acp` gửi `approvalsReviewer` theo **mode của session** ở mỗi lượt, đè lên `config.toml`; mode mặc định `agent` dùng `auto_review` | Agent dùng LiteLLM được đặt `INITIAL_AGENT_MODE=read-only` (reviewer `user`, acpx `approve-all` tự duyệt) |
| Paperclip không có cost | LiteLLM tính cost đúng, nhưng **Codex bỏ trường `cost`** khi đọc response (đã kiểm chứng bằng `codex exec --json`) và `codex-acp` chỉ phát `{ used, size }` | Paperclip lấy cost trực tiếp từ log của LiteLLM |
| Token trên Paperclip thấp hơn thực tế | `codex-acp` chỉ trả token của **request cuối** trong lượt (`tokenUsage.last`), không phải tổng | Token cũng lấy từ log LiteLLM, cộng mọi request của run |
| Không tách được request theo run (run song song, recover cùng phiên) | Spend của key là bộ đếm chung | Mỗi request mang tag `paperclip_run:<runId>` qua header `x-litellm-tags` |

---

## 2. Kiến trúc tính cost và token theo run

```
Paperclip (mỗi run, tiến trình Codex mới)
  buildRuntime đặt env:
    PAPERCLIP_LITELLM_TAGS = paperclip_run:<runId>,paperclip_agent:<agentId>,paperclip_company:<companyId>
      │
Codex đọc config.toml:
  [model_providers.mygw]
  env_http_headers = { "x-litellm-tags" = "PAPERCLIP_LITELLM_TAGS" }
      │  mọi request (kể cả request phụ) gửi header  x-litellm-tags: ...
      ▼
LiteLLM lưu thành request_tags của từng request (không cần cấu hình thêm)
      │
Paperclip sau lượt chạy, trước khi trả kết quả run:
  GET /spend/logs?api_key=<hash>&start_date&end_date&summarize=false
  lọc request có tag đúng bằng paperclip_run:<runId>
  cộng: input (prompt − cached), cached, output, spend
      │
  ghi đè usage + costUsd của kết quả run  →  Paperclip core ghi sổ và hiển thị
```

Thời điểm gọi API:

| Thời điểm | API | Mục đích |
|---|---|---|
| Ngay trước lượt chạy | `GET /key/info` | Lấy spend ban đầu (dùng cho phương án dự phòng) và hash của key (để lọc `/spend/logs`) |
| Ngay sau lượt chạy, trước khi run kết thúc | `GET /spend/logs` (đọc lặp) | Gom các request mang tag của run |

### 2.1 Bản đồ code: phép cộng nằm ở đâu

| Bước | Vị trí | Việc làm |
|---|---|---|
| Cộng token + cost từng request của run | `litellm-spend.ts` → `summarizeTaggedSpendLogs` (dòng ~166-196) | Vòng lặp trên danh sách `/spend/logs`: bỏ request không có tag đúng `paperclip_run:<runId>`; cộng `inputTokens += prompt − cached`, `cachedInputTokens += cached`, `outputTokens += completion_tokens`, `costUsd += spend`; đếm `requestCount` và `failedRequestCount`. Hàm thuần túy, mỗi lần gọi tính lại từ đầu |
| Gọi API, đọc lặp, chờ log ổn định | `litellm-spend.ts` → `collectLiteLlmRunUsage` (dòng ~206-247) | Gọi `GET /spend/logs` rồi đưa qua hàm trên; quyết định khi nào dừng chờ |
| Cắm vào luồng chạy run | `acpx-engine/execute.ts` (dòng ~3141-3180) | Gọi `collectLiteLlmRunUsage`; ghi đè `turnUsage.usage` và `turnUsage.costUsd`; in dòng log tóm tắt; hoặc rơi về phương án dự phòng |
| Trả kết quả cho Paperclip core | `acpx-engine/execute.ts` (dòng ~3275-3276) | `usage: turnUsage.usage`, `costUsd: turnUsage.costUsd` |
| Quy đổi sang cent, ghi sổ, cộng dồn ngân sách theo agent | `server/src/services/heartbeat.ts` (dòng ~11720) | Code có sẵn của core, không thuộc đợt thay đổi này |

Phạm vi của đợt thay đổi này chỉ là **tổng của từng run**. Cộng dồn theo thời gian vào ngân sách là việc của core.

### 2.2 Vì sao phải chờ log

Khi Codex chạy xong, LiteLLM chưa chắc đã ghi đủ log của các request thuộc run đó. Nếu đọc ngay thì tổng bị thiếu:

```
Run thật có 20 request, tổng 0.050
Đọc ngay lúc xong:   thấy 14 request → 0.031   (thiếu)
Chờ vài giây:        thấy 20 request → 0.050   (đủ)
```

Quan sát thực tế dẫn đến thiết kế này: một run từng báo "2 request, cả 2 đều lỗi, 0 token" trong khi thực tế còn nhiều request thành công chưa kịp xuất hiện. Suy luận (**chưa kiểm chứng trên LiteLLM 1.102 của môi trường này**): LiteLLM ghi request lỗi ngay, còn request thành công được ghi theo lô nên trễ hơn.

### 2.3 Hai giai đoạn sau khi lượt chạy xong

```
Lượt chạy xong
   │
   ▼
┌─ Giai đoạn A: gom log theo tag ──────────────────────────────────────┐
│  Vào khi: agent dùng LiteLLM, đã lấy được key hash trước lượt,       │
│           và KHÔNG dùng lại tiến trình giữ ấm                        │
│  Chờ tối đa 15 giây                                                  │
└──────────────────────────────────────────────────────────────────────┘
   │
   ├─ thấy ≥ 1 request mang tag ──► dùng số liệu này, kết thúc (không chạy giai đoạn B)
   │
   └─ không thấy request nào, hoặc không đọc được log
         ▼
┌─ Giai đoạn B: dự phòng, trừ spend của key ───────────────────────────┐
│  Vào khi: ACP chưa có cost và đã đọc được spend trước lượt           │
│  Chờ tối đa 6 giây                                                   │
└──────────────────────────────────────────────────────────────────────┘
   │
   ▼
Trả { usage, costUsd } cho Paperclip core
```

### 2.4 Giai đoạn A: logic chờ (`collectLiteLlmRunUsage`)

```
đọc lần 0, tính tổng thử (chỉ lấy request có tag của run)
lặp khi: lần đọc trước chưa lỗi  VÀ  chưa quá hạn:
    nếu (đã có ≥ 1 request THÀNH CÔNG) VÀ (số liệu đứng yên 2 lần liên tiếp) → DỪNG
    nghỉ 1.5 giây
    đọc lại, tính lại tổng từ đầu
    số request VÀ tổng cost đều không đổi so với lần trước → đếm +1; ngược lại → đếm về 0
trả kết quả của lần đọc cuối
```

- "Request thành công" nghĩa là `requestCount > failedRequestCount`. Vế này được thêm sau khi phát hiện lỗi dừng sớm: nếu chỉ kiểm tra "đứng yên" thì khi log mới về toàn request lỗi, code kết luận đã xong và bỏ lỡ các request thành công về sau.
- Mỗi lần đọc **tính lại toàn bộ** từ danh sách log, không cộng dồn giữa các lần đọc. Chỉ lần đọc cuối được dùng.
- Giai đoạn A lọc **theo tag**, không lọc theo thời gian. `startedAtMs` và `endedAtMs` chỉ dùng để chọn ngày truy vấn (`start_date`, `end_date`), có tính cả run vắt qua nửa đêm UTC.

| Tham số | Giá trị | Ghi chú |
|---|---|---|
| Khoảng nghỉ giữa hai lần đọc | 1.5 giây | hằng số `DEFAULT_POLL_INTERVAL_MS` |
| Số lần đứng yên liên tiếp để chốt | 2 | cố định |
| Thời gian chờ tối đa | 15 giây | `DEFAULT_LITELLM_LOG_SETTLE_MS`, chỉnh bằng `adapterConfig.litellmSpendSettleMs` (mili giây) |
| Timeout của mỗi lần gọi HTTP | 3 giây | hằng số `DEFAULT_REQUEST_TIMEOUT_MS` |

### 2.5 Giai đoạn B: phương án dự phòng (`measureLiteLlmRunCostUsd`)

```
đọc spend tích lũy của key lần 0 (GET /key/info)
lặp khi: lần đọc trước chưa lỗi, chưa quá hạn 6 giây, và spend chưa đứng yên 2 lần:
    nghỉ 1.5 giây, đọc lại spend
cost của run = spend cuối − spend đã ghi trước lượt   (null nếu spend cuối nhỏ hơn: key bị reset)
```

Chỉ cho **cost**, không cho token, và bị lẫn nếu có run khác dùng chung key chạy cùng lúc. Chờ tối đa 6 giây (`DEFAULT_LITELLM_SPEND_SETTLE_MS`).

Cả hai giai đoạn dùng chung tên tham số `adapterConfig.litellmSpendSettleMs`: khi được đặt, cùng một giá trị áp cho cả hai. Khi không đặt, giai đoạn A dùng 15000 và giai đoạn B dùng 6000.

### 2.6 Tình huống thực tế và thời gian chậm thêm cho run

| Tình huống | Giai đoạn A | Giai đoạn B | Chậm thêm khoảng |
|---|---|---|---|
| Bình thường, log về nhanh | Dừng khi đủ điều kiện, dùng số liệu | Không chạy | 3 giây (hai lần đọc xác nhận) |
| Log về trễ vài giây | Chờ đến khi ổn định | Không chạy | vài giây đến 10 giây |
| Mọi request của run đều lỗi (model sai, 429...) | Chờ đủ 15 giây, trả số liệu toàn lỗi (token 0, cost 0, đếm số request lỗi), dùng luôn | Không chạy | 15 giây |
| Không request nào mang tag (Codex không gửi header, hoặc run không gọi model) | Chờ đủ 15 giây, không thấy gì | Chạy | 15 đến 21 giây |
| Không đọc được log (LiteLLM tắt, key không đủ quyền) | Dừng ngay vì lần đọc đầu đã `null` | Chạy nếu đọc được spend | vài giây |
| Dùng lại tiến trình giữ ấm (`warmHandleIdleMs > 0`) | Bỏ qua | Chạy | đến 6 giây |
| Agent không dùng LiteLLM | Không chạy | Không chạy | 0 |

Giới hạn "15 giây" chỉ được kiểm tra giữa các lần đọc. Nếu LiteLLM treo, mỗi lần đọc có thể mất thêm tối đa 3 giây (timeout HTTP) nên thời gian thực tế có thể vượt hạn một chút.

Các lần chờ nằm **bên trong** run: run chỉ được tính là kết thúc sau khi chờ xong, và run kế tiếp của cùng agent chỉ bắt đầu sau đó. Nhờ vậy số liệu hai run liên tiếp không bị lẫn nhau.

### 2.7 Giả định chưa kiểm chứng của cơ chế chờ

- Mức 15 giây là **ước lượng**, chưa đo độ trễ thật giữa lúc request thành công xong và lúc nó xuất hiện trong `/spend/logs`.
- Chưa ghi số lần đọc và số giây đã chờ vào log của run, nên chưa có số liệu để chỉnh `litellmSpendSettleMs` cho khớp. Đề xuất việc sau: thêm hai con số này vào dòng `[paperclip] LiteLLM usage for ...`.
- Điều kiện dừng chỉ so sánh `requestCount` và `costUsd`. Với model miễn phí (cost luôn 0), việc ổn định phụ thuộc vào số request.

### 2.8 Vì sao không ảnh hưởng việc nạp lại phiên
`PAPERCLIP_LITELLM_TAGS` được đặt vào env **runtime**, không phải env cấu hình agent. Fingerprint của session chỉ băm env cấu hình (`resolvedAdapterEnv`), nên đổi run id mỗi lần không làm mất phiên đã lưu.

---

## 3. Danh sách file thay đổi

### File mới

| File | Nội dung |
|---|---|
| `packages/adapter-utils/src/codex-toml.ts` | Bộ chỉnh TOML theo table (`setTomlRootKeys`, `setTomlTableKeys`, `replaceTomlTable`); cấu hình LiteLLM (`applyLiteLlmGatewayToml`, `patchCodexTomlForLiteLlmGateway`); tắt approval (`ensureCodexApprovalsDisabled`, `disableCodexApprovalsInHome`); nhận diện gateway (`resolveCodexGatewayConfig`); mode `codex-acp` (`resolveCodexAcpInitialMode`); tag theo run (`LITELLM_TAGS_ENV`, `buildPaperclipLiteLlmTags`, `paperclipRunTag`) |
| `packages/adapter-utils/src/codex-toml.test.ts` | Test cho module trên |
| `packages/adapter-utils/src/litellm-spend.ts` | `readLiteLlmKeyInfo`, `readLiteLlmKeySpend`, `measureLiteLlmRunCostUsd` (dự phòng), `summarizeTaggedSpendLogs`, `collectLiteLlmRunUsage` |
| `packages/adapter-utils/src/litellm-spend.test.ts` | Test cho module trên |

### File sửa

| File | Thay đổi |
|---|---|
| `packages/adapter-utils/src/acpx-engine/execute.ts` | Bỏ các hàm TOML trùng lặp, dùng module chung; đặt `INITIAL_AGENT_MODE=read-only` và `PAPERCLIP_LITELLM_TAGS` cho agent LiteLLM; đọc `/key/info` trước lượt; gom log theo tag sau lượt và ghi đè `usage`/`costUsd`; in dòng log `[paperclip] LiteLLM usage for ...`; `buildCodexStartupConfig` chỉ tắt approval cho agent LiteLLM. Đã bỏ phần reformat do formatter |
| `packages/adapter-utils/src/acpx-engine/execute.test.ts` | Thêm nhóm test `ACPX engine LiteLLM gateway run usage` |
| `packages/adapters/codex-local/src/server/codex-home.ts` | Dùng module chung; helper `resolveGatewaySeedInputs`; tùy chọn `disableApprovalGuardian` (chỉ bật khi dùng gateway) |
| `packages/adapters/codex-local/src/server/codex-home.test.ts` | Kiểm tra `config.toml` có `env_http_headers`; bỏ dòng trống thừa |
| `packages/adapters/codex-local/src/server/codex-args.ts` | Cờ `approval_policy="never"` và tắt Guardian **chỉ** khi agent dùng gateway (trước đây áp cho mọi agent) |
| `packages/adapters/codex-local/src/server/execute.ts` (lane CLI) | Dùng `resolveCodexGatewayConfig`; đặt `PAPERCLIP_LITELLM_TAGS` cho agent LiteLLM |
| `server/src/routes/agents.ts` | `reconcileCodexLocalAgentOnSave` dùng `resolveCodexGatewayConfig`; bỏ import `secretService` bị trùng (lỗi typecheck) |

### `config.toml` của agent LiteLLM sau khi seed

```toml
model_provider = "mygw"
model = "<model trên LiteLLM>"
model_reasoning_effort = "low"
approval_policy = "never"
approvals_reviewer = "user"
...
[features]
guardian_approval = false
guardian = false

[model_providers.mygw]
name = "My gateway"
base_url = "http://localhost:4000/v1"
env_key = "LITELLM_API_KEY"
wire_api = "responses"
env_http_headers = { "x-litellm-tags" = "PAPERCLIP_LITELLM_TAGS" }
```

Khối `[model_providers.mygw]` được viết lại toàn bộ ở mỗi lần seed (tạo agent, Save agent, mỗi run), nên agent cũ tự được cập nhật và không bị lặp dòng.

---

## 4. Hành vi theo loại agent

| Agent | Guardian / approval | Tag theo run | Cost / token |
|---|---|---|---|
| `codex_local` dùng LiteLLM (`LITELLM_API_KEY`, `LITELLM_BASE_URL` hoặc `OPENAI_BASE_URL`), lane ACPX | Tắt (`INITIAL_AGENT_MODE=read-only` + `config.toml`) | Có | Từ log LiteLLM theo tag; dự phòng: chênh lệch spend |
| `codex_local` dùng LiteLLM, lane CLI | Tắt (cờ `-c` + `config.toml`) | Có (env được đặt) | **Chưa** gom log, vẫn như cũ |
| `codex_local` không dùng LiteLLM | Mặc định của Codex, Paperclip không ép | Không | Như cũ |

---

## 5. Cấu hình LiteLLM

- **Không cần cấu hình gì thêm** để có tag: LiteLLM tự đọc header `x-litellm-tags`.
- Key của agent phải đọc được `/key/info` và `/spend/logs`. Key `codex` hiện có vai trò `proxy_admin` nên đọc được.
- Nên **tắt** `store_prompts_in_spend_logs` (chỉ bật để thử nghiệm): log nhẹ hơn nhiều, tag vẫn còn.
- Nên thêm alias `gpt-5.6-luna` trỏ về một model có thật: Codex dùng tên này cho request tạo tiêu đề hội thoại, hiện các request đó thất bại (`Invalid model name`), tuy không tốn tiền nhưng làm nhiễu log.

---

## 6. Kiểm thử

### 6.1 Test tự động

```sh
npx vitest run packages/adapter-utils/src/litellm-spend.test.ts
npx vitest run packages/adapter-utils/src/codex-toml.test.ts
npx vitest run packages/adapter-utils/src/acpx-engine/execute.test.ts -t "LiteLLM gateway run usage"
npx vitest run packages/adapters/codex-local/src/server/codex-home.test.ts -t "LiteLLM|base_url"
```

Chạy từ thư mục gốc repo (cấu hình vitest projects nằm ở gốc).

| Nhóm test | Kiểm tra |
|---|---|
| `summarizeTaggedSpendLogs` | Chỉ cộng request đúng tag (khớp chính xác, không theo tiền tố); tách cached khỏi input; đếm request lỗi (ở `status` hoặc `metadata.status`); trường thiếu/không phải số/âm coi là 0; cached không vượt prompt; làm tròn cost |
| Phân bổ theo run | Hai run song song cùng key tách đúng; hai run nối tiếp cùng phiên (recover) tách đúng |
| `collectLiteLlmRunUsage` | URL `/spend/logs` đúng (key hash, ngày UTC, run vắt qua nửa đêm); chờ log đến muộn; **không dừng khi mới chỉ có request lỗi**; run toàn request lỗi chờ đến hạn; lỗi đọc trả `null` |
| `readLiteLlmKeyInfo` / `measureLiteLlmRunCostUsd` | Đọc spend + hash; chênh lệch spend; spend giảm (key bị reset) trả `null`; dừng ở hạn chờ |
| Tag và TOML | `env_http_headers` ghi dạng inline table, không bị lặp khi seed lại; chuỗi tag run/agent/company |
| Tích hợp lane ACPX | Env có `PAPERCLIP_LITELLM_TAGS` và `INITIAL_AGENT_MODE=read-only`; `usage`/`costUsd` của run bằng tổng log có tag (bỏ qua request của run khác); dòng log tóm tắt; rơi về chênh lệch spend khi không có tag; agent không dùng LiteLLM không bị đổi và không gọi gateway |

Kết quả khi viết tài liệu: typecheck sạch (`adapter-utils`, `codex-local`, `server`); các test mới đều pass. Các test fail còn lại trên Windows là lỗi môi trường có sẵn từ trước (assert quyền file POSIX 0600/0700, lệnh `tar`/`sh` của nhóm test remote sandbox), đã đối chiếu với bản gốc.

### 6.2 Kiểm thử thủ công với LiteLLM thật

1. Cho agent dùng model **có tính tiền** (model free luôn cho cost = 0).
2. Khởi động lại `pnpm dev`, vào agent bấm **Save**, kiểm tra `codex-home\config.toml` có dòng `env_http_headers`.
3. Chạy một task. Cuối log của run phải có:
   ```
   [paperclip] LiteLLM usage for paperclip_run:<runId>: N request(s) (M failed), input ..., cached ..., output ..., cost $...
   ```
4. Tự cộng lại trên LiteLLM (thay `<RUN_ID>`, `<KEY_HASH>`, `<KEY>`, ngày):
   ```powershell
   $RUN = "<RUN_ID>"
   $rows = curl.exe -s "http://localhost:4000/spend/logs?api_key=<KEY_HASH>&start_date=2026-10-13&end_date=2026-10-14&summarize=false" -H "Authorization: Bearer <KEY>" | ConvertFrom-Json
   $mine = $rows | Where-Object { $_.request_tags -contains "paperclip_run:$RUN" }
   $cached = ($mine | ForEach-Object { $_.metadata.usage_object.prompt_tokens_details.cached_tokens } | Measure-Object -Sum).Sum
   $prompt = ($mine | Measure-Object prompt_tokens -Sum).Sum
   "requests: $($mine.Count)"; "input: $($prompt - $cached)"; "cached: $cached"
   "output: $(($mine | Measure-Object completion_tokens -Sum).Sum)"; "cost: $(($mine | Measure-Object spend -Sum).Sum)"
   ```
5. Dòng log, kết quả tự cộng và số trên màn hình run phải khớp nhau.

---

## 7. Giới hạn và việc còn mở

- **Lane CLI** (`engine: "cli"`) chưa gom log theo tag.
- **Giữ ấm tiến trình** (`warmHandleIdleMs > 0`): tiến trình dùng lại mang tag của run cũ. Code phát hiện và rơi về cách trừ spend, nhưng trên LiteLLM UI các request đó sẽ mang tag sai. Giữ `warmHandleIdleMs = 0` (mặc định) cho agent LiteLLM.
- **Key chung giữa nhiều agent**: cách gom theo tag vẫn đúng; chỉ phương án dự phòng bị lẫn.
- **Key quyền hạn chế** (không phải `proxy_admin`): chưa kiểm chứng đọc được `/spend/logs`; nếu không, code rơi về cách trừ spend.
- **Thời gian chờ ghi log** của LiteLLM: giai đoạn gom theo tag chờ tối đa 15 giây, giai đoạn dự phòng 6 giây (xem mục 2.3 đến 2.6). Nếu cost/token vẫn thiếu so với tổng trên LiteLLM, tăng `litellmSpendSettleMs` (áp cho cả hai giai đoạn). Run toàn request lỗi hoặc không có tag sẽ chậm thêm đến 15 đến 21 giây.
- **Sub-agent của Codex**: dùng cùng tiến trình và cùng cấu hình provider nên được kỳ vọng mang cùng tag, nhưng chưa kiểm chứng.
- `features.guardian` bị Codex 0.160.1 báo "is ignored" (chỉ `guardian_approval` hợp lệ). Vô hại, chưa bỏ vì chưa rõ bản đóng gói 0.153.4.
- **Sandbox của mode `read-only`**: request tạo tiêu đề cho thấy `sandbox_mode = read-only`, có thể chỉ là luồng phụ. Cần xác nhận lượt chính vẫn ghi được trong workspace.

---

## 8. Đính chính tài liệu cũ

- `co_che_va_cau_hinh_codex_home_multi_level_paperclip.md` mục 8.6: `guardian_approval = false` **không đủ** ở lane ACPX, vì `codex-acp` đè bằng mode của session. Cần thêm `INITIAL_AGENT_MODE`.
- `HUONG_DAN_QUAN_TRI_MODEL_LITELLM_PROXY.md` mục 8.5: giả định "Codex CLI in `usage.cost` ra stdout" **sai**. `turn.completed.usage` của Codex chỉ có 5 trường token; cost phải lấy từ log LiteLLM như mô tả ở mục 2.

---

## 9. MCP server của Paperclip: chuyển danh tính run bằng `env_vars`

Phần này tách khỏi LiteLLM: nó xử lý việc tool MCP của Paperclip (`paperclip-mcp/src/paperclip_mcp/server.py`) không nhận được `PAPERCLIP_API_KEY`, `PAPERCLIP_RUN_ID`... nên agent phải tự dò key qua nhiều lượt rồi truyền qua tham số.

### 9.1 Nguyên nhân

```
Paperclip server
 └─ codex-acp ... env: PAPERCLIP_RUN_ID, PAPERCLIP_API_KEY, PAPERCLIP_TASK_ID, ...
     └─ codex.exe ... cùng env
         └─ python server.py (MCP, stdio) ... chỉ có env mặc định + những gì [mcp_servers.*] khai báo
```

MCP server là tiến trình con của Codex. Biến môi trường đi theo hướng cha → con **lúc khởi chạy** và Codex không chuyển toàn bộ môi trường. Một tiến trình không đọc được biến của tiến trình khác, nên không có hàm nào "đi lấy" biến được: phải khai báo chuyển tiếp trong `config.toml`.

### 9.2 Cấu hình

```toml
[mcp_servers.paperclip]
command = "D:\\anaconda\\envs\\ml_env\\python.exe"
args = ["C:/paperclip/paperclip-mcp/src/paperclip_mcp/server.py", "--transport", "stdio"]
env = { PAPERCLIP_BASE_URL = "http://localhost:3100/api" }
env_vars = ["PAPERCLIP_API_KEY", "PAPERCLIP_COMPANY_ID", "PAPERCLIP_RUN_ID", "PAPERCLIP_TASK_ID", "PAPERCLIP_API_URL", "PAPERCLIP_WAKE_PAYLOAD_JSON"]
```

| Khai báo | Giá trị lấy từ đâu | Dùng cho |
|---|---|---|
| `env = { TÊN = "giá trị" }` | Ghi cứng trong file | Hằng số (`PAPERCLIP_BASE_URL`) |
| `env_vars = ["TÊN"]` | Môi trường của Codex lúc khởi chạy, mỗi run một giá trị, không lưu trong file | Giá trị theo run hoặc bí mật |

### 9.3 Paperclip tự đảm bảo dòng `env_vars` khi seed `codex-home`

- Hàm `ensurePaperclipMcpEnvVars` / `ensurePaperclipMcpEnvVarsInHome` trong `packages/adapter-utils/src/codex-toml.ts`.
- Gọi ở cả hai nơi seed: `seedManagedCodexHome` (`codex-home.ts`, lane CLI) và `prepareManagedCodexHome` (`acpx-engine/execute.ts`, lane ACPX), **mỗi lần seed**. Lý do: `config.toml` chỉ được sao chép một lần (không ghi đè nếu đã có), nên các home đã seed từ trước sẽ không bao giờ nhận dòng này nếu chỉ sửa file gốc.
- Nhận diện MCP server của Paperclip: bảng `[mcp_servers.paperclip]`, hoặc bảng `[mcp_servers.*]` có command/args chứa `paperclip_mcp` / `paperclip-mcp`.
- Giữ các tên đã liệt kê và chỉ thêm tên còn thiếu; không đụng MCP server khác; **không tạo** bảng mới; idempotent (không ghi lại file nếu không đổi); giữ CRLF.
- Chỉ áp dụng cho home **do Paperclip quản lý**. Agent dùng `CODEX_HOME` trỏ thẳng vào thư mục máy (`C:\Users\<user>\.codex`) không bị Paperclip sửa: phải thêm dòng này vào file đó bằng tay.

### 9.4 `server.py`: danh tính từ biến môi trường thắng tham số do agent điền

Các hàm `_resolve_api_key`, `_resolve_run_id`, `_get_company_id`, `_headers`, `_upload_headers`, `_resolve_current_task_id` dùng chung `_pick_identity`:

| Chế độ chạy | Ưu tiên |
|---|---|
| `--transport stdio` (Codex khởi chạy MCP riêng cho phiên) | **Biến môi trường trước**, tham số chỉ là phương án cuối |
| HTTP (một tiến trình phục vụ nhiều agent) | **Tham số trước** (hành vi cũ) |
| Ép bằng `PAPERCLIP_MCP_ENV_FIRST=1` hoặc `0` | Theo cờ |

Lý do: trước đây `api_key`/`run_id` agent tự điền đè lên biến môi trường đúng, tức là một giá trị bịa vẫn thắng. `task_id` **chưa** đổi thứ tự ưu tiên. Test: `paperclip-mcp/tests/test_identity_resolution.py` (13 ca).

### 9.5 Kiểm chứng và giới hạn

- Đã kiểm chứng bằng run thật: `get_agent` chạy ngay lượt đầu, agent không còn gọi shell để dò biến, `finish_task_and_reply_telegram` đọc được task id.
- `paperclip-mcp` nằm trong `.gitignore` (`/paperclip-mcp`): thay đổi ở `server.py` và thư mục `tests` **không có trong git**.
- `server.py` có 4 tool bị định nghĩa trùng (`list_issue_documents`, `get_issue_document`, `upsert_issue_document`, `upload_issue_attachment`), có sẵn từ trước, chưa sửa.
- `finish_task_and_reply_telegram` lỗi cứng `Step 2/5 FAILED` khi task không có `chat_id` (task tạo tay, không đến từ Telegram). Đúng thiết kế, nhưng nên lùi êm. Chưa sửa.
- Xem lỗi trả về của tool MCP: log Codex ở `<CODEX_HOME>\logs_2.sqlite` (bảng `logs`, cột `feedback_log_body`). File này chứa toàn bộ prompt, tham số và kết quả tool nên **không chia sẻ nguyên file**.
