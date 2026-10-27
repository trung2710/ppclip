import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ArrowUpRight, Loader2, Lock } from "lucide-react";
import type { AppDefinition, ToolConnection } from "@paperclipai/shared";
import { credentialConfigPath, getAvailableConnectionMethod, humanizeConnectionDisplayName } from "@paperclipai/shared";
import { toolsApi } from "@/api/tools";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { useToast } from "@/context/ToastContext";
import { redactUrlSecrets } from "@/lib/redact-url-secrets";
import {
  RUN_IDENTITY_HEADER_NAMES,
  configWithRunCredential,
  configWithRunIdentityForwarding,
  forwardsRunIdentity,
  isLoopbackAddress,
  partialRunIdentityKeys,
  sendsRunCredential,
} from "../run-identity";
import type { AppDetailSectionProps } from "./types";

export function AdvancedPanel({
  connection,
  appName,
  galleryEntry,
  removing,
  onRemove,
  onReplaced,
  configUpdateDisabled,
  onUpdateConfig,
}: Pick<AppDetailSectionProps, "connection" | "appName" | "galleryEntry"> & {
  removing: boolean;
  onRemove: () => void;
  onReplaced: () => void;
  configUpdateDisabled: boolean;
  onUpdateConfig: (config: Record<string, unknown>) => void;
}) {
  return (
    <div className="space-y-6">
      <KeySection connection={connection} galleryEntry={galleryEntry} onReplaced={onReplaced} />
      {connection.transport === "mcp_remote" && (
        <RunIdentitySection connection={connection} disabled={configUpdateDisabled} onUpdateConfig={onUpdateConfig} />
      )}
      <TechnicalDetails connection={connection} />
      <DangerZone appName={appName} removing={removing} onRemove={onRemove} />
    </div>
  );
}

function KeySection({
  connection,
  galleryEntry,
  onReplaced,
}: {
  connection: ToolConnection;
  galleryEntry: AppDefinition | null;
  onReplaced: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="rounded-xl border border-border bg-card">
      <div className="flex items-center justify-between px-5 py-4">
        <div className="flex items-start gap-3">
          <Lock className="mt-0.5 h-4 w-4 text-muted-foreground" />
          <div>
            <h2 className="text-sm font-bold text-foreground">Key</h2>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Your key is stored securely. Replace it if it stopped working or you rotated it.
            </p>
          </div>
        </div>
        {!open && (
          <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
            Replace key
          </Button>
        )}
      </div>
      {open && (
        <div className="border-t border-border px-5 py-4">
          <ReconnectForm
            connection={connection}
            galleryEntry={galleryEntry}
            onCancel={() => setOpen(false)}
            onReconnected={() => {
              setOpen(false);
              onReplaced();
            }}
          />
        </div>
      )}
    </section>
  );
}

export function ReconnectCard({
  connection,
  galleryEntry,
  onReconnected,
}: {
  connection: ToolConnection;
  galleryEntry: AppDefinition | null;
  onReconnected: () => void;
}) {
  return (
    <div className="rounded-xl border border-amber-500/50 bg-amber-500/10 p-5">
      <h2 className="text-sm font-bold text-amber-900 dark:text-amber-100">This app needs reconnecting</h2>
      <p className="mt-1 text-sm text-amber-800 dark:text-amber-200">
        {connection.healthMessage?.trim() || "The key stopped working. Paste a new one to get it back online."}
      </p>
      <div className="mt-3">
        <ReconnectForm connection={connection} galleryEntry={galleryEntry} onReconnected={onReconnected} />
      </div>
    </div>
  );
}

