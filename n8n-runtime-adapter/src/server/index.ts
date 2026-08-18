import type { AdapterConfigSchema, ServerAdapterModule } from "../types.js";
import { agentConfigurationDoc, models, type } from "../metadata.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    models,
    agentConfigurationDoc,
    getConfigSchema,
  };
}

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "webhookUrl",
        label: "Webhook URL",
        type: "text",
        required: true,
        hint: "n8n webhook URL that starts the agent workflow.",
      },
      {
        key: "baseUrl",
        label: "n8n Base URL",
        type: "text",
        required: true,
        hint: "Base URL for the n8n REST API, for example your ngrok origin.",
      },
      {
        key: "workflowId",
        label: "Workflow ID",
        type: "text",
        required: true,
        hint: "The n8n workflow id used to find matching executions.",
      },
      {
        key: "n8nApiKey",
        label: "n8n API Key",
        type: "text",
        required: true,
        hint: "API key used to read n8n execution and node data.",
      },
      {
        key: "method",
        label: "Method",
        type: "select",
        default: "POST",
        options: [
          { label: "POST", value: "POST" },
          { label: "GET", value: "GET" },
        ],
      },
      {
        key: "pollIntervalMs",
        label: "Poll interval (ms)",
        type: "number",
        default: 1000,
      },
      {
        key: "executionTimeoutMs",
        label: "Execution timeout (ms)",
        type: "number",
        default: 300000,
      },
      {
        key: "matchTraceId",
        label: "Match traceId",
        type: "toggle",
        default: true,
        hint: "Verify the execution by checking the traceId injected into the webhook input.",
      },
      {
        key: "includeInputSummary",
        label: "Include input summary",
        type: "toggle",
        default: false,
      },
      {
        key: "logDetail",
        label: "Log detail",
        type: "select",
        default: "compact",
        options: [
          { label: "Compact", value: "compact" },
          { label: "Verbose", value: "verbose" },
        ],
      },
    ],
  };
}
