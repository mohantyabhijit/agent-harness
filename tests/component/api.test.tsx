// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenQuestApi, type FetchLike } from "../../src/web/api.js";
import { App } from "../../src/web/App.js";
import type { Evidence } from "../../src/domain/evidence.js";

const realSpacesResponse = { spaces: ["developer_tools", "web"] };
const realCampaignResponse = {
  id: ":review.1",
  repository: "owner/repo",
  issueNumber: 1,
  issueUrl: "https://github.com/owner/repo/issues/1",
  parentSessionId: "session-1",
  lane: "easy_win",
  status: "policy_review",
  qodoIteration: 0,
  version: 1,
} as const;
const canonicalEvidence = {
  id: "guide",
  sourceUrl: "https://github.com/owner/repo/blob/main/CONTRIBUTING.md",
  retrievedAt: "2026-08-26T00:00:00Z",
  observation: "Contribution guide is present.",
  kind: "direct" as const,
};
const repositorySignals = {
  stars: 100,
  recentActivity: 1,
  contributionGuide: true,
  ciHealthy: true,
  externalPrAcceptance: 0.8,
  topicMatch: 1,
  maintainerResponse: 0.9,
};

function repositoryResponse(explanationEvidence: Evidence = canonicalEvidence) {
  return {
    repositories: [{
      repository: {
        fullName: "owner/repo",
        url: "https://github.com/owner/repo",
        description: "A healthy repository.",
        spaces: ["developer_tools"],
        license: "MIT",
        isPublic: true,
        signals: repositorySignals,
        evidence: [canonicalEvidence],
      },
      score: 0.9,
      explanation: {
        inputSignals: repositorySignals,
        weightedContributions: [],
        evidence: [explanationEvidence],
        sourceUrls: [canonicalEvidence.sourceUrl],
        retrievedAt: [canonicalEvidence.retrievedAt],
      },
    }],
  };
}

describe("OpenQuest browser API", () => {
  it("maps the Task 7 spaces contract and keeps capabilities off GET requests", async () => {
    const fetcher = vi.fn<FetchLike>(async () => new Response(JSON.stringify(realSpacesResponse), { status: 200 }));
    const api = createOpenQuestApi({ fetch: fetcher, baseUrl: "https://openquest.test", operatorCapability: () => "runtime-only" });

    await expect(api.getSpaces()).resolves.toEqual([
      expect.objectContaining({ id: "developer_tools", name: "Developer tools" }),
      expect.objectContaining({ id: "web", name: "Web" }),
    ]);
    expect(fetcher).toHaveBeenCalledWith("https://openquest.test/api/spaces", expect.not.objectContaining({ headers: expect.anything() }));
    expect(fetcher.mock.calls[0]?.[1]?.headers).toBeUndefined();
  });

  it("rejects hostile and unknown space payloads before rendering them", async () => {
    const api = createOpenQuestApi({ fetch: async () => new Response(JSON.stringify({ spaces: ["developer_tools", "<script>"] }), { status: 200 }) });

    await expect(api.getSpaces()).rejects.toThrow(/spaces/i);
  });

  it("accepts the strict Task 7 campaign response and projects its navigation id", async () => {
    const api = createOpenQuestApi({ fetch: async () => new Response(JSON.stringify(realCampaignResponse), { status: 201 }), operatorCapability: () => "runtime-only" });

    await expect(api.createCampaign({ repository: "owner/repo", issueNumber: 1, issueUrl: "https://github.com/owner/repo/issues/1", lane: "easy_win" })).resolves.toEqual({ id: ":review.1" });
  });

  it("rejects campaign responses with unexpected fields", async () => {
    const api = createOpenQuestApi({ fetch: async () => new Response(JSON.stringify({ ...realCampaignResponse, operatorToken: "not-for-client" }), { status: 201 }), operatorCapability: () => "runtime-only" });

    await expect(api.createCampaign({ repository: "owner/repo", issueNumber: 1, issueUrl: "https://github.com/owner/repo/issues/1", lane: "easy_win" })).rejects.toThrow(/campaign/i);
  });

  it.each([
    ["retrieval timestamp", { ...canonicalEvidence, retrievedAt: "2026-08-26T00:01:00Z" }],
    ["evidence kind", { ...canonicalEvidence, kind: "inference" as const }],
  ])("rejects explanation evidence with a mismatched %s", async (_label, explanationEvidence) => {
    const api = createOpenQuestApi({ fetch: async () => new Response(JSON.stringify(repositoryResponse(explanationEvidence)), { status: 200 }), operatorCapability: () => "runtime-only" });

    await expect(api.discoverRepositories(["developer_tools"])).rejects.toThrow(/recommendations/i);
  });
});

describe("operator connection", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
  });

  it("requires a local runtime connection and clears it on disconnect", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: /connect an operator capability/i })).toBeVisible();
    const field = screen.getByLabelText(/operator capability/i);
    fireEvent.change(field, { target: { value: "runtime-secret" } });
    fireEvent.click(screen.getByRole("button", { name: /^connect$/i }));
    expect(screen.getByRole("button", { name: /disconnect/i })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    expect(screen.getByRole("heading", { name: /connect an operator capability/i })).toBeVisible();
  });

  it("disconnects from a campaign route and focuses each route heading", async () => {
    window.history.replaceState({}, "", "/campaigns/campaign-1");
    render(<App operatorCapability={() => "runtime-only"} />);

    const campaignHeading = screen.getByRole("heading", { name: /campaign created/i });
    await vi.waitFor(() => {
      expect(campaignHeading).toHaveFocus();
    });
    fireEvent.click(screen.getByRole("button", { name: /disconnect/i }));

    expect(window.location.pathname).toBe("/");
    const connectionHeading = screen.getByRole("heading", { name: /connect an operator capability/i });
    await vi.waitFor(() => {
      expect(connectionHeading).toHaveFocus();
    });
  });
});
