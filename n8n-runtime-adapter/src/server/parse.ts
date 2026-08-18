export type JsonRecord = Record<string, unknown>;

export function asString(value: unknown, fallback = ""): string {
  if (value == null) return fallback;
  const text = String(value);
  return text.length > 0 ? text : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  if (value == null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function parseObject(value: unknown): JsonRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as JsonRecord
    : {};
}

export function removeUndefined<T extends JsonRecord>(value: T): JsonRecord {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

export function summarizeNodeRun(params: {
  executionId: string;
  traceId: string;
  nodeName: string;
  nodeRun: JsonRecord;
  index: number;
  logDetail: string;
  includeInputSummary: boolean;
}): JsonRecord {
  const { executionId, traceId, nodeName, nodeRun, index, logDetail, includeInputSummary } = params;
  const tokenUsage = findFirstKey(nodeRun, "tokenUsage");
  const concise = summarizeNodeOutput(nodeName, nodeRun, logDetail);
  const event = {
    executionId,
    traceId,
    nodeName,
    runIndex: index,
    executionIndex: nodeRun.executionIndex,
    status: asString(nodeRun.executionStatus, nodeRun.error ? "error" : "success"),
    startTime: nodeRun.startTime,
    durationMs: nodeRun.executionTime,
    previousNode: Array.isArray((nodeRun.source as JsonRecord[] | undefined))
      ? parseObject((nodeRun.source as JsonRecord[])[0]).previousNode
      : undefined,
    tokenUsage: tokenUsage && typeof tokenUsage === "object" ? tokenUsage : undefined,
    ...concise,
    message: formatNodeMessage(nodeName, nodeRun, concise),
  };

  if (logDetail === "verbose") {
    Object.assign(event, {
      outputSummary: summarizeValue(nodeRun.data ?? nodeRun.error ?? null, 900),
    });
  }

  if (includeInputSummary) {
    Object.assign(event, {
      inputSummary: summarizeValue(nodeRun.inputOverride ?? null, 700),
    });
  }

  return removeUndefined(event);
}

export function summarizeNodeOutput(
  nodeName: string,
  nodeRun: JsonRecord,
  logDetail = "compact",
): JsonRecord {
  const isVerbose = logDetail === "verbose";

  if (nodeRun.error) {
    const error = parseObject(nodeRun.error);
    return {
      level: "error",
      outputKind: "error",
      outputPreview: isVerbose
        ? asString(error.message ?? error.description, "Node error")
        : asString(error.message ?? error.description, "Node error").slice(0, 240),
    };
  }

  const rows = collectJsonItems(nodeRun.data);
  const lowerName = nodeName.toLowerCase();

  if (lowerName.includes("groq") || lowerName.includes("chat model") || lowerName.includes("llm")) {
    const text = findFirstKey(nodeRun.data, "text");
    const finishReason = findFirstKey(nodeRun.data, "finish_reason");
    return {
      outputKind: "llm",
      outputPreview: text
        ? isVerbose
          ? text
          : truncateText(text, 260)
        : finishReason
          ? `finish_reason=${String(finishReason)}`
          : "LLM call completed",
    };
  }

  if (lowerName.includes("google sheets") || lowerName.includes("sheet")) {
    return {
      outputKind: "table",
      itemCount: rows.length || undefined,
      outputPreview: rows.length ? `${rows.length} rows returned` : "Sheet node completed",
    };
  }

  if (lowerName.includes("comment")) {
    const body = findFirstKey(nodeRun.data, "body");
    return {
      outputKind: "paperclip.comment",
      outputPreview: body
        ? isVerbose
          ? body
          : truncateText(body, 220)
        : "Comment created",
    };
  }

  if (lowerName.includes("status") || lowerName.includes("cập nhật")) {
    const status = findFirstKey(nodeRun.data, "status");
    return {
      outputKind: "paperclip.issue",
      outputPreview: status ? `Issue status = ${String(status)}` : "Issue updated",
    };
  }

  if (lowerName.includes("respond to webhook")) {
    return {
      outputKind: "webhook.response",
      outputPreview: "Webhook response sent",
    };
  }

  const output = findFirstKey(nodeRun.data, "output");
  if (typeof output === "string" && output.trim()) {
    return {
      outputKind: "text",
      outputPreview: isVerbose ? output : truncateText(output, 260),
    };
  }

  if (rows.length) {
    return {
      outputKind: "json",
      itemCount: rows.length,
      outputPreview: `${rows.length} items returned`,
    };
  }

  return {
    outputKind: "json",
    outputPreview: "Node completed",
  };
}

export function makeNodeRunKey(executionId: string, nodeName: string, nodeRun: JsonRecord, index: number): string {
  return [
    executionId,
    nodeName,
    nodeRun.executionIndex ?? index,
    nodeRun.startTime ?? "no-start",
    nodeRun.executionStatus ?? "no-status",
  ].join(":");
}

export function isTerminalExecution(execution: JsonRecord): boolean {
  const status = asString(execution.status).toLowerCase();
  return Boolean(execution.finished) || ["success", "error", "canceled", "cancelled", "failed"].includes(status);
}

export function deepContains(value: unknown, needle: string, depth = 0): boolean {
  if (!needle || depth > 12) return false;
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => deepContains(item, needle, depth + 1));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => deepContains(item, needle, depth + 1));
  }
  return false;
}

export function findFirstKey(value: unknown, wantedKey: string, depth = 0): unknown {
  if (!value || depth > 10) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstKey(item, wantedKey, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value === "object") {
    const record = value as JsonRecord;
    if (Object.prototype.hasOwnProperty.call(record, wantedKey)) return record[wantedKey];
    for (const child of Object.values(record)) {
      const found = findFirstKey(child, wantedKey, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

export function summarizeValue(value: unknown, maxLength: number): string | undefined {
  if (value == null) return undefined;
  const redacted = redact(value);
  const text = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function formatNodeMessage(nodeName: string, nodeRun: JsonRecord, concise: JsonRecord): string {
  const status = asString(nodeRun.executionStatus, nodeRun.error ? "error" : "finished");
  const duration = nodeRun.executionTime ?? "?";
  const preview = concise.outputPreview ? ` - ${String(concise.outputPreview)}` : "";
  return `[${nodeName}] ${status} (${duration}ms)${preview}`;
}

function collectJsonItems(value: unknown, result: JsonRecord[] = [], depth = 0): JsonRecord[] {
  if (!value || depth > 10) return result;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonItems(item, result, depth + 1);
    return result;
  }
  if (typeof value === "object") {
    const record = value as JsonRecord;
    if (record.json && typeof record.json === "object" && !Array.isArray(record.json)) {
      result.push(record.json as JsonRecord);
    }
    for (const child of Object.values(record)) collectJsonItems(child, result, depth + 1);
  }
  return result;
}

function truncateText(text: unknown, maxLength: number): string {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[MaxDepth]";
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => redact(item, depth + 1));
  if (!value || typeof value !== "object") return value;

  const result: JsonRecord = {};
  for (const [key, child] of Object.entries(value)) {
    result[key] = isSensitiveKey(key) ? "[REDACTED]" : redact(child, depth + 1);
  }
  return result;
}

function isSensitiveKey(key: string): boolean {
  return /authorization|cookie|api[_-]?key|token|password|secret|credential/i.test(key);
}
