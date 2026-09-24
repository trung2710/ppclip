# Kế hoạch Nâng cấp n8n-runtime-adapter (Bản Cập Nhật Tận Dụng Tối Đa Code Cũ)

## Tổng quan

Mục tiêu: Nâng cấp `n8n-runtime-adapter` để khi nhận được tín hiệu Heartbeat Wake (nhất là `issue_commented`), nó có thể tổng hợp và gửi toàn bộ ngữ cảnh của Task sang n8n Webhook. **Đặc biệt, tận dụng tuyệt đối các hàm đã được xây dựng sẵn cho các local adapter (như Claude, Gemini) để đảm bảo payload gửi sang n8n có chất lượng và định dạng giống hệt như khi gửi cho các LLM.**

---

## 1. Phân tích khoảng cách (GAP ANALYSIS)

### Hiện tại
```
Paperclip Server
    ↓ heartbeat.wakeup()
n8n-runtime-adapter (execute.ts)
    ↓ triggerN8nWebhook()  
n8n Webhook nhận được JSON thô:
  {
    "agentId": "...",
    "runId": "...",
    "issueId": "...",
    "context": { "wakeCommentId": "cm-123", ... }  <-- chỉ có ID, không có text
  }
```

### Mục tiêu
```
Paperclip Server
    ↓ heartbeat.wakeup() kèm context đầy đủ
n8n-runtime-adapter (execute.ts)
    ↓ import các hàm từ @paperclipai/adapter-utils
    ↓ triggerN8nWebhook() - đọc + đóng gói context
n8n Webhook nhận được JSON có cấu trúc + Full Prompt:
  {
    "agentId": "...",
    "issueId": "...",
    "paperclip": {
      "wakeReason": "issue_commented",
      "issueTitle": "...",
      "latestComments": [...],
      "continuationSummary": "...",
      "fullPrompt": "## Paperclip Wake Payload\n\nTreat this wake payload..." // Giống hệt prompt local adapter
    }
  }
```

---

## 2. Các hàm tái sử dụng từ `@paperclipai/adapter-utils/server-utils`

Thay vì tự parse và format lại, chúng ta sẽ import và sử dụng trực tiếp các hàm cốt lõi sau:

| Hàm | Chức năng | Lý do sử dụng |
|:---|:---|:---|
| `normalizePaperclipWakePayload()` | Parse an toàn và chuẩn hóa `context.paperclipWake` thành type `PaperclipWakePayload`. | Xử lý hoàn hảo mọi edge case, type-safe, không sợ sót trường dữ liệu. |
| `renderPaperclipWakePrompt()` | Render payload (comments, reason, etc) thành string Markdown. | Định dạng chuẩn của Paperclip cho LLM, đã bao gồm các chỉ dẫn quan trọng. |
| `selectPaperclipTaskMarkdown()` | Lấy description/title của task (chọn thông minh giữa bản full và compact). | Tiết kiệm token khi cần thiết, tự động lấy đúng trường. |
| `joinPromptSections()` | Ghép nối các phần tử prompt với nhau một cách an toàn. | Loại bỏ các khoảng trắng thừa, cách đều các section. |

---

## 3. Kế hoạch thực thi chi tiết

### Bước 1: Khai báo dependency

Thêm `@paperclipai/adapter-utils` vào `n8n-runtime-adapter/package.json` để có thể import các hàm trên.

**File:** `n8n-runtime-adapter/package.json`
```json
{
  "dependencies": {
    "@paperclipai/adapter-utils": "workspace:*"
  }
}
```

### Bước 2: Cập nhật config cho n8n

Thêm các cờ để kiểm soát việc gửi context.

**File:** `n8n-runtime-adapter/src/server/execute.ts`
```typescript
interface N8nRuntimeConfig {
  // ... các field hiện tại ...
  includeFullContext: boolean; // bật/tắt gửi object paperclip (default: true)
  includeFullPrompt: boolean;  // bật/tắt gửi trường fullPrompt (default: false vì rất dài)
}

function readConfig(rawConfig: Record<string, unknown>): N8nRuntimeConfig {
  return {
    // ... các field hiện tại ...
    includeFullContext: asBoolean(rawConfig.includeFullContext, true),
    includeFullPrompt: asBoolean(rawConfig.includeFullPrompt, false),
  };
}
```

