import { z } from "zod";
import { isExactMultilineText, isExactSingleLineText } from "../domain/exact-text.js";

import type { DiscoveredRepository } from "../application/discover.js";
import type { DiscoveryConversationMessage, DiscoveryIntentResult } from "../application/ports/intent-classifier.js";
import type { ApprovalAction } from "../domain/approval.js";
import type { Campaign } from "../domain/campaign.js";
import type { IssueBrief } from "../domain/issue-brief.js";
import { spaces, type IssueCandidate, type Space } from "../domain/discovery.js";

export interface SpaceOption { readonly id: Space; readonly name: string; readonly description: string; }
export interface CreateCampaignRequest { readonly repository: string; readonly issueNumber: number; readonly issueUrl: string; readonly lane: "easy_win" | "long_term"; }
export interface ApprovalBrief { readonly policy: string; readonly approach: string; readonly files: readonly string[]; readonly risks: readonly string[]; readonly tests: readonly string[]; readonly safetyResult: string; readonly qodoStatus: string; readonly aiDisclosure: string; }
export type ApprovalActionSummary =
  | Readonly<{ action: "post_issue_comment"; repository: string; issueNumber: number; body: string }>
  | Readonly<{ action: "request_assignment"; repository: string; issueNumber: number; assignee: string }>
  | Readonly<{ action: "push_branch"; repository: string; issueNumber: number; branch: string; sourceCommitSha: string; targetCommitSha: string }>
  | Readonly<{ action: "create_pr"; repository: string; issueNumber: number; branch: string; baseBranch: string; commitSha: string; title: string; body: string }>
  | Readonly<{ action: "update_pr"; repository: string; issueNumber: number; pullRequest: string; branch: string; commitSha: string; body: string }>;
export interface ApprovalProposal { readonly proposalId: string; readonly actionDigest: string; readonly expectedCampaignVersion: number; readonly action: ApprovalActionSummary; readonly brief: ApprovalBrief; }
export type PublicationAction = Extract<ApprovalActionSummary, Readonly<{ action: "push_branch" | "create_pr" }>>;
export type PublicationResult = Readonly<{ commitSha: string }> | Readonly<{ pullRequest: string }>;
export interface ApprovalConfirmation { readonly proposalId: string; readonly actionDigest: string; readonly expectedCampaignVersion: number; }
export interface PublicApproval { readonly id: string; readonly action: ApprovalAction; readonly actionDigest: string; readonly status: "pending" | "approved" | "rejected" | "consumed"; readonly issuedAt: string; readonly expiresAt?: string; readonly consumedAt?: string; readonly proposalId?: string; readonly expectedCampaignVersion?: number; readonly isActive: boolean; }
export interface CampaignSnapshot extends Campaign {
  readonly issueBrief: IssueBrief | null;
  readonly fixExplanation: Readonly<{ readonly commitSha: string; readonly before: string; readonly after: string; readonly changedAreas: readonly string[]; readonly tests: readonly string[]; readonly uncertainty: string }> | null;
  readonly nextAllowedAction: "preflight" | "implement" | "verify" | null;
  readonly evidence: readonly { readonly id: string; readonly sourceUrl: string; readonly retrievedAt: string; readonly observation: string; readonly kind: "direct" | "inference" }[];
  readonly events: readonly { readonly id: string; readonly eventType: string; readonly occurredAt: string; readonly sequence: number; readonly facts: Readonly<Record<string, string | number | boolean>> }[];
  readonly approvals: readonly PublicApproval[];
  readonly qodoFindings: readonly { readonly id: string; readonly severity: "high" | "medium" | "low" | "suggestion"; readonly status: "open" | "fixed" | "dismissed"; readonly summary: string; readonly sourceUrl?: string; readonly disposition?: string }[];
  readonly externalReferences: readonly { readonly kind: "issue" | "branch" | "pull_request" | "commit" | "sandbox" | "child_session" | "ci_run"; readonly value: string }[];
  readonly externalActionClaims: readonly { readonly id: string; readonly approvalId: string; readonly action: ApprovalAction; readonly actionDigest: string; readonly claimedCampaignVersion: number; readonly claimedCampaignStatus: Campaign["status"]; readonly status: "active" | "outcome_unknown" | "completed" | "reconciled"; readonly attemptedAt: string; readonly leaseStartedAt: string; readonly closedAt?: string; readonly disposition?: "confirmed_completed" | "confirmed_not_completed" }[];
  readonly approvalProposal: ApprovalProposal | null;
  readonly qualityEscalationReason: "maximum_qodo_iterations" | "tests_failed" | "repair_child_failed" | "repair_cancelled" | "operation_result_not_safely_recorded" | "operator_recovered_interrupted_operation" | null;
}
export interface OpenQuestApi {
  getSpaces(signal?: AbortSignal): Promise<readonly SpaceOption[]>;
  classifyDiscoveryIntent(message: string, history: readonly DiscoveryConversationMessage[], signal?: AbortSignal): Promise<DiscoveryIntentResult>;
  discoverRepositories(spaces: readonly Space[], signal?: AbortSignal): Promise<readonly DiscoveredRepository[]>;
  getIssues(repository: string, signal?: AbortSignal): Promise<readonly IssueCandidate[]>;
  createCampaign(input: CreateCampaignRequest, signal?: AbortSignal): Promise<Pick<Campaign, "id">>;
  getCampaign(id: string, signal?: AbortSignal): Promise<CampaignSnapshot>;
  finalizeCampaign(id: string, expectedVersion: number, idempotencyKey: string, signal?: AbortSignal): Promise<Campaign>;
  runCampaignAction(id: string, action: "preflight" | "implement" | "verify", signal?: AbortSignal): Promise<Campaign>;
  issueApproval(campaignId: string, confirmation: ApprovalConfirmation, idempotencyKey: string, signal?: AbortSignal): Promise<PublicApproval>;
  publishApprovedAction(campaignId: string, approvalId: string, action: PublicationAction, signal?: AbortSignal): Promise<PublicationResult>;
}
export type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export interface OpenQuestApiOptions { readonly fetch: FetchLike; readonly baseUrl?: string; readonly operatorCapability?: () => string | undefined; }
export class OpenQuestApiError extends Error { constructor(message: string, readonly status?: number, readonly code?: string) { super(message); this.name = "OpenQuestApiError"; } }

