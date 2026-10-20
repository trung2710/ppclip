import { describe, expect, it } from "vitest";
import {
  collectLiteLlmRunUsage,
  measureLiteLlmRunCostUsd,
  readLiteLlmKeyInfo,
  readLiteLlmKeySpend,
  summarizeTaggedSpendLogs,
} from "./litellm-spend.js";

function fakeFetch(spends: Array<number | "error">) {
  const calls: string[] = [];
  let i = 0;
  const fetchImpl = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push(`${url}|${init?.headers?.Authorization ?? ""}`);
    const value = spends[Math.min(i, spends.length - 1)];
    i += 1;
    if (value === "error") return { ok: false, json: async () => ({}) };
    return { ok: true, json: async () => ({ info: { spend: value } }) };
  };
  return { fetchImpl, calls };
}

const noSleep = async () => {};

describe("readLiteLlmKeySpend", () => {
  it("calls /key/info on the gateway root with the key as bearer", async () => {
    const { fetchImpl, calls } = fakeFetch([1.5]);
    const spend = await readLiteLlmKeySpend({
      baseUrl: "http://localhost:4000/v1/",
      apiKey: "sk-key",
      fetchImpl,
    });
    expect(spend).toBe(1.5);
    expect(calls).toEqual(["http://localhost:4000/key/info|Bearer sk-key"]);
  });

  it("returns null on HTTP errors, thrown errors and missing key", async () => {
    expect(
      await readLiteLlmKeySpend({ baseUrl: "http://x/v1", apiKey: "k", fetchImpl: fakeFetch(["error"]).fetchImpl }),
    ).toBeNull();
    expect(
      await readLiteLlmKeySpend({
        baseUrl: "http://x/v1",
        apiKey: "k",
        fetchImpl: async () => {
          throw new Error("down");
        },
      }),
    ).toBeNull();
    expect(await readLiteLlmKeySpend({ baseUrl: "http://x/v1", apiKey: " " })).toBeNull();
  });
});

