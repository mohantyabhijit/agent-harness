// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/web/components/OpenQuestTrueForgeUI.js", () => ({
  OpenQuestTrueForgeUI: () => { throw new Error("controlled TrueForge render failure"); },
}));

import { OpenQuestAgentThread } from "../../src/web/components/OpenQuestAgentThread.js";

describe("OpenQuestAgentThread", () => {
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("contains a TrueForge render failure without hiding durable campaign controls", () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(<OpenQuestAgentThread sessionId="session-qa" />);

    expect(screen.getByRole("heading", { name: /openquest agent/i })).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent(/campaign facts and approvals remain available/i);
  });
});