const metadata: Readonly<Record<Space, Omit<SpaceOption, "id">>> = {
  ai_ml: { name: "AI & agents", description: "Contribute to models, agents, and intelligent systems." }, developer_tools: { name: "Developer tools", description: "Improve the tools developers use to build and ship." }, web: { name: "Web & apps", description: "Build open experiences for browsers, desktops, and mobile devices." }, data: { name: "Data & infrastructure", description: "Strengthen data systems and the infrastructure behind them." }, social_impact: { name: "Civic, science & social impact", description: "Support public-interest technology, research, and access." },
};
const finite = z.number();
const rate = finite.min(0).max(1);
const text = z.string().min(1).max(2_000).refine((value) => value.trim().length > 0);
const longText = z.string().min(1).max(20_000).refine((value) => value.trim().length > 0);
const actionText = z.string().refine((value) => isExactMultilineText(value, 20_000));
const actionTitle = z.string().refine((value) => isExactSingleLineText(value, 256));
const identifier = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/u);
const repositoryName = z.string().regex(/^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/u);
const githubUrl = z.url().max(2_048).refine(github, "github HTTPS URL");
const campaignId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/u);
const timestamp = z.iso.datetime({ offset: true });
const digest = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const campaignStatus = z.enum(["policy_review", "coordination_pending", "preflight", "quarantined", "baseline", "implementation", "verification", "contribution_approval", "pull_request_open", "qodo_review", "repair", "human_escalation", "merged", "closed", "withdrawn"]);
const approvalAction = z.enum(["post_issue_comment", "request_assignment", "push_branch", "create_pr", "update_pr"]);
const conversationMessage = z.object({ role: z.enum(["user", "assistant"]), content: z.string().trim().min(1).max(500) }).strict();
const discoveryIntent = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("category"), space: z.enum(spaces) }).strict(),
  z.object({ kind: z.literal("clarification"), question: z.string().trim().min(1).max(240) }).strict(),
]);
const commitSha = z.string().regex(/^[0-9a-f]{40}$/u);
const fixExplanation = z.object({ commitSha, before: text, after: text, changedAreas: z.array(text).min(1).max(100), tests: z.array(text).min(1).max(100), uncertainty: text }).strict();
const evidence = z.object({ id: identifier, sourceUrl: githubUrl, retrievedAt: timestamp, observation: text, kind: z.enum(["direct", "inference"]) }).strict();
const repositoryEvidenceFields = { id: identifier, sourceUrl: githubUrl, retrievedAt: timestamp, observation: text, kind: z.literal("direct") } as const;
const repositoryEvidence = z.discriminatedUnion("claim", [
  z.object({ ...repositoryEvidenceFields, claim: z.literal("visibility"), verifiedValue: z.object({ visibility: z.literal("public") }).strict() }).strict(),
  z.object({ ...repositoryEvidenceFields, claim: z.literal("license"), verifiedValue: z.object({ spdxId: z.string().trim().min(1).max(100), path: z.string().trim().min(1).max(500) }).strict() }).strict(),
  z.object({ ...repositoryEvidenceFields, claim: z.literal("recent_activity"), verifiedValue: z.object({ commitSha, committedAt: timestamp }).strict() }).strict(),
  z.object({ ...repositoryEvidenceFields, claim: z.literal("contribution_policy"), verifiedValue: z.object({ path: z.string().trim().min(1).max(500) }).strict() }).strict(),
  z.object({ ...repositoryEvidenceFields, claim: z.literal("external_pr_acceptance"), verifiedValue: z.object({ pullRequestNumber: finite.int().positive(), mergedAt: timestamp, authorAssociation: z.enum(["CONTRIBUTOR", "FIRST_TIME_CONTRIBUTOR", "FIRST_TIMER", "NONE"]) }).strict() }).strict(),
]);
const signals = z.object({ stars: finite.int().nonnegative().max(2_000_000_000), recentActivity: rate, contributionGuide: z.boolean(), ciHealthy: z.boolean(), externalPrAcceptance: rate, topicMatch: rate, maintainerResponse: rate }).strict();
const repository = z.object({ fullName: repositoryName, url: githubUrl, description: z.string().max(2_000), spaces: z.array(z.enum(spaces)).min(1).max(spaces.length), license: z.string().trim().min(1).max(100), isPublic: z.literal(true), signals, evidence: z.array(repositoryEvidence).length(5) }).strict().superRefine((item, ctx) => {
  if (!repoUrl(item.url, item.fullName) || item.evidence.some((entry) => !repoEvidence(entry.sourceUrl, item.fullName))) ctx.addIssue({ code: "custom", message: "Repository identity mismatch" });
  const claims = new Map(item.evidence.map((entry) => [entry.claim, entry]));
  const licenseEvidence = item.evidence.find((entry) => entry.claim === "license");
  if (claims.size !== 5 || licenseEvidence?.verifiedValue.spdxId !== item.license || item.signals.recentActivity <= 0 || !item.signals.contributionGuide || item.signals.externalPrAcceptance <= 0) ctx.addIssue({ code: "custom", message: "Repository verification is incomplete" });
});
const discovered = z.object({ repository, score: rate, explanation: z.object({ inputSignals: signals, weightedContributions: z.array(z.object({ signal: z.string().max(100), weight: rate, value: rate, contribution: rate }).strict()).max(20), evidence: z.array(repositoryEvidence).min(5).max(100), sourceUrls: z.array(githubUrl).min(1).max(100), retrievedAt: z.array(timestamp).min(1).max(100) }).strict() }).strict().superRefine((item, ctx) => { for (const entry of item.explanation.evidence) { const canonical = item.repository.evidence.find((source) => source.id === entry.id); if (canonical === undefined || canonical.sourceUrl !== entry.sourceUrl || canonical.observation !== entry.observation || canonical.retrievedAt !== entry.retrievedAt || canonical.claim !== entry.claim || JSON.stringify(canonical.verifiedValue) !== JSON.stringify(entry.verifiedValue)) ctx.addIssue({ code: "custom", message: "Explanation evidence does not match repository evidence" }); } });
const issue = z.object({ repository: repositoryName, number: finite.int().positive().max(2_000_000_000), title: text, url: githubUrl, clarity: rate, affectedAreas: finite.int().nonnegative().max(10_000), testComplexity: rate, dependencyRisk: rate, estimatedHours: finite.nonnegative().max(100_000), maintainerSignals: z.array(text).max(50) }).strict().superRefine((item, ctx) => { if (!issueUrl(item.url, item.repository, item.number)) ctx.addIssue({ code: "custom", message: "Issue identity mismatch" }); });
const branch = z.string().min(1).max(255).regex(/^(?![./])(?!.*(?:\.\.|\/\/|@\{|\\))[A-Za-z0-9._/-]+(?<![./])$/u);
const baseAction = { repository: repositoryName, issueNumber: finite.int().positive().max(Number.MAX_SAFE_INTEGER) };
const approvalActionSummary = z.discriminatedUnion("action", [
  z.object({ action: z.literal("post_issue_comment"), ...baseAction, body: actionText }).strict(), z.object({ action: z.literal("request_assignment"), ...baseAction, assignee: z.string().min(1).max(39).regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u) }).strict(), z.object({ action: z.literal("push_branch"), ...baseAction, branch, sourceCommitSha: commitSha, targetCommitSha: commitSha }).strict(), z.object({ action: z.literal("create_pr"), ...baseAction, branch, baseBranch: branch, commitSha, title: actionTitle, body: actionText }).strict(), z.object({ action: z.literal("update_pr"), ...baseAction, pullRequest: githubUrl, branch, commitSha, body: actionText }).strict(),
]);
const campaignCore = z.object({ id: campaignId, repository: repositoryName, issueNumber: finite.int().positive().max(Number.MAX_SAFE_INTEGER), issueUrl: githubUrl, parentSessionId: z.string().trim().min(1).max(512), lane: z.enum(["easy_win", "long_term"]), status: campaignStatus, qodoIteration: finite.int().nonnegative().max(3), version: finite.int().positive() }).strict();
type CampaignIdentity = { issueUrl: string; repository: string; issueNumber: number };
function validateCampaignIdentity(value: CampaignIdentity, context: z.core.$RefinementCtx): void { if (!issueUrl(value.issueUrl, value.repository, value.issueNumber)) context.addIssue({ code: "custom", message: "Campaign issue identity mismatch" }); }
const campaignResponse = campaignCore.superRefine(validateCampaignIdentity);
const approvalBrief = z.object({ policy: longText, approach: longText, files: z.array(longText).min(1).max(200), risks: z.array(longText).min(1).max(200), tests: z.array(longText).min(1).max(200), safetyResult: longText, qodoStatus: longText, aiDisclosure: longText }).strict();
const approvalProposal = z.object({ proposalId: identifier, actionDigest: digest, expectedCampaignVersion: finite.int().positive(), action: approvalActionSummary, brief: approvalBrief }).strict();
const publicApproval = z.object({ id: identifier, action: approvalAction, actionDigest: digest, status: z.enum(["pending", "approved", "rejected", "consumed"]), issuedAt: timestamp, expiresAt: timestamp.optional(), consumedAt: timestamp.optional(), proposalId: identifier.optional(), expectedCampaignVersion: finite.int().positive().optional(), isActive: z.boolean() }).strict();
const qodoFinding = z.object({ id: z.string().trim().min(1).max(128), severity: z.enum(["high", "medium", "low", "suggestion"]), status: z.enum(["open", "fixed", "dismissed"]), summary: text, sourceUrl: z.url().max(2_048).refine(githubReviewUrl, "GitHub review URL").optional(), disposition: text.optional() }).strict();
const externalReference = z.object({ kind: z.enum(["issue", "branch", "pull_request", "commit", "sandbox", "child_session", "ci_run"]), value: z.string().trim().min(1).max(2_048) }).strict();
const externalActionClaim = z.object({ id: identifier, approvalId: identifier, action: approvalAction, actionDigest: digest, claimedCampaignVersion: finite.int().positive(), claimedCampaignStatus: campaignStatus, status: z.enum(["active", "outcome_unknown", "completed", "reconciled"]), attemptedAt: timestamp, leaseStartedAt: timestamp, closedAt: timestamp.optional(), disposition: z.enum(["confirmed_completed", "confirmed_not_completed"]).optional() }).strict();
const publicEventType = z.enum(["campaign_created", "campaign_finalized", "campaign_operation_completed", "campaign_operation_rejected", "external_action_proposed", "external_action_attempted", "external_action_completed", "external_action_outcome_unknown", "external_action_reconciled", "external_action_stale_recovered", "interrupted_operation_recovered", "preflight_execution_failed", "implementation_execution_failed", "verification_execution_failed", "qodo_review_claimed", "qodo_finding_recorded", "quality_gate_passed", "quality_gate_escalated", "quality_gate_repair_requested", "repair_execution_failed"]);
const publicEvent = z.object({ id: identifier, eventType: publicEventType, occurredAt: timestamp, sequence: finite.int().positive(), facts: z.record(identifier, z.union([z.string().max(2_048), z.number(), z.boolean()])) }).strict().superRefine((event, context) => {
  if (event.eventType !== "external_action_reconciled") return;
  const allowed = new Set(["action", "disposition", "observedCanonicalHead", "reason", "claimedCampaignVersion", "resultingCampaignVersion"]);
  if (Object.keys(event.facts).some((key) => !allowed.has(key)) ||
    (event.facts.disposition !== undefined && event.facts.disposition !== "confirmed_completed" && event.facts.disposition !== "confirmed_not_completed") ||
    (event.facts.observedCanonicalHead !== undefined && (typeof event.facts.observedCanonicalHead !== "string" || !/^[0-9a-f]{40}$/u.test(event.facts.observedCanonicalHead)))) {
    context.addIssue({ code: "custom", message: "Invalid external action reconciliation facts" });
  }
});
const qualityEscalationReason = z.enum(["maximum_qodo_iterations", "tests_failed", "repair_child_failed", "repair_cancelled", "operation_result_not_safely_recorded", "operator_recovered_interrupted_operation"]);
const issueBrief = z.object({ problem: longText, likelyCause: longText, smallestFix: longText, affectedAreas: z.array(longText).min(1).max(50), tests: z.array(longText).min(1).max(50), risks: z.array(longText).min(1).max(50), uncertainty: longText, evidence: z.array(z.object({ sourceUrl: githubUrl, observation: longText }).strict()).min(1).max(50) }).strict();
const campaignSnapshotResponse = campaignCore.extend({ nextAllowedAction: z.enum(["preflight", "implement", "verify"]).nullable(), issueBrief: issueBrief.nullable(), fixExplanation: fixExplanation.nullable(), evidence: z.array(evidence).max(10_000), events: z.array(publicEvent).max(10_000), approvals: z.array(publicApproval).max(1_000), qodoFindings: z.array(qodoFinding).max(10_000), externalReferences: z.array(externalReference).max(10_000), externalActionClaims: z.array(externalActionClaim).max(1_000), approvalProposal: approvalProposal.nullable(), qualityEscalationReason: qualityEscalationReason.nullable() }).strict().superRefine((value, context) => {
  validateCampaignIdentity(value, context);
  const proposal = value.approvalProposal;
  if (proposal !== null && (proposal.action.repository !== value.repository || proposal.action.issueNumber !== value.issueNumber || proposal.expectedCampaignVersion !== value.version)) context.addIssue({ code: "custom", message: "Approval proposal identity mismatch" });
});
const approvalResponse = z.object({ approval: publicApproval }).strict();
const publicationResult = z.union([
  z.object({ commitSha }).strict(),
  z.object({ pullRequest: githubUrl.refine(pullRequestUrl, "GitHub pull request URL") }).strict(),
]);
const idempotencyKey = z.string().min(8).max(128).regex(/^[\x21-\x7E]+$/u);

