import type { Campaign } from "../domain/campaign.js";
import type { DiscoveredRepository } from "../application/discover.js";
import type { IssueCandidate, Space } from "../domain/discovery.js";

export interface SpaceOption {
  readonly id: Space;
  readonly name: string;
  readonly description: string;
}

export interface CreateCampaignRequest {
  readonly repository: string;
  readonly issueNumber: number;
  readonly issueUrl: string;
  readonly lane: "easy_win" | "long_term";
}

export interface OpenQuestApi {
  getSpaces(): Promise<readonly SpaceOption[]>;
  discoverRepositories(spaces: readonly Space[]): Promise<readonly DiscoveredRepository[]>;
  getIssues(repository: string): Promise<readonly IssueCandidate[]>;
  createCampaign(input: CreateCampaignRequest): Promise<Pick<Campaign, "id">>;
}

export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface OpenQuestApiOptions {
  readonly fetch: FetchLike;
  readonly baseUrl?: string;
  readonly operatorCapability?: () => string | undefined;
}

export class OpenQuestApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenQuestApiError";
  }
}

export function createOpenQuestApi(options: OpenQuestApiOptions): OpenQuestApi {
  const baseUrl = options.baseUrl ?? "";

  return {
    async getSpaces() {
      const body = await request(options.fetch, `${baseUrl}/api/spaces`);
      return readArrayProperty(body, "spaces", "Spaces could not be loaded") as readonly SpaceOption[];
    },
    async discoverRepositories(selectedSpaces) {
      const uniqueSpaces = [...new Set(selectedSpaces)];
      const body = await request(options.fetch, `${baseUrl}/api/discovery/repositories`, {
        method: "POST",
        headers: writeHeaders(options.operatorCapability),
        body: JSON.stringify({ spaces: uniqueSpaces }),
      });
      return readArrayProperty(body, "repositories", "Recommendations could not be loaded") as readonly DiscoveredRepository[];
    },
    async getIssues(repository) {
      const [owner, repo] = repository.split("/");
      if (owner === undefined || repo === undefined || repository.split("/").length !== 2) {
        throw new OpenQuestApiError("Issues could not be loaded");
      }
      const body = await request(
        options.fetch,
        `${baseUrl}/api/discovery/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
      );
      return readArrayProperty(body, "issues", "Issues could not be loaded") as readonly IssueCandidate[];
    },
    async createCampaign(input) {
      const body = await request(options.fetch, `${baseUrl}/api/campaigns`, {
        method: "POST",
        headers: writeHeaders(options.operatorCapability),
        body: JSON.stringify(input),
      });
      if (!isRecord(body) || typeof body.id !== "string" || body.id.trim() === "") {
        throw new OpenQuestApiError("Campaign could not be started");
      }
      return { id: body.id };
    },
  };
}

async function request(fetcher: FetchLike, url: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetcher(url, init);
  } catch {
    throw new OpenQuestApiError("OpenQuest is unavailable. Please try again.");
  }
  if (!response.ok) throw new OpenQuestApiError("OpenQuest could not complete that request. Please try again.");
  try {
    return await response.json() as unknown;
  } catch {
    throw new OpenQuestApiError("OpenQuest returned an invalid response. Please try again.");
  }
}

function writeHeaders(capabilityProvider: OpenQuestApiOptions["operatorCapability"]): HeadersInit {
  const capability = capabilityProvider?.();
  if (capability === undefined || capability.trim() === "") {
    throw new OpenQuestApiError("An operator capability is required to start a campaign.");
  }
  return { "content-type": "application/json", authorization: `Bearer ${capability}` };
}

function readArrayProperty(value: unknown, key: string, message: string): readonly unknown[] {
  if (!isRecord(value) || !Array.isArray(value[key])) throw new OpenQuestApiError(message);
  return value[key];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
