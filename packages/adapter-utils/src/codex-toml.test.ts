import { describe, expect, it } from "vitest";
import {
  applyLiteLlmGatewayToml,
  buildPaperclipLiteLlmTags,
  ensureCodexApprovalsDisabled,
  ensurePaperclipMcpEnvVars,
  PAPERCLIP_MCP_ENV_VARS,
  replaceTomlTable,
  resolveCodexAcpInitialMode,
  resolveCodexGatewayConfig,
  setTomlRootKeys,
  setTomlTableKeys,
} from "./codex-toml.js";

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe("setTomlRootKeys", () => {
  it("inserts missing keys before the first table header", () => {
    const out = setTomlRootKeys('[profiles.x]\nmodel = "inner"\n', { model: "outer" });
    expect(out.indexOf('model = "outer"')).toBeLessThan(out.indexOf("[profiles.x]"));
    expect(out).toContain('model = "inner"');
  });

  it("does not touch a same-named key inside a table", () => {
    const out = setTomlRootKeys('model = "a"\n[profiles.x]\nmodel = "inner"\n', { model: "b" });
    expect(out).toBe('model = "b"\n[profiles.x]\nmodel = "inner"\n');
  });

  it("replaces a multi-line array value as a whole", () => {
    const out = setTomlRootKeys('model = [\n  "a",\n  "b",\n]\nother = 1\n', { model: "x" });
    expect(out).toBe('model = "x"\nother = 1\n');
  });

  it("preserves CRLF line endings", () => {
    const out = setTomlRootKeys('model = "a"\r\n[t]\r\nk = 1\r\n', { model: "b" });
    expect(out).toBe('model = "b"\r\n[t]\r\nk = 1\r\n');
  });
});

describe("setTomlTableKeys", () => {
  it("creates the table when missing", () => {
    const out = setTomlTableKeys('model = "a"\n', "features", { guardian: false });
    expect(out).toBe('model = "a"\n\n[features]\nguardian = false\n');
  });

  it("never rewrites a `guardian` key that lives in another table", () => {
    const input = '[other]\nguardian = true\n\n[features]\nfast_mode = true\n';
    const out = setTomlTableKeys(input, "features", { guardian: false });
    expect(out).toContain("[other]\nguardian = true");
    expect(out).toContain("[features]\nfast_mode = true\nguardian = false");
    expect(count(out, "[features]")).toBe(1);
  });

  it("emits a single [features] header when adding several keys", () => {
    const out = setTomlTableKeys("[features]\nfast_mode = true\n", "features", {
      guardian_approval: false,
      guardian: false,
    });
    expect(count(out, "[features]")).toBe(1);
    expect(out).toContain("guardian_approval = false");
    expect(out).toContain("guardian = false");
  });

  it("removes root dotted-key forms that would redefine the table", () => {
    const out = setTomlTableKeys("features.guardian = true\nmodel = \"a\"\n", "features", {
      guardian: false,
    });
    expect(out).not.toContain("features.guardian");
    expect(out).toContain("[features]\nguardian = false");
  });

  it("keeps comments that introduce the next table", () => {
    const input = "[features]\na = 1\n\n# about next\n[next]\nb = 2\n";
    const out = setTomlTableKeys(input, "features", { c: 3 });
    expect(out).toBe("[features]\na = 1\nc = 3\n\n# about next\n[next]\nb = 2\n");
  });
});

describe("replaceTomlTable", () => {
  it("collapses duplicate tables into one", () => {
    const input = '[p.x]\na = 1\n\n[keep]\nk = 1\n\n[p.x]\na = 2\n';
    const out = replaceTomlTable(input, "p.x", { a: 3 });
    expect(count(out, "[p.x]")).toBe(1);
    expect(out).toContain("[keep]\nk = 1");
    expect(out).toContain("[p.x]\na = 3");
  });
});

describe("ensureCodexApprovalsDisabled", () => {
  it("is idempotent", () => {
    const once = ensureCodexApprovalsDisabled('model = "a"\n[features]\nfast_mode = true\n');
    expect(ensureCodexApprovalsDisabled(once)).toBe(once);
    expect(once).toContain('approval_policy = "never"');
    expect(once).toContain('approvals_reviewer = "user"');
    expect(once).toContain("guardian_approval = false");
  });
});

