import fs from "node:fs/promises";
import path from "node:path";

/**
 * Shared helpers for editing a Codex `config.toml` and for resolving the
 * LiteLLM-gateway / approval-guardian settings of a `codex_local` agent.
 *
 * Used by both the CLI engine (`@paperclipai/adapter-codex-local`) and the
 * ACPX engine so the two never drift. The editor is deliberately line-based
 * and table-aware rather than regex-over-the-whole-file: a key is only ever
 * touched inside the table it belongs to (root keys never match a same-named
 * key inside `[profiles.x]`, `guardian` never matches outside `[features]`).
 *
 * Limitations: only single-line scalar / inline-table values are written; an existing
 * multi-line array / string value for a managed key is replaced as a whole;
 * inline-table forms such as `features = { ... }` are not rewritten.
 */

export const DEFAULT_LITELLM_BASE_URL = "http://localhost:4000/v1";
export const LITELLM_PROVIDER_ID = "mygw";
export const LITELLM_API_KEY_ENV = "LITELLM_API_KEY";
/**
 * Per-run spend tags. Paperclip sets this env var on every run and Codex
 * forwards it as `x-litellm-tags` (`env_http_headers` of the provider), so
 * LiteLLM stores `paperclip_run:<runId>` on each request the run makes.
 */
export const LITELLM_TAGS_ENV = "PAPERCLIP_LITELLM_TAGS";
export const LITELLM_TAGS_HEADER = "x-litellm-tags";
export const PAPERCLIP_RUN_TAG_PREFIX = "paperclip_run:";

export function paperclipRunTag(runId: string): string {
  return `${PAPERCLIP_RUN_TAG_PREFIX}${runId}`;
}

/** Comma-separated LiteLLM tags for one run (LiteLLM splits the header on commas). */
export function buildPaperclipLiteLlmTags(input: {
  runId: string;
  agentId?: string | null;
  companyId?: string | null;
}): string {
  const tags = [paperclipRunTag(input.runId)];
  if (input.agentId) tags.push(`paperclip_agent:${input.agentId}`);
  if (input.companyId) tags.push(`paperclip_company:${input.companyId}`);
  return tags.map((tag) => tag.replace(/,/g, "_")).join(",");
}

const LEGACY_GUARDIAN_COMMENT = "Chuyển chính sách duyệt sang";

export type TomlScalar = string | number | boolean;
/**
 * A scalar, a string array (`["a", "b"]`), or a flat string map written as an
 * inline table (`{ "k" = "v" }`).
 */
export type TomlValue = TomlScalar | string[] | Record<string, string>;

// ---------------------------------------------------------------------------
// Low-level, table-aware line editor
// ---------------------------------------------------------------------------

