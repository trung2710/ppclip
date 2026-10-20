/**
 * Per-run cost for agents that go through a LiteLLM gateway.
 *
 * Neither Codex nor `codex-acp` forwards the response cost that LiteLLM
 * computes (`codex-acp` only emits `{ used, size }` in `usage_update`), so the
 * run cost is measured on the gateway side instead: the cumulative `spend` of
 * the agent's own virtual key is read before and after the run, and the delta
 * is the cost of every request the run made.
 *
 * Limits worth knowing:
 *  - Requests made with the same key by another process during the run are
 *    counted too, so use one virtual key per agent.
 *  - LiteLLM writes spend in batches, so the "after" value is polled until it
 *    stops moving (bounded by `settleMs`).
 *
 * Everything here is best-effort: any failure yields `null`, never an error.
 */

export const DEFAULT_LITELLM_SPEND_SETTLE_MS = 6000;
/**
 * Upper bound for waiting on tagged spend-log rows. LiteLLM writes failed calls
 * right away but batches successful ones, so the successful rows of a run can
 * land several seconds after its failures.
 */
export const DEFAULT_LITELLM_LOG_SETTLE_MS = 15000;
const DEFAULT_POLL_INTERVAL_MS = 1500;
const DEFAULT_REQUEST_TIMEOUT_MS = 3000;
/** Costs are USD; 1e-8 is far below a billable fraction and hides float noise. */
const COST_PRECISION = 1e8;

type FetchLike = (
  input: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal },
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

export interface LiteLlmSpendClient {
  /** OpenAI-style base URL of the gateway, e.g. `http://localhost:4000/v1`. */
  baseUrl: string;
  /** The agent's LiteLLM virtual key. */
  apiKey: string;
  fetchImpl?: FetchLike;
  requestTimeoutMs?: number;
}

/** Gateway root without the trailing `/v1`, which hosts the management API. */
function gatewayRoot(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "").replace(/\/v1$/i, "");
}

/** GET a gateway management endpoint as the caller's key; null on any failure. */
async function getGatewayJson(client: LiteLlmSpendClient, pathAndQuery: string): Promise<unknown> {
  const fetchImpl = client.fetchImpl ?? (globalThis.fetch as unknown as FetchLike | undefined);
  if (!fetchImpl || !client.apiKey.trim() || !client.baseUrl.trim()) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), client.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`${gatewayRoot(client.baseUrl)}${pathAndQuery}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${client.apiKey.trim()}` },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface LiteLlmKeyInfo {
  /** Cumulative spend (USD) of the key. */
  spend: number | null;
  /** Hashed key, the `api_key` filter of `/spend/logs`. */
  keyHash: string | null;
}

/** `/key/info` for the caller's own key. */
export async function readLiteLlmKeyInfo(client: LiteLlmSpendClient): Promise<LiteLlmKeyInfo | null> {
  const body = (await getGatewayJson(client, "/key/info")) as
    | { key?: unknown; info?: { spend?: unknown } }
    | null;
  if (!body || typeof body !== "object") return null;
  const spend = body.info?.spend;
  return {
    spend: typeof spend === "number" && Number.isFinite(spend) && spend >= 0 ? spend : null,
    keyHash: typeof body.key === "string" && body.key.trim().length > 0 ? body.key.trim() : null,
  };
}

/** Cumulative spend (USD) of the caller's key, or null when it cannot be read. */
export async function readLiteLlmKeySpend(client: LiteLlmSpendClient): Promise<number | null> {
  return (await readLiteLlmKeyInfo(client))?.spend ?? null;
}

/**
 * Cost of the run that started when `before` was read. Polls until the spend
 * is unchanged for two consecutive reads or `settleMs` elapses.
 */
