import type { Campaign } from "../../domain/campaign.js";

export type CampaignAction = "preflight" | "implement" | "verify";

interface CampaignActionsProps {
  readonly status: Campaign["status"];
  readonly action: CampaignAction | null;
  readonly onRun: (action: CampaignAction) => void;
  readonly running?: CampaignAction | undefined;
}

const copy: Readonly<Record<CampaignAction, { readonly eyebrow: string; readonly title: string; readonly description: string; readonly button: string }>> = {
  preflight: {
    eyebrow: "Safe first pass",
    title: "Run static preflight",
    description: "Inspect repository policy, paths, lifecycle hooks, credentials, and network behavior before any dependency or repository script can run.",
    button: "Start static preflight",
  },
  implement: {
    eyebrow: "Isolated contribution",
    title: "Run implementation",
    description: "Create a fresh sandbox session for the smallest defensible patch. No GitHub write occurs at this stage.",
    button: "Run isolated implementation",
  },
  verify: {
    eyebrow: "Independent evidence",
    title: "Run verification",
    description: "Verify the candidate commit in a fresh sandbox before any exact external proposal can become available.",
    button: "Run verification",
  },
};

export function CampaignActions({ status, action, onRun, running }: CampaignActionsProps) {
  if (action === null) {
    return <section className="campaign-panel action-panel" aria-labelledby="campaign-actions-heading">
      <p className="eyebrow">Campaign controls</p>
      <h2 id="campaign-actions-heading">Awaiting the next verified state</h2>
      <p>This campaign is {status.replaceAll("_", " ")}. Its next action is determined by durable evidence and the approval boundary.</p>
    </section>;
  }
  const details = copy[action];
  return <section className="campaign-panel action-panel" aria-labelledby="campaign-actions-heading">
    <div className="panel-heading"><div><p className="eyebrow">{details.eyebrow}</p><h2 id="campaign-actions-heading">{details.title}</h2></div><span className="status-pill">{status.replaceAll("_", " ")}</span></div>
    <p>{details.description}</p>
    <button className="primary-action" disabled={running !== undefined} onClick={() => { onRun(action); }} type="button">{running === action ? "Starting isolated session…" : details.button}</button>
    <p className="action-note">This records a durable operation claim before work starts. If the provider cannot prove a safe result, the campaign stops for review.</p>
  </section>;
}
