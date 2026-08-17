const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

loadEnv(path.join(__dirname, ".env"));

const config = {
  port: numberEnv("PORT", 3005),
  n8nBaseUrl: requiredEnv("N8N_BASE_URL").replace(/\/+$/, ""),
  n8nApiKey: requiredEnv("N8N_API_KEY"),
  n8nWebhookUrl: requiredEnv("N8N_WEBHOOK_URL"),
  n8nWorkflowId: requiredEnv("N8N_WORKFLOW_ID"),
  pollIntervalMs: numberEnv("POLL_INTERVAL_MS", 1000),
  findExecutionTimeoutMs: numberEnv("FIND_EXECUTION_TIMEOUT_MS", 30_000),
  executionTimeoutMs: numberEnv("EXECUTION_TIMEOUT_MS", 300_000),
  matchTraceId: boolEnv("MATCH_TRACE_ID", true),
  includeInputSummary: boolEnv("INCLUDE_INPUT_SUMMARY", true),
  logDetail: process.env.LOG_DETAIL || "verbose",
};

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && reqUrl.pathname === "/health") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method !== "POST" || reqUrl.pathname !== "/run") {
    sendJson(res, 404, { error: "Not found" });
    return;
  }

  await handleRun(req, res, reqUrl).catch((error) => {
    if (!res.headersSent) {
      sendJson(res, 500, { error: error.message });
      return;
    }
    writeEvent(res, "bridge.error", {
      level: "error",
      message: error.message,
    });
    res.end();
  });
});

server.listen(config.port, () => {
  console.log(`[n8n-bridge] listening on http://localhost:${config.port}`);
});

async function handleRun(req, res, reqUrl) {
  setupJsonlStream(res);

  const startedAtMs = Date.now();
  const body = await readJsonBody(req);
  const query = Object.fromEntries(reqUrl.searchParams.entries());
  const metadata = extractPaperclipMetadata(body, query);
  const traceId = metadata.traceId || createTraceId(metadata.paperclipRunId, metadata.issueId);

  writeEvent(res, "bridge.started", {
    traceId,
    paperclipRunId: metadata.paperclipRunId,
    issueId: metadata.issueId,
    message: "Bridge nhận request",
  });

  await triggerN8nWebhook({ body, query, traceId, metadata });

  writeEvent(res, "n8n.triggered", {
    traceId,
    message: "Đã gọi webhook n8n",
  });

  const executionId = await findExecutionId({
    traceId,
    startedAtMs,
    res,
  });

  writeEvent(res, "n8n.execution.found", {
    traceId,
    executionId,
    message: "Đã tìm thấy execution n8n",
  });

  await pollExecution({
    executionId,
    traceId,
    res,
  });
}

