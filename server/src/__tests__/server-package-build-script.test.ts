import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));

describe("server package build script", () => {
  it("copies static runtime asset directories into dist", () => {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      scripts?: Record<string, string>;
    };
    const buildScript = packageJson.scripts?.build ?? "";

    // Copied with node's fs.cpSync so the script also runs under cmd.exe on Windows.
    expect(buildScript).toMatch(/^tsc && node -e /);
    expect(buildScript).toContain("fs.cpSync('src/'+d,'dist/'+d,{recursive:true})");
    expect(buildScript).toContain("'onboarding-assets'");
    expect(buildScript).toContain("'built-ins'");
    expect(buildScript).not.toMatch(/\b(mkdir -p|cp -R)\b/);
  });
});