describe("measureLiteLlmRunCostUsd", () => {
  it("returns the delta once the spend stops moving", async () => {
    // lagging writes: 0.10 -> 0.12 -> 0.15 -> 0.15 -> 0.15
    const { fetchImpl } = fakeFetch([0.12, 0.15, 0.15, 0.15]);
    const cost = await measureLiteLlmRunCostUsd({
      client: { baseUrl: "http://x/v1", apiKey: "k", fetchImpl },
      before: 0.1,
      sleep: noSleep,
    });
    expect(cost).toBe(0.05);
  });

  it("returns 0 when nothing was spent", async () => {
    const { fetchImpl } = fakeFetch([2]);
    const cost = await measureLiteLlmRunCostUsd({
      client: { baseUrl: "http://x/v1", apiKey: "k", fetchImpl },
      before: 2,
      sleep: noSleep,
    });
    expect(cost).toBe(0);
  });

  it("is null when the baseline or the final read is unavailable", async () => {
    const ok = fakeFetch([1]).fetchImpl;
    expect(
      await measureLiteLlmRunCostUsd({
        client: { baseUrl: "http://x/v1", apiKey: "k", fetchImpl: ok },
        before: null,
        sleep: noSleep,
      }),
    ).toBeNull();
    expect(
      await measureLiteLlmRunCostUsd({
        client: { baseUrl: "http://x/v1", apiKey: "k", fetchImpl: fakeFetch(["error"]).fetchImpl },
        before: 1,
        sleep: noSleep,
      }),
    ).toBeNull();
  });

  it("is null when spend went backwards (key rotated/reset)", async () => {
    const { fetchImpl } = fakeFetch([0.5]);
    expect(
      await measureLiteLlmRunCostUsd({
        client: { baseUrl: "http://x/v1", apiKey: "k", fetchImpl },
        before: 3,
        sleep: noSleep,
      }),
    ).toBeNull();
  });

  it("stops polling at the settle deadline", async () => {
    let clock = 0;
    const { fetchImpl, calls } = fakeFetch([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const cost = await measureLiteLlmRunCostUsd({
      client: { baseUrl: "http://x/v1", apiKey: "k", fetchImpl },
      before: 0,
      settleMs: 3000,
      pollIntervalMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(calls.length).toBeLessThanOrEqual(5);
    expect(cost).not.toBeNull();
  });
});

function logRow(tags: string[], fields: Record<string, unknown> = {}) {
  return { request_tags: tags, ...fields };
}

const RUN = "paperclip_run:r1";
// Shapes taken from a real LiteLLM 1.102 /spend/logs response.
const rows = [
  logRow([RUN, "User-Agent: acpx"], {
    spend: 0.01,
    prompt_tokens: 29156,
    completion_tokens: 145,
    metadata: { usage_object: { prompt_tokens_details: { cached_tokens: 27248 } } },
  }),
  logRow([RUN], {
    spend: 0.02,
    prompt_tokens: 33708,
    completion_tokens: 186,
    metadata: { additional_usage_values: { cache_read_input_tokens: 31440 } },
  }),
  logRow([RUN], { spend: 0, prompt_tokens: 0, completion_tokens: 0, status: "failure" }),
  logRow(["paperclip_run:other"], { spend: 5, prompt_tokens: 999, completion_tokens: 999 }),
];

describe("summarizeTaggedSpendLogs", () => {
  it("sums only the run's requests and splits cache reads out of input", () => {
    expect(summarizeTaggedSpendLogs(rows, RUN)).toEqual({
      requestCount: 3,
      failedRequestCount: 1,
      inputTokens: (29156 - 27248) + (33708 - 31440),
      cachedInputTokens: 27248 + 31440,
      outputTokens: 145 + 186,
      costUsd: 0.03,
    });
  });

  it("matches the tag exactly, not by prefix", () => {
    expect(summarizeTaggedSpendLogs([logRow(["paperclip_run:r10"], { spend: 1 })], RUN).requestCount).toBe(0);
  });

  it("tolerates non-array input", () => {
    expect(summarizeTaggedSpendLogs(null, RUN).requestCount).toBe(0);
  });
});

describe("readLiteLlmKeyInfo", () => {
  it("returns the spend and the key hash", async () => {
    const info = await readLiteLlmKeyInfo({
      baseUrl: "http://x/v1",
      apiKey: "k",
      fetchImpl: async () => ({ ok: true, json: async () => ({ key: "hash123", info: { spend: 0.5 } }) }),
    });
    expect(info).toEqual({ spend: 0.5, keyHash: "hash123" });
  });
});

describe("collectLiteLlmRunUsage", () => {
  function sequencedFetch(responses: unknown[]) {
    const urls: string[] = [];
    let i = 0;
    const fetchImpl = async (url: string) => {
      urls.push(url);
      const body = responses[Math.min(i, responses.length - 1)];
      i += 1;
      if (body === "error") return { ok: false, json: async () => ({}) };
      return { ok: true, json: async () => body };
    };
    return { fetchImpl, urls };
  }

  it("queries the key's logs for the run day(s) and waits for late rows", async () => {
    const { fetchImpl, urls } = sequencedFetch([[], [rows[0]], rows, rows, rows]);
    const usage = await collectLiteLlmRunUsage({
      client: { baseUrl: "http://gw:4000/v1", apiKey: "k", fetchImpl },
      keyHash: "hash123",
      runTag: RUN,
      startedAtMs: Date.parse("2026-10-13T23:59:00Z"),
      endedAtMs: Date.parse("2026-10-14T00:01:00Z"),
      sleep: async () => {},
    });
    expect(usage?.requestCount).toBe(3);
    expect(usage?.costUsd).toBe(0.03);
    expect(urls[0]).toBe(
      "http://gw:4000/spend/logs?api_key=hash123&start_date=2026-10-13&end_date=2026-10-15&summarize=false",
    );
  });

  it("returns null when the logs cannot be read", async () => {
    const usage = await collectLiteLlmRunUsage({
      client: { baseUrl: "http://gw/v1", apiKey: "k", fetchImpl: sequencedFetch(["error"]).fetchImpl },
      keyHash: "h",
      runTag: RUN,
      startedAtMs: 0,
      endedAtMs: 0,
      sleep: async () => {},
    });
    expect(usage).toBeNull();
  });

  it("gives up at the deadline with zero matches", async () => {
    let clock = 0;
    const usage = await collectLiteLlmRunUsage({
      client: { baseUrl: "http://gw/v1", apiKey: "k", fetchImpl: sequencedFetch([[]]).fetchImpl },
      keyHash: "h",
      runTag: RUN,
      startedAtMs: 0,
      endedAtMs: 0,
      settleMs: 3000,
      pollIntervalMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(usage?.requestCount).toBe(0);
  });

  it("does not settle on failed rows alone: waits for the batched successful rows", async () => {
    // LiteLLM writes failed calls immediately and batches successful ones, so a
    // run's failures can sit alone in the logs for a few polls.
    const failed = logRow([RUN], { spend: 0, prompt_tokens: 0, completion_tokens: 0, status: "failure" });
    const ok = logRow([RUN], { spend: 0.02, prompt_tokens: 1000, completion_tokens: 50 });
    const { fetchImpl } = sequencedFetch([[failed], [failed], [failed], [failed], [failed, ok], [failed, ok], [failed, ok]]);
    const usage = await collectLiteLlmRunUsage({
      client: { baseUrl: "http://gw/v1", apiKey: "k", fetchImpl },
      keyHash: "h",
      runTag: RUN,
      startedAtMs: 0,
      endedAtMs: 0,
      sleep: async () => {},
    });
    expect(usage).toMatchObject({ requestCount: 2, failedRequestCount: 1, inputTokens: 1000, outputTokens: 50, costUsd: 0.02 });
  });

  it("keeps waiting until the deadline when every matched row failed", async () => {
    let clock = 0;
    const failed = logRow([RUN], { status: "failure" });
    const { fetchImpl, urls } = sequencedFetch([[failed]]);
    const usage = await collectLiteLlmRunUsage({
      client: { baseUrl: "http://gw/v1", apiKey: "k", fetchImpl },
      keyHash: "h",
      runTag: RUN,
      startedAtMs: 0,
      endedAtMs: 0,
      settleMs: 5000,
      pollIntervalMs: 1000,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
    });
    expect(urls.length).toBe(6); // initial read + one per second until the 5s deadline
    expect(usage).toMatchObject({ requestCount: 1, failedRequestCount: 1, costUsd: 0 });
  });
});

describe("summarizeTaggedSpendLogs attribution", () => {
  it("keeps concurrent runs on the same key apart", () => {
    const runA = "paperclip_run:run-a";
    const runB = "paperclip_run:run-b";
    const interleaved = [
      logRow([runA, "paperclip_agent:x"], { spend: 0.1, prompt_tokens: 100, completion_tokens: 10 }),
      logRow([runB, "paperclip_agent:y"], { spend: 0.2, prompt_tokens: 200, completion_tokens: 20 }),
      logRow([runA, "paperclip_agent:x"], { spend: 0.3, prompt_tokens: 300, completion_tokens: 30 }),
      logRow([runB, "paperclip_agent:y"], { spend: 0.4, prompt_tokens: 400, completion_tokens: 40 }),
    ];
    expect(summarizeTaggedSpendLogs(interleaved, runA)).toMatchObject({ requestCount: 2, inputTokens: 400, outputTokens: 40, costUsd: 0.4 });
    expect(summarizeTaggedSpendLogs(interleaved, runB)).toMatchObject({ requestCount: 2, inputTokens: 600, outputTokens: 60, costUsd: 0.6 });
  });

  it("separates back-to-back runs of the same session by their run tag", () => {
    // A recover run reuses the Codex thread; only the run tag differs.
    const thread = "User-Agent: acpx";
    const logs = [
      logRow(["paperclip_run:first", thread], { spend: 0.01, prompt_tokens: 10, completion_tokens: 1 }),
      logRow(["paperclip_run:second", thread], { spend: 0.02, prompt_tokens: 20, completion_tokens: 2 }),
    ];
    expect(summarizeTaggedSpendLogs(logs, "paperclip_run:first").costUsd).toBe(0.01);
    expect(summarizeTaggedSpendLogs(logs, "paperclip_run:second").costUsd).toBe(0.02);
  });

  it("treats missing, non-numeric and negative fields as zero", () => {
    const usage = summarizeTaggedSpendLogs(
      [
        logRow([RUN]),
        logRow([RUN], { spend: "0.5", prompt_tokens: "10", completion_tokens: null }),
        logRow([RUN], { spend: -1, prompt_tokens: -5, completion_tokens: Number.NaN }),
      ],
      RUN,
    );
    expect(usage).toEqual({
      requestCount: 3,
      failedRequestCount: 0,
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    });
  });

  it("never reports more cached tokens than prompt tokens", () => {
    const usage = summarizeTaggedSpendLogs(
      [logRow([RUN], { prompt_tokens: 100, metadata: { usage_object: { prompt_tokens_details: { cached_tokens: 500 } } } })],
      RUN,
    );
    expect(usage).toMatchObject({ inputTokens: 0, cachedInputTokens: 100 });
  });

  it("rounds the summed cost to hide float noise", () => {
    const usage = summarizeTaggedSpendLogs([logRow([RUN], { spend: 0.1 }), logRow([RUN], { spend: 0.2 })], RUN);
    expect(usage.costUsd).toBe(0.3);
  });

  it("counts failures flagged on the row or in its metadata", () => {
    const usage = summarizeTaggedSpendLogs(
      [logRow([RUN], { status: "failure" }), logRow([RUN], { metadata: { status: "failure" } }), logRow([RUN])],
      RUN,
    );
    expect(usage).toMatchObject({ requestCount: 3, failedRequestCount: 2 });
  });
});
