import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterRuntimeEvent,
} from "../types.js";
import {
  normalizePaperclipWakePayload,
  renderPaperclipWakePrompt,
  selectPaperclipTaskMarkdown,
  joinPromptSections,
} from "@paperclipai/adapter-utils/server-utils";
import {
  asBoolean,
  asNumber,
  asString,
  deepContains,
  isTerminalExecution,
  makeNodeRunKey,
  parseObject,
  removeUndefined,
  summarizeNodeRun,
  type JsonRecord,
} from "./parse.js";

declare const process: { env: Record<string, string | undefined> };

interface N8nRuntimeConfig {
  webhookUrl: string;
  baseUrl: string;
  workflowId: string;
  method: string;
  n8nApiKey: string;
  pollIntervalMs: number;
  findExecutionTimeoutMs: number;
  executionTimeoutMs: number;
  matchTraceId: boolean;
  includeInputSummary: boolean;
  logDetail: string;
  headers: Record<string, string>;
  payloadTemplate: JsonRecord;
  includeFullContext: boolean;
  includeFullPrompt: boolean;
}

type WebhookTriggerResult =
  | { ok: true; body: string }
  | { ok: false; error: Error };

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = readConfig(ctx.config);
  if (!config.webhookUrl) throw new Error("n8n_runtime adapter missing webhookUrl");
  if (!config.baseUrl) throw new Error("n8n_runtime adapter missing baseUrl");
  if (!config.workflowId) throw new Error("n8n_runtime adapter missing workflowId");
  if (!config.n8nApiKey) throw new Error("n8n_runtime adapter missing N8N_API_KEY");

  const startedAtMs = Date.now();
  const issueId = getIssueId(ctx);
  const traceId = createTraceId(ctx.runId, issueId);

  await emit(ctx, "bridge.started", {
    traceId,
    paperclipRunId: ctx.runId,
    issueId,
    agentId: ctx.agent.id,
    message: "n8n runtime adapter received Paperclip run",
  });

  let webhookTriggerError: Error | null = null;
  const webhookTrigger: Promise<WebhookTriggerResult> = triggerN8nWebhook({ ctx, config, traceId, issueId }).then(
    (body): WebhookTriggerResult => ({ ok: true, body }),
    (error: unknown): WebhookTriggerResult => {
      const normalized = normalizeError(error);
      webhookTriggerError = normalized;
      return { ok: false, error: normalized };
    },
  );

  await emit(ctx, "n8n.triggered", {
    traceId,
    message: "n8n webhook request started",
  });

  const executionId = await findExecutionId({
    ctx,
    config,
    traceId,
    startedAtMs,
    getWebhookTriggerError: () => webhookTriggerError,
  });

  await emit(ctx, "n8n.execution.found", {
    traceId,
    executionId,
    message: "n8n execution found",
  });

  const result = await pollExecution({
    ctx,
    config,
    executionId,
    traceId,
  });

  const triggerResult = await webhookTrigger;
  if (!triggerResult.ok) {
    await emit(ctx, "n8n.webhook.response_failed", {
      traceId,
      executionId,
      level: result.exitCode === 0 ? "warn" : "error",
      message: triggerResult.error.message,
    });
  } else if (triggerResult.body) {
    await emit(ctx, "n8n.webhook.response_success", {
      traceId,
      executionId,
      message: "Received final webhook response",
      body: triggerResult.body,
    });

    // Nếu extractWorkflowResult ở pollExecution không tìm được gì, ta gán tạm webhook body làm result
    if (result.resultJson && !result.resultJson.result) {
      result.resultJson.result = triggerResult.body;
    }
  }

  return result;
}

function readConfig(rawConfig: Record<string, unknown>): N8nRuntimeConfig {
  const headersRaw = parseObject(rawConfig.headers);
  const headers = Object.fromEntries(
    Object.entries(headersRaw).map(([key, value]) => [key, String(value)]),
  );

  return {
    webhookUrl: stripTrailingSpaces(asString(rawConfig.webhookUrl, asString(rawConfig.url))),
    baseUrl: stripTrailingSlash(asString(rawConfig.baseUrl, asString(process.env.N8N_BASE_URL))),
    workflowId: asString(rawConfig.workflowId, asString(process.env.N8N_WORKFLOW_ID)),
    method: asString(rawConfig.method, "POST").toUpperCase(),
    n8nApiKey: asString(rawConfig.n8nApiKey, asString(process.env.N8N_API_KEY)),
    pollIntervalMs: Math.max(250, asNumber(rawConfig.pollIntervalMs, 1000)),
    findExecutionTimeoutMs: Math.max(1000, asNumber(rawConfig.findExecutionTimeoutMs, 30_000)),
    executionTimeoutMs: Math.max(1000, asNumber(rawConfig.executionTimeoutMs, 300_000)),
    matchTraceId: asBoolean(rawConfig.matchTraceId, true),
    includeInputSummary: asBoolean(rawConfig.includeInputSummary, false),
    logDetail: asString(rawConfig.logDetail, "compact"),
    headers,
    payloadTemplate: parseObject(rawConfig.payloadTemplate),
    includeFullContext: asBoolean(rawConfig.includeFullContext, true),
    includeFullPrompt: asBoolean(rawConfig.includeFullPrompt, true),
  };
}

