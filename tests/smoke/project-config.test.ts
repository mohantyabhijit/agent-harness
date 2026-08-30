import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("OpenQuest project configuration", () => {
  it("keeps the embedded OpenQuest agent incapable of GitHub writes", () => {
    const manifest = JSON.parse(readFileSync("config/agents/openquest.json", "utf8")) as { instructions: string; mcp_servers: { name: string; enable_tools: string[]; disable_tools: string[] }[] };
    expect(manifest.mcp_servers.find(({ name }) => name === "github")).toMatchObject({ enable_tools: ["@read-only"], disable_tools: [] });
    expect(manifest.instructions).toMatch(/AI & agents.*Developer tools.*Web & apps.*Data & infrastructure.*Civic, science & social impact/is);
    expect(manifest.instructions).toMatch(/onboarding chat.*never display repository or issue recommendations.*validated discovery cards/is);
    expect(manifest.instructions).toMatch(/GitHub read-only tools.*at most 8.*source-linked/is);
    expect(manifest.instructions).toMatch(/public.*license.*recent activity.*contribution policy.*external pull request acceptance/is);
    expect(manifest.instructions).toMatch(/background.*seeds.*leads/is);
    expect(manifest.instructions).toMatch(/exclude openai\/codex.*does not accept external code contributions/is);
    expect(manifest.instructions).toMatch(/implementation turns.*status.*commitSha.*changedAreas.*tests.*uncertainty.*before.*after.*no extra fields/is);
    expect(manifest.instructions).toMatch(/verification turns.*testsPassed.*currentCommitSha.*tests.*uncertainty.*no extra fields/is);
    expect(manifest.instructions).toMatch(/untrusted.*never.*write/is);
  });

  it("pins the harness and exposes every quality command", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8"));

    expect(pkg.name).toBe("openquest");
    expect(pkg.engines.node).toBe(">=22");
    expect(pkg.dependencies["@truefoundry/trueforge"]).toBe("0.1.4");
    expect(pkg.dependencies["@truefoundry/trueforge-sdk"]).toBe("0.1.3");
    expect(pkg.dependencies["@truefoundry/trueforge-ui"]).toBe("0.2.4");
    expect(Object.keys(pkg.scripts)).toEqual(
      expect.arrayContaining(["dev", "build", "typecheck", "lint", "test", "test:integration", "test:e2e"]),
    );
  });
});