### Bước 3: Tạo hàm `buildN8nContextPayload`

Import các hàm từ `adapter-utils` và kết hợp chúng.

**File:** `n8n-runtime-adapter/src/server/execute.ts`
```typescript
import {
  normalizePaperclipWakePayload,
  renderPaperclipWakePrompt,
  selectPaperclipTaskMarkdown,
  joinPromptSections,
} from "@paperclipai/adapter-utils/server-utils.js"; // Nhớ thêm .js

function buildN8nContextPayload(ctx: AdapterExecutionContext, opts: { includeFullPrompt: boolean }) {
  const wake = normalizePaperclipWakePayload(ctx.context.paperclipWake);
  
  let fullPrompt: string | null = null;
  if (opts.includeFullPrompt) {
    const taskMarkdown = selectPaperclipTaskMarkdown(ctx.context);
    const wakePromptText = wake ? renderPaperclipWakePrompt(wake) : null;
    fullPrompt = joinPromptSections([wakePromptText, taskMarkdown]);
  }

  return {
    wakeReason: wake?.reason ?? null,
    issueTitle: wake?.issue?.title ?? null,
    issueStatus: wake?.issue?.status ?? null,
    issueDescription: wake?.issue?.description ?? null,
    issueIdentifier: wake?.issue?.identifier ?? null,
    latestComments: wake?.comments.map(c => ({
      id: c.id, 
      body: c.body, 
      authorType: c.authorType, 
      createdAt: c.createdAt
    })) ?? [],
    continuationSummary: wake?.continuationSummary?.body ?? null,
    recovery: wake?.recovery ? {
      cause: wake.recovery.cause,
      failureSummary: wake.recovery.failureSummary,
      attempt: wake.recovery.attemptCount,
      maxAttempts: wake.recovery.maxAttempts,
    } : null,
    fallbackFetchNeeded: wake?.fallbackFetchNeeded ?? false,
    fullPrompt, // Chuỗi text hoàn chỉnh giống hệt Claude/Gemini nhận
  };
}
```

### Bước 4: Cập nhật `triggerN8nWebhook`

Tích hợp payload mới vào body gửi đi n8n.

**File:** `n8n-runtime-adapter/src/server/execute.ts`
```typescript
async function triggerN8nWebhook(params: {
  ctx: AdapterExecutionContext;
  config: N8nRuntimeConfig;
  traceId: string;
  issueId: string | undefined;
}): Promise<void> {
  // ... phần đầu giữ nguyên ...

  const paperclipContext = config.includeFullContext
    ? buildN8nContextPayload(ctx, { includeFullPrompt: config.includeFullPrompt })
    : undefined;

  const body = {
    ...config.payloadTemplate,
    agentId: ctx.agent.id,
    runId: ctx.runId,
    paperclipRunId: ctx.runId,
    issueId,
    taskId: issueId,
    traceId,
    context: ctx.context,
    ...(paperclipContext ? { paperclip: paperclipContext } : {}), // 👈 THÊM MỚI
    bridge: {
      kind: "paperclip-n8n-runtime-adapter",
      startedAt: new Date().toISOString(),
    },
  };

  // ... phần call fetch() giữ nguyên ...
}
```

---

## 4. Tóm tắt các tác vụ cần làm

| # | Nhiệm vụ | File liên quan |
|---|---|---|
| 1 | Sửa `package.json` thêm `@paperclipai/adapter-utils` | `n8n-runtime-adapter/package.json` |
| 2 | Cập nhật `N8nRuntimeConfig` và `readConfig()` | `n8n-runtime-adapter/src/server/execute.ts` |
| 3 | Import utils & viết `buildN8nContextPayload()` | `n8n-runtime-adapter/src/server/execute.ts` |
| 4 | Cập nhật `triggerN8nWebhook()` để đính kèm data mới | `n8n-runtime-adapter/src/server/execute.ts` |
| 5 | Chạy `pnpm install` và `pnpm build` để kiểm tra build | Thư mục `n8n-runtime-adapter/` |

> Bằng cách này, chúng ta không cần phát minh lại bánh xe. `n8n-runtime-adapter` sẽ sử dụng chính xác quy trình xây dựng prompt đang dùng cho Claude và Gemini, giúp các agent trên n8n có thể nhận được bối cảnh chất lượng cao nhất mà không sợ bị sai sót khi tự parse dữ liệu.
