/**
 * Env keys the server sets to a per-run scratch directory
 * (`run-scratch.ts` → `buildHeartbeatRunScratchEnv`). The directory is created
 * with `mkdtemp`, so its path is unique to every run.
 */
const RUN_SCRATCH_ENV_KEYS: ReadonlySet<string> = new Set([
  "PAPERCLIP_RUN_SCRATCH_DIR",
  "PAPERCLIP_TASK_SCRATCH_DIR",
  "PAPERCLIP_SCRATCH_DIR",
  "PAPERCLIP_TMPDIR",
]);

/**
 * Returns the part of the resolved adapter env that identifies a session's
 * configuration, i.e. without values that are unique to a single run.
 *
 * The server writes the run scratch directory into the adapter env (under the
 * keys above, and into TMPDIR/TEMP/TMP when the user did not set them). Hashing
 * those made `adapterEnvHash` differ on every run, so a resumable ACPX session
 * was never compatible with the next run. A user-configured TMPDIR/TEMP/TMP
 * keeps a stable value and stays in the hash.
 */
export function stripRunScopedEnvForFingerprint(
  env: Record<string, string>,
): Record<string, string> {
  const scratchDir = env.PAPERCLIP_RUN_SCRATCH_DIR ?? env.PAPERCLIP_SCRATCH_DIR ?? null;
  return Object.fromEntries(
    Object.entries(env).filter(([key, value]) => {
      if (RUN_SCRATCH_ENV_KEYS.has(key)) return false;
      return !(scratchDir && value === scratchDir);
    }),
  );
}