export function createOpenQuestApi(options: OpenQuestApiOptions): OpenQuestApi {
  const baseUrl = options.baseUrl ?? "";
  return {
    async getSpaces(signal) { const body = await request(options.fetch, `${baseUrl}/api/spaces`, withSignal({}, signal)); const ids = parsed(z.object({ spaces: z.array(z.enum(spaces)).length(spaces.length) }).strict(), body, "Spaces could not be loaded").spaces; if (new Set(ids).size !== ids.length) throw new OpenQuestApiError("Spaces could not be loaded"); return ids.map((id) => ({ id, ...metadata[id] })); },
    async classifyDiscoveryIntent(message, history, signal) { const input = parsed(z.object({ message: z.string().trim().min(1).max(500), history: z.array(conversationMessage).max(10) }).strict(), { message, history }, "Conversation could not be continued"); const body = await request(options.fetch, `${baseUrl}/api/discovery/classify`, withSignal({ method: "POST", headers: authenticatedHeaders(options.operatorCapability), body: JSON.stringify(input) }, signal)); return parsed(discoveryIntent, body, "Conversation could not be continued"); },
    async discoverRepositories(selected, signal) { const validSpaces = parsed(z.array(z.enum(spaces)).length(1), selected, "Recommendations could not be loaded"); const body = await request(options.fetch, `${baseUrl}/api/discovery/repositories`, withSignal({ method: "POST", headers: authenticatedHeaders(options.operatorCapability), body: JSON.stringify({ spaces: validSpaces }) }, signal)); return parsed(z.object({ repositories: z.array(discovered).max(8) }).strict(), body, "Recommendations could not be loaded").repositories as readonly DiscoveredRepository[]; },
    async getIssues(name, signal) { const [owner, repo, extra] = name.split("/"); if (owner === undefined || repo === undefined || extra !== undefined || !repositoryName.safeParse(name).success) throw new OpenQuestApiError("Issues could not be loaded"); const body = await request(options.fetch, `${baseUrl}/api/discovery/repositories/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, withSignal({}, signal)); const values = parsed(z.object({ issues: z.array(issue).max(200) }).strict(), body, "Issues could not be loaded").issues; if (values.some((value) => value.repository !== name)) throw new OpenQuestApiError("Issues could not be loaded"); return values; },
    async createCampaign(input, signal) { const body = await request(options.fetch, `${baseUrl}/api/campaigns`, withSignal({ method: "POST", headers: authenticatedHeaders(options.operatorCapability), body: JSON.stringify(input) }, signal)); const response = parsed(campaignResponse, body, "Campaign could not be started"); return { id: response.id }; },
    async getCampaign(id, signal) { const validId = parsed(campaignId, id, "Campaign could not be loaded"); const body = await request(options.fetch, `${baseUrl}/api/campaigns/${encodeURIComponent(validId)}`, withSignal({}, signal)); return parsed(campaignSnapshotResponse, body, "Campaign could not be loaded") as CampaignSnapshot; },
    async finalizeCampaign(id, expectedVersion, key, signal) { const validId = parsed(campaignId, id, "Campaign could not be finalized"); const version = parsed(finite.int().positive(), expectedVersion, "Campaign could not be finalized"); const validKey = parsed(idempotencyKey, key, "Campaign could not be finalized"); const body = await request(options.fetch, `${baseUrl}/api/campaigns/${encodeURIComponent(validId)}/finalize`, withSignal({ method: "POST", headers: authenticatedHeaders(options.operatorCapability), body: JSON.stringify({ expectedVersion: version, idempotencyKey: validKey }) }, signal)); return parsed(campaignResponse, body, "Campaign could not be finalized"); },
    async runCampaignAction(id, action, signal) { const validId = parsed(campaignId, id, "Campaign action could not be started"); const validAction = parsed(z.enum(["preflight", "implement", "verify"]), action, "Campaign action could not be started"); const body = await request(options.fetch, `${baseUrl}/api/campaigns/${encodeURIComponent(validId)}/actions/${validAction}`, withSignal({ method: "POST", headers: authenticatedHeaders(options.operatorCapability), body: "{}" }, signal)); return parsed(campaignResponse, body, "Campaign action could not be started"); },
    async issueApproval(campaign, confirmation, key, signal) { const validCampaign = parsed(campaignId, campaign, "Approval could not be issued"); const validConfirmation = parsed(z.object({ proposalId: identifier, actionDigest: digest, expectedCampaignVersion: finite.int().positive() }).strict(), confirmation, "Approval could not be issued"); const validKey = parsed(idempotencyKey, key, "Approval could not be issued"); const body = await request(options.fetch, `${baseUrl}/api/campaigns/${encodeURIComponent(validCampaign)}/approvals`, withSignal({ method: "POST", headers: { ...authenticatedHeaders(options.operatorCapability), "idempotency-key": validKey }, body: JSON.stringify(validConfirmation) }, signal)); return parsed(approvalResponse, body, "Approval could not be issued").approval as PublicApproval; },
    async publishApprovedAction(campaign, approval, action, signal) {
      const validCampaign = parsed(campaignId, campaign, "Publication could not be started");
      const validApproval = parsed(identifier, approval, "Publication could not be started");
      const validAction = parsed(approvalActionSummary, action, "Publication could not be started");
      if (validAction.action !== "push_branch" && validAction.action !== "create_pr") throw new OpenQuestApiError("Only branch pushes and pull requests can be published.");
      const payload = validAction.action === "push_branch"
        ? { action: validAction.action, repository: validAction.repository, issueNumber: validAction.issueNumber, branch: validAction.branch, commitSha: validAction.targetCommitSha }
        : validAction;
      const body = await request(options.fetch, `${baseUrl}/api/campaigns/${encodeURIComponent(validCampaign)}/publish`, withSignal({ method: "POST", headers: authenticatedHeaders(options.operatorCapability), body: JSON.stringify({ approvalId: validApproval, payload }) }, signal));
      const parsedResult = publicationResult.safeParse(body);
      if (!parsedResult.success) throw new OpenQuestApiError("Publication returned an invalid result", undefined, "publication_response_invalid");
      const result = parsedResult.data;
      if ((validAction.action === "push_branch" && !("commitSha" in result)) || (validAction.action === "create_pr" && !("pullRequest" in result))) throw new OpenQuestApiError("Publication returned an unexpected result.", undefined, "publication_response_invalid");
      return result;
    },
  };
}

async function request(fetcher: FetchLike, url: string, init: RequestInit): Promise<unknown> {
  let response: Response;
  try { response = await fetcher(url, init); } catch (error) { if (error instanceof DOMException && error.name === "AbortError") throw error; throw new OpenQuestApiError("OpenQuest is unavailable. Please try again.", undefined, "transport_unavailable"); }
  if (!response.ok) {
    let body: unknown;
    try { body = await response.json() as unknown; } catch { body = undefined; }
    if (typeof body === "object" && body !== null && "code" in body && typeof body.code === "string" && "message" in body && typeof body.message === "string") throw new OpenQuestApiError(body.message, response.status, body.code);
    throw new OpenQuestApiError(response.status === 409 ? "This request conflicts with current campaign state." : "OpenQuest could not complete that request. Please try again.", response.status);
  }
  try { return await response.json() as unknown; } catch { throw new OpenQuestApiError("OpenQuest returned an invalid response. Please try again.", undefined, "invalid_response"); }
}
function authenticatedHeaders(provider: OpenQuestApiOptions["operatorCapability"]): Record<string, string> { const value = provider?.(); if (value === undefined || value.trim() === "") throw new OpenQuestApiError("Connect an operator capability before authenticated actions.", undefined, "operator_capability_missing"); return { "content-type": "application/json", authorization: `Bearer ${value}` }; }
function withSignal(init: RequestInit, signal: AbortSignal | undefined): RequestInit { return signal === undefined ? init : { ...init, signal }; }
function parsed<T>(schema: z.ZodType<T>, body: unknown, message: string): T { const result = schema.safeParse(body); if (!result.success) throw new OpenQuestApiError(message); return result.data; }
function github(value: string): boolean { try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "github.com" && url.username === "" && url.password === "" && url.port === "" && url.search === "" && url.hash === ""; } catch { return false; } }
function githubReviewUrl(value: string): boolean { try { const url = new URL(value); return url.protocol === "https:" && url.hostname === "github.com" && url.username === "" && url.password === "" && url.port === "" && url.search === "" && /^\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*(?:\/files)?$/u.test(url.pathname) && (url.hash === "" || /^#(?:discussion_r|r)[1-9][0-9]*$/u.test(url.hash)); } catch { return false; } }
function repoUrl(value: string, name: string): boolean { try { return new URL(value).pathname === `/${name}`; } catch { return false; } }
function repoEvidence(value: string, name: string): boolean { try { return new URL(value).pathname.split("/").slice(1, 3).join("/") === name; } catch { return false; } }
function issueUrl(value: string, name: string, number: number): boolean { try { return new URL(value).pathname === `/${name}/issues/${String(number)}`; } catch { return false; } }
function pullRequestUrl(value: string): boolean { try { return /^\/[^/]+\/[^/]+\/pull\/[1-9][0-9]*$/u.test(new URL(value).pathname); } catch { return false; } }