async function triggerN8nWebhook(params: {
  ctx: AdapterExecutionContext;
  config: N8nRuntimeConfig;
  traceId: string;
  issueId: string | undefined;
}): Promise<string> {
  const { ctx, config, traceId, issueId } = params;
  const url = new URL(config.webhookUrl);
  const content = getTaskContent(ctx);

  if (content) url.searchParams.set("Content", content);
  url.searchParams.set("traceId", traceId);
  url.searchParams.set("paperclipRunId", ctx.runId);
  if (issueId) url.searchParams.set("issueId", issueId);
  url.searchParams.set("agentId", ctx.agent.id);
  url.searchParams.set("companyId", ctx.agent.companyId);

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
    ...(paperclipContext ? { paperclip: paperclipContext } : {}),
    bridge: {
      kind: "paperclip-n8n-runtime-adapter",
      startedAt: new Date().toISOString(),
    },
  };

  const response = await fetch(url, {
    method: config.method,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json,text/plain,*/*",
      ...config.headers,
    },
    body: config.method === "GET" ? undefined : JSON.stringify(body),
  });

  const text = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`n8n webhook failed: ${response.status} ${response.statusText} ${text.slice(0, 500)}`);
  }

  return text;
}

async function findExecutionId(params: {
  ctx: AdapterExecutionContext;
  config: N8nRuntimeConfig;
  traceId: string;
  startedAtMs: number;
  getWebhookTriggerError?: () => Error | null;
}): Promise<string> {
  const { ctx, config, traceId, startedAtMs, getWebhookTriggerError } = params;
  const deadline = Date.now() + config.findExecutionTimeoutMs;
  let lastLoggedId: string | null = null;

  // Cho n8n kip tao execution trong DB
  await delay(400);

  while (Date.now() < deadline) {
    const triggerError = getWebhookTriggerError?.();
    if (triggerError) throw triggerError;

    const executions = await listExecutions(config);
    const recent = executions
      .filter((execution) => {
        const startedAt = Date.parse(asString(execution.startedAt, asString(execution.createdAt)));
        return Number.isFinite(startedAt) && startedAt >= startedAtMs - 10_000;
      })
      .sort((a, b) => {
        const bStarted = Date.parse(asString(b.startedAt, asString(b.createdAt)));
        const aStarted = Date.parse(asString(a.startedAt, asString(a.createdAt)));
        return bStarted - aStarted;
      });

    for (const execution of recent) {
      const id = String(execution.id);

      if (id !== lastLoggedId) {
        lastLoggedId = id;
        await emit(ctx, "n8n.execution.candidate", {
          executionId: id,
          startedAt: execution.startedAt,
          message: "checking n8n execution candidate",
        });
      }

      const detail = await getExecution(config, id, true);
      if (deepContains(detail, traceId)) return id;
    }

    if (!config.matchTraceId && recent[0]?.id) {
      return String(recent[0].id);
    }

    await delay(config.pollIntervalMs);
  }

  const executions = await listExecutions(config);
  if (executions[0]?.id) {
    await emit(ctx, "n8n.execution.fallback", {
      executionId: String(executions[0].id),
      message: "traceId not matched, using newest execution",
    });
    return String(executions[0].id);
  }

  throw new Error("Could not find matching n8n execution");
}

async function pollExecution(params: {
  ctx: AdapterExecutionContext;
  config: N8nRuntimeConfig;
  executionId: string;
  traceId: string;
}): Promise<AdapterExecutionResult> {
  const { ctx, config, executionId, traceId } = params;
  const deadline = Date.now() + config.executionTimeoutMs;
  const emitted = new Set<string>();

  while (Date.now() < deadline) {
    const execution = await getExecution(config, executionId, true);
    const data = parseObject(execution.data);
    const resultData = parseObject(data.resultData);
    const runData = parseObject(resultData.runData ?? data.runData);

    for (const [nodeName, nodeRuns] of Object.entries(runData)) {
      if (!Array.isArray(nodeRuns)) continue;

      for (let index = 0; index < nodeRuns.length; index += 1) {
        const nodeRun = parseObject(nodeRuns[index]);
        const key = makeNodeRunKey(executionId, nodeName, nodeRun, index);
        if (emitted.has(key)) continue;
        emitted.add(key);

        await emit(ctx, "n8n.node.finished", summarizeNodeRun({
          executionId,
          traceId,
          nodeName,
          nodeRun,
          index,
          logDetail: config.logDetail,
          includeInputSummary: config.includeInputSummary,
        }));
      }
    }

    if (isTerminalExecution(execution)) {
      const status = asString(execution.status, execution.finished ? "success" : "unknown");
      await emit(ctx, "n8n.execution.finished", {
        executionId,
        traceId,
        status,
        finished: execution.finished,
        startedAt: execution.startedAt,
        stoppedAt: execution.stoppedAt,
        message: "n8n workflow finished",
      });

      const failed = ["error", "failed", "canceled", "cancelled"].includes(status.toLowerCase());
      return {
        exitCode: failed ? 1 : 0,
        signal: null,
        timedOut: false,
        errorMessage: failed ? `n8n workflow ended with status ${status}` : null,
        summary: failed ? "n8n workflow failed" : "n8n workflow completed successfully",
        resultJson: removeUndefined({
          executionId,
          traceId,
          status,
          finished: execution.finished,
          startedAt: execution.startedAt,
          stoppedAt: execution.stoppedAt,
        }),
      };
    }

    await delay(config.pollIntervalMs);
  }

  await emit(ctx, "n8n.execution.timeout", {
    executionId,
    traceId,
    level: "warn",
    message: "n8n execution timed out",
  });

  return {
    exitCode: null,
    signal: null,
    timedOut: true,
    errorCode: "timeout",
    errorMessage: `n8n execution ${executionId} timed out after ${config.executionTimeoutMs}ms`,
    summary: "n8n workflow timed out",
    resultJson: { executionId, traceId },
  };
}

async function listExecutions(config: N8nRuntimeConfig): Promise<JsonRecord[]> {
  const urlRunning = new URL(`${config.baseUrl}/api/v1/executions`);
  urlRunning.searchParams.set("workflowId", config.workflowId);
  urlRunning.searchParams.set("limit", "10");
  urlRunning.searchParams.set("includeData", "false");
  urlRunning.searchParams.set("status", "running");

  const urlDefault = new URL(`${config.baseUrl}/api/v1/executions`);
  urlDefault.searchParams.set("workflowId", config.workflowId);
  urlDefault.searchParams.set("limit", "10");
  urlDefault.searchParams.set("includeData", "false");

  const [resRunning, resDefault] = await Promise.all([
    fetch(urlRunning, { headers: { "X-N8N-API-KEY": config.n8nApiKey, Accept: "application/json" } }),
    fetch(urlDefault, { headers: { "X-N8N-API-KEY": config.n8nApiKey, Accept: "application/json" } })
  ]);

  if (!resDefault.ok) {
    const text = await resDefault.text().catch(() => "");
    throw new Error(`n8n list executions failed: ${resDefault.status} ${text.slice(0, 500)}`);
  }

  const jsonRunning = resRunning.ok ? (await resRunning.json() as JsonRecord) : { data: [] };
  const jsonDefault = await resDefault.json() as JsonRecord;

  const dataRunning = Array.isArray(jsonRunning.data) ? jsonRunning.data : [];
  const dataDefault = Array.isArray(jsonDefault.data) ? jsonDefault.data : [];

  const seenIds = new Set<string>();
  const executions: JsonRecord[] = [];

  for (const raw of [...dataRunning, ...dataDefault]) {
    const item = parseObject(raw);
    const id = item.id != null ? String(item.id) : "";
    if (id) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }
    executions.push(item);
  }

  return executions;
}

async function getExecution(config: N8nRuntimeConfig, executionId: string, includeData: boolean): Promise<JsonRecord> {
  const url = new URL(`${config.baseUrl}/api/v1/executions/${executionId}`);
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

  return await response.json() as JsonRecord;
}

function formatLogEvent(event: JsonRecord): string {
  const ts = asString(event.ts);
  const timePart = ts ? ts.substring(11, 23) : new Date().toISOString().substring(11, 23);
  const type = asString(event.type);
  const message = asString(event.message);

  let statusStr = "INFO";
  if (event.status) {
    const status = String(event.status).toLowerCase();
    if (status === "success") {
      statusStr = "SUCCESS";
    } else if (status === "error" || status === "failed") {
      statusStr = "ERROR";
    } else {
      statusStr = status.toUpperCase();
    }
  } else if (type === "n8n.execution.finished") {
    statusStr = "FINISHED";
  } else if (type === "n8n.execution.timeout") {
    statusStr = "TIMEOUT";
  }

  let output = `[${timePart}] [${statusStr}] `;

  if (type === "n8n.node.finished") {
    const nodeName = asString(event.nodeName);
    const duration = event.durationMs != null ? ` in ${event.durationMs}ms` : "";
    output += `Node '${nodeName}' finished${duration}`;
  } else {
    output += message || type;
  }

  const details: string[] = [];

  if (type === "n8n.node.finished") {
    if (event.outputPreview) {
      details.push(`  ├─ Preview: ${event.outputPreview}`);
    }
    if (event.previousNode) {
      details.push(`  ├─ Previous Node: ${event.previousNode}`);
    }
    if (event.tokenUsage && typeof event.tokenUsage === "object") {
      const tokens = event.tokenUsage as JsonRecord;
      details.push(`  ├─ Tokens: Prompt: ${tokens.promptTokens ?? "?"} | Completion: ${tokens.completionTokens ?? "?"} | Total: ${tokens.totalTokens ?? "?"}`);
    }
    if (event.rawError) {
      const errStr = JSON.stringify(event.rawError, null, 2)
        .split("\n")
        .map(line => `  │ ${line}`)
        .join("\n");
      details.push(`  ├─ Error Details:\n${errStr}`);
    }
    if (event.rawData) {
      const dataStr = JSON.stringify(event.rawData, null, 2)
        .split("\n")
        .map(line => `  │ ${line}`)
        .join("\n");
      details.push(`  ├─ Output Data:\n${dataStr}`);
    }

    if (details.length > 0) {
      const lastIdx = details.length - 1;
      details[lastIdx] = details[lastIdx].replace("  ├─", "  └─");
    }
  } else if (type === "bridge.started") {
    details.push(`  ├─ Trace ID: ${event.traceId}`);
    details.push(`  └─ Run ID: ${event.paperclipRunId}`);
  } else if (type === "n8n.execution.found") {
    details.push(`  └─ Execution ID: ${event.executionId}`);
  } else if (type === "n8n.execution.finished") {
    details.push(`  ├─ Status: ${event.status}`);
    details.push(`  └─ Execution ID: ${event.executionId}`);
  } else if (type === "n8n.webhook.response_success") {
    details.push(`  └─ Body: ${event.body}`);
  }

  if (details.length > 0) {
    output += "\n" + details.join("\n");
  }

  if (type === "n8n.node.finished") {
    output += "\n\n" + "─".repeat(80);
  } else if (type === "n8n.execution.finished" || type === "n8n.execution.timeout" || type === "n8n.webhook.response_success") {
    output += "\n\n" + "=".repeat(80);
  }

  return output + "\n\n";
}

async function emit(ctx: AdapterExecutionContext, type: string, payload: JsonRecord): Promise<void> {
  const event = removeUndefined({
    ts: new Date().toISOString(),
    type,
    ...payload,
  });

  await ctx.onLog("stdout", formatLogEvent(event));

  const runtimeEvent: AdapterRuntimeEvent = {
    eventType: type,
    stream: payload.level === "error" ? "stderr" : "system",
    level: payload.level === "error" ? "error" : payload.level === "warn" ? "warn" : "info",
    message: asString(payload.message, type),
    payload: event,
  };
  await ctx.onEvent?.(runtimeEvent);
}

function getIssueId(ctx: AdapterExecutionContext): string | undefined {
  const context = ctx.context;
  return stringValue(context.issueId ?? context.taskId ?? context.id);
}

function getTaskContent(ctx: AdapterExecutionContext): string | undefined {
  const context = ctx.context;
  return stringValue(
    context.Content ??
    context.content ??
    context.query ??
    context.taskTitle ??
    context.issueTitle ??
    context.title,
  );
}

function createTraceId(runId: string, issueId: string | undefined): string {
  if (runId) return `pc-run-${runId}`;
  if (issueId) return `pc-issue-${issueId}-${Date.now()}`;
  const randomId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `pc-${randomId}`;
}

function stringValue(value: unknown): string | undefined {
  if (value == null || value === "") return undefined;
  return String(value);
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function stripTrailingSpaces(value: string): string {
  return value.trim();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeError(error: unknown): Error {
  if (error instanceof Error) return error;
  return new Error(String(error));
}

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
    latestComments: wake?.comments.map((c: any) => ({
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
    fullPrompt,
  };
}
