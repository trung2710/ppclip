# paperclip-n8n-runtime-adapter

External Paperclip adapter for running an agent through n8n.

Adapter type:

```txt
n8n_runtime
```

## What it does

This adapter replaces the plain HTTP adapter for n8n-backed agents.

Flow:

```txt
Paperclip run
-> n8n_runtime adapter
-> n8n webhook
-> n8n Execution API polling
-> Paperclip Run tab logs/events
```

The first implementation uses polling. It does not require custom n8n Docker images or n8n lifecycle hooks.

## Build

```powershell
cd C:\paperclip\n8n-runtime-adapter
pnpm build
pnpm typecheck
```

## Install into local Paperclip

Start Paperclip first:

```powershell
cd C:\paperclip
$env:N8N_API_KEY="your-n8n-api-key"
pnpm dev
```

Then install the adapter:

```powershell
cd C:\paperclip
pnpm paperclipai adapter install --payload-json '{"packageName":"C:\paperclip\n8n-runtime-adapter","isLocalPath":true}'
```

Check install status:

```powershell
pnpm paperclipai adapter list
pnpm paperclipai adapter get n8n_runtime
```

After editing adapter code:

```powershell
cd C:\paperclip\n8n-runtime-adapter
pnpm build
cd C:\paperclip
pnpm paperclipai adapter reload n8n_runtime
```

## Agent config

Update the agent from:

```json
{
  "adapterType": "http"
}
```

to:

```json
{
  "adapterType": "n8n_runtime",
  "adapterConfig": {
    "webhookUrl": "https://inexpert-aleida-rostrally.ngrok-free.dev/webhook/<webhook-b>",
    "workflowId": "<workflow-b-id>",
    "baseUrl": "https://inexpert-aleida-rostrally.ngrok-free.dev",
    "method": "POST",
    "pollIntervalMs": 1000,
    "executionTimeoutMs": 300000,
    "matchTraceId": true,
    "logDetail": "compact"
  }
}
```

Compatibility alias:

```json
{
  "url": "https://inexpert-aleida-rostrally.ngrok-free.dev/webhook/<webhook-b>"
}
```

The adapter treats `url` as `webhookUrl` for easier migration from the built-in HTTP adapter.

## Required n8n setup

n8n must expose the Execution API and save execution data.

Recommended environment variables for n8n Docker:

```txt
N8N_API_KEY=<your-key>
EXECUTIONS_DATA_SAVE_ON_SUCCESS=all
EXECUTIONS_DATA_SAVE_ON_ERROR=all
EXECUTIONS_DATA_SAVE_MANUAL_EXECUTIONS=true
EXECUTIONS_DATA_SAVE_ON_PROGRESS=true
```

## Paperclip server secret

Prefer setting the n8n API key on the Paperclip server process:

```powershell
$env:N8N_API_KEY="your-n8n-api-key"
```

Avoid storing n8n API keys directly in `adapterConfig`.
