import { describe, expect, it } from "vitest";
import { assertPublicRemoteHttpEndpoint, isLoopbackHttpEndpoint } from "../services/remote-http-endpoint-guard.js";

function guardError(message: string, code: string) {
  return Object.assign(new Error(message), { code });
}

describe("remote HTTP endpoint guard", () => {
  it("blocks hostnames that resolve to private network addresses", async () => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://metadata.example/mcp"),
      { lookup: async () => [{ address: "10.0.0.12", family: 4 }] },
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });

  it("allows hostnames when every resolved address is public", async () => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL("https://public.example/mcp"),
      { lookup: async () => [{ address: "93.184.216.34", family: 4 }] },
      guardError,
    )).resolves.toBeUndefined();
  });

  it.each([
    "http://[2001::1]/mcp",
    "http://[2001:20::1]/mcp",
    "http://[2001:2f::1]/mcp",
    "http://[64:ff9b:1::1]/mcp",
  ])("rejects reserved IPv6 endpoint %s", async (url) => {
    await expect(assertPublicRemoteHttpEndpoint(
      new URL(url),
      {},
      guardError,
    )).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });
});

describe("isLoopbackHttpEndpoint", () => {
  it.each([
    "http://127.0.0.1:9011/mcp",
    "http://127.5.6.7/mcp",
    "http://localhost:9011/mcp",
    "http://mcp.localhost/mcp",
    "http://[::1]:9011/mcp",
  ])("treats %s as this machine", (url) => {
    expect(isLoopbackHttpEndpoint(new URL(url))).toBe(true);
  });

  it.each([
    "https://mcp.example.test/mcp",
    "http://10.0.0.5:9011/mcp",
    "http://192.168.1.5/mcp",
    "http://0.0.0.0:9011/mcp",
    "http://[::ffff:127.0.0.1]/mcp",
    "http://127.0.0.1.example.test/mcp",
    "http://localhost.example.test/mcp",
  ])("treats %s as off this machine", (url) => {
    expect(isLoopbackHttpEndpoint(new URL(url))).toBe(false);
  });
});
