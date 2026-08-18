import type {
  AdapterExecutionContext,
  AdapterExecutionResult,
  AdapterRuntimeEvent,
} from "../types.js";
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
}

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

  await triggerN8nWebhook({ ctx, config, traceId, issueId });

  await emit(ctx, "n8n.triggered", {
    traceId,
    message: "n8n webhook triggered",
  });

  const executionId = await findExecutionId({
    ctx,
    config,
    traceId,
    startedAtMs,
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
  };
}

async function triggerN8nWebhook(params: {
  ctx: AdapterExecutionContext;
  config: N8nRuntimeConfig;
  traceId: string;
  issueId: string | undefined;
}): Promise<void> {
  const { ctx, config, traceId, issueId } = params;
  const url = new URL(config.webhookUrl);
  const content = getTaskContent(ctx);

  if (content) url.searchParams.set("Content", content);
  url.searchParams.set("traceId", traceId);
  url.searchParams.set("paperclipRunId", ctx.runId);
  if (issueId) url.searchParams.set("issueId", issueId);
  url.searchParams.set("agentId", ctx.agent.id);
  url.searchParams.set("companyId", ctx.agent.companyId);

  const body = {
    ...config.payloadTemplate,
    agentId: ctx.agent.id,
    runId: ctx.runId,
    paperclipRunId: ctx.runId,
    issueId,
    taskId: issueId,
    traceId,
    context: ctx.context,
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

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`n8n webhook failed: ${response.status} ${response.statusText} ${text.slice(0, 500)}`);
  }
}

async function findExecutionId(params: {
  ctx: AdapterExecutionContext;
  config: N8nRuntimeConfig;
  traceId: string;
  startedAtMs: number;
}): Promise<string> {
  const { ctx, config, traceId, startedAtMs } = params;
  const deadline = Date.now() + config.findExecutionTimeoutMs;
  const seenCandidates = new Set<string>();
  let fallbackExecutionId: string | null = null;

  while (Date.now() < deadline) {
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

    if (recent[0]?.id) fallbackExecutionId = String(recent[0].id);

    for (const execution of recent) {
      const id = String(execution.id);
      if (seenCandidates.has(id)) continue;
      seenCandidates.add(id);

      await emit(ctx, "n8n.execution.candidate", {
        executionId: id,
        startedAt: execution.startedAt,
        message: "checking n8n execution candidate",
      });

      const detail = await getExecution(config, id, true);
      if (deepContains(detail, traceId)) return id;
    }

    if (!config.matchTraceId && fallbackExecutionId) return fallbackExecutionId;
    await delay(config.pollIntervalMs);
  }

  if (fallbackExecutionId) {
    await emit(ctx, "n8n.execution.fallback", {
      executionId: fallbackExecutionId,
      message: "traceId was not matched, using newest execution by time",
    });
    return fallbackExecutionId;
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
  const url = new URL(`${config.baseUrl}/api/v1/executions`);
  url.searchParams.set("workflowId", config.workflowId);
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

  const json = await response.json() as JsonRecord;
  return Array.isArray(json.data) ? json.data.map(parseObject) : [];
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

async function emit(ctx: AdapterExecutionContext, type: string, payload: JsonRecord): Promise<void> {
  const event = removeUndefined({
    ts: new Date().toISOString(),
    type,
    ...payload,
  });

  await ctx.onLog("stdout", `${JSON.stringify(event)}\n`);

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
