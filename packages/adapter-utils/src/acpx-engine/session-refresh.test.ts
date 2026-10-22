import type { AcpSessionRecord, AcpSessionStore } from "acpx/runtime";
import { describe, expect, it } from "vitest";
import { requestFreshClientForResume } from "./session-refresh.js";

function memoryStore(initial?: Record<string, unknown>) {
  const records = new Map<string, AcpSessionRecord>();
  if (initial) records.set("key-1", initial as unknown as AcpSessionRecord);
  const saved: AcpSessionRecord[] = [];
  const store: AcpSessionStore = {
    load: async (id) => records.get(id),
    save: async (record) => {
      saved.push(record);
      records.set("key-1", record);
    },
  };
  return { store, saved, records };
}

describe("requestFreshClientForResume", () => {
  it("flags a stored record so acpx spawns the agent with this run's env", async () => {
    const { store, saved, records } = memoryStore({
      acpxRecordId: "key-1",
      acpSessionId: "thread-1",
      acpx: { session_options: { env: { PAPERCLIP_RUN_ID: "old-run" } } },
    });

    await expect(requestFreshClientForResume(store, "key-1")).resolves.toBe(true);

    expect(saved).toHaveLength(1);
    const record = records.get("key-1") as unknown as Record<string, any>;
    expect(record.acpx.reset_on_next_ensure).toBe(true);
    // Only the flag is added; the agent session id used for resume is untouched.
    expect(record.acpSessionId).toBe("thread-1");
    expect(record.acpx.session_options.env.PAPERCLIP_RUN_ID).toBe("old-run");
  });

  it("does nothing when there is no stored record", async () => {
    const { store, saved } = memoryStore();
    await expect(requestFreshClientForResume(store, "key-1")).resolves.toBe(false);
    expect(saved).toHaveLength(0);
  });

  it("does not rewrite a record that is already flagged", async () => {
    const { store, saved } = memoryStore({ acpxRecordId: "key-1", acpx: { reset_on_next_ensure: true } });
    await expect(requestFreshClientForResume(store, "key-1")).resolves.toBe(false);
    expect(saved).toHaveLength(0);
  });

  it("treats an unreadable store as no record", async () => {
    const store: AcpSessionStore = {
      load: async () => {
        throw new Error("disk error");
      },
      save: async () => {
        throw new Error("should not save");
      },
    };
    await expect(requestFreshClientForResume(store, "key-1")).resolves.toBe(false);
  });
});
