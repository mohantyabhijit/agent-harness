// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { OnboardingPage } from "../../src/web/routes/OnboardingPage.js";

const spaces = [
  { id: "developer_tools", name: "Developer tools", description: "Build the tools developers rely on." },
  { id: "web", name: "Web", description: "Shape the open web." },
] as const;

const fakeApi = {
  getSpaces: async () => spaces,
  discoverRepositories: async () => [],
  getIssues: async () => [],
  createCampaign: async () => ({ id: "campaign-1" }),
};

describe("OnboardingPage", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
  });

  it("requires at least one space before continuing", async () => {
    const navigate = () => undefined;
    render(<OnboardingPage api={fakeApi} navigate={navigate} />);

    const continueButton = await screen.findByRole("button", { name: /continue/i });
    expect(continueButton).toBeDisabled();

    fireEvent.click(screen.getByRole("checkbox", { name: /developer tools/i }));
    expect(continueButton).toBeEnabled();
  });

  it("persists a keyboard-selected space and continues with a single normalized selection", async () => {
    const destinations: string[] = [];
    render(<OnboardingPage api={fakeApi} navigate={(destination) => destinations.push(destination)} />);

    const space = await screen.findByRole("checkbox", { name: /developer tools/i });
    fireEvent.keyDown(space, { key: " " });
    expect(window.location.search).toBe("?spaces=developer_tools");
    fireEvent.keyDown(space, { key: " " });
    fireEvent.keyDown(space, { key: " " });
    fireEvent.click(screen.getByRole("button", { name: /continue/i }));

    expect(destinations).toEqual(["/discover?spaces=developer_tools"]);
    expect(window.location.search).toBe("?spaces=developer_tools");
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

    expect(await screen.findByRole("checkbox", { name: /developer tools/i })).toBeVisible();
  });
});