function ReconnectForm({
  connection,
  galleryEntry,
  onCancel,
  onReconnected,
}: {
  connection: ToolConnection;
  galleryEntry: AppDefinition | null;
  onCancel?: () => void;
  onReconnected: () => void;
}) {
  const { pushToast } = useToast();
  const method = galleryEntry && Array.isArray(galleryEntry.methods)
    ? getAvailableConnectionMethod(galleryEntry)
    : null;
  const fields = (method?.credentialFields ?? []).map((field) => ({
    ...field,
    configPath: credentialConfigPath(field),
    helpUrl: method?.consoleLinks?.keys ?? method?.consoleLinks?.docs ?? "",
  }));
  const [values, setValues] = useState<Record<string, string>>({});
  const [single, setSingle] = useState("");
  const usesGallery = fields.length > 0 && !!galleryEntry;

  const reconnect = useMutation({
    mutationFn: () => {
      const credentialValues = usesGallery
        ? values
        : { "credentials.authorization": single.trim() };
      return toolsApi.reconnectConnection(connection.id, credentialValues);
    },
    onSuccess: (result) => {
      const healthy =
        result.connection.healthStatus === "healthy" || result.connection.healthStatus === "unknown";
      if (healthy) {
        pushToast({
          title: "Reconnected",
          body: `${humanizeConnectionDisplayName(connection)} is back online.`,
          tone: "success",
        });
        onReconnected();
      } else {
        pushToast({
          title: "Still not working",
          body: result.connection.healthMessage?.trim() || "That key didn't check out. Try another.",
          tone: "error",
        });
      }
    },
    onError: (error) =>
      pushToast({
        title: "That key didn't work",
        body: error instanceof Error ? error.message : "Check the key and try again.",
        tone: "error",
      }),
  });

  const filled = usesGallery
    ? fields.every((f) => f.required === false || (values[f.configPath]?.trim().length ?? 0) > 0)
    : single.trim().length > 0;

  return (
    <div className="space-y-3">
      {usesGallery ? (
        fields.map((field) => (
          <div key={field.configPath}>
            <label className="text-xs font-medium text-foreground">{field.label}</label>
            <Input
              type="password"
              autoComplete="off"
              value={values[field.configPath] ?? ""}
              onChange={(e) => setValues({ ...values, [field.configPath]: e.target.value })}
              placeholder="****************"
              className="mt-1 h-10 font-mono"
            />
            {field.helpUrl && (
              <a
                href={field.helpUrl}
                target="_blank"
                rel="noreferrer"
                className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-foreground underline underline-offset-2"
              >
                Where do I find this? <ArrowUpRight className="h-3 w-3" />
              </a>
            )}
          </div>
        ))
      ) : (
        <Input
          type="password"
          autoComplete="off"
          value={single}
          onChange={(e) => setSingle(e.target.value)}
          placeholder="Paste your new key"
          className="h-10 font-mono"
        />
      )}
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={!filled || reconnect.isPending} onClick={() => reconnect.mutate()}>
          {reconnect.isPending && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {reconnect.isPending ? "Checking..." : "Check & reconnect"}
        </Button>
        {onCancel && (
          <Button size="sm" variant="ghost" onClick={onCancel} disabled={reconnect.isPending}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

export function RunIdentitySection({
  connection,
  disabled,
  onUpdateConfig,
}: {
  connection: ToolConnection;
  disabled: boolean;
  onUpdateConfig: (config: Record<string, unknown>) => void;
}) {
  const config = connection.config ?? connection.transportConfig ?? {};
  const enabled = forwardsRunIdentity(config);
  const partial = partialRunIdentityKeys(config);
  const local = isLoopbackAddress(config.url ?? config.endpoint ?? config.remoteUrl);
  const tokenOn = sendsRunCredential(config);
  const storedAuthorization = (connection.credentialRefs ?? []).some(
    (ref) => ref.placement === "header" && ref.key.toLowerCase() === "authorization",
  );
  return (
    <section className="rounded-xl border border-border bg-card px-5 py-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-sm font-bold text-foreground">Send run identity</h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Adds the run, task, company and agent IDs to every call this app receives. No keys are sent.
          </p>
        </div>
        <ToggleSwitch
          aria-label={enabled ? "Stop sending run identity" : "Send run identity"}
          checked={enabled}
          disabled={disabled}
          onCheckedChange={(next) => onUpdateConfig(configWithRunIdentityForwarding(config, next))}
          size="lg"
        />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        {local
          ? "This app runs on this machine. Turn this on when its server needs to know which run is calling."
          : "This app runs outside this machine. Only turn this on for a server you run yourself."}
      </p>
      {partial.length > 0 && (
        <p className="mt-1 text-xs text-muted-foreground">
          Already sending {partial.join(", ")}. Turning this on sends all four.
        </p>
      )}
      <p className="mt-1 font-mono text-xs text-muted-foreground">{RUN_IDENTITY_HEADER_NAMES.join(", ")}</p>

      <div className="mt-4 flex items-center justify-between gap-4 border-t border-border pt-4">
        <div>
          <h3 className="text-sm font-bold text-foreground">Send run token</h3>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Sends the calling run's own API key as Authorization, so the server can call Paperclip as that agent.
            The key works only while the run is active.
          </p>
        </div>
        <ToggleSwitch
          aria-label={tokenOn ? "Stop sending run token" : "Send run token"}
          checked={tokenOn}
          disabled={disabled || (!tokenOn && (!local || storedAuthorization))}
          onCheckedChange={(next) => onUpdateConfig(configWithRunCredential(config, next))}
          size="lg"
        />
      </div>
      {!local && (
        <p className="mt-2 text-xs text-muted-foreground">
          Only available for servers on this machine. This address is outside it.
        </p>
      )}
      {storedAuthorization && (
        <p className="mt-2 text-xs text-muted-foreground">
          This app already sends a stored key as Authorization. Remove that key before using the run token.
        </p>
      )}
    </section>
  );
}

function TechnicalDetails({ connection }: { connection: ToolConnection }) {
  return (
    <section className="rounded-xl border border-border bg-card px-5 py-4">
      <h2 className="text-sm font-bold text-foreground">Technical details</h2>
      <dl className="mt-3 grid gap-2 text-xs sm:grid-cols-(--gtc-59)">
        <dt className="text-muted-foreground">Address</dt>
        <dd className="break-all font-mono text-foreground">{connectionAddress(connection)}</dd>
        <dt className="text-muted-foreground">Connection type</dt>
        <dd className="text-foreground">{connectionTransportLabel(connection.transport)}</dd>
      </dl>
    </section>
  );
}

export function DangerZone({
  appName,
  removing,
  onRemove,
}: {
  appName: string;
  removing: boolean;
  onRemove: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <section className="rounded-xl border border-destructive/40 bg-card">
      <div className="border-b border-destructive/40 px-5 py-3 text-sm font-bold text-destructive">
        Danger zone
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <div>
          <p className="text-sm font-medium text-foreground">Remove this app</p>
          <p className="text-xs text-muted-foreground">
            Agents lose access to {appName} right away. You can connect it again later.
          </p>
        </div>
        {confirming ? (
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={removing}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={onRemove} disabled={removing}>
              {removing && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
              Yes, remove it
            </Button>
          </div>
        ) : (
          <Button variant="destructive" size="sm" onClick={() => setConfirming(true)}>
            Remove app
          </Button>
        )}
      </div>
    </section>
  );
}

export function connectionAddress(connection: ToolConnection): string {
  const config = connection.config ?? connection.transportConfig ?? {};
  const value = config.url ?? config.endpoint ?? config.remoteUrl;
  if (typeof value === "string" && value.trim().length > 0) return redactUrlSecrets(value);
  if (connection.transport === "local_stdio") return "Local command";
  return "Not set";
}

export function connectionTransportLabel(transport: ToolConnection["transport"]): string {
  if (transport === "mcp_remote") return "Remote HTTP";
  if (transport === "local_stdio") return "Local command";
  return "Unknown";
}
