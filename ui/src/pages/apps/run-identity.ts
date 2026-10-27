// Run-identity forwarding for remote MCP connections. The gateway reads
// `config.headerPolicy.metadata.forward` (also `metadata.headers` and
// `forwardContextHeaders`) and adds x-paperclip-<key> headers built from the
// gateway session to every upstream call. Off unless the board turns it on.

export const RUN_IDENTITY_KEYS = ["run_id", "issue_id", "company_id", "agent_id"] as const;

export const RUN_IDENTITY_HEADER_NAMES = RUN_IDENTITY_KEYS.map((key) => `x-paperclip-${key.replace(/_/g, "-")}`);

const RUN_IDENTITY_KEY_SET = new Set<string>(RUN_IDENTITY_KEYS);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

/** Every metadata key the gateway will forward for this config, from all three places it reads. */
export function forwardedMetadataKeys(config: Record<string, unknown> | null | undefined): string[] {
  const headerPolicy = asRecord(config?.headerPolicy);
  const metadata = asRecord(headerPolicy?.metadata);
  return Array.from(new Set([
    ...stringList(metadata?.forward),
    ...stringList(metadata?.headers),
    ...stringList(headerPolicy?.forwardContextHeaders),
  ]));
}

export function forwardsRunIdentity(config: Record<string, unknown> | null | undefined): boolean {
  const forwarded = new Set(forwardedMetadataKeys(config));
  return RUN_IDENTITY_KEYS.every((key) => forwarded.has(key));
}

/** Run-identity keys forwarded when only some of them are on, so the UI can say so. */
export function partialRunIdentityKeys(config: Record<string, unknown> | null | undefined): string[] {
  if (forwardsRunIdentity(config)) return [];
  return forwardedMetadataKeys(config).filter((key) => RUN_IDENTITY_KEY_SET.has(key));
}

/**
 * Returns the full config to PATCH. The connection API replaces `config` as a whole,
 * so every other key (url, quarantineNewEntries, other header policy fields) is kept.
 */
export function configWithRunIdentityForwarding(
  currentConfig: Record<string, unknown> | null | undefined,
  enabled: boolean,
): Record<string, unknown> {
  const config = { ...(currentConfig ?? {}) };
  const headerPolicy = { ...(asRecord(config.headerPolicy) ?? {}) };
  const metadata = { ...(asRecord(headerPolicy.metadata) ?? {}) };
  const withoutIdentity = (value: unknown) => stringList(value).filter((key) => !RUN_IDENTITY_KEY_SET.has(key));

  const forward = enabled
    ? Array.from(new Set([...stringList(metadata.forward), ...RUN_IDENTITY_KEYS]))
    : withoutIdentity(metadata.forward);
  if (forward.length > 0) metadata.forward = forward;
  else delete metadata.forward;

  if (!enabled) {
    if ("headers" in metadata) {
      const remaining = withoutIdentity(metadata.headers);
      if (remaining.length > 0) metadata.headers = remaining;
      else delete metadata.headers;
    }
    if ("forwardContextHeaders" in headerPolicy) {
      const remaining = withoutIdentity(headerPolicy.forwardContextHeaders);
      if (remaining.length > 0) headerPolicy.forwardContextHeaders = remaining;
      else delete headerPolicy.forwardContextHeaders;
    }
  }

  if (Object.keys(metadata).length > 0) headerPolicy.metadata = metadata;
  else delete headerPolicy.metadata;
  if (Object.keys(headerPolicy).length > 0) config.headerPolicy = headerPolicy;
  else delete config.headerPolicy;
  return config;
}

/** Whether the gateway sends the calling run's own agent JWT (`headerPolicy.runCredential`). */
export function sendsRunCredential(config: Record<string, unknown> | null | undefined): boolean {
  return asRecord(config?.headerPolicy)?.runCredential === true;
}

/** Returns the full config to PATCH with `headerPolicy.runCredential` set or removed. */
export function configWithRunCredential(
  currentConfig: Record<string, unknown> | null | undefined,
  enabled: boolean,
): Record<string, unknown> {
  const config = { ...(currentConfig ?? {}) };
  const headerPolicy = { ...(asRecord(config.headerPolicy) ?? {}) };
  if (enabled) headerPolicy.runCredential = true;
  else delete headerPolicy.runCredential;
  if (Object.keys(headerPolicy).length > 0) config.headerPolicy = headerPolicy;
  else delete config.headerPolicy;
  return config;
}

/** True for addresses on this machine, where sending run identity is the expected setup. */
export function isLoopbackAddress(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    const hostname = new URL(url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost"
      || hostname.endsWith(".localhost")
      || hostname === "::1"
      || /^127(\.\d{1,3}){3}$/.test(hostname);
  } catch {
    return false;
  }
}
