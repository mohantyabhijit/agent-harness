// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { RepositoryCard } from "../../src/web/components/RepositoryCard.js";
import { DiscoverPage } from "../../src/web/routes/DiscoverPage.js";

const healthyRepository = {
  repository: {
    fullName: "friendly/healthy-contributor",
    url: "https://github.com/friendly/healthy-contributor",
    description: "An active project with reviewed external pull requests.",
    spaces: ["developer_tools"] as const,
    license: "Apache-2.0",
    isPublic: true,
    signals: {
      stars: 8000,
      recentActivity: 1,
      contributionGuide: true,
      ciHealthy: true,
      externalPrAcceptance: 0.8,
      topicMatch: 1,
      maintainerResponse: 0.9,
    },
    evidence: [
      {
        id: "guide",
        sourceUrl: "https://github.com/friendly/healthy-contributor/blob/main/CONTRIBUTING.md",
        retrievedAt: "2026-08-26T00:00:00Z",
        observation: "Contribution guide is present.",
        kind: "direct" as const,
      },
    ],
  },
  score: 0.9,
  explanation: {
    inputSignals: {} as never,
    weightedContributions: [],
    evidence: [
      {
        id: "guide",
        sourceUrl: "https://github.com/friendly/healthy-contributor/blob/main/CONTRIBUTING.md",
        retrievedAt: "2026-08-26T00:00:00Z",
        observation: "Contribution guide is present.",
        kind: "direct" as const,
      },
    ],
    sourceUrls: ["https://github.com/friendly/healthy-contributor/blob/main/CONTRIBUTING.md"],
    retrievedAt: ["2026-08-26T00:00:00Z"],
  },
};

const easyIssue = {
  repository: "friendly/healthy-contributor",
  number: 101,
  title: "Clarify an error message",
  url: "https://github.com/friendly/healthy-contributor/issues/101",
  clarity: 0.9,
  affectedAreas: 1,
  testComplexity: 0.2,
  dependencyRisk: 0.1,
  estimatedHours: 3,
  maintainerSignals: ["Acceptance criteria are documented."],
};

const longTermIssue = {
  ...easyIssue,
  number: 102,
  title: "Redesign the synchronization pipeline",
  url: "https://github.com/friendly/healthy-contributor/issues/102",
  affectedAreas: 4,
  testComplexity: 0.9,
  dependencyRisk: 0.7,
  estimatedHours: 20,
};

describe("RepositoryCard", () => {
  it("explains contribution readiness instead of showing stars alone", () => {
    render(<RepositoryCard repository={healthyRepository} />);

    expect(screen.getAllByText(/contribution guide/i)[0]).toBeVisible();
    expect(screen.getAllByText(/external pull requests/i)[0]).toBeVisible();
    expect(screen.getAllByText(/retrieved/i)[0]).toBeVisible();
  });
});

describe("DiscoverPage", () => {
  afterEach(cleanup);
  it("groups issues into understandable lanes and starts a campaign", async () => {
    const destinations: string[] = [];
    const created: unknown[] = [];
    const api = {
      getSpaces: async () => [],
      discoverRepositories: async () => [healthyRepository],
      getIssues: async () => [easyIssue, longTermIssue],
      createCampaign: async (input: unknown) => {
        created.push(input);
        return { id: ":review.1" };
      },
    };
    render(<DiscoverPage api={api} spaces={["developer_tools"]} navigate={(destination) => destinations.push(destination)} />);

    expect(await screen.findByRole("heading", { name: /easy wins/i })).toBeVisible();
    expect(screen.getByRole("heading", { name: /long-term challenges/i })).toBeVisible();
    expect(screen.getAllByText(/test complexity/i)[0]).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /start.*clarify an error message/i }));

    expect(created).toEqual([{
      repository: "friendly/healthy-contributor",
      issueNumber: 101,
      issueUrl: "https://github.com/friendly/healthy-contributor/issues/101",
      lane: "easy_win",
    }]);
    await waitFor(() => {
      expect(destinations).toEqual(["/campaigns/%3Areview.1"]);
    });
  });

  it("offers retry after a failed discovery request", async () => {
    let attempts = 0;
    const api = {
      getSpaces: async () => [],
      discoverRepositories: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("offline");
        return [healthyRepository];
      },
      getIssues: async () => [],
      createCampaign: async () => ({ id: "campaign-1" }),
    };
    render(<DiscoverPage api={api} spaces={["developer_tools"]} navigate={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("heading", { name: /friendly\/healthy-contributor/i })).toBeVisible();
  });
});
