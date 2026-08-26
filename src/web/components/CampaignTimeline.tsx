import type { CampaignSnapshot } from "../api.js";

interface CampaignTimelineProps { readonly events: CampaignSnapshot["events"]; readonly approvals: CampaignSnapshot["approvals"]; }

const eventLabels: Readonly<Record<string, string>> = {
  campaign_created: "Campaign created",
  campaign_operation_completed: "Campaign operation completed",
  campaign_operation_rejected: "Campaign operation rejected",
  external_action_proposed: "External action proposed",
  external_action_attempted: "External action attempted",
  external_action_completed: "External action completed",
  external_action_outcome_unknown: "External action outcome unknown",
  external_action_reconciled: "External action reconciled",
  external_action_stale_recovered: "Stale external action recovered",
  interrupted_operation_recovered: "Interrupted operation recovered",
  preflight_execution_failed: "Preflight quarantined",
  implementation_execution_failed: "Implementation escalated",
  verification_execution_failed: "Verification escalated",
};

export function CampaignTimeline({ events, approvals }: CampaignTimelineProps) {
  const entries = [
    ...events.map((event) => ({ id: `event-${event.id}`, occurredAt: event.occurredAt, label: eventLabels[event.eventType] ?? humanize(event.eventType), facts: event.facts })),
    ...approvals.map((approval) => ({ id: `approval-${approval.id}`, occurredAt: approval.consumedAt ?? approval.issuedAt, label: `${approvalActionName(approval.action)} approval ${approval.status}`, facts: approval.consumedAt === undefined ? { issuedAt: approval.issuedAt } : { issuedAt: approval.issuedAt, consumedAt: approval.consumedAt } })),
  ].toSorted((left, right) => left.occurredAt.localeCompare(right.occurredAt) || left.id.localeCompare(right.id));
  return <section aria-labelledby="timeline-heading" className="campaign-panel">
    <div className="panel-heading"><div><p className="eyebrow">Durable history</p><h2 id="timeline-heading">Campaign timeline</h2></div><span className="fact-count">{events.length} events · {approvals.length} approvals</span></div>
    {entries.length === 0 ? <p>No durable campaign events have been recorded yet.</p> : <ol className="campaign-timeline">
      {entries.map((entry) => <li key={entry.id}>
        <span aria-hidden="true" className="timeline-marker" />
        <div><strong>{entry.label}</strong><time dateTime={entry.occurredAt}>{formatTimestamp(entry.occurredAt)}</time>{Object.keys(entry.facts).length === 0 ? null : <dl className="timeline-facts">{Object.entries(entry.facts).map(([key, value]) => <div key={key}><dt>{humanize(key)}</dt><dd>{String(value)}</dd></div>)}</dl>}</div>
      </li>)}
    </ol>}
  </section>;
}

function humanize(value: string): string { return value.replace(/([a-z])([A-Z])/gu, "$1 $2").split("_").map((word) => `${word.slice(0, 1).toUpperCase()}${word.slice(1)}`).join(" "); }
function formatTimestamp(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)); }
function approvalActionName(value: CampaignSnapshot["approvals"][number]["action"]): string { return ({ post_issue_comment: "Issue comment", request_assignment: "Assignment request", push_branch: "Branch push", create_pr: "Pull request", update_pr: "Pull request update" })[value]; }
