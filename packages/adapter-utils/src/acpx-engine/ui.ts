import type { TranscriptEntry } from "@paperclipai/adapter-utils";

function parseJson(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function pickToolUseId(parsed: Record<string, unknown>): string {
  return (
    asString(parsed.toolCallId) ||
    asString(parsed.toolUseId) ||
    asString(parsed.id)
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function statusText(parsed: Record<string, unknown>): string {
  const text = asString(parsed.text).trim();
  const tag = asString(parsed.tag).trim();
  const used = asNumber(parsed.used, -1);
  const size = asNumber(parsed.size, -1);
  const parts: string[] = [];
  if (text) parts.push(text);
  if (tag && !text) parts.push(tag);
  if (used >= 0 && size > 0) parts.push(`(${used}/${size} ctx)`);
  return parts.join(" ") || tag || "status";
}

export function parseAcpxStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const parsed = parseJson(line);
  if (!parsed) return [{ kind: "stdout", ts, text: line }];

  const type = asString(parsed.type);
  if (type === "acpx.session") {
    const agent = asString(parsed.agent, "acpx");
    const mode = asString(parsed.mode);
    const permissionMode = asString(parsed.permissionMode);
    const tail = [mode, permissionMode].filter(Boolean).join(" / ");
    return [{
      kind: "init",
      ts,
      model: tail ? `${agent} (${tail})` : agent,
      sessionId:
        asString(parsed.acpSessionId) ||
        asString(parsed.sessionId) ||
        asString(parsed.runtimeSessionName),
    }];
  }

  if (type === "acpx.text_delta") {
    const text = asString(parsed.text);
    if (!text) return [];
    const channel = asString(parsed.channel) || asString(parsed.stream);
    return [{
      kind: channel === "thought" || channel === "thinking" ? "thinking" : "assistant",
      ts,
      text,
      delta: true,
    }];
  }

  if (type === "acpx.tool_call") {
    const status = asString(parsed.status);
    const text = asString(parsed.text);
    const name = asString(parsed.name, "acp_tool");
    const toolUseId = pickToolUseId(parsed);
    const parsedInput = parsed.input;
    // `args` (đầu vào thật của tool) và `kind` được nối THÊM vào input đang hiển thị.
    const args = asString(parsed.args).trim();
    const kind = asString(parsed.kind).trim();
    const input = (() => {
      if (parsedInput === undefined) {
        return text || status || args || kind
          ? {
              ...(text ? { text } : {}),
              ...(status ? { status } : {}),
              ...(kind ? { kind } : {}),
              ...(args ? { args } : {}),
            }
          : {};
      }
      const inputRecord = asRecord(parsedInput);
      if (!inputRecord) return parsedInput;
      return {
        ...inputRecord,
        ...(status && inputRecord.status === undefined ? { status } : {}),
        ...(text && inputRecord.text === undefined ? { text } : {}),
        ...(kind && inputRecord.kind === undefined ? { kind } : {}),
        ...(args && inputRecord.args === undefined ? { args } : {}),
      };
    })();
    const entries: TranscriptEntry[] = [
      {
        kind: "tool_call",
        ts,
        name,
        toolUseId: toolUseId || undefined,
        input,
      },
    ];
    if (status === "completed" || status === "failed" || status === "cancelled") {
      // `output` là nội dung kết quả/lỗi thật của tool (nếu có); nối THÊM sau nội dung cũ.
      const output = asString(parsed.output).trim();
      const base = text || status;
      entries.push({
        kind: "tool_result",
        ts,
        toolUseId: toolUseId || name,
        toolName: name,
        content: output ? `${base}\n${output}` : base,
        isError: status !== "completed",
      });
    }
    return entries;
  }

  if (type === "acpx.tool_result") {
    return [{
      kind: "tool_result",
      ts,
      toolUseId: pickToolUseId(parsed) || asString(parsed.name, "acp_tool"),
      toolName: asString(parsed.name) || undefined,
      content: stringify(parsed.content ?? parsed.output ?? parsed.error),
      isError: parsed.isError === true || parsed.error !== undefined,
    }];
  }

  if (type === "acpx.status") {
    return [{ kind: "system", ts, text: statusText(parsed) }];
  }

  if (type === "acpx.result") {
    return [{
      kind: "result",
      ts,
      text: asString(parsed.summary, asString(parsed.stopReason, asString(parsed.text))),
      inputTokens: asNumber(parsed.inputTokens),
      outputTokens: asNumber(parsed.outputTokens),
      cachedTokens: asNumber(parsed.cachedTokens),
      costUsd: asNumber(parsed.costUsd),
      subtype: asString(parsed.subtype, asString(parsed.stopReason, "acpx.result")),
      isError: parsed.isError === true,
      errors: Array.isArray(parsed.errors)
        ? parsed.errors.map((error) => stringify(error)).filter(Boolean)
        : [],
    }];
  }

  if (type === "acpx.error") {
    return [{ kind: "stderr", ts, text: asString(parsed.message, line) }];
  }

  if (type.startsWith("acpx.")) {
    return [{ kind: "system", ts, text: asString(parsed.message, type) }];
  }

  return [{ kind: "stdout", ts, text: line }];
}
