import { describe, expect, it } from "vitest";
import {
  configWithRunCredential,
  configWithRunIdentityForwarding,
  forwardsRunIdentity,
  isLoopbackAddress,
  partialRunIdentityKeys,
  sendsRunCredential,
} from "./run-identity";

const base = { url: "http://127.0.0.1:9011/mcp", quarantineNewEntries: true };

describe("configWithRunIdentityForwarding", () => {
  it("turns forwarding on and keeps every other config key", () => {
    const next = configWithRunIdentityForwarding(base, true);
    expect(next).toEqual({
      ...base,
      headerPolicy: { metadata: { forward: ["run_id", "issue_id", "company_id", "agent_id"] } },
    });
    expect(forwardsRunIdentity(next)).toBe(true);
  });

  it("keeps other header policy fields and other forwarded keys", () => {
    const current = {
      ...base,
      headerPolicy: {
        staticHeaders: [{ name: "x-static-mode", value: "canary" }],
        metadata: { forward: ["project_id", "issue_id"] },
      },
    };
    const on = configWithRunIdentityForwarding(current, true);
    expect(on.headerPolicy).toEqual({
      staticHeaders: [{ name: "x-static-mode", value: "canary" }],
      metadata: { forward: ["project_id", "issue_id", "run_id", "company_id", "agent_id"] },
    });

    const off = configWithRunIdentityForwarding(on, false);
    expect(off.headerPolicy).toEqual({
      staticHeaders: [{ name: "x-static-mode", value: "canary" }],
      metadata: { forward: ["project_id"] },
    });
  });

  it("turning off removes identity keys from every place the gateway reads", () => {
    const current = {
      ...base,
      headerPolicy: {
        metadata: { forward: ["run_id"], headers: ["agent_id", "correlation_id"] },
        forwardContextHeaders: ["company_id"],
      },
    };
    const off = configWithRunIdentityForwarding(current, false);
    expect(off.headerPolicy).toEqual({ metadata: { headers: ["correlation_id"] } });
  });

  it("drops an empty header policy instead of leaving empty objects", () => {
    const off = configWithRunIdentityForwarding(configWithRunIdentityForwarding(base, true), false);
    expect(off).toEqual(base);
  });

  it("does not mutate the config it was given", () => {
    const current = { ...base, headerPolicy: { metadata: { forward: ["project_id"] } } };
    const snapshot = JSON.parse(JSON.stringify(current));
    configWithRunIdentityForwarding(current, true);
    expect(current).toEqual(snapshot);
  });
});

describe("forwardsRunIdentity / partialRunIdentityKeys", () => {
  it("is on only when all four keys are forwarded, from any of the three places", () => {
    expect(forwardsRunIdentity(base)).toBe(false);
    expect(forwardsRunIdentity(null)).toBe(false);
    expect(forwardsRunIdentity({
      headerPolicy: { metadata: { forward: ["run_id", "issue_id"], headers: ["company_id"] }, forwardContextHeaders: ["agent_id"] },
    })).toBe(true);
  });

  it("reports which identity keys are on when only some are", () => {
    const partial = { headerPolicy: { metadata: { forward: ["agent_id", "issue_id", "project_id"] } } };
    expect(partialRunIdentityKeys(partial)).toEqual(["agent_id", "issue_id"]);
    expect(partialRunIdentityKeys(configWithRunIdentityForwarding(base, true))).toEqual([]);
  });
});

describe("configWithRunCredential", () => {
  it("turns the run token on and off without touching identity forwarding", () => {
    const withIdentity = configWithRunIdentityForwarding(base, true);
    const on = configWithRunCredential(withIdentity, true);
    expect(sendsRunCredential(on)).toBe(true);
    expect(forwardsRunIdentity(on)).toBe(true);
    expect(on.url).toBe(base.url);

    const off = configWithRunCredential(on, false);
    expect(sendsRunCredential(off)).toBe(false);
    expect(off).toEqual(withIdentity);
  });

  it("drops an empty header policy when the run token was the only setting", () => {
    expect(configWithRunCredential(configWithRunCredential(base, true), false)).toEqual(base);
  });
});

describe("isLoopbackAddress", () => {
  it("recognizes addresses on this machine", () => {
    for (const url of ["http://127.0.0.1:9011/mcp", "http://localhost:9011/mcp", "http://[::1]:9011/mcp", "http://127.0.0.2/mcp"]) {
      expect(isLoopbackAddress(url)).toBe(true);
    }
  });

  it("treats everything else as remote", () => {
    for (const url of ["https://mcp.linear.app/mcp", "http://192.168.1.5:9011/mcp", "not a url", undefined]) {
      expect(isLoopbackAddress(url)).toBe(false);
    }
  });
});