// `[a.b]` or `[[a.b]]`; the body is restricted to key characters so that a
// bare `[1, 2]` row of a multi-line array is not mistaken for a table header.
const TABLE_HEADER_RE = /^\s*\[\[?\s*([A-Za-z0-9_\-."' ]+?)\s*\]\]?\s*(?:#.*)?$/;

function normalizeTablePath(raw: string): string {
  return raw
    .split(".")
    .map((segment) => segment.trim().replace(/^["']|["']$/g, ""))
    .join(".");
}

function headerPathOf(line: string): string | null {
  const match = TABLE_HEADER_RE.exec(line);
  return match ? normalizeTablePath(match[1]) : null;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function formatScalar(value: TomlValue): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => JSON.stringify(item)).join(", ")}]`;
  if (typeof value === "object") {
    const pairs = Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`);
    return pairs.length > 0 ? `{ ${pairs.join(", ")} }` : "{}";
  }
  return String(value);
}

function splitLines(toml: string): { eol: string; lines: string[] } {
  const eol = toml.includes("\r\n") ? "\r\n" : "\n";
  const lines = toml.split(/\r?\n/);
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  return { eol, lines };
}

function joinLines(lines: string[], eol: string): string {
  return lines.length === 0 ? "" : lines.join(eol) + eol;
}

function isBlankOrComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

/** Index of the first table header, or `lines.length` when there is none. */
function rootEnd(lines: string[]): number {
  const idx = lines.findIndex((line) => headerPathOf(line) !== null);
  return idx === -1 ? lines.length : idx;
}

/**
 * Ranges `[headerIdx, endExclusive)` of every table named `tablePath`.
 * Trailing blank/comment lines are not part of the table: they usually
 * introduce the next table (or the Paperclip managed MCP block).
 */
function findTableRanges(lines: string[], tablePath: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (headerPathOf(lines[i]) !== tablePath) continue;
    let end = i + 1;
    while (end < lines.length && headerPathOf(lines[end]) === null) end += 1;
    let trimmed = end;
    while (trimmed > i + 1 && isBlankOrComment(lines[trimmed - 1])) trimmed -= 1;
    ranges.push([i, trimmed]);
  }
  return ranges;
}

/** Number of lines occupied by the (possibly multi-line) value starting at `idx`. */
function valueLineSpan(lines: string[], idx: number, end: number): number {
  const line = lines[idx];
  const tripleQuote = /=\s*("""|''')/.exec(line);
  if (tripleQuote) {
    const delimiter = tripleQuote[1];
    const afterOpen = line.slice(line.indexOf(delimiter) + 3);
    if (afterOpen.includes(delimiter)) return 1;
    for (let i = idx + 1; i < end; i += 1) {
      if (lines[i].includes(delimiter)) return i - idx + 1;
    }
    return end - idx;
  }
  if (/=\s*\[\s*(?:#.*)?$/.test(line)) {
    for (let i = idx + 1; i < end; i += 1) {
      if (lines[i].trim().startsWith("]")) return i - idx + 1;
    }
    return end - idx;
  }
  return 1;
}

/**
 * Sets `entries` inside `lines[from, to)`. Existing keys are replaced in
 * place (later duplicates are dropped), missing keys are inserted after the
 * last non-blank/non-comment line of the range. Returns the new `to`.
 */
function setKeysInRange(
  lines: string[],
  from: number,
  to: number,
  entries: Record<string, TomlValue>,
): number {
  let end = to;
  for (const [key, value] of Object.entries(entries)) {
    const keyRe = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`);
    const rendered = `${key} = ${formatScalar(value)}`;
    let found = false;
    for (let i = from; i < end;) {
      if (!keyRe.test(lines[i])) {
        i += 1;
        continue;
      }
      const span = valueLineSpan(lines, i, end);
      if (!found) {
        lines.splice(i, span, rendered);
        end -= span - 1;
        found = true;
        i += 1;
      } else {
        lines.splice(i, span);
        end -= span;
      }
    }
    if (!found) {
      let insertAt = end;
      while (insertAt > from && isBlankOrComment(lines[insertAt - 1])) insertAt -= 1;
      lines.splice(insertAt, 0, rendered);
      end += 1;
    }
  }
  return end;
}

/** Sets root-level (before the first table header) keys. */
export function setTomlRootKeys(toml: string, entries: Record<string, TomlValue>): string {
  const { eol, lines } = splitLines(toml);
  setKeysInRange(lines, 0, rootEnd(lines), entries);
  return joinLines(lines, eol);
}

/**
 * Sets keys inside `[tablePath]`, creating the table when it is missing.
 * Root dotted-key forms (`tablePath.key = ...`) of the same keys are removed
 * because they would redefine the table.
 */
export function setTomlTableKeys(
  toml: string,
  tablePath: string,
  entries: Record<string, TomlValue>,
): string {
  const { eol, lines } = splitLines(toml);

  const rootRegionEnd = rootEnd(lines);
  for (let i = rootRegionEnd - 1; i >= 0; i -= 1) {
    const dotted = Object.keys(entries).some((key) =>
      new RegExp(`^\\s*${escapeRegExp(tablePath)}\\.${escapeRegExp(key)}\\s*=`).test(lines[i]),
    );
    if (dotted) lines.splice(i, 1);
  }

  const ranges = findTableRanges(lines, tablePath);
  if (ranges.length === 0) {
    if (lines.length > 0) lines.push("");
    lines.push(`[${tablePath}]`);
    for (const [key, value] of Object.entries(entries)) lines.push(`${key} = ${formatScalar(value)}`);
    return joinLines(lines, eol);
  }

  const [start, end] = ranges[0];
  setKeysInRange(lines, start + 1, end, entries);
  return joinLines(lines, eol);
}

/**
 * Replaces every `[tablePath]` table (duplicates included) with a single
 * freshly written one appended at the end of the file.
 */
export function replaceTomlTable(
  toml: string,
  tablePath: string,
  entries: Record<string, TomlValue>,
): string {
  const { eol, lines } = splitLines(toml);
  const ranges = findTableRanges(lines, tablePath);
  for (let i = ranges.length - 1; i >= 0; i -= 1) {
    const [start, end] = ranges[i];
    lines.splice(start, end - start);
  }
  if (lines.length > 0 && lines[lines.length - 1].trim() !== "") lines.push("");
  lines.push(`[${tablePath}]`);
  for (const [key, value] of Object.entries(entries)) lines.push(`${key} = ${formatScalar(value)}`);
  return joinLines(lines, eol);
}

// ---------------------------------------------------------------------------
// Codex-specific transforms
// ---------------------------------------------------------------------------

/**
 * `approval_policy = "never"` only silences terminal approvals. MCP tool calls
 * are additionally gated by the Guardian review (`features.guardian_approval`),
 * which calls a separate model that a gateway usually cannot serve.
 */
export function ensureCodexApprovalsDisabled(toml: string): string {
  const withRoot = setTomlRootKeys(toml, {
    approval_policy: "never",
    approvals_reviewer: "user",
  });
  return setTomlTableKeys(withRoot, "features", {
    guardian_approval: false,
    guardian: false,
  });
}

export interface LiteLlmGatewayTomlOptions {
  baseUrl?: string | null;
  model?: string | null;
  reasoningEffort?: string | null;
}

/** Routes Codex through the LiteLLM gateway (`[model_providers.mygw]`). */
export function applyLiteLlmGatewayToml(toml: string, options: LiteLlmGatewayTomlOptions = {}): string {
  const model = options.model?.trim() || "lfm-free";
  const reasoningEffort = options.reasoningEffort?.trim() || "low";
  const baseUrl = options.baseUrl?.trim() || DEFAULT_LITELLM_BASE_URL;

  // Older Paperclip builds injected a Vietnamese explanatory comment; drop it.
  const cleaned = toml
    .split(/\r?\n/)
    .filter((line) => !(line.trim().startsWith("#") && line.includes(LEGACY_GUARDIAN_COMMENT)))
    .join(toml.includes("\r\n") ? "\r\n" : "\n");

  const withRoot = setTomlRootKeys(cleaned, {
    model_provider: LITELLM_PROVIDER_ID,
    model,
    model_reasoning_effort: reasoningEffort,
  });
  const withProvider = replaceTomlTable(withRoot, `model_providers.${LITELLM_PROVIDER_ID}`, {
    name: "My gateway",
    base_url: baseUrl,
    env_key: LITELLM_API_KEY_ENV,
    wire_api: "responses",
    env_http_headers: { [LITELLM_TAGS_HEADER]: LITELLM_TAGS_ENV },
  });
  return ensureCodexApprovalsDisabled(withProvider);
}

export type PatchCodexTomlForLiteLlmGatewayOptions = LiteLlmGatewayTomlOptions;

export async function patchCodexTomlForLiteLlmGateway(
  targetHome: string,
  options: PatchCodexTomlForLiteLlmGatewayOptions = {},
): Promise<void> {
  await fs.mkdir(targetHome, { recursive: true });
  const configPath = path.join(targetHome, "config.toml");
  const existing = await fs.readFile(configPath, "utf-8").catch(() => "");
  await fs.writeFile(configPath, applyLiteLlmGatewayToml(existing, options), { mode: 0o600 });
}

/** Rewrites `<home>/config.toml` (if present) so approvals/Guardian are disabled. */
export async function disableCodexApprovalsInHome(targetHome: string): Promise<void> {
  const configPath = path.join(targetHome, "config.toml");
  const existing = await fs.readFile(configPath, "utf-8").catch(() => null);
  if (existing === null) return;
  await fs.writeFile(configPath, ensureCodexApprovalsDisabled(existing), { mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Paperclip MCP server: forward the run identity
// ---------------------------------------------------------------------------

/**
 * Codex starts an MCP server as a child process with a small default
 * environment plus whatever `env` / `env_vars` name. The run-scoped identity
 * Paperclip puts in the agent's environment therefore never reaches the
 * Paperclip MCP server unless it is listed in `env_vars` (names only: the
 * values are read from Codex's own environment at launch, per run).
 */
export const PAPERCLIP_MCP_ENV_VARS = [
  "PAPERCLIP_API_KEY",
  "PAPERCLIP_COMPANY_ID",
  "PAPERCLIP_RUN_ID",
  "PAPERCLIP_TASK_ID",
  "PAPERCLIP_API_URL",
  "PAPERCLIP_WAKE_PAYLOAD_JSON",
] as const;

const PAPERCLIP_MCP_TABLE_PATH = "mcp_servers.paperclip";
const MCP_SERVER_TABLE_RE = /^mcp_servers\.[^.]+$/;
const PAPERCLIP_MCP_COMMAND_RE = /paperclip[_-]mcp/i;

function readStringArrayValue(body: string, key: string): string[] {
  const match = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=\\s*\\[([\\s\\S]*?)\\]`, "m").exec(body);
  if (!match) return [];
  return Array.from(match[1].matchAll(/"([^"\\]*)"|'([^']*)'/g), (m) => m[1] ?? m[2] ?? "");
}

/**
 * Makes sure every Paperclip MCP server table forwards the run identity via
 * `env_vars`. A table counts as the Paperclip MCP server when it is
 * `[mcp_servers.paperclip]` or its command/args mention `paperclip_mcp` /
 * `paperclip-mcp`. Existing entries are kept and missing names appended; other
 * MCP servers are never touched and no table is created. Idempotent.
 */
export function ensurePaperclipMcpEnvVars(
  toml: string,
  names: readonly string[] = PAPERCLIP_MCP_ENV_VARS,
): string {
  const { eol, lines } = splitLines(toml);
  const candidates = new Set<string>();
  for (const line of lines) {
    const tablePath = headerPathOf(line);
    if (tablePath && MCP_SERVER_TABLE_RE.test(tablePath)) candidates.add(tablePath);
  }

  let changed = false;
  for (const tablePath of candidates) {
    const ranges = findTableRanges(lines, tablePath);
    if (ranges.length === 0) continue;
    const [start, end] = ranges[0];
    const body = lines.slice(start + 1, end).join("\n");
    const isPaperclip = tablePath === PAPERCLIP_MCP_TABLE_PATH || PAPERCLIP_MCP_COMMAND_RE.test(body);
    if (!isPaperclip) continue;

    const existing = readStringArrayValue(body, "env_vars");
    const missing = names.filter((name) => !existing.includes(name));
    if (missing.length === 0) continue;
    setKeysInRange(lines, start + 1, end, { env_vars: [...existing, ...missing] });
    changed = true;
  }
  return changed ? joinLines(lines, eol) : toml;
}

/**
 * Applies {@link ensurePaperclipMcpEnvVars} to `<home>/config.toml`. Returns
 * true when the file was rewritten. A missing file is left alone.
 */
export async function ensurePaperclipMcpEnvVarsInHome(targetHome: string): Promise<boolean> {
  const configPath = path.join(targetHome, "config.toml");
  const existing = await fs.readFile(configPath, "utf-8").catch(() => null);
  if (existing === null) return false;
  const next = ensurePaperclipMcpEnvVars(existing);
  if (next === existing) return false;
  await fs.writeFile(configPath, next, { mode: 0o600 });
  return true;
}

// ---------------------------------------------------------------------------
// Agent config resolution
// ---------------------------------------------------------------------------

/**
 * `codex-acp` sends `approvalPolicy` and `approvalsReviewer` with every turn,
 * taken from its session "mode", and that overrides `config.toml`. Its default
 * mode ("agent") uses `approvalsReviewer = "auto_review"`, i.e. the Guardian
 * model, so `features.guardian_approval = false` alone has no effect in the
 * ACP lane. "read-only" is the preset with reviewer "user": same
 * workspace-write sandbox as "agent", approvals go to the ACP client (acpx
 * `approve-all`) instead of the Guardian model.
 */
export const CODEX_ACP_NO_GUARDIAN_MODE = "read-only";

/** Value for `INITIAL_AGENT_MODE` of the codex-acp process, or null to leave it alone. */
export function resolveCodexAcpInitialMode(input: {
  isGateway: boolean;
  existingMode?: string | null;
}): string | null {
  if (!input.isGateway) return null;
  if (input.existingMode && input.existingMode.trim().length > 0) return null;
  return CODEX_ACP_NO_GUARDIAN_MODE;
}

export interface CodexGatewayConfig {
  /** `OPENAI_API_KEY`, falling back to `LITELLM_API_KEY`. */
  apiKey: string | null;
  /** `LITELLM_BASE_URL` / `OPENAI_BASE_URL`, or the default when only a LiteLLM key is set. */
  liteLlmBaseUrl: string | null;
  model: string | null;
  reasoningEffort: string | null;
  /** True when the agent is routed through a gateway. */
  isGateway: boolean;
  /**
   * Whether to force `approval_policy="never"` and turn Guardian approval off.
   * Only on for gateway agents: the Guardian model is not served by the
   * gateway. Every other agent keeps Codex's default approval behaviour.
   */
  disableApprovalGuardian: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function resolveCodexGatewayConfig(config: unknown): CodexGatewayConfig {
  const record = asRecord(config);
  const env = asRecord(record.env);

  const liteLlmKey = nonEmptyString(env[LITELLM_API_KEY_ENV]);
  const apiKey = nonEmptyString(env.OPENAI_API_KEY) ?? liteLlmKey;
  const liteLlmBaseUrl =
    nonEmptyString(env.LITELLM_BASE_URL) ??
    nonEmptyString(env.OPENAI_BASE_URL) ??
    (liteLlmKey ? DEFAULT_LITELLM_BASE_URL : null);
  const isGateway = liteLlmBaseUrl !== null;

  return {
    apiKey,
    liteLlmBaseUrl,
    model: typeof record.model === "string" ? record.model : null,
    reasoningEffort:
      typeof record.modelReasoningEffort === "string"
        ? record.modelReasoningEffort
        : typeof record.effort === "string"
          ? record.effort
          : null,
    isGateway,
    disableApprovalGuardian: isGateway,
  };
}
