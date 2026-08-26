import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("OpenQuest project configuration", () => {
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