export async function measureLiteLlmRunCostUsd(input: {
  client: LiteLlmSpendClient;
  before: number | null;
  settleMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<number | null> {
  if (input.before == null) return null;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;
  const settleMs = input.settleMs ?? DEFAULT_LITELLM_SPEND_SETTLE_MS;
  const interval = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = now() + settleMs;

  let last = await readLiteLlmKeySpend(input.client);
  let unchangedReads = 0;
  while (last != null && now() < deadline && unchangedReads < 2) {
    await sleep(interval);
    const next = await readLiteLlmKeySpend(input.client);
    if (next == null) break;
    unchangedReads = next === last ? unchangedReads + 1 : 0;
    last = next;
  }

  if (last == null || last < input.before) return null;
  return Math.round((last - input.before) * COST_PRECISION) / COST_PRECISION;
}

// ---------------------------------------------------------------------------
// Exact per-run usage from tagged spend logs
// ---------------------------------------------------------------------------

/** Usage summed over every gateway request tagged with the run. */
export interface LiteLlmRunUsage {
  requestCount: number;
  failedRequestCount: number;
  /** Prompt tokens excluding cache reads (Paperclip's `inputTokens` convention). */
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  costUsd: number;
}

interface SpendLogRow {
  request_tags?: unknown;
  spend?: unknown;
  prompt_tokens?: unknown;
  completion_tokens?: unknown;
  status?: unknown;
  metadata?: {
    status?: unknown;
    usage_object?: { prompt_tokens_details?: { cached_tokens?: unknown } | null } | null;
    additional_usage_values?: { cache_read_input_tokens?: unknown } | null;
  } | null;
}

function finiteNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Sums the rows tagged with `runTag`; pure, exported for tests. */
export function summarizeTaggedSpendLogs(rows: unknown, runTag: string): LiteLlmRunUsage {
  const usage: LiteLlmRunUsage = {
    requestCount: 0,
    failedRequestCount: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
  if (!Array.isArray(rows)) return usage;
  for (const raw of rows as SpendLogRow[]) {
    if (!raw || typeof raw !== "object") continue;
    const tags = Array.isArray(raw.request_tags) ? raw.request_tags : [];
    if (!tags.some((tag) => typeof tag === "string" && tag.trim() === runTag)) continue;
    usage.requestCount += 1;
    const status = raw.status ?? raw.metadata?.status;
    if (status === "failure") usage.failedRequestCount += 1;
    const prompt = finiteNonNegative(raw.prompt_tokens);
    const cached = Math.min(
      prompt,
      finiteNonNegative(raw.metadata?.usage_object?.prompt_tokens_details?.cached_tokens) ||
        finiteNonNegative(raw.metadata?.additional_usage_values?.cache_read_input_tokens),
    );
    usage.inputTokens += prompt - cached;
    usage.cachedInputTokens += cached;
    usage.outputTokens += finiteNonNegative(raw.completion_tokens);
    usage.costUsd += finiteNonNegative(raw.spend);
  }
  usage.costUsd = Math.round(usage.costUsd * COST_PRECISION) / COST_PRECISION;
  return usage;
}

/**
 * Reads `/spend/logs` for the key over the run's UTC day(s) and sums the
 * requests tagged `runTag`. LiteLLM writes failed calls immediately but batches
 * successful ones, so it only settles once at least one successful row has
 * landed and the matched count and spend are unchanged for two reads; a run
 * with no successful row waits until `settleMs` elapses. Returns null when the
 * logs cannot be read.
 */
export async function collectLiteLlmRunUsage(input: {
  client: LiteLlmSpendClient;
  keyHash: string;
  runTag: string;
  startedAtMs: number;
  endedAtMs: number;
  settleMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}): Promise<LiteLlmRunUsage | null> {
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = input.now ?? Date.now;
  const deadline = now() + (input.settleMs ?? DEFAULT_LITELLM_LOG_SETTLE_MS);
  const interval = input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const query = new URLSearchParams({
    api_key: input.keyHash,
    start_date: utcDay(input.startedAtMs),
    // end_date is exclusive at day granularity; cover a run that crosses midnight.
    end_date: utcDay(input.endedAtMs + 24 * 60 * 60 * 1000),
    summarize: "false",
  });
  const read = async () => {
    const rows = await getGatewayJson(input.client, `/spend/logs?${query.toString()}`);
    return Array.isArray(rows) ? summarizeTaggedSpendLogs(rows, input.runTag) : null;
  };

  let last = await read();
  let unchangedReads = 0;
  while (last != null && now() < deadline) {
    // Failed rows alone do not settle: the batched successful rows may still come.
    const hasSuccessfulRow = last.requestCount > last.failedRequestCount;
    if (hasSuccessfulRow && unchangedReads >= 2) break;
    await sleep(interval);
    const next = await read();
    if (next == null) break;
    unchangedReads =
      next.requestCount === last.requestCount && next.costUsd === last.costUsd ? unchangedReads + 1 : 0;
    last = next;
  }
  return last;
}
