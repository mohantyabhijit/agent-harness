import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type { HarnessPort } from "../../../../src/application/ports/harness.js";
import { HarnessOutputInvalid } from "../../../../src/adapters/trueforge/harness.js";
import { TrueForgeGithubCatalog } from "../../../../src/adapters/trueforge/github-catalog.js";

describe("TrueForgeGithubCatalog", () => {
  it("maps a valid, source-linked repository envelope", async () => {
    const [repository] = await loadFixture<readonly unknown[]>("repositories.json");
    const webRepository = verifiedRepository(repository as Record<string, unknown>, ["web"]);
    const { harness, runChildSession } = harnessReturning({
      kind: "repositories",
      items: [webRepository],
    });
    const catalog = createCatalog(harness);

    await expect(catalog.listRepositories(["web"])).resolves.toEqual([
      webRepository,
    ]);
    expect(runChildSession).toHaveBeenCalledOnce();
    expect(runChildSession).toHaveBeenCalledWith(
      expect.objectContaining({
        repository: "*",
        issueNumber: 0,
        verifiedEvidence: [],
        approvals: [],
        context: {
          responseSchema: expect.objectContaining({
            type: "object",
            properties: expect.objectContaining({
              items: expect.objectContaining({ maxItems: 8 }),
            }),
          }),
        },
      }),
      "discover",
    );
  });

  it("normalizes a numeric CI confidence to a conservative false boolean", async () => {
    const [repository] = await loadFixture<readonly Record<string, unknown>[]>("repositories.json");
    if (repository === undefined) throw new Error("Repository fixture is empty");
    const candidate = verifiedRepository(repository, ["web"]);
    const signals = { ...(candidate.signals as Record<string, unknown>), ciHealthy: 0.9 };
    const { harness } = harnessReturning({
      kind: "repositories",
      items: [{ ...candidate, signals }],
    });

    await expect(createCatalog(harness).listRepositories(["web"])).resolves.toEqual([
      expect.objectContaining({ signals: expect.objectContaining({ ciHealthy: false }) }),
    ]);
  });

  it("allows a repository to match the selected category plus other known categories", async () => {
    const [repository] = await loadFixture<readonly Record<string, unknown>[]>("repositories.json");
    if (repository === undefined) throw new Error("Repository fixture is empty");
    const candidate = verifiedRepository(repository, ["web", "ai_ml"]);
    const { harness } = harnessReturning({ kind: "repositories", items: [candidate] });
    const catalog = createCatalog(harness);

    await expect(catalog.listRepositories(["web"])).resolves.toEqual([candidate]);
  });

  it("rejects repository envelopes larger than the display contract", async () => {
    const [repository] = await loadFixture<readonly Record<string, unknown>[]>("repositories.json");
    if (repository === undefined) throw new Error("Repository fixture is empty");
    const items = Array.from({ length: 9 }, (_, index) => verifiedRepository({
      ...repository,
      fullName: `owner/repository-${String(index)}`,
    }, ["web"]));
    const { harness } = harnessReturning({ kind: "repositories", items });

    await expect(createCatalog(harness).listRepositories(["web"])).rejects.toBeInstanceOf(
      HarnessOutputInvalid,
    );
  });

  it("rejects extra evidence records outside the exact five-claim contract", async () => {
    const [repository] = await loadFixture<readonly Record<string, unknown>[]>("repositories.json");
    if (repository === undefined) throw new Error("Repository fixture is empty");
    const candidate = verifiedRepository(repository, ["web"]);
    const evidence = [...candidate.evidence, candidate.evidence[0]];
    const { harness } = harnessReturning({
      kind: "repositories",
      items: [{ ...candidate, evidence }],
    });

    await expect(createCatalog(harness).listRepositories(["web"])).rejects.toBeInstanceOf(
      HarnessOutputInvalid,
    );
  });

  it.each([
    ["license homepage", "license", { sourceUrl: "https://github.com/legacy/famous-dormant" }],
    ["invalid license identifier", "license", { verifiedValue: { spdxId: "NOASSERTION" } }],
    ["license path mismatch", "license", { verifiedValue: { spdxId: "MIT", path: "docs/LICENSE" } }],
    ["activity list without a concrete commit", "recent_activity", { sourceUrl: "https://github.com/legacy/famous-dormant/commits/main" }],
    ["commit identifier mismatch", "recent_activity", { verifiedValue: { commitSha: "b".repeat(40), committedAt: "2026-08-25T00:00:00Z" } }],
    ["stale activity", "recent_activity", { verifiedValue: { commitSha: "a".repeat(40), committedAt: "2025-01-01T00:00:00Z" } }],
    ["policy homepage", "contribution_policy", { sourceUrl: "https://github.com/legacy/famous-dormant" }],
    ["policy path mismatch", "contribution_policy", { verifiedValue: { path: "docs/CONTRIBUTING.md" } }],
    ["pull request search instead of a concrete merged PR", "external_pr_acceptance", { sourceUrl: "https://github.com/legacy/famous-dormant/pulls?q=is%3Apr+is%3Amerged" }],
    ["pull request identifier mismatch", "external_pr_acceptance", { verifiedValue: { pullRequestNumber: 43, mergedAt: "2026-08-20T00:00:00Z", authorAssociation: "CONTRIBUTOR" } }],
    ["maintainer-authored pull request", "external_pr_acceptance", { verifiedValue: { pullRequestNumber: 42, mergedAt: "2026-08-20T00:00:00Z", authorAssociation: "MEMBER" } }],
  ])("rejects claim evidence with %s", async (_label, claim, replacement) => {
    const [repository] = await loadFixture<readonly Record<string, unknown>[]>("repositories.json");
    if (repository === undefined) throw new Error("Repository fixture is empty");
    const candidate = verifiedRepository(repository, ["web"]);
    const evidence = candidate.evidence.map((entry) =>
      entry.claim === claim ? { ...entry, ...replacement } : entry,
    );
    const { harness } = harnessReturning({
      kind: "repositories",
      items: [{ ...candidate, evidence }],
    });

    await expect(createCatalog(harness).listRepositories(["web"])).rejects.toBeInstanceOf(
      HarnessOutputInvalid,
    );
  });

  it.each([
    ["stale retrieval", "2026-08-24T11:59:00Z"],
    ["future retrieval", "2026-08-26T12:10:00Z"],
  ])("rejects %s timestamps", async (_label, retrievedAt) => {
    const [repository] = await loadFixture<readonly Record<string, unknown>[]>("repositories.json");
    if (repository === undefined) throw new Error("Repository fixture is empty");
    const candidate = verifiedRepository(repository, ["web"]);
    const evidence = candidate.evidence.map((entry) => ({ ...entry, retrievedAt }));
    const { harness } = harnessReturning({
      kind: "repositories",
      items: [{ ...candidate, evidence }],
    });

    await expect(createCatalog(harness).listRepositories(["web"])).rejects.toBeInstanceOf(
      HarnessOutputInvalid,
    );
  });

  it.each([
    ["a missing claim", "license", "direct"],
    ["inference evidence", undefined, "inference"],
  ])("rejects repositories verified with %s", async (_label, omittedClaim, kind) => {
    const [repository] = await loadFixture<readonly Record<string, unknown>[]>("repositories.json");
    if (repository === undefined) throw new Error("Repository fixture is empty");
    const candidate = verifiedRepository(repository, ["web"]);
    const evidence = candidate.evidence
      .filter((entry) => entry.claim !== omittedClaim)
      .map((entry) => ({ ...entry, kind }));
    const { harness } = harnessReturning({
      kind: "repositories",
      items: [{ ...candidate, evidence }],
    });
    const catalog = createCatalog(harness);

    await expect(catalog.listRepositories(["web"])).rejects.toBeInstanceOf(
      HarnessOutputInvalid,
    );
  });

  it("rejects generic direct evidence that does not identify the verified claim", async () => {
    const [repository] = await loadFixture<readonly Record<string, unknown>[]>("repositories.json");
    if (repository === undefined) throw new Error("Repository fixture is empty");
    const candidate = verifiedRepository(repository, ["web"]);
    const evidence = candidate.evidence.map((entry) => Object.fromEntries(
      Object.entries(entry).filter(([key]) => key !== "claim" && key !== "verifiedValue"),
    ));
    const { harness } = harnessReturning({
      kind: "repositories",
      items: [{ ...candidate, evidence }],
    });
    const catalog = createCatalog(harness);

    await expect(catalog.listRepositories(["web"])).rejects.toBeInstanceOf(
      HarnessOutputInvalid,
    );
  });

  it("rejects readiness evidence that contradicts contribution signals", async () => {
    const [repository] = await loadFixture<readonly Record<string, unknown>[]>("repositories.json");
    if (repository === undefined) throw new Error("Repository fixture is empty");
    const candidate = verifiedRepository(repository, ["web"]);
    const { harness } = harnessReturning({
      kind: "repositories",
      items: [{ ...candidate, signals: { ...(candidate.signals as Record<string, unknown>), contributionGuide: false, externalPrAcceptance: 0 } }],
    });
    await expect(createCatalog(harness).listRepositories(["web"])).rejects.toBeInstanceOf(HarnessOutputInvalid);
  });

  it("uses background candidates only as seeds and requires fresh canonical GitHub verification", async () => {
    const { harness, runChildSession } = harnessReturning({ kind: "repositories", items: [] });
    const catalog = createCatalog(harness);

    await catalog.listRepositories(["ai_ml"]);

    const request = runChildSession.mock.calls[0]?.[0] as { goal?: string } | undefined;
    expect(request?.goal).toMatch(/background research.*seeds/i);
    expect(request?.goal).toContain("nanocoai/nanoclaw");
    expect(request?.goal).toContain("tinyfish-io/tinyfish-cookbook");
    expect(request?.goal).toContain("NVIDIA/NeMo-Agent-Toolkit");
    expect(request?.goal).toMatch(/freshly verify.*public visibility.*license.*recent activity.*contribution guide.*external pull request acceptance/i);
    expect(request?.goal).toMatch(/exclude openai\/codex.*does not accept external code contributions/i);
    expect(request?.goal).toMatch(/(?:no|never) return more than 8/i);
    expect(request?.goal).toMatch(/up to 8 fully verified repositories/i);
    expect(request?.goal).toMatch(/prefer fewer complete results/i);
    expect(request?.goal).toMatch(/never use booleans or null for numeric signals/i);
    expect(request?.goal).toMatch(/claim and verifiedValue as top-level fields/i);
    expect(request?.goal).toMatch(/observation must be a plain non-empty string/i);
    expect(request?.goal).toMatch(/trueforge final envelope with exactly summary, artifacts, and output/i);
    expect(request?.goal).toMatch(/GitHub read tools only/i);
  });

  it("maps a valid issue envelope for the requested repository", async () => {
    const issues = await loadFixture<readonly unknown[]>("issues.json");
    const { harness } = harnessReturning({ kind: "issues", items: issues });
    const catalog = createCatalog(harness);

    await expect(catalog.listIssues("friendly/healthy-contributor")).resolves.toEqual(issues);
  });

  it("normalizes a canonical GitHub repository URL before identity comparison", async () => {
    const [repository] = await loadFixture<readonly Record<string, unknown>[]>("repositories.json");
    if (repository === undefined) throw new Error("Repository fixture is empty");
    const normalizedCandidate = { ...verifiedRepository(repository, ["web"]), url: "https://GITHUB.com/legacy/famous-dormant/" };
    const { harness } = harnessReturning({ kind: "repositories", items: [normalizedCandidate] });
    const catalog = createCatalog(harness);

    await expect(catalog.listRepositories(["web"])).resolves.toEqual([
      normalizedCandidate,
    ]);
  });

  it("rejects repository output with no source evidence", async () => {
    const [repository] = await loadFixture<readonly Record<string, unknown>[]>("repositories.json");
    const { harness } = harnessReturning({
      kind: "repositories",
      items: [{ ...repository, evidence: [] }],
    });
    const catalog = createCatalog(harness);

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
    const catalog = createCatalog(harness);

    await expect(catalog.listRepositories(["developer_tools"])).rejects.toBeInstanceOf(
      HarnessOutputInvalid,
    );
  });

  it("rejects a repository that escapes the requested space set", async () => {
    const [repository] = await loadFixture<readonly Record<string, unknown>[]>("repositories.json");
    const { harness } = harnessReturning({ kind: "repositories", items: [repository] });
    const catalog = createCatalog(harness);

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
      items: [{ ...repository, spaces: ["web"], ...replacement }],
    });
    const catalog = createCatalog(harness);

    await expect(catalog.listRepositories(["web"])).rejects.toBeInstanceOf(
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
      items: [{ ...repository, spaces: ["web"], evidence }],
    });
    const catalog = createCatalog(harness);

    await expect(catalog.listRepositories(["web"])).rejects.toBeInstanceOf(
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
      items: [{ ...repository, spaces: ["web"], signals }],
    });
    const catalog = createCatalog(harness);

    await expect(catalog.listRepositories(["web"])).rejects.toBeInstanceOf(
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
    const catalog = createCatalog(harness);

    await expect(catalog.listIssues("friendly/healthy-contributor")).rejects.toBeInstanceOf(
      HarnessOutputInvalid,
    );
  });

  it("rejects malformed JSON instead of substituting fixture data", async () => {
    const { harness } = harnessReturning('{"kind":"repositories","items":[');
    const catalog = createCatalog(harness);

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
      deleteSession: vi.fn(),
      streamSession: vi.fn(),
      getSessionEvents: vi.fn(),
      runChildSession,
    },
    runChildSession,
  };
}