describe("applyLiteLlmGatewayToml", () => {
  it("puts root keys before the provider table and keeps one provider block", () => {
    const input =
      'model_provider = "old"\nmodel = "old"\n\n[model_providers.mygw]\nbase_url = "http://old"\n\n' +
      "# BEGIN PAPERCLIP MANAGED MCP\n[mcp_servers.paperclip]\nurl = \"x\"\n# END PAPERCLIP MANAGED MCP\n";
    const out = applyLiteLlmGatewayToml(input, {
      baseUrl: "http://gw/v1",
      model: "m",
      reasoningEffort: "high",
    });
    expect(out.indexOf('model_provider = "mygw"')).toBeLessThan(out.indexOf("[model_providers.mygw]"));
    expect(count(out, "[model_providers.mygw]")).toBe(1);
    expect(out).toContain('base_url = "http://gw/v1"');
    expect(out).toContain('model = "m"');
    expect(out).toContain('model_reasoning_effort = "high"');
    expect(out).toContain("# BEGIN PAPERCLIP MANAGED MCP");
    expect(out).toContain("[mcp_servers.paperclip]");
    expect(out).toContain("guardian_approval = false");
  });

  it("drops the legacy Vietnamese comment injected by older builds", () => {
    const out = applyLiteLlmGatewayToml(
      '# Chuyển chính sách duyệt sang "never" và reviewer sang "user"\nmodel = "a"\n',
      {},
    );
    expect(out).not.toContain("Chuyển");
  });
});

describe("resolveCodexAcpInitialMode", () => {
  it("selects the user-reviewer mode only for gateway agents", () => {
    expect(resolveCodexAcpInitialMode({ isGateway: true })).toBe("read-only");
    expect(resolveCodexAcpInitialMode({ isGateway: false })).toBeNull();
  });

  it("never overrides a mode the operator already set", () => {
    expect(resolveCodexAcpInitialMode({ isGateway: true, existingMode: "agent-full-access" })).toBeNull();
  });
});

describe("resolveCodexGatewayConfig", () => {
  it("is not a gateway without LiteLLM/base-url env", () => {
    const resolved = resolveCodexGatewayConfig({ env: { OPENAI_API_KEY: "sk-1" }, model: "gpt" });
    expect(resolved.isGateway).toBe(false);
    expect(resolved.apiKey).toBe("sk-1");
    expect(resolved.disableApprovalGuardian).toBe(false);
  });

  it("defaults the base URL when only a LiteLLM key is set", () => {
    const resolved = resolveCodexGatewayConfig({ env: { LITELLM_API_KEY: "sk-l" } });
    expect(resolved.isGateway).toBe(true);
    expect(resolved.liteLlmBaseUrl).toBe("http://localhost:4000/v1");
    expect(resolved.disableApprovalGuardian).toBe(true);
  });

  it("ignores a stray disableApprovalGuardian key: only a gateway disables Guardian", () => {
    const resolved = resolveCodexGatewayConfig({ disableApprovalGuardian: true });
    expect(resolved.isGateway).toBe(false);
    expect(resolved.disableApprovalGuardian).toBe(false);
  });
});

describe("per-run LiteLLM tags", () => {
  it("writes env_http_headers into the gateway provider as an inline table", () => {
    const out = applyLiteLlmGatewayToml("", { baseUrl: "http://gw/v1" });
    expect(out).toContain('env_http_headers = { "x-litellm-tags" = "PAPERCLIP_LITELLM_TAGS" }');
    expect(count(out, "env_http_headers")).toBe(1);
    // re-applying keeps a single provider block with a single header mapping
    expect(count(applyLiteLlmGatewayToml(out, {}), "env_http_headers")).toBe(1);
  });

  it("builds comma-separated run/agent/company tags", () => {
    expect(buildPaperclipLiteLlmTags({ runId: "r1", agentId: "a1", companyId: "c1" })).toBe(
      "paperclip_run:r1,paperclip_agent:a1,paperclip_company:c1",
    );
    expect(buildPaperclipLiteLlmTags({ runId: "r,1" })).toBe("paperclip_run:r_1");
  });
});

