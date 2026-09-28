function parseStdoutLine(line, ts) {
  const trimmed = String(line || "").trim();
  if (!trimmed) return [];

  let event;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return [{ kind: "stdout", ts, text: line }];
  }

  if (!event || typeof event !== "object") {
    return [{ kind: "stdout", ts, text: line }];
  }

  if (event.type === "bridge.started") {
    const text = `⚡ Bridge nhận request (Trace ID: ${event.traceId || "N/A"})`;
    return [{ kind: "system", ts: event.ts || ts, text }];
  }
  if (event.type === "n8n.triggered") {
    const text = `Đã gọi webhook n8n`;
    return [{ kind: "system", ts: event.ts || ts, text }];
  }
  if (event.type === "n8n.execution.found") {
    const text = `🔍 Đã tìm thấy execution n8n: #${event.executionId}`;
    return [{ kind: "system", ts: event.ts || ts, text }];
  }
  if (event.type === "n8n.execution.candidate") {
    const text = `Đang kiểm tra execution candidate`;
    return [{ kind: "system", ts: event.ts || ts, text }];
  }

  if (event.type === "n8n.node.finished") {
    const status = event.status || "finished";
    const duration = event.durationMs == null ? "?" : event.durationMs;
    const input = event.inputSummary || "";
    const output = event.outputSummary || event.outputPreview || "";

    let text = `______________________________________________________________________\n`;
    text += `Node: [${event.nodeName}] (${status} - ${duration}ms)\n`;
    if (event.tokenUsage) {
      const tokens = event.tokenUsage;
      text += `• Token: Prompt: ${tokens.promptTokens || 0} | Completion: ${tokens.completionTokens || 0} | Total: ${tokens.totalTokens || 0}\n`;
    }
    if (input) {
      text += `• Input: ${input}\n`;
    }
    if (output) {
      text += `• Output: ${output}\n`;
    }
    text += `______________________________________________________________________`;

    return [{ kind: event.level === "error" ? "stderr" : "system", ts: event.ts || ts, text }];
  }

  if (event.type === "n8n.execution.finished") {
    const isError = ["error", "failed", "canceled", "cancelled"].includes(String(event.status || "").toLowerCase());
    return [{
      kind: "result",
      ts: event.ts || ts,
      text: `🏁 Workflow n8n đã kết thúc (${(event.status || "unknown").toUpperCase()})`,
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      subtype: "n8n",
      isError: isError,
      errors: [],
    }];
  }

  const message = event.message || event.type || JSON.stringify(event);
  return [{ kind: event.level === "error" ? "stderr" : "system", ts: event.ts || ts, text: String(message) }];
}

module.exports = { parseStdoutLine };
