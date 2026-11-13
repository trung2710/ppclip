# Phần 6. Log chi tiết của run và giao diện transcript

- Ngày: 13/11/2026
- Nhánh: `test_adapter`. Các link code trỏ tới commit [`f6c9d6bfc`](https://github.com/trung2710/ppclip/tree/f6c9d6bfc1225895047151d99f8d4002dacee482), nên số dòng không bị lệch khi code thay đổi sau này.
- Commit chính của phần này:
  - [`d7860be2f`](https://github.com/trung2710/ppclip/commit/d7860be2f) (20/10): hiển thị tham số và output của tool trong log run (engine ACPX);
  - [`641b26382`](https://github.com/trung2710/ppclip/commit/641b26382) (20/10): thêm cột giờ vào transcript của run (giao diện);
  - [`b681e6ef5`](https://github.com/trung2710/ppclip/commit/b681e6ef5) (17/08): định dạng log cho adapter HTTP và `n8n-bridge`;
  - [`782e05caa`](https://github.com/trung2710/ppclip/commit/782e05caa) (18/08): parser giao diện cho log n8n;
  - [`5abc0bad7`](https://github.com/trung2710/ppclip/commit/5abc0bad7) (27/08): n8n runtime ghi log dạng văn bản có cấu trúc (`├─ └─`);
  - [`d61b782b5`](https://github.com/trung2710/ppclip/commit/d61b782b5) (27/08): sửa log lỗi và cách tìm `executionId` của n8n.
- **Đính chính so với danh sách ban đầu:** ở bước lập kế hoạch tôi đã mô tả `b681e6ef5` và `5abc0bad7` là "định dạng log trong tab transcript". Đọc diff thì cả hai sửa **adapter** (n8n bridge, HTTP, n8n runtime) chứ không sửa giao diện. Phần giao diện thật sự chỉ là `641b26382` (cột giờ). Báo cáo này trình bày theo đúng thực tế đó.
- Liên quan: Phần 4 (nguồn gốc của `permissionMode` và các dòng tool), Phần 7 (lỗi MCP hiện ra trong log).

---

## Tóm tắt phần này

**Đã thực hiện:** đọc diff của cả 6 commit và code hiện tại; chạy test và bộ kiểm tra token thiết kế; **đo trên các file log run thật** trong `data/run-logs` (689 file, trong đó 236 file có `acpx.tool_call`; không cần database); kiểm tra độ phủ của bộ che secret bằng mẫu thử. Tôi **chưa xem giao diện bằng mắt** (không có trình duyệt trong phiên này), nên phần hiển thị chỉ được kiểm bằng code và test.

| Nội dung trong plan | Trạng thái | Xem ở mục |
|---|---|---|
| Log chi tiết: tham số và output của tool (acpx) | Xong, có số liệu trước/sau | 2 |
| Giao diện transcript: cột giờ | Xong | 3 |
| Định dạng log trực quan (adapter HTTP, n8n) | Xong, **phát hiện lệch giờ** | 4 |
| Log node của n8n | Xong | 4 |

**Nguồn đã dùng:**
- Code: `adapter-utils/src/acpx-engine/{tool-output,execute,ui,cli}.ts`; `ui/src/components/transcript/RunTranscriptView.tsx`, `ui/src/pages/AgentDetail.tsx`; `n8n-runtime-adapter/` và `packages/adapters/n8n-runtime/`; `server/src/adapters/http/execute.ts`; `n8n-bridge/bridge.js`.
- Dữ liệu thật: các file `*.ndjson` trong `~/.paperclip/instances/default/data/run-logs`.

**Kết quả kiểm tra:**
- 42 test pass (`tool-output.test.ts` và `RunTranscriptView.test.tsx`).
- `pnpm check:token-gates` báo 115 vi phạm, **không có vi phạm nào** trong `RunTranscriptView.tsx` hay `AgentDetail.tsx` (đều ở các trang Lab và file test có sẵn).
- Trước 15/10, **khoảng 90% dòng `tool_call` trong log là dòng rỗng** (không có tên, tham số hay kết quả). Từ 20/10 không còn dòng rỗng nào, và số dòng `tool_call` mỗi run giảm từ vài chục đến vài trăm xuống còn 7 đến 10.
- Cột giờ mới hiển thị **giờ địa phương**, còn log n8n tự in **giờ UTC** trong nội dung, nên trên cùng một dòng có hai giờ lệch 7 tiếng (đã xác nhận bằng một dòng thật).

**Kết luận chính:**
1. Trước đây log run của agent Codex chỉ ghi "tool call (completed)", người xem không biết agent đã chạy lệnh gì, đọc file nào, gọi tool MCP với tham số gì. Giờ log ghi thêm tham số, output (đã che secret, cắt ngắn), diff khi sửa file, và bỏ các cập nhật rỗng.
2. Cột "Time" của tab Run hiển thị giờ từng dòng, bật mặc định, kèm mili giây khi rê chuột.
3. Log của adapter n8n đã đổi từ JSON sang văn bản có cấu trúc, nên **hai parser giao diện viết cho JSON không còn được dùng** cho các dòng này, và giờ trong nội dung là UTC.
4. Bộ che secret **không phủ** vài dạng phổ biến: `Authorization: Basic`, token GitHub `ghp_…`, khóa AWS, chuỗi kết nối cơ sở dữ liệu có mật khẩu.

---

## 1. Ba luồng log

```mermaid
flowchart LR
  subgraph A["A. Agent Codex (engine ACPX)"]
    A1["acpx: sự kiện tool_call<br/>rawInput, rawOutput, content, locations"] --> A2["emitRuntimeEvent<br/>lọc rỗng, tóm tắt, che secret,<br/>cắt ngắn, nối output"]
    A2 --> A3["dòng NDJSON acpx.tool_call<br/>(thêm args, kind, output)"]
  end
  subgraph C["C. Agent n8n / HTTP"]
    C1["n8n webhook + execution API"] --> C2["adapter: emit()"]
    C2 --> C3["văn bản [HH:MM:SS.mmm] [LEVEL] ...<br/>├─ └─ (từ 27/08)"]
  end
  A3 --> F["data/run-logs/…/&lt;runId&gt;.ndjson"]
  C3 --> F
  F --> P["parser giao diện<br/>parseAcpxStdoutLine / parse-stdout"]
  P --> T["TranscriptEntry"]
  T --> V["RunTranscriptView<br/>B. cột Time (giờ địa phương)"]
```

- **A** (mục 2) làm cho nội dung log của Codex giàu thông tin hơn.
- **B** (mục 3) là phần giao diện duy nhất: cột giờ.
- **C** (mục 4) là log của agent n8n và HTTP, được định dạng ngay ở adapter.

---

## 2. Luồng A: tham số và output của tool trong log ACPX

### 2.1. Vấn đề trước đây

`acpx` đã chuyển tiếp đủ `rawInput`, `rawOutput`, `content`, `locations` trên mỗi sự kiện tool, nhưng dòng log `acpx.tool_call` chỉ mang `text` (ví dụ `tool call (completed)`). Ngoài ra `codex-acp` gửi hàng loạt cập nhật rỗng khi lệnh đang chạy: comment trong code ghi nhận *"ví dụ 24 dòng 'tool call' cho một lần đọc file"*.

Dữ liệu thật trên máy bạn cho thấy mức độ (đếm trên mọi log run có `acpx.tool_call`, theo ngày file được ghi; "rỗng" nghĩa là không trạng thái, tên chung chung, không input, args hay output):

| Ngày | Số run | Dòng `tool_call` TB/run | Có `args` | Có `output` | Dòng rỗng |
|---|---|---|---|---|---|
| 28/07 | 21 | 363 | 0 | 0 | 6.778 |
| 08/09 | 18 | 176 | 0 | 0 | 2.868 |
| 08/10 | 6 | 436 | 0 | 0 | 2.499 |
| 13/10 | 5 | 328 | 0 | 0 | 1.568 |
| 15/10 | 12 | 48 | 0 | 11 | 410 |
| 19/10 | 13 | 32 | 9 | 50 | 295 |
| **20/10** | 8 | **8** | 24 | 41 | **0** |
| **22/10** | 36 | **7** | 129 | 143 | **0** |
| **27/10** | 16 | **10** | 90 | 99 | **0** |

- Trước 15/10: **0 dòng nào có tham số hay output**, và khoảng 90% dòng `tool_call` là rỗng (ví dụ 28/07: 6.778 dòng rỗng trên khoảng 7.600).
- Từ 20/10: không còn dòng rỗng, và có `args`/`output` ở các dòng còn lại.
- Hiệu quả xuất hiện từ khoảng 15 đến 19/10, tức **sớm hơn ngày commit 20/10**, cùng quy luật ở Phần 5: sửa đổi chạy trong working tree trước khi được commit.
- Số liệu gộp mọi agent dùng engine ACPX (Codex và các agent khác), và ngày là ngày ghi file. Đây là số đếm mô tả, không phải so sánh có kiểm soát.

### 2.2. Giải pháp: module `tool-output.ts`

Module mới ([tool-output.ts](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/packages/adapter-utils/src/acpx-engine/tool-output.ts)) gồm các hàm:

| Hàm | Dòng | Việc làm |
|---|---|---|
| `isEmptyToolUpdate` | [225-231](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/packages/adapter-utils/src/acpx-engine/tool-output.ts#L225-L231) | Nhận ra cập nhật rỗng (không trạng thái, tên chung chung, không `rawInput/rawOutput/content/locations`) để **không ghi vào log** |
| `summarizeToolInputForLog` | [264-](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/packages/adapter-utils/src/acpx-engine/tool-output.ts#L264) | Tham số của tool (MCP, lệnh): che secret, cắt ở **2.000 ký tự**; bỏ `{}` rỗng mà `codex-acp` gửi cho các tool nội bộ |
| `summarizeToolOutputForLog` | [181-](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/packages/adapter-utils/src/acpx-engine/tool-output.ts#L181) | Kết quả: `Exit code`, output lệnh, nội dung file đã đọc, lỗi, **diff khi tạo hoặc sửa file** (tối đa 60 dòng), vị trí file; che secret, cắt ở **4.000 ký tự**; bỏ qua nếu đã nằm sẵn trong `text` |
| `ToolOutputCarry` | [239-](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/packages/adapter-utils/src/acpx-engine/tool-output.ts#L239) | Mang output của sự kiện "đang chạy" sang sự kiện "kết thúc" cùng `toolCallId` (xem dưới) |
| `redactToolOutput` | [164-](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/packages/adapter-utils/src/acpx-engine/tool-output.ts#L164) | Che secret bằng 4 mẫu regex (mục 2.4) |

Hằng số giới hạn: [tool-output.ts:11-13](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/packages/adapter-utils/src/acpx-engine/tool-output.ts#L11-L13).

**Vì sao cần `ToolOutputCarry`:** khi tạo hoặc sửa file, nội dung diff chỉ có ở sự kiện *bắt đầu*, còn sự kiện `completed` rỗng. Giao diện chỉ hiện output ở dòng *kết quả*, nên phải giữ output trước đó cho tới khi tool kết thúc, nếu không diff sẽ biến mất.

### 2.3. Nối vào engine và giao diện

Trong `emitRuntimeEvent` ([acpx-engine/execute.ts:2315-2360](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/packages/adapter-utils/src/acpx-engine/execute.ts#L2315-L2360)):

```ts
// execute.ts (rút gọn): thứ tự xử lý một sự kiện tool_call
await captureRawToolEvent(ctx.runId, eventRecord);          // chẩn đoán, mặc định tắt (xem dưới)
if (isEmptyToolUpdate(eventRecord)) return;                 // bỏ cập nhật rỗng
const toolArgs   = summarizeToolInputForLog(eventRecord.rawInput);
const toolOutput = carry.resolve(event.toolCallId, event.status,
                     summarizeToolOutputForLog({ rawOutput, content, locations, text: event.text }));
await emitAcpxLog(ctx, { type: "acpx.tool_call", name: event.title ?? "acp_tool", ...,
  ...(toolKind   ? { kind: toolKind }     : {}),
  ...(toolArgs   ? { args: toolArgs }     : {}),
  ...(toolOutput ? { output: toolOutput } : {}) });         // chỉ THÊM trường, không bỏ trường cũ
```

Phía giao diện, `parseAcpxStdoutLine` ([ui.ts:56-](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/packages/adapter-utils/src/acpx-engine/ui.ts#L56)) nối `args` và `kind` vào phần input của thẻ tool, và nối `output` vào nội dung của dòng kết quả (`${base}\n${output}`). Bản in ra terminal (`cli.ts`) cũng in `args:` và output (đỏ khi lỗi).

**Công cụ chẩn đoán:** nếu đặt biến môi trường `PAPERCLIP_ACPX_DEBUG_TOOL_EVENTS_DIR` cho server, `captureRawToolEvent` ([execute.ts:2295-](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/packages/adapter-utils/src/acpx-engine/execute.ts#L2295)) ghi sự kiện tool thô (đã che secret, tối đa 20.000 ký tự mỗi dòng) vào `<thư mục>/<runId>.ndjson`. Mặc định tắt; chỉ dùng khi cần xem các dòng "tool call" không tiêu đề chứa gì.

### 2.4. Che secret

Bốn mẫu ([tool-output.ts:15-22](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/packages/adapter-utils/src/acpx-engine/tool-output.ts#L15-L22)): `Bearer …`, JWT (`eyJ….….…`), `sk-…` (từ 16 ký tự), và các khóa dạng `api_key | access_token | auth_token | secret | password` theo sau bởi `:` hoặc `=`.

Tôi thử với 12 mẫu thực tế (hàm `redactToolOutput` thật):

| Mẫu | Kết quả |
|---|---|
| `Authorization: Bearer abcdefghijklmnop1234` | Đã che |
| JWT `eyJhbGciOi….….…` | Đã che |
| `LITELLM_API_KEY=sk-…`, `PAPERCLIP_API_KEY: …`, `x-api-key: …`, `client_secret=…` | Đã che |
| `{"password":"…"}` | Đã che (mất dấu nháy đóng, chỉ là thẩm mỹ) |
| `sk-proj-…` | Đã che |
| `Authorization: Basic dXNlcjpwYXNzd29yZA==` | **Không che** |
| `ghp_…` (token GitHub) | **Không che** |
| `AKIAIOSFODNN7EXAMPLE` (khóa AWS) | **Không che** |
| `postgres://paperclip:paperclip@127.0.0.1:54329/paperclip` | **Không che** (mật khẩu trong chuỗi kết nối) |

### 2.5. Một ví dụ thật: lỗi MCP hiện ra trong transcript

Trong log run từ 22/10, một dòng `tool_call` đã kết thúc có output (đã rút gọn):

```text
{"result":{"content":[{"type":"text","text":"[LỖI MCP] [finish_task] [Step 3/5 FAILED] Webhook n8n báo lỗi HTTP 500: ..."}]}}
```

Trước thay đổi này, dòng đó chỉ là `tool call (completed)`, không ai biết bước `finish_task` đã thất bại ở đâu. Đây là một lợi ích cụ thể của luồng A.

Một điểm cần biết: **tên hiển thị của mọi tool đã kết thúc vẫn là `tool call`**. Trong 175 sự kiện `completed`/`failed` từ 22/10, cả 175 có tên `tool call` và `kind` trống; thông tin cụ thể nằm ở `output` (và tiêu đề ở sự kiện bắt đầu). Giao diện ghép hai sự kiện theo `toolUseId` nên người xem vẫn thấy đủ.

### 2.6. Nhiễu của commit

Diff của `execute.ts` trong commit này là +67/−16, nhưng khi bỏ qua khoảng trắng (`git show -w`) chỉ còn **+51/0**: phần còn lại là formatter đổi `.catch(() => {})` thành `.catch(() => { })` và căn lề lại ở khoảng 9 chỗ không liên quan. Không ảnh hưởng hành vi, nhưng làm diff khó đọc và dễ xung đột khi merge.

---

## 3. Luồng B: cột giờ trong transcript (giao diện)

Commit [`641b26382`](https://github.com/trung2710/ppclip/commit/641b26382) thêm vào `RunTranscriptView` một tùy chọn `showTimestamps` và một nút bật tắt.

| Thành phần | Code |
|---|---|
| Hàm định dạng `HH:MM:SS` giờ **địa phương** (24h), trả `""` nếu ngày không hợp lệ | [RunTranscriptView.tsx:47-52](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/ui/src/components/transcript/RunTranscriptView.tsx#L47-L52) |
| Thành phần `TranscriptClock` (thẻ `<time dateTime=… title=…>`, tooltip có mili giây) | [RunTranscriptView.tsx:60-](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/ui/src/components/transcript/RunTranscriptView.tsx#L60) |
| Chế độ "nice": mỗi khối thành một lưới 2 cột, giờ ở cột đầu | [RunTranscriptView.tsx:1778](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/ui/src/components/transcript/RunTranscriptView.tsx#L1778) |
| Chế độ "raw": giờ đứng trước tên loại dòng (`kind`) | [RunTranscriptView.tsx:1717](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/ui/src/components/transcript/RunTranscriptView.tsx#L1717) |
| Nút **Time** trong thanh công cụ, **bật mặc định** | [AgentDetail.tsx:3463](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/ui/src/pages/AgentDetail.tsx#L3463), [3930-3941](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/ui/src/pages/AgentDetail.tsx#L3930-L3941), truyền vào view ở [3973](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/ui/src/pages/AgentDetail.tsx#L3973) |

Điểm đáng chú ý:
- Tuân thủ quy tắc token thiết kế của dự án (`AGENTS.md`): dùng `text-(length:--text-nano)`, `grid-cols-(--gtc-16)`, không hex hay px thô. `pnpm check:token-gates` không báo vi phạm nào trong hai file này.
- `RunTranscriptView` chỉ được dùng ở **một chỗ** ngoài các trang Lab: `LogViewer` trong `AgentDetail.tsx`. Các trang khác (ví dụ chi tiết issue) dùng thành phần khác, nên không có cột giờ.
- Trạng thái nút là `useState` cục bộ (`true`), **không nhớ** giữa các lần mở trang.
- Test: [RunTranscriptView.test.tsx](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/ui/src/components/transcript/RunTranscriptView.test.tsx) kiểm tra định dạng giờ, mili giây trong tooltip, ngày không hợp lệ.
- Phần thay đổi diff lớn của commit (+164/−47) chủ yếu do bọc lại các khối trong thẻ `<div>` mới nên thụt lề đổi; logic thêm không nhiều.

Vì cột giờ lấy `ts` của từng dòng log (giờ server khi dòng được ghi), nó phản ánh **thời điểm ghi log**, không phải thời điểm sự kiện xảy ra bên trong tool.

---

## 4. Luồng C: log của agent n8n và HTTP

### 4.1. Diễn biến theo thời gian

| Ngày | Commit | Thay đổi |
|---|---|---|
| 17/08 | `b681e6ef5` | Adapter HTTP ([execute.ts](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/server/src/adapters/http/execute.ts)) đọc luồng NDJSON từ `n8n-bridge`, chuyển từng dòng JSON thành văn bản có emoji (`⚡ Bridge nhận request`, `🔗`, `🔍`, `✅ Node: […]`, `🏁`) kèm giờ `toLocaleTimeString()`. Bridge đổi mặc định `INCLUDE_INPUT_SUMMARY=true`, `LOG_DETAIL=verbose` |
| 18/08 | `782e05caa` | Parser giao diện của plugin n8n (`ui-parser.cjs`): đọc **dòng JSON** và dựng thẻ `system`/`result`/`stderr` |
| 27/08 | `5abc0bad7` | Adapter n8n runtime đổi `emit()` từ ghi `JSON.stringify(event)` sang ghi **văn bản định dạng** `formatLogEvent` (`[HH:MM:SS.mmm] [LEVEL] …` và các dòng `├─`, `└─`); thêm `rawError`, `rawData` vào log node; khử trùng execution khi liệt kê |
| 27/08 | `d61b782b5` | Gom lỗi khi gọi webhook (`n8n.webhook.response_failed`); chờ 400 ms cho n8n tạo execution; gọi song song danh sách execution `running` và mặc định; chỉ ghi `execution.candidate` khi id đổi |

Mẫu log thật (run ngày 17/09, agent n8n):

```text
[18:20:12.781] [INFO] n8n runtime adapter received Paperclip run
  ├─ Trace ID: pc-run-5f3264e3-7ce8-481a-8185-b891c1782ada
  └─ Run ID: 5f3264e3-7ce8-481a-8185-b891c1782ada

[18:20:12.785] [INFO] n8n webhook request started
```

Dữ liệu trên đĩa xác nhận diễn biến này:

| Định dạng | Số log | Ngày | Kích thước (trung vị / lớn nhất) |
|---|---|---|---|
| Văn bản emoji của adapter HTTP (`Bridge nhận request`) | 8 | chỉ 17/08 | (không đo) |
| JSON (`n8n.node.finished`) | 26 | 17/08 đến sáng 27/08 | 8 KB / 13 KB |
| Văn bản có cấu trúc (`Node '…' finished`) | 27 | từ chiều 27/08 đến 18/09 | 35 KB / 71 KB |

- Định dạng emoji của adapter HTTP **chỉ xuất hiện trong 8 log ngày 17/08**, tức là chỉ dùng trong giai đoạn thử nghiệm đầu; về sau thay bằng adapter n8n runtime.
- Log văn bản có cấu trúc lớn hơn khoảng **4 lần** so với JSON, vì `rawData` (toàn bộ dữ liệu đầu ra của node) được in nguyên vẹn dạng JSON thụt lề (mục 5, R4).

### 4.2. Phát hiện 1: lệch giờ UTC và giờ địa phương

`formatLogEvent` lấy giờ bằng `ts.substring(11, 23)` của chuỗi ISO, tức **giờ UTC** ([packages/adapters/n8n-runtime/src/server/execute.ts:525-528](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/packages/adapters/n8n-runtime/src/server/execute.ts#L525-L528)). Còn cột Time mới của giao diện hiển thị giờ **địa phương**. Kiểm tra trên một dòng thật:

| Nơi | Giá trị |
|---|---|
| `ts` của chunk | `2026-09-17T18:20:12.781Z` (UTC) |
| Giờ in trong nội dung dòng log | `[18:20:12.781]` |
| Giờ mà cột Time sẽ hiện (UTC+7) | `01:20:12` |

Vậy trên cùng một dòng, người xem thấy `01:20:12` ở cột Time và `[18:20:12.781]` trong nội dung, lệch **7 tiếng**. Cột giờ ra đời sau (20/10) nên khi viết định dạng n8n (27/08) chưa có xung đột; sau khi bật cột giờ thì xung đột xuất hiện. Phần mô tả này dựa trên code và dữ liệu log; tôi chưa nhìn thấy trên giao diện.

### 4.3. Phát hiện 2: parser giao diện cho n8n đã thành mã chết với các dòng này

Cả hai parser giao diện n8n đều giả định mỗi dòng stdout là **một sự kiện JSON**:
- [n8n-runtime-adapter/src/ui-parser.cjs](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/n8n-runtime-adapter/src/ui-parser.cjs) (bản plugin);
- [packages/adapters/n8n-runtime/src/ui/parse-stdout.ts](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/packages/adapters/n8n-runtime/src/ui/parse-stdout.ts) (bản built-in), có chú thích *"Each line is either a JSON event object or a plain text fallback."*

Nhưng từ `5abc0bad7`, `emit()` ghi **văn bản**, không còn JSON ([execute.ts:638](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/packages/adapters/n8n-runtime/src/server/execute.ts#L638); trong cả hai file tôi không tìm thấy chỗ nào còn ghi `JSON.stringify(event)` ra stdout). Mỗi dòng văn bản rơi vào nhánh dự phòng `JSON.parse` lỗi và thành một dòng `stdout` thường. Hệ quả:
- Các thẻ `system` có biểu tượng, phần phân loại lỗi (`stderr`), và dòng `result` cuối (kèm token và cờ `isError`) mà parser dựng cho dạng JSON **không còn được tạo** cho các run mới.
- Định dạng hiển thị thật sự là do chính chuỗi văn bản của adapter quyết định.

Đây là một thiết kế còn dang dở: tồn tại cùng lúc hai đường (văn bản của adapter và parser JSON), chỉ một đường còn chạy. Chưa rõ đây là chủ ý (đơn giản hóa) hay sơ suất.

### 4.4. Phát hiện 3: mã bị nhân đôi

`formatLogEvent` và phần còn lại của adapter n8n tồn tại ở hai nơi: thư mục gốc `n8n-runtime-adapter/` (bản plugin ngoài, [execute.ts:528](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/n8n-runtime-adapter/src/server/execute.ts#L528)) và `packages/adapters/n8n-runtime/` (bản built-in, [execute.ts:525](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/packages/adapters/n8n-runtime/src/server/execute.ts#L525)), với vị trí dòng lệch nhau 3. Sửa một bản mà quên bản kia sẽ làm hai nơi lệch hành vi, như vừa thấy ở mục 4.3 với hai parser.

---

## 5. Rủi ro và điểm cần lưu ý

**R1. Bộ che secret không phủ một số dạng phổ biến. Mức trung bình (an toàn).** `Authorization: Basic`, token `ghp_…`, khóa AWS (`AKIA…`), và chuỗi kết nối có mật khẩu đều đi thẳng vào log nếu xuất hiện trong tham số hay output của tool. Log nằm trên đĩa và hiển thị cho mọi người xem tab Run. Nên bổ sung mẫu, và cân nhắc che theo danh sách tên biến đã biết.

**R2. Log giờ chứa nội dung dữ liệu người dùng. Mức trung bình (riêng tư).** Output tới 4.000 ký tự và tham số tới 2.000 ký tự của mỗi tool được lưu, gồm cả nội dung file agent đọc (mẫu thật có phần đầu của `SKILL.md`) và có thể cả nội dung tin nhắn người dùng khi tool MCP xử lý yêu cầu từ Telegram (tôi chưa tìm mẫu cụ thể). Cần cân nhắc về thời gian lưu và quyền xem log.

**R3. Lệch giờ UTC và giờ địa phương trong log n8n (mục 4.2). Mức thấp.** Dễ gây hiểu nhầm khi đối chiếu. Cách sửa gọn: bỏ giờ khỏi nội dung dòng (vì cột Time đã có), hoặc ghi giờ địa phương.

**R4. `rawData` và `rawError` của n8n không bị cắt. Mức thấp đến trung bình.** `formatLogEvent` in `JSON.stringify(event.rawData, null, 2)` toàn bộ, không có giới hạn như `MAX_TOOL_OUTPUT_LOG_CHARS` của luồng A. Log trung vị tăng từ 8 KB lên 35 KB, lớn nhất đo được 71 KB; một node n8n trả dữ liệu lớn có thể làm log phình nhiều hơn. Dữ liệu này cũng có thể chứa thông tin kinh doanh.

**R5. Parser n8n là mã chết với log văn bản, và mã n8n bị nhân đôi (mục 4.3, 4.4). Mức thấp.**

**R6. Tên tool đã kết thúc vẫn là "tool call".** 175/175 sự kiện kết thúc từ 22/10 có tên chung chung. Hiện giao diện ghép theo `toolUseId` nên vẫn đọc được; nhưng chế độ "raw" và log thô khó theo dõi nếu thiếu sự kiện bắt đầu.

**R7. Chưa kiểm tra bằng mắt trên giao diện.** Phần hiển thị (cột giờ, thẻ tool có output) chỉ được kiểm bằng code và test.

**R8. Công tắc cột giờ không được nhớ và chỉ có ở tab Run của agent.** Các màn hình khác không có cột giờ.

**R9. Lane CLI (`codex exec`) không dùng module này.** `tool-output.ts` chỉ nằm trong engine ACPX; log của lane CLI do parser JSONL riêng của Codex quyết định (không thuộc phạm vi 6 commit này).

---

## 6. Kết luận

1. **Log tool của Codex (luồng A) là cải tiến có số đo:** từ khoảng 90% dòng `tool_call` rỗng và không có tham số hay output, chuyển sang không còn dòng rỗng, mỗi run có 7 đến 10 dòng thực sự mang thông tin. Lỗi của tool MCP (ví dụ `finish_task` bước 3/5 thất bại) giờ nhìn thấy được trong transcript.
2. **Cột giờ (luồng B)** là thay đổi giao diện duy nhất của phần này: nhỏ, đúng quy tắc token thiết kế, có test; chỉ hiển thị giờ địa phương ở tab Run của agent.
3. **Log n8n (luồng C)** đã đổi từ JSON sang văn bản có cấu trúc, đọc được hơn khi nhìn thẳng, nhưng kéo theo ba hệ quả: lệch giờ UTC với cột Time, parser giao diện thành mã chết, và log phình khoảng 4 lần vì in nguyên `rawData`.
4. **Điểm an toàn cần xử lý trước:** bổ sung bộ che secret (R1) và cân nhắc giới hạn dữ liệu lưu trong log (R2, R4).
5. **Nên làm tiếp:** sửa lệch giờ n8n (R3); cắt `rawData` như luồng A (R4); quyết định giữ hay bỏ parser JSON và gộp hai bản adapter n8n (R5); thêm một test kiểm tra mẫu secret mới.

---

## Phụ lục A. Danh sách file đã trích dẫn

| File | Nội dung chính |
|---|---|
| [adapter-utils/src/acpx-engine/tool-output.ts](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/packages/adapter-utils/src/acpx-engine/tool-output.ts) | Tóm tắt, che secret, cắt, lọc rỗng, mang output |
| [adapter-utils/src/acpx-engine/execute.ts](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/packages/adapter-utils/src/acpx-engine/execute.ts) | `emitRuntimeEvent`, `captureRawToolEvent` |
| [adapter-utils/src/acpx-engine/ui.ts](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/packages/adapter-utils/src/acpx-engine/ui.ts) | `parseAcpxStdoutLine` (dựng thẻ tool từ dòng log) |
| [ui/src/components/transcript/RunTranscriptView.tsx](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/ui/src/components/transcript/RunTranscriptView.tsx) | Cột giờ |
| [ui/src/pages/AgentDetail.tsx](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/ui/src/pages/AgentDetail.tsx) | Nút Time, `LogViewer` |
| [packages/adapters/n8n-runtime/src/server/execute.ts](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/packages/adapters/n8n-runtime/src/server/execute.ts) | `formatLogEvent` (bản built-in) |
| [n8n-runtime-adapter/src/server/execute.ts](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/n8n-runtime-adapter/src/server/execute.ts), [ui-parser.cjs](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/n8n-runtime-adapter/src/ui-parser.cjs) | Bản plugin của adapter n8n và parser |
| [server/src/adapters/http/execute.ts](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/server/src/adapters/http/execute.ts), [n8n-bridge/bridge.js](https://github.com/trung2710/ppclip/blob/f6c9d6bfc1225895047151d99f8d4002dacee482/n8n-bridge/bridge.js) | Adapter HTTP và bridge (giai đoạn đầu) |

## Phụ lục B. Cách tự kiểm tra trên máy

```sh
# 1. Đếm dòng tool_call có args/output trong log run của bạn
python - <<'PY'
import os, json
tot = rich = 0
for root, _, files in os.walk(os.path.expanduser("~/.paperclip/instances/default/data/run-logs")):
    for f in files:
        for line in open(os.path.join(root, f), encoding="utf-8", errors="replace"):
            if "acpx.tool_call" not in line: continue
            try: e = json.loads(json.loads(line)["chunk"])
            except Exception: continue
            if e.get("type") == "acpx.tool_call":
                tot += 1; rich += bool(e.get("args") or e.get("output"))
print("tool_call:", tot, "có args/output:", rich)
PY

# 2. Chạy test của phần này và bộ kiểm tra token thiết kế
npx vitest run packages/adapter-utils/src/acpx-engine/tool-output.test.ts ui/src/components/transcript/RunTranscriptView.test.tsx
pnpm check:token-gates     # có 115 vi phạm sẵn có ở các trang Lab; xem có dòng nào thuộc file của nhánh không

# 3. Bật bản ghi sự kiện tool thô để chẩn đoán (khởi động lại server sau khi đặt)
#    PowerShell: $env:PAPERCLIP_ACPX_DEBUG_TOOL_EVENTS_DIR = "C:\tmp\acpx-tool-events"
```

```text
4. Kiểm tra lệch giờ n8n: mở tab Run của một run agent n8n, so cột Time (giờ địa phương)
   với giờ trong ngoặc vuông [HH:MM:SS.mmm] ở đầu mỗi khối log (giờ UTC).
```
