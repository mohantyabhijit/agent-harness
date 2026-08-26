// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createOpenQuestApi, type FetchLike } from "../../src/web/api.js";
import { App } from "../../src/web/App.js";

const realSpacesResponse = { spaces: ["developer_tools", "web"] };

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

  it("accepts server-valid campaign ids and encodes them before navigation", async () => {
    const api = createOpenQuestApi({ fetch: async () => new Response(JSON.stringify({ id: ":review.1" }), { status: 201 }), operatorCapability: () => "runtime-only" });

    await expect(api.createCampaign({ repository: "owner/repo", issueNumber: 1, issueUrl: "https://github.com/owner/repo/issues/1", lane: "easy_win" })).resolves.toEqual({ id: ":review.1" });
  });

  it("rejects campaign responses with unexpected fields", async () => {
    const api = createOpenQuestApi({ fetch: async () => new Response(JSON.stringify({ id: "campaign-1", operatorToken: "not-for-client" }), { status: 201 }), operatorCapability: () => "runtime-only" });

    await expect(api.createCampaign({ repository: "owner/repo", issueNumber: 1, issueUrl: "https://github.com/owner/repo/issues/1", lane: "easy_win" })).rejects.toThrow(/campaign/i);
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
});
