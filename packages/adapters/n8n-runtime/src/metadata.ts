export const type = "n8n_runtime";
export const label = "n8n Runtime";

export const models = [
  { id: "n8n-workflow", label: "n8n Workflow" },
];

export const agentConfigurationDoc = `# n8n_runtime adapter configuration

Adapter: n8n_runtime

Use when:
- Paperclip should execute an agent task by triggering an n8n webhook.
- You need Paperclip Run tab logs from n8n execution/node output.
- The n8n instance exposes the Execution API and saves execution data.

Don't use when:
- A simple one-shot HTTP call is enough and node-level trace is not needed.
- n8n execution data is disabled or inaccessible.

Core fields:
- webhookUrl (string, required): n8n webhook URL to trigger.
- url (string, optional): compatibility alias for webhookUrl.
- baseUrl (string, required): n8n base URL used for /api/v1/executions.
- workflowId (string, required): n8n workflow id used to find executions.
- method (string, optional): webhook method, default POST.
- pollIntervalMs (number, optional): polling interval, default 1000.
- findExecutionTimeoutMs (number, optional): execution lookup timeout, default 30000.
- executionTimeoutMs (number, optional): workflow timeout, default 300000.
- matchTraceId (boolean, optional): match execution by injected traceId, default true.
- logDetail (string, optional): compact or verbose, default compact.
- includeInputSummary (boolean, optional): include node input summaries, default false.
- headers (object, optional): extra headers for webhook call.
- payloadTemplate (object, optional): extra JSON body merged into the webhook payload.

Secrets:
- Prefer N8N_API_KEY in the Paperclip server environment.
- Do not put n8n API keys in prompts or task descriptions.
`;