describe("ensurePaperclipMcpEnvVars", () => {
  const ALL = PAPERCLIP_MCP_ENV_VARS.map((name) => `"${name}"`).join(", ");
  const BLOCK = [
    "[mcp_servers.paperclip]",
    'command = "python"',
    'args = ["C:/paperclip/paperclip-mcp/src/paperclip_mcp/server.py", "--transport", "stdio"]',
    'env = { PAPERCLIP_BASE_URL = "http://localhost:3100/api" }',
  ].join("\n");

  it("adds env_vars to [mcp_servers.paperclip] right after its other keys", () => {
    const out = ensurePaperclipMcpEnvVars(`model = "m"\n\n${BLOCK}\n\n[features]\nguardian_approval = false\n`);
    expect(out).toContain(`env_vars = [${ALL}]`);
    expect(out.indexOf("env_vars")).toBeLessThan(out.indexOf("[features]"));
    expect(out.indexOf("env_vars")).toBeGreaterThan(out.indexOf("[mcp_servers.paperclip]"));
    expect(out).toContain('env = { PAPERCLIP_BASE_URL = "http://localhost:3100/api" }');
  });

  it("is idempotent and does not rewrite a file that already forwards everything", () => {
    const once = ensurePaperclipMcpEnvVars(`${BLOCK}\n`);
    expect(ensurePaperclipMcpEnvVars(once)).toBe(once);
    expect(count(once, "env_vars")).toBe(1);
  });

  it("keeps the names already listed and appends only the missing ones", () => {
    const out = ensurePaperclipMcpEnvVars(`${BLOCK}\nenv_vars = ["MY_OWN_VAR", "PAPERCLIP_API_KEY"]\n`);
    expect(count(out, "env_vars")).toBe(1);
    expect(out).toContain('"MY_OWN_VAR", "PAPERCLIP_API_KEY", "PAPERCLIP_COMPANY_ID"');
    expect(count(out, '"PAPERCLIP_API_KEY"')).toBe(1);
  });

  it("merges into a multi-line env_vars array", () => {
    const out = ensurePaperclipMcpEnvVars(
      `${BLOCK}\nenv_vars = [\n  "PAPERCLIP_API_KEY",\n  "PAPERCLIP_RUN_ID",\n]\n\n[features]\nx = 1\n`,
    );
    expect(count(out, "env_vars")).toBe(1);
    expect(out).toContain('"PAPERCLIP_TASK_ID"');
    expect(out).toContain("[features]\nx = 1");
  });

  it("recognises a renamed Paperclip MCP server by its command", () => {
    const out = ensurePaperclipMcpEnvVars(
      '[mcp_servers.pc]\ncommand = "python"\nargs = ["C:/x/paperclip_mcp/server.py"]\n',
    );
    expect(out).toContain("env_vars = [");
  });

  it("leaves other MCP servers alone and never creates a table", () => {
    const other = '[mcp_servers.github]\ncommand = "npx"\nargs = ["gh-mcp"]\n';
    expect(ensurePaperclipMcpEnvVars(other)).toBe(other);
    expect(ensurePaperclipMcpEnvVars("")).toBe("");
    expect(ensurePaperclipMcpEnvVars('model = "m"\n')).toBe('model = "m"\n');
  });

  it("writes before the env sub-table and keeps CRLF line endings", () => {
    const input = `${BLOCK}\n[mcp_servers.paperclip.env]\nPAPERCLIP_BASE_URL = "x"\n`.replace(/\n/g, "\r\n");
    const out = ensurePaperclipMcpEnvVars(input);
    expect(out.indexOf("env_vars")).toBeLessThan(out.indexOf("[mcp_servers.paperclip.env]"));
    expect(out).toContain("\r\n");
    expect(out.replace(/\r\n/g, "")).not.toContain("\n");
  });
});
