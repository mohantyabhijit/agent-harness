import type { AuthorizedPublisherAction, PublisherPort } from "../../src/application/ports/publisher.js";

export class FakePublisher implements PublisherPort {
  readonly pushes: AuthorizedPublisherAction<"push_branch">[] = [];
  readonly pullRequests: AuthorizedPublisherAction<"create_pr">[] = [];

  constructor(
    private readonly commitSha = "a".repeat(40),
    private readonly pullRequest = "https://github.com/example/repo/pull/1",
  ) {}

  async pushBranch(action: AuthorizedPublisherAction<"push_branch">): Promise<{ commitSha: string }> {
    this.pushes.push(action);
    return { commitSha: this.commitSha };
  }

  async createPr(action: AuthorizedPublisherAction<"create_pr">): Promise<{ pullRequest: string }> {
    this.pullRequests.push(action);
    return { pullRequest: this.pullRequest };
  }
}
