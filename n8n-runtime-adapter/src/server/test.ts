import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "../types.js";
import { asString } from "./parse.js";

declare const process: { env: Record<string, string | undefined> };

export async function testEnvironment(
  ctx: AdapterEnvironmentTestContext,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const webhookUrl = asString(ctx.config.webhookUrl, asString(ctx.config.url));
  const baseUrl = asString(ctx.config.baseUrl, asString(process.env.N8N_BASE_URL)).replace(/\/+$/, "");
  const workflowId = asString(ctx.config.workflowId, asString(process.env.N8N_WORKFLOW_ID));
  const apiKey = asString(ctx.config.n8nApiKey, asString(process.env.N8N_API_KEY));

  if (!webhookUrl) {
    checks.push({
      code: "missing_webhook_url",
      level: "error",
      message: "n8n runtime adapter requires webhookUrl.",
      hint: "Set adapterConfig.webhookUrl to the n8n webhook URL.",
    });
  } else {
    checks.push(validateUrl("webhook_url_valid", "Webhook URL is valid.", webhookUrl));
  }

  if (!baseUrl) {
    checks.push({
      code: "missing_base_url",
      level: "error",
      message: "n8n runtime adapter requires baseUrl.",
      hint: "Set adapterConfig.baseUrl or N8N_BASE_URL.",
    });
  } else {
    checks.push(validateUrl("base_url_valid", "n8n Base URL is valid.", baseUrl));
  }

  if (!workflowId) {
    checks.push({
      code: "missing_workflow_id",
      level: "error",
      message: "n8n runtime adapter requires workflowId.",
      hint: "Set adapterConfig.workflowId or N8N_WORKFLOW_ID.",
    });
  }

  if (!apiKey) {
    checks.push({
      code: "missing_n8n_api_key",
      level: "error",
      message: "n8n Execution API key is missing.",
      hint: "Set N8N_API_KEY in the Paperclip server environment.",
    });
  }

  const hasBlockingConfigError = checks.some((check) => check.level === "error");
  if (!hasBlockingConfigError && baseUrl && workflowId && apiKey) {
    const probe = await probeExecutions(baseUrl, workflowId, apiKey);
    checks.push(probe);
  }

  return {
    adapterType: ctx.adapterType,
    status: checks.some((check) => check.level === "error")
      ? "fail"
      : checks.some((check) => check.level === "warn")
        ? "warn"
        : "pass",
    checks,
    testedAt: new Date().toISOString(),
  };
}

function validateUrl(code: string, message: string, value: string): AdapterEnvironmentCheck {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      return {
        code,
        level: "error",
        message: `${message} Only http/https URLs are supported.`,
      };
    }
    return { code, level: "info", message };
  } catch {
    return {
      code,
      level: "error",
      message: `${message} Invalid URL: ${value}`,
    };
  }
}

async function probeExecutions(
  baseUrl: string,
  workflowId: string,
  apiKey: string,
): Promise<AdapterEnvironmentCheck> {
  const url = new URL(`${baseUrl}/api/v1/executions`);
  url.searchParams.set("workflowId", workflowId);
  url.searchParams.set("limit", "1");
  url.searchParams.set("includeData", "false");

  try {
    const response = await fetch(url, {
      headers: {
        "X-N8N-API-KEY": apiKey,
        Accept: "application/json",
      },
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      return {
        code: "n8n_api_unreachable",
        level: "error",
        message: `n8n Execution API returned HTTP ${response.status}.`,
        detail: text.slice(0, 500),
      };
    }

    return {
      code: "n8n_api_reachable",
      level: "info",
      message: "n8n Execution API is reachable.",
    };
  } catch (error) {
    return {
      code: "n8n_api_probe_failed",
      level: "error",
      message: "Could not reach n8n Execution API.",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
