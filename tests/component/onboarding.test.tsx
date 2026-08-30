// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const trueForgeUiCalls = vi.hoisted(() => vi.fn());
const trueForgeUiState = vi.hoisted(() => ({ throws: false }));
vi.mock("@truefoundry/trueforge-ui", () => ({
  TrueForgeUI: (props: unknown) => {
    trueForgeUiCalls(props);
    if (trueForgeUiState.throws) throw new Error("TrueForge unavailable");
    return <div>OpenQuest discovery chat</div>;
  },
}));

import { OnboardingPage } from "../../src/web/routes/OnboardingPage.js";

const spaces = [
  { id: "ai_ml", name: "AI & agents", description: "Contribute to models, agents, and intelligent systems." },
  { id: "developer_tools", name: "Developer tools", description: "Improve the tools developers use to build and ship." },
  { id: "web", name: "Web & apps", description: "Build open experiences for browsers, desktops, and mobile devices." },
  { id: "data", name: "Data & infrastructure", description: "Strengthen data systems and the infrastructure behind them." },
  { id: "social_impact", name: "Civic, science & social impact", description: "Support public-interest technology, research, and access." },
] as const;

const fakeApi = {
  getSpaces: async () => spaces,
  discoverRepositories: async () => [],
  getIssues: async () => [],
  createCampaign: async () => ({ id: "campaign-1" }),
};

describe("OnboardingPage", () => {
  beforeEach(() => { trueForgeUiCalls.mockClear(); trueForgeUiState.throws = false; });
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
  });

  it("offers natural-language discovery through the locked OpenQuest agent", async () => {
    render(<OnboardingPage api={fakeApi} navigate={() => undefined} />);

    expect(await screen.findByRole("heading", { name: /talk to openquest/i })).toBeVisible();
    expect(screen.getByText(/describe what you want to contribute to/i)).toBeVisible();
    expect(screen.getByText(/or choose a category/i)).toBeVisible();
    expect(trueForgeUiCalls).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /start talking to openquest/i }));

    expect(screen.getByText("OpenQuest discovery chat")).toBeVisible();
    expect(trueForgeUiCalls).toHaveBeenCalledWith(expect.objectContaining({
      agentConfig: { mode: "SingleAgent", name: "openquest" },
      server: { type: "trueforge", baseUrl: "http://localhost:8790" },
    }));
  });

  it("keeps category discovery available when the chat runtime fails", async () => {
    trueForgeUiState.throws = true;

    render(<OnboardingPage api={fakeApi} navigate={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: /start talking to openquest/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/chat could not connect/i);
    expect(screen.getByRole("button", { name: /developer tools/i })).toBeVisible();
  });

  it("unmounts a failed chat runtime while preserving category discovery", async () => {
    render(<OnboardingPage api={fakeApi} navigate={() => undefined} />);
    fireEvent.click(await screen.findByRole("button", { name: /start talking to openquest/i }));
    const props = trueForgeUiCalls.mock.calls.at(-1)?.[0] as { onError?: () => void } | undefined;

    props?.onError?.();

    expect(await screen.findByRole("alert")).toHaveTextContent(/chat could not connect/i);
    expect(screen.queryByText("OpenQuest discovery chat")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /developer tools/i })).toBeVisible();
  });

  it("shows exactly five broad categories and navigates on one click", async () => {
    const destinations: string[] = [];
    render(<OnboardingPage api={fakeApi} navigate={(destination) => destinations.push(destination)} />);

    const categoryGroup = await screen.findByRole("group", { name: /choose a category/i });
    const categories = within(categoryGroup).getAllByRole("button");
    expect(categories).toHaveLength(5);
    expect(screen.getByRole("button", { name: /ai & agents/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /web & apps/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /data & infrastructure/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /civic, science & social impact/i })).toBeVisible();

    fireEvent.click(screen.getByRole("button", { name: /developer tools/i }));

    expect(destinations).toEqual(["/discover?spaces=developer_tools"]);
    expect(screen.queryByRole("button", { name: /continue/i })).not.toBeInTheDocument();
  });

  it("offers a retry when spaces cannot be loaded", async () => {
    let attempts = 0;
    render(<OnboardingPage api={{ ...fakeApi, getSpaces: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return spaces;
    } }} navigate={() => undefined} />);

    const retry = await screen.findByRole("button", { name: /try again/i });
    fireEvent.click(retry);

    expect(await screen.findByRole("button", { name: /developer tools/i })).toBeVisible();
  });
});
