import type { AcpSessionStore } from "acpx/runtime";

/**
 * Makes the next `ensureSession` for `sessionKey` start a new agent client
 * with the caller's env instead of reusing the stored session record.
 *
 * acpx persists the `sessionOptions.env` of the run that created a persistent
 * session in its on-disk record, and on later `ensureSession` calls returns that
 * record unchanged, so every turn spawns the agent with the first run's env.
 * Paperclip's env is run-scoped (`PAPERCLIP_API_KEY` is a JWT bound to the run
 * id, plus `PAPERCLIP_RUN_ID`), so a resumed session called the API as the old
 * run and got "Issue run ownership conflict" / `agent_jwt_run_id_mismatch`.
 *
 * Setting acpx's own `reset_on_next_ensure` flag makes it skip the stored record,
 * spawn the agent with this run's env and reattach the same agent session via
 * `session/resume` or `session/load`, so the conversation is kept.
 *
 * Returns whether a stored record was flagged.
 */
export async function requestFreshClientForResume(
  store: AcpSessionStore,
  sessionKey: string,
): Promise<boolean> {
  const record = await store.load(sessionKey).catch(() => undefined);
  if (!record || record.acpx?.reset_on_next_ensure === true) return false;
  record.acpx = { ...record.acpx, reset_on_next_ensure: true };
  await store.save(record);
  return true;
}
