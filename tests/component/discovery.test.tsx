// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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

const secondEvidence = {
  id: "guide",
  sourceUrl: "https://github.com/friendly/second-project/blob/main/CONTRIBUTING.md",
  retrievedAt: "2026-08-26T00:00:00Z",
  observation: "Contribution guide is present.",
  kind: "direct" as const,
};

const secondRepository = {
  ...healthyRepository,
  repository: {
    ...healthyRepository.repository,
    fullName: "friendly/second-project",
    url: "https://github.com/friendly/second-project",
    evidence: [secondEvidence],
  },
  explanation: {
    ...healthyRepository.explanation,
    evidence: [secondEvidence],
    sourceUrls: ["https://github.com/friendly/second-project/blob/main/CONTRIBUTING.md"],
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

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

  it("starts only one campaign when the same issue is selected twice", async () => {
    const campaign = deferred<{ id: string }>();
    let createAttempts = 0;
    const destinations: string[] = [];
    const api = {
      discoverRepositories: async () => [healthyRepository],
      getIssues: async () => [easyIssue],
      createCampaign: async () => {
        createAttempts += 1;
        return campaign.promise;
      },
    };
    render(<DiscoverPage api={api} spaces={["developer_tools"]} navigate={(destination) => destinations.push(destination)} />);

    const start = await screen.findByRole("button", { name: /start.*clarify an error message/i });
    fireEvent.click(start);
    fireEvent.click(start);
    expect(createAttempts).toBe(1);

    await act(async () => {
      campaign.resolve({ id: "campaign-1" });
    });
    expect(destinations).toEqual(["/campaigns/campaign-1"]);
  });

  it("keeps partial issue cards visible while other issue requests are loading", async () => {
    const firstIssues = deferred<readonly [typeof easyIssue]>();
    const secondIssues = deferred<readonly []>();
    const api = {
      discoverRepositories: async () => [healthyRepository, secondRepository],
      getIssues: async (repository: string) => repository === healthyRepository.repository.fullName ? firstIssues.promise : secondIssues.promise,
      createCampaign: async () => ({ id: "campaign-1" }),
    };
    render(<DiscoverPage api={api} spaces={["developer_tools"]} navigate={() => undefined} />);

    expect(await screen.findByText(/loading contribution issues for friendly\/second-project/i)).toBeVisible();
    await act(async () => {
      firstIssues.resolve([easyIssue]);
    });

    expect(await screen.findByRole("button", { name: /start.*clarify an error message/i })).toBeVisible();
    expect(screen.getByText(/loading easy wins/i)).toBeVisible();
    expect(screen.queryByText(/no long-term challenges/i)).not.toBeInTheDocument();

    await act(async () => {
      secondIssues.resolve([]);
    });
    expect(await screen.findByText(/no long-term challenges/i)).toBeVisible();
    expect(screen.queryByText(/loading easy wins/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/no easy wins/i)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /start.*clarify an error message/i })).toBeVisible();
  });

  it("ignores a stale issue response and permits repeated issue retries", async () => {
    const staleIssues = deferred<readonly [typeof easyIssue]>();
    const freshIssues = deferred<readonly [typeof longTermIssue]>();
    let issueAttempt = 0;
    const api = {
      discoverRepositories: async () => [healthyRepository],
      getIssues: async () => {
        issueAttempt += 1;
        if (issueAttempt === 1) return staleIssues.promise;
        if (issueAttempt < 4) throw new Error("offline");
        return freshIssues.promise;
      },
      createCampaign: async () => ({ id: "campaign-1" }),
    };
    const { rerender } = render(<DiscoverPage api={api} spaces={["developer_tools"]} navigate={() => undefined} />);
    await screen.findByText(/loading contribution issues/i);

    rerender(<DiscoverPage api={api} spaces={["web"]} navigate={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: /retry issues/i }));
    fireEvent.click(await screen.findByRole("button", { name: /retry issues/i }));
    expect(issueAttempt).toBe(4);

    await act(async () => {
      staleIssues.resolve([easyIssue]);
    });
    expect(screen.queryByText(easyIssue.title)).not.toBeInTheDocument();
    await act(async () => {
      freshIssues.resolve([longTermIssue]);
    });
    expect(await screen.findByText(longTermIssue.title)).toBeVisible();
    expect(screen.queryByText(easyIssue.title)).not.toBeInTheDocument();
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
