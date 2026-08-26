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

  it("normalizes a canonical GitHub repository URL before identity comparison", async () => {
    const [repository] = await loadFixture<readonly Record<string, unknown>[]>("repositories.json");
    const normalizedCandidate = { ...repository, url: "https://GITHUB.com/legacy/famous-dormant/" };
    const { harness } = harnessReturning({ kind: "repositories", items: [normalizedCandidate] });
    const catalog = new TrueForgeGithubCatalog(harness);

    await expect(catalog.listRepositories(["developer_tools", "web"])).resolves.toEqual([
      normalizedCandidate,
    ]);
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

  it("rejects a repository that escapes the requested space set", async () => {
    const [repository] = await loadFixture<readonly Record<string, unknown>[]>("repositories.json");
    const { harness } = harnessReturning({ kind: "repositories", items: [repository] });
    const catalog = new TrueForgeGithubCatalog(harness);

    await expect(catalog.listRepositories(["developer_tools"])).rejects.toBeInstanceOf(
      HarnessOutputInvalid,
    );
  });

  it.each([
    ["cross-repository identity", { url: "https://github.com/attacker/spoof" }],
    ["non-HTTPS repository URL", { url: "http://github.com/legacy/famous-dormant" }],
    ["credentialed repository URL", { url: "https://user:secret@github.com/legacy/famous-dormant" }],
  ])("rejects %s", async (_label, replacement) => {
    const [repository] = await loadFixture<readonly Record<string, unknown>[]>("repositories.json");
    const { harness } = harnessReturning({
      kind: "repositories",
      items: [{ ...repository, ...replacement }],
    });
    const catalog = new TrueForgeGithubCatalog(harness);

    await expect(catalog.listRepositories(["developer_tools", "web"])).rejects.toBeInstanceOf(
      HarnessOutputInvalid,
    );
  });

  it.each([
    ["cross-repository evidence", "https://github.com/attacker/spoof/issues/1"],
    ["non-HTTPS evidence", "http://github.com/legacy/famous-dormant/issues/1"],
    ["non-HTTP evidence", "file:///legacy/famous-dormant/CONTRIBUTING.md"],
  ])("rejects %s", async (_label, sourceUrl) => {
    const [repository] = await loadFixture<readonly Record<string, unknown>[]>("repositories.json");
    const evidence = [{
      id: "spoofed-evidence",
      sourceUrl,
      retrievedAt: "2026-08-26T00:00:00Z",
      observation: "Untrusted evidence",
      kind: "direct",
    }];
    const { harness } = harnessReturning({
      kind: "repositories",
      items: [{ ...repository, evidence }],
    });
    const catalog = new TrueForgeGithubCatalog(harness);

    await expect(catalog.listRepositories(["developer_tools", "web"])).rejects.toBeInstanceOf(
      HarnessOutputInvalid,
    );
  });

  it.each([
    ["unsafe star count", { stars: Number.MAX_SAFE_INTEGER + 1 }],
    ["infinite activity", { recentActivity: Number.POSITIVE_INFINITY }],
    ["out-of-range response", { maintainerResponse: 1.1 }],
  ])("rejects repository numeric bounds: %s", async (_label, signalReplacement) => {
    const [repository] = await loadFixture<readonly Record<string, unknown>[]>("repositories.json");
    if (repository === undefined) {
      throw new Error("Repository fixture is empty");
    }
    const signals = { ...(repository.signals as Record<string, unknown>), ...signalReplacement };
    const { harness } = harnessReturning({
      kind: "repositories",
      items: [{ ...repository, signals }],
    });
    const catalog = new TrueForgeGithubCatalog(harness);

    await expect(catalog.listRepositories(["developer_tools", "web"])).rejects.toBeInstanceOf(
      HarnessOutputInvalid,
    );
  });

  it.each([
    ["mismatched issue number", { url: "https://github.com/friendly/healthy-contributor/issues/999" }],
    ["cross-repository issue URL", { url: "https://github.com/attacker/spoof/issues/101" }],
    ["non-HTTPS issue URL", { url: "http://github.com/friendly/healthy-contributor/issues/101" }],
    ["unsafe issue number", { number: Number.MAX_SAFE_INTEGER + 1 }],
    ["negative affected areas", { affectedAreas: -1 }],
    ["infinite estimate", { estimatedHours: Number.POSITIVE_INFINITY }],
  ])("rejects invalid issue identity or numeric bounds: %s", async (_label, replacement) => {
    const [issue] = await loadFixture<readonly Record<string, unknown>[]>("issues.json");
    const { harness } = harnessReturning({
      kind: "issues",
      items: [{ ...issue, ...replacement }],
    });
    const catalog = new TrueForgeGithubCatalog(harness);

    await expect(catalog.listIssues("friendly/healthy-contributor")).rejects.toBeInstanceOf(
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
