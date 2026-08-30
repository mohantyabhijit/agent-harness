// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  classifyDiscoveryIntent: async () => ({ kind: "clarification" as const, question: "Choose one category." }),
};

describe("OnboardingPage", () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState({}, "", "/");
  });

  it("routes only after server-side conversational classification", async () => {
    const destinations: string[] = [];
    const classifyDiscoveryIntent = vi.fn(async () => ({ kind: "category" as const, space: "data" as const }));
    render(<OnboardingPage api={{ ...fakeApi, classifyDiscoveryIntent }} navigate={(destination) => destinations.push(destination)} />);

    fireEvent.change(screen.getByRole("textbox", { name: /what would you like to contribute to/i }), { target: { value: "I enjoy database infrastructure" } });
    fireEvent.click(screen.getByRole("button", { name: /find repositories/i }));

    await vi.waitFor(() => { expect(destinations).toEqual(["/discover?spaces=data"]); });
    expect(classifyDiscoveryIntent).toHaveBeenCalledWith("I enjoy database infrastructure", [], expect.any(AbortSignal));
  });

  it("keeps clarification history and never navigates from an ambiguous response", async () => {
    const destinations: string[] = [];
    const classifyDiscoveryIntent = vi.fn()
      .mockResolvedValueOnce({ kind: "clarification", question: "Choose one of the five categories." })
      .mockResolvedValueOnce({ kind: "category", space: "web" });
    render(<OnboardingPage api={{ ...fakeApi, classifyDiscoveryIntent }} navigate={(destination) => destinations.push(destination)} />);

    fireEvent.change(screen.getByRole("textbox", { name: /what would you like to contribute to/i }), { target: { value: "I want an AI web app" } });
    fireEvent.click(screen.getByRole("button", { name: /find repositories/i }));
    expect(await screen.findByText(/choose one of the five categories/i)).toBeVisible();
    expect(destinations).toEqual([]);

    fireEvent.change(screen.getByRole("textbox", { name: /what would you like to contribute to/i }), { target: { value: "Web and browser apps" } });
    fireEvent.click(screen.getByRole("button", { name: /find repositories/i }));

    await vi.waitFor(() => { expect(destinations).toEqual(["/discover?spaces=web"]); });
    expect(classifyDiscoveryIntent).toHaveBeenLastCalledWith("Web and browser apps", [
      { role: "user", content: "I want an AI web app" },
      { role: "assistant", content: "Choose one of the five categories." },
    ], expect.any(AbortSignal));
  });

  it("keeps only the newest five complete clarification turns", async () => {
    const classifyDiscoveryIntent = vi.fn(async (
      _message: string,
      _history: readonly { readonly role: "user" | "assistant"; readonly content: string }[],
      _signal?: AbortSignal,
    ) => {
      void [_message, _history, _signal];
      return { kind: "clarification" as const, question: "Please narrow that down." };
    });
    render(<OnboardingPage api={{ ...fakeApi, classifyDiscoveryIntent }} navigate={() => undefined} />);

    for (let index = 0; index < 7; index += 1) {
      fireEvent.change(screen.getByRole("textbox", { name: /what would you like to contribute to/i }), { target: { value: `Interest ${String(index)}` } });
      fireEvent.click(screen.getByRole("button", { name: /find repositories/i }));
      await vi.waitFor(() => { expect(classifyDiscoveryIntent).toHaveBeenCalledTimes(index + 1); });
      await screen.findByText(/please narrow that down/i);
    }

    const lastHistory = classifyDiscoveryIntent.mock.calls.at(-1)?.[1];
    expect(lastHistory).toHaveLength(10);
    expect(lastHistory?.[0]).toEqual({ role: "user", content: "Interest 1" });
    expect(lastHistory?.[9]).toEqual({ role: "assistant", content: "Please narrow that down." });
  });

  it("does not let a late classifier result override a manual category selection", async () => {
    const destinations: string[] = [];
    let resolveClassification: ((value: { kind: "category"; space: "data" }) => void) | undefined;
    const classifyDiscoveryIntent = vi.fn(() => new Promise<{ kind: "category"; space: "data" }>((resolve) => { resolveClassification = resolve; }));
    render(<OnboardingPage api={{ ...fakeApi, classifyDiscoveryIntent }} navigate={(destination) => destinations.push(destination)} />);

    fireEvent.change(screen.getByRole("textbox", { name: /what would you like to contribute to/i }), { target: { value: "Something broad" } });
    fireEvent.click(screen.getByRole("button", { name: /find repositories/i }));
    fireEvent.click(await screen.findByRole("button", { name: /developer tools/i }));
    resolveClassification?.({ kind: "category", space: "data" });

    await vi.waitFor(() => { expect(destinations).toEqual(["/discover?spaces=developer_tools"]); });
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
