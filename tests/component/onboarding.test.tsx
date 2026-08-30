// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OnboardingPage } from "../../src/web/routes/OnboardingPage.js";

vi.mock("../../src/web/components/DiscoveryAgentWorkspace.js", () => ({
  DiscoveryAgentWorkspace: ({ operatorCapability }: { readonly operatorCapability?: string }) => <section aria-label="TrueForge native chat" data-capability={operatorCapability}>Native TrueForge chat</section>,
}));

const spaces = [
  { id: "ai_ml", name: "AI & agents", description: "Contribute to models, agents, and intelligent systems." },
  { id: "developer_tools", name: "Developer tools", description: "Improve the tools developers use to build and ship." },
  { id: "web", name: "Web & apps", description: "Build open experiences for browsers, desktops, and mobile devices." },
  { id: "data", name: "Data & infrastructure", description: "Strengthen data systems and the infrastructure behind them." },
  { id: "social_impact", name: "Civic, science & social impact", description: "Support public-interest technology, research, and access." },
] as const;

const fakeApi = { getSpaces: async () => spaces };

describe("OnboardingPage", () => {
  afterEach(() => { cleanup(); window.history.replaceState({}, "", "/"); });

  it("makes the native TrueForge chat the primary experience", async () => {
    render(<OnboardingPage api={fakeApi} navigate={() => undefined} operatorCapability="operator-session-token" />);

    expect(screen.getByRole("heading", { name: /find work that is worth shipping/i })).toBeVisible();
    expect(screen.getByRole("region", { name: /trueforge native chat/i })).toHaveAttribute("data-capability", "operator-session-token");
    expect(screen.queryByLabelText(/operator capability/i)).not.toBeInTheDocument();
    expect(await screen.findByRole("group", { name: /choose a category/i })).toBeVisible();
  });

  it("shows exactly five validated quick starts and routes in one click", async () => {
    const destinations: string[] = [];
    render(<OnboardingPage api={fakeApi} navigate={(destination) => destinations.push(destination)} />);

    const group = await screen.findByRole("group", { name: /choose a category/i });
    expect(within(group).getAllByRole("button")).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: /developer tools/i }));

    expect(destinations).toEqual(["/discover?spaces=developer_tools"]);
  });

  it("offers a retry when spaces cannot be loaded", async () => {
    let attempts = 0;
    render(<OnboardingPage api={{ getSpaces: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("offline");
      return spaces;
    } }} navigate={() => undefined} />);

    fireEvent.click(await screen.findByRole("button", { name: /try again/i }));
    expect(await screen.findByRole("button", { name: /developer tools/i })).toBeVisible();
  });
});
