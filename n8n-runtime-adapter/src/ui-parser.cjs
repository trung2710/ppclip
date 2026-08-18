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

  if (event.type === "n8n.node.finished") {
    const status = event.status || "finished";
    const duration = event.durationMs == null ? "?" : event.durationMs;
    const preview = event.outputPreview || event.outputSummary || "";
    const parts = [
      "n8n node",
      event.nodeName ? String(event.nodeName) : "unknown",
      String(status),
      duration + "ms",
    ];
    const text = preview ? parts.join(" | ") + "\n" + String(preview) : parts.join(" | ");
    return [{ kind: event.level === "error" ? "stderr" : "system", ts: event.ts || ts, text }];
  }

  if (event.type === "n8n.execution.finished") {
    return [{
      kind: "result",
      ts: event.ts || ts,
      text: "n8n workflow finished: " + (event.status || "unknown"),
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      costUsd: 0,
      subtype: "n8n",
      isError: ["error", "failed", "canceled", "cancelled"].includes(String(event.status || "").toLowerCase()),
      errors: [],
    }];
  }

  const message = event.message || event.type || JSON.stringify(event);
  return [{ kind: event.level === "error" ? "stderr" : "system", ts: event.ts || ts, text: String(message) }];
}

module.exports = { parseStdoutLine };
