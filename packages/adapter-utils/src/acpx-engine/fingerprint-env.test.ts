import { describe, expect, it } from "vitest";
import { stripRunScopedEnvForFingerprint } from "./fingerprint-env.js";

const scratchEnv = (dir: string) => ({
  PAPERCLIP_RUN_SCRATCH_DIR: dir,
  PAPERCLIP_TASK_SCRATCH_DIR: dir,
  PAPERCLIP_SCRATCH_DIR: dir,
  PAPERCLIP_TMPDIR: dir,
  TMPDIR: dir,
  TEMP: dir,
  TMP: dir,
});

describe("stripRunScopedEnvForFingerprint", () => {
  it("yields the same env for two runs that only differ by scratch directory", () => {
    const configured = { OPENAI_API_KEY: "key", PLAIN_FLAG: "on" };
    const first = stripRunScopedEnvForFingerprint({ ...configured, ...scratchEnv("C:\\tmp\\paperclip-run-KHT-1-aaaa-X1") });
    const second = stripRunScopedEnvForFingerprint({ ...configured, ...scratchEnv("C:\\tmp\\paperclip-run-KHT-1-bbbb-Y2") });

    expect(first).toEqual(configured);
    expect(second).toEqual(first);
  });

  it("still sees a real change to configured env", () => {
    const dir = "C:\\tmp\\paperclip-run-KHT-1-aaaa-X1";
    const before = stripRunScopedEnvForFingerprint({ PLAIN_FLAG: "on", ...scratchEnv(dir) });
    const after = stripRunScopedEnvForFingerprint({ PLAIN_FLAG: "off", ...scratchEnv(dir) });

    expect(after).not.toEqual(before);
  });

  it("keeps a user-configured TMPDIR, which is stable across runs", () => {
    const dir = "C:\\tmp\\paperclip-run-KHT-1-aaaa-X1";
    // The server only fills TMPDIR/TEMP/TMP when the user left them empty, so a
    // configured TMPDIR keeps its own value while TEMP/TMP point at the scratch dir.
    const { TMPDIR: _scratchTmpdir, ...scratchWithoutTmpdir } = scratchEnv(dir);
    const result = stripRunScopedEnvForFingerprint({
      TMPDIR: "D:\\fast-tmp",
      ...scratchWithoutTmpdir,
    });

    expect(result).toEqual({ TMPDIR: "D:\\fast-tmp" });
  });

  it("is a no-op when the server did not create a scratch dir", () => {
    const env = { PLAIN_FLAG: "on", TMPDIR: "D:\\fast-tmp" };
    expect(stripRunScopedEnvForFingerprint(env)).toEqual(env);
  });
});
