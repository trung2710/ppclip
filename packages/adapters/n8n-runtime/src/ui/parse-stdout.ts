import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asStr(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Parse a single stdout line emitted by the n8n-runtime adapter.
 * Each line is either a JSON event object or a plain text fallback.
 */
export function parseN8nRuntimeStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  const event = asRecord(safeJsonParse(trimmed));
  if (!event) {
    return [{ kind: "stdout", ts, text: line }];
  }

  const eventType = asStr(event.type);

  if (eventType === "bridge.started") {
    return [{ kind: "system", ts: asStr(event.ts) || ts, text: `⚡ n8n runtime started (Trace: ${event.traceId ?? "N/A"})` }];
  }

  if (eventType === "n8n.triggered") {
    return [{ kind: "system", ts: asStr(event.ts) || ts, text: "n8n webhook triggered" }];
  }

  if (eventType === "n8n.execution.found") {
    return [{ kind: "system", ts: asStr(event.ts) || ts, text: `🔍 Found execution: #${event.executionId}` }];
  }

  if (eventType === "n8n.execution.candidate") {
    return [];
  }

  if (eventType === "n8n.node.finished") {
    const status = asStr(event.status) || "finished";
    const duration = event.durationMs != null ? `${event.durationMs}ms` : "?";
    const preview = asStr(event.outputPreview || event.outputSummary);
    let text = `[${event.nodeName ?? "Node"}] ${status} (${duration})`;
    if (preview) text += `\n  └─ ${preview}`;
    return [{ kind: event.level === "error" ? "stderr" : "system", ts: asStr(event.ts) || ts, text }];
  }

  if (eventType === "n8n.execution.finished") {
    const status = asStr(event.status) || "unknown";
    const isError = ["error", "failed", "canceled", "cancelled"].includes(status.toLowerCase());
    return [{
      kind: "result",
      ts: asStr(event.ts) || ts,
      text: `🏁 n8n workflow finished (${status.toUpperCase()})`,
      inputTokens: Number(event.totalPromptTokens) || 0,
      outputTokens: Number(event.totalCompletionTokens) || 0,
      cachedTokens: 0,
      costUsd: 0,
      subtype: "n8n",
      isError,
      errors: [],
    }];
  }

  if (eventType === "n8n.execution.timeout") {
    return [{ kind: "stderr", ts: asStr(event.ts) || ts, text: `⏱ n8n execution timed out` }];
  }

  const message = asStr(event.message) || eventType || JSON.stringify(event);
  return [{ kind: event.level === "error" ? "stderr" : "system", ts: asStr(event.ts) || ts, text: message }];
}
