import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { HarnessPort } from "../../../../src/application/ports/harness.js";
import { HarnessOutputInvalid } from "../../../../src/adapters/trueforge/harness.js";
import { TrueForgeGithubCatalog } from "../../../../src/adapters/trueforge/github-catalog.js";

describe("TrueForgeGithubCatalog", () => {
  it("maps a valid, source-linked repository envelope", async () => {
    const [repository] = await loadFixture<readonly unknown[]>("repositories.json");
    const { harness, runChildSession } = harnessReturning({
      kind: "repositories",
      items: [repository],
    });
    const catalog = new TrueForgeGithubCatalog(harness);

    await expect(catalog.listRepositories(["developer_tools", "web"])).resolves.toEqual([
      repository,
    ]);
    expect(runChildSession).toHaveBeenCalledOnce();
    expect(runChildSession).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: "*",
        issueNumber: 0,
        verifiedEvidence: [],
        approvals: [],
      }),
      "discover",
    );
  });

  it("maps a valid issue envelope for the requested repository", async () => {
    const issues = await loadFixture<readonly unknown[]>("issues.json");
    const { harness } = harnessReturning({ kind: "issues", items: issues });
    const catalog = new TrueForgeGithubCatalog(harness);

    await expect(catalog.listIssues("friendly/healthy-contributor")).resolves.toEqual(issues);
  });

  it("rejects repository output with no source evidence", async () => {
    const [repository] = await loadFixture<readonly Record<string, unknown>[]>("repositories.json");
    const { harness } = harnessReturning({
      kind: "repositories",
      items: [{ ...repository, evidence: [] }],
    });
    const catalog = new TrueForgeGithubCatalog(harness);

    await expect(catalog.listRepositories(["developer_tools"])).rejects.toBeInstanceOf(
      HarnessOutputInvalid,
    );
  });

  it("rejects repository output containing an unknown space", async () => {
    const [repository] = await loadFixture<readonly Record<string, unknown>[]>("repositories.json");
    const { harness } = harnessReturning({
      kind: "repositories",
      items: [{ ...repository, spaces: ["developer_tools", "unknown_space"] }],
    });
    const catalog = new TrueForgeGithubCatalog(harness);

    await expect(catalog.listRepositories(["developer_tools"])).rejects.toBeInstanceOf(
      HarnessOutputInvalid,
    );
  });

  it("rejects malformed JSON instead of substituting fixture data", async () => {
    const { harness } = harnessReturning('{"kind":"repositories","items":[');
    const catalog = new TrueForgeGithubCatalog(harness);

    await expect(catalog.listRepositories(["developer_tools"])).rejects.toBeInstanceOf(
      HarnessOutputInvalid,
    );
  });
});

function harnessReturning(output: unknown): {
  harness: HarnessPort;
  runChildSession: ReturnType<typeof vi.fn>;
} {
  const runChildSession = vi.fn().mockResolvedValue({
    sessionId: "discover-session-1",
    summary: "Catalog evidence collected from GitHub read tools.",
    artifacts: [],
    output,
  });
  return {
    harness: {
      createParentSession: vi.fn(),
      streamSession: vi.fn(),
      getSessionEvents: vi.fn(),
      runChildSession,
    },
    runChildSession,
  };
}

async function loadFixture<T>(name: string): Promise<T> {
  const contents = await readFile(
    new URL(`../../../../fixtures/catalog/${name}`, import.meta.url),
    "utf8",
  );
  return JSON.parse(contents) as T;
}
