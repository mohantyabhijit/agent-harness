const TERMINAL_CAMPAIGN_STATES = new Set(['merged', 'closed', 'withdrawn']);

export function rankRepository(repo, now = new Date()) {
  const activityDays = Math.max(0, (now - new Date(repo.pushedAt)) / 86400000);
  const activity = Math.max(0, 30 - activityDays) / 30;
  const stars = Math.min(1, Math.log10(Math.max(1, repo.stars)) / 6);
  const readiness = [repo.hasContributing, repo.hasCi, repo.hasLicense, repo.externalReview].filter(Boolean).length / 4;
  const score = Math.round((stars * 0.35 + activity * 0.2 + readiness * 0.45) * 100);
  return { ...repo, score, reasons: [`${repo.stars.toLocaleString()} stars`, activityDays < 14 ? 'active in the last 14 days' : 'recently active', `${Math.round(readiness * 4)}/4 contribution-readiness signals`] };
}

export function classifyIssue(issue) {
  const signals = [issue.clearScope, issue.hasAcceptanceCriteria, issue.hasTests, issue.lowSurfaceArea, !issue.activeContributor].filter(Boolean).length;
  const classification = signals >= 4 && issue.estimatedHours <= 8 ? 'easy-win' : 'long-term-challenge';
  return { classification, confidence: Math.round((signals / 5) * 100), signals };
}

export function validateEvidence(evidence) {
  return evidence.every(item => item.source && item.retrievedAt && item.observation && ['direct', 'inference'].includes(item.kind));
}

export function canTransition(from, to) {
  if (TERMINAL_CAMPAIGN_STATES.has(from)) return false;
  const allowed = {
    discovery: ['policy-review'], 'policy-review': ['coordination-pending', 'preflight'],
    'coordination-pending': ['preflight'], preflight: ['quarantined', 'baseline'],
    quarantined: ['human-escalation'], baseline: ['implementation'], implementation: ['verification'],
    verification: ['contribution-approval'], 'contribution-approval': ['pull-request-open'],
    'pull-request-open': ['qodo-review'], 'qodo-review': ['repair', 'merged', 'human-escalation'],
    repair: ['qodo-review', 'human-escalation'], 'human-escalation': ['withdrawn']
  };
  return allowed[from]?.includes(to) ?? false;
}

export function isApprovalValid(approval, action, now = new Date()) {
  return Boolean(approval && !approval.used && approval.action === action && new Date(approval.expiresAt) > now);
}

export function qualityGate({ testsPassed, lintPassed, securityPassed, actionableFindings, iterations }) {
  return { passed: testsPassed && lintPassed && securityPassed && actionableFindings === 0 && iterations <= 3, reason: testsPassed && lintPassed && securityPassed && actionableFindings === 0 && iterations <= 3 ? 'All required gates pass.' : 'One or more required gates remain unresolved.' };
}

export function buildContributionBrief({ repo, issue, diff, evidence, checks }) {
  if (!validateEvidence(evidence)) throw new Error('Contribution brief requires complete, typed evidence.');
  return { repository: repo.fullName, issue: issue.number, title: issue.title, proposedChange: diff, evidence, checks, aiDisclosure: 'This change was prepared with AI assistance and must be reviewed by maintainers.' };
}