const referenceClock = (): Date => new Date("2026-08-26T12:00:00Z");

function createCatalog(harness: HarnessPort): TrueForgeGithubCatalog {
  return new TrueForgeGithubCatalog(harness, referenceClock);
}

function verifiedRepository(
  repository: Record<string, unknown>,
  selectedSpaces: readonly string[],
): Record<string, unknown> & { evidence: ReadonlyArray<Record<string, unknown> & { claim: string }> } {
  const fullName = String(repository.fullName);
  const url = `https://github.com/${fullName}`;
  const claims = [
    ["visibility", url, { visibility: "public" }],
    ["license", `${url}/blob/main/LICENSE`, { spdxId: repository.license, path: "LICENSE" }],
    ["recent_activity", `${url}/commit/${"a".repeat(40)}`, { commitSha: "a".repeat(40), committedAt: "2026-08-25T00:00:00Z" }],
    ["contribution_policy", `${url}/blob/main/CONTRIBUTING.md`, { path: "CONTRIBUTING.md" }],
    ["external_pr_acceptance", `${url}/pull/42`, { pullRequestNumber: 42, mergedAt: "2026-08-20T00:00:00Z", authorAssociation: "CONTRIBUTOR" }],
  ] as const;
  return {
    ...repository,
    spaces: selectedSpaces,
    signals: {
      ...(repository.signals as Record<string, unknown>),
      recentActivity: 1,
      contributionGuide: true,
      externalPrAcceptance: 0.8,
    },
    evidence: claims.map(([claim, sourceUrl, verifiedValue]) => ({
      id: `${fullName}-${claim}`,
      sourceUrl,
      retrievedAt: "2026-08-26T11:55:00Z",
      observation: `${claim} verified directly on GitHub.`,
      kind: "direct",
      claim,
      verifiedValue,
    })),
  };
}

async function loadFixture<T>(name: string): Promise<T> {
  const contents = await readFile(
    new URL(`../../../../fixtures/catalog/${name}`, import.meta.url),
    "utf8",
  );
  return JSON.parse(contents) as T;
}