async function triggerN8nWebhook({ body, query, traceId, metadata }) {
  const url = new URL(config.n8nWebhookUrl);

  for (const [key, value] of Object.entries(query)) {
    if (value != null && value !== "") url.searchParams.set(key, String(value));
  }

  const content = body.Content ?? body.content ?? body.query ?? query.Content ?? query.content;
  if (content != null && content !== "") {
    url.searchParams.set("Content", String(content));
  }

  url.searchParams.set("traceId", traceId);
  if (metadata.paperclipRunId) url.searchParams.set("paperclipRunId", metadata.paperclipRunId);
  if (metadata.issueId) url.searchParams.set("issueId", metadata.issueId);
  if (metadata.agentId) url.searchParams.set("agentId", metadata.agentId);

  const payload = {
    ...body,
    traceId,
    paperclipRunId: metadata.paperclipRunId,
    issueId: metadata.issueId,
    agentId: metadata.agentId,
    bridge: {
      startedAt: new Date().toISOString(),
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json,text/plain,*/*",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`n8n webhook failed: ${response.status} ${response.statusText} ${text.slice(0, 500)}`);
  }
}

async function findExecutionId({ traceId, startedAtMs, res }) {
  const deadline = Date.now() + config.findExecutionTimeoutMs;
  const seenCandidates = new Set();
  let fallbackExecutionId = null;

  while (Date.now() < deadline) {
    const executions = await listExecutions();
    const recent = executions
      .filter((execution) => {
        const startedAt = Date.parse(execution.startedAt ?? execution.createdAt ?? "");
        return Number.isFinite(startedAt) && startedAt >= startedAtMs - 10_000;
      })
      .sort((a, b) => Date.parse(b.startedAt ?? b.createdAt ?? "") - Date.parse(a.startedAt ?? a.createdAt ?? ""));

    if (recent[0]?.id) {
      fallbackExecutionId = String(recent[0].id);
    }

    for (const execution of recent) {
      const id = String(execution.id);
      if (seenCandidates.has(id)) continue;
      seenCandidates.add(id);

      writeEvent(res, "n8n.execution.candidate", {
        executionId: id,
        startedAt: execution.startedAt,
        message: "Đang kiểm tra execution candidate",
      });

      const detail = await getExecution(id, true);
      if (deepContains(detail, traceId)) {
        return id;
      }
    }

    if (!config.matchTraceId && fallbackExecutionId) {
      return fallbackExecutionId;
    }

    await delay(config.pollIntervalMs);
  }

  if (fallbackExecutionId) {
    writeEvent(res, "n8n.execution.fallback", {
      executionId: fallbackExecutionId,
      message: "Không match được traceId, dùng execution mới nhất theo thời gian",
    });
    return fallbackExecutionId;
  }

  throw new Error("Không tìm thấy n8n execution tương ứng");
}

async function pollExecution({ executionId, traceId, res }) {
  const deadline = Date.now() + config.executionTimeoutMs;
  const emitted = new Set();

  while (Date.now() < deadline) {
    const execution = await getExecution(executionId, true);
    const runData = execution?.data?.resultData?.runData ?? execution?.data?.runData ?? {};

    for (const [nodeName, nodeRuns] of Object.entries(runData)) {
      if (!Array.isArray(nodeRuns)) continue;

      nodeRuns.forEach((nodeRun, index) => {
        const key = makeNodeRunKey(executionId, nodeName, nodeRun, index);
        if (emitted.has(key)) return;
        emitted.add(key);

        writeEvent(res, "n8n.node.finished", summarizeNodeRun({
          executionId,
          traceId,
          nodeName,
          nodeRun,
          index,
        }));
      });
    }

    if (isTerminalExecution(execution)) {
      writeEvent(res, "n8n.execution.finished", {
        executionId,
        traceId,
        status: execution.status ?? (execution.finished ? "success" : "unknown"),
        finished: execution.finished,
        startedAt: execution.startedAt,
        stoppedAt: execution.stoppedAt,
        message: "Workflow n8n đã kết thúc",
      });
      res.end();
      return;
    }

    await delay(config.pollIntervalMs);
  }

  writeEvent(res, "n8n.execution.timeout", {
    executionId,
    traceId,
    level: "warn",
    message: "Hết thời gian chờ execution n8n",
  });
  res.end();
}

async function listExecutions() {
  const url = new URL(`${config.n8nBaseUrl}/api/v1/executions`);
  url.searchParams.set("workflowId", config.n8nWorkflowId);
  url.searchParams.set("limit", "10");
  url.searchParams.set("includeData", "false");

  const response = await fetch(url, {
    headers: {
      "X-N8N-API-KEY": config.n8nApiKey,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`n8n list executions failed: ${response.status} ${text.slice(0, 500)}`);
  }

  const json = await response.json();
  return Array.isArray(json.data) ? json.data : [];
}

async function getExecution(executionId, includeData) {
  const url = new URL(`${config.n8nBaseUrl}/api/v1/executions/${executionId}`);
  url.searchParams.set("includeData", includeData ? "true" : "false");

  const response = await fetch(url, {
    headers: {
      "X-N8N-API-KEY": config.n8nApiKey,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`n8n get execution failed: ${response.status} ${text.slice(0, 500)}`);
  }

  return response.json();
}

function summarizeNodeRun({ executionId, traceId, nodeName, nodeRun, index }) {
  const tokenUsage = findFirstKey(nodeRun, "tokenUsage");
  const concise = summarizeNodeOutput(nodeName, nodeRun);
  const event = {
    executionId,
    traceId,
    nodeName,
    runIndex: index,
    executionIndex: nodeRun.executionIndex,
    status: nodeRun.executionStatus ?? (nodeRun.error ? "error" : "success"),
    startTime: nodeRun.startTime,
    durationMs: nodeRun.executionTime,
    previousNode: nodeRun.source?.[0]?.previousNode,
    tokenUsage: tokenUsage && typeof tokenUsage === "object" ? tokenUsage : undefined,
    ...concise,
    message: formatNodeMessage(nodeName, nodeRun, concise),
  };

  if (config.logDetail === "verbose") {
    event.outputSummary = summarizeValue(nodeRun.data ?? nodeRun.error ?? null, 600);
  }

  if (config.includeInputSummary) {
    event.inputSummary = summarizeValue(nodeRun.inputOverride ?? null, 600);
  }

  return removeUndefined(event);
}

function summarizeNodeOutput(nodeName, nodeRun) {
  if (nodeRun.error) {
    return {
      level: "error",
      outputKind: "error",
      outputPreview: String(nodeRun.error.message ?? nodeRun.error.description ?? "Node error").slice(0, 240),
    };
  }

  const rows = collectJsonItems(nodeRun.data);
  const lowerName = nodeName.toLowerCase();

  if (lowerName.includes("groq") || lowerName.includes("chat model")) {
    const text = findFirstKey(nodeRun.data, "text");
    const finishReason = findFirstKey(nodeRun.data, "finish_reason");
    return {
      outputKind: "llm",
      outputPreview: text ? truncateText(text, 260) : finishReason ? `finish_reason=${finishReason}` : "LLM call completed",
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
      outputPreview: body ? truncateText(body, 220) : "Comment created",
    };
  }

  if (lowerName.includes("status") || lowerName.includes("cập nhật")) {
    const status = findFirstKey(nodeRun.data, "status");
    return {
      outputKind: "paperclip.issue",
      outputPreview: status ? `Issue status = ${status}` : "Issue updated",
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
      outputPreview: truncateText(output, 260),
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

function formatNodeMessage(nodeName, nodeRun, concise) {
  const status = nodeRun.executionStatus ?? (nodeRun.error ? "error" : "finished");
  const duration = nodeRun.executionTime ?? "?";
  const preview = concise.outputPreview ? ` - ${concise.outputPreview}` : "";
  return `[${nodeName}] ${status} (${duration}ms)${preview}`;
}

function collectJsonItems(value, result = [], depth = 0) {
  if (!value || depth > 10) return result;
  if (Array.isArray(value)) {
    for (const item of value) collectJsonItems(item, result, depth + 1);
    return result;
  }
  if (typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "json") && value.json && typeof value.json === "object") {
      result.push(value.json);
    }
    for (const child of Object.values(value)) collectJsonItems(child, result, depth + 1);
  }
  return result;
}

function truncateText(text, maxLength) {
  const normalized = String(text).replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength)}...` : normalized;
}

function makeNodeRunKey(executionId, nodeName, nodeRun, index) {
  return [
    executionId,
    nodeName,
    nodeRun.executionIndex ?? index,
    nodeRun.startTime ?? "no-start",
    nodeRun.executionStatus ?? "no-status",
  ].join(":");
}

function isTerminalExecution(execution) {
  const status = String(execution?.status ?? "").toLowerCase();
  return Boolean(execution?.finished) || ["success", "error", "canceled", "cancelled", "failed"].includes(status);
}

function extractPaperclipMetadata(body, query) {
  const context = body.context && typeof body.context === "object" ? body.context : {};
  return {
    traceId: stringValue(body.traceId ?? query.traceId),
    paperclipRunId: stringValue(body.paperclipRunId ?? body.runId ?? query.paperclipRunId ?? query.runId ?? context.runId),
    issueId: stringValue(body.issueId ?? body.taskId ?? query.issueId ?? query.taskId ?? context.issueId ?? context.taskId),
    agentId: stringValue(body.agentId ?? query.agentId ?? context.agentId),
  };
}

function createTraceId(runId, issueId) {
  if (runId) return `pc-run-${runId}`;
  if (issueId) return `pc-issue-${issueId}-${Date.now()}`;
  return `pc-${crypto.randomUUID()}`;
}

function setupJsonlStream(res) {
  res.writeHead(200, {
    "Content-Type": "application/x-ndjson; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
}

function writeEvent(res, type, payload) {
  res.write(`${JSON.stringify(removeUndefined({
    ts: new Date().toISOString(),
    type,
    ...payload,
  }))}\n`);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    return { rawBody: raw };
  }
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function summarizeValue(value, maxLength) {
  if (value == null) return undefined;
  const redacted = redact(value);
  const text = typeof redacted === "string" ? redacted : JSON.stringify(redacted);
  if (!text) return undefined;
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function redact(value, depth = 0) {
  if (depth > 8) return "[MaxDepth]";
  if (Array.isArray(value)) return value.slice(0, 10).map((item) => redact(item, depth + 1));
  if (!value || typeof value !== "object") return value;

  const result = {};
  for (const [key, child] of Object.entries(value)) {
    if (isSensitiveKey(key)) {
      result[key] = "[REDACTED]";
      continue;
    }
    result[key] = redact(child, depth + 1);
  }
  return result;
}

function isSensitiveKey(key) {
  return /authorization|cookie|api[_-]?key|token|password|secret|credential/i.test(key);
}

function deepContains(value, needle, depth = 0) {
  if (!needle || depth > 12) return false;
  if (typeof value === "string") return value.includes(needle);
  if (Array.isArray(value)) return value.some((item) => deepContains(item, needle, depth + 1));
  if (value && typeof value === "object") {
    return Object.values(value).some((item) => deepContains(item, needle, depth + 1));
  }
  return false;
}

function findFirstKey(value, wantedKey, depth = 0) {
  if (!value || depth > 10) return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findFirstKey(item, wantedKey, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, wantedKey)) return value[wantedKey];
    for (const child of Object.values(value)) {
      const found = findFirstKey(child, wantedKey, depth + 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function removeUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function stringValue(value) {
  if (value == null || value === "") return undefined;
  return String(value);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`[n8n-bridge] Missing required env ${name}`);
    process.exit(1);
  }
  return value;
}

function numberEnv(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value == null) return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}
