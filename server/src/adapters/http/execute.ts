import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, asNumber, parseObject } from "../utils.js";

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const { config, runId, agent, context } = ctx;
  const url = asString(config.url, "");
  if (!url) throw new Error("HTTP adapter missing url");

  const method = asString(config.method, "POST");
  const timeoutMs = asNumber(config.timeoutMs, 0);
  const headers = parseObject(config.headers) as Record<string, string>;
  const payloadTemplate = parseObject(config.payloadTemplate);
  const body = { ...payloadTemplate, agentId: agent.id, runId, context };

  const controller = new AbortController();
  const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;

  try {
    const res = await fetch(url, {
      method,
      headers: {
        "content-type": "application/json",
        ...headers,
      },
      body: JSON.stringify(body),
      ...(timer ? { signal: controller.signal } : {}),
    });

    if (!res.ok) {
      const errorText = await res.text().catch(() => "");
      if (ctx.onLog && errorText) {
        await ctx.onLog("stderr", errorText);
      }
      throw new Error(`HTTP invoke failed with status ${res.status}: ${errorText || res.statusText}`);
    }

    // Đọc luồng stream trả về từ n8n (Chunked Transfer hoặc SSE) để stream ra STDOUT của Paperclip
    let responseText = "";
    if (res.body && ctx.onLog) {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let done = false;
      let lineBuffer = "";

      while (!done) {
        const { value, done: readerDone } = await reader.read();
        done = readerDone;
        if (value) {
          const chunk = decoder.decode(value, { stream: !done });
          responseText += chunk;
          lineBuffer += chunk;

          const lines = lineBuffer.split("\n");
          lineBuffer = lines.pop() ?? "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const parsed = JSON.parse(trimmed);
              const formattedLine = formatNDJSONLog(parsed);
              await ctx.onLog("stdout", formattedLine);
            } catch {
              await ctx.onLog("stdout", line + "\n");
            }
          }
        }
      }

      if (lineBuffer.trim()) {
        const trimmed = lineBuffer.trim();
        try {
          const parsed = JSON.parse(trimmed);
          const formattedLine = formatNDJSONLog(parsed);
          await ctx.onLog("stdout", formattedLine);
        } catch {
          await ctx.onLog("stdout", lineBuffer + "\n");
        }
      }
    } else {
      responseText = await res.text();
      if (ctx.onLog && responseText) {
        await ctx.onLog("stdout", responseText);
      }
    }

    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      summary: `HTTP ${method} ${url}`,
      resultJson: {
        output: responseText,
      },
    };
  } catch (err) {
    if (timer && err instanceof Error && err.name === "AbortError") {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        errorMessage: `HTTP ${method} ${url} timed out after ${timeoutMs}ms`,
        errorCode: "timeout",
      };
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function formatNDJSONLog(parsed: any): string {
  const ts = parsed.ts ? new Date(parsed.ts).toLocaleTimeString() : "";
  const timeStr = ts ? `[${ts}] ` : "";

  if (parsed.type === "bridge.started") {
    return `${timeStr}⚡ Bridge nhận request (Trace ID: ${parsed.traceId || "N/A"})\n`;
  }
  if (parsed.type === "n8n.triggered") {
    return `${timeStr}🔗 Đã gọi webhook n8n\n`;
  }
  if (parsed.type === "n8n.execution.found") {
    return `${timeStr}🔍 Đã tìm thấy execution n8n: #${parsed.executionId}\n`;
  }
  if (parsed.type === "n8n.node.finished") {
    let result = `______________________________________________________________________\n`;
    const statusEmoji = parsed.status === "success" ? "✅" : "❌";
    result += `${timeStr}${statusEmoji} Node: [${parsed.nodeName}] (${parsed.status} - ${parsed.durationMs}ms)\n`;
    if (parsed.tokenUsage) {
      const tokens = parsed.tokenUsage;
      result += `  • Token: Prompt: ${tokens.promptTokens || 0} | Completion: ${tokens.completionTokens || 0} | Total: ${tokens.totalTokens || 0}\n`;
    }
    if (parsed.inputSummary) {
      result += `  • Input: ${parsed.inputSummary}\n`;
    }
    if (parsed.outputSummary) {
      result += `  • Output: ${parsed.outputSummary}\n`;
    } else if (parsed.outputPreview) {
      result += `  • Output: ${parsed.outputPreview}\n`;
    }
    result += `______________________________________________________________________\n`;
    return result;
  }
  if (parsed.type === "n8n.execution.finished") {
    return `\n${timeStr}🏁 Workflow n8n đã kết thúc (${parsed.status.toUpperCase()})\n`;
  }

  // Fallback for other events
  const msg = parsed.message || parsed.error || JSON.stringify(parsed);
  return `${timeStr}${msg}\n`;
}
