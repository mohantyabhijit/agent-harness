import test from 'node:test';
import assert from 'node:assert/strict';
import { buildContributionBrief, canTransition, classifyIssue, isApprovalValid, qualityGate, rankRepository, validateEvidence } from '../src/domain.js';

test('ranks active, contribution-ready repositories', () => {
  const result = rankRepository({ stars: 100000, pushedAt: '2026-08-27T00:00:00Z', hasContributing: true, hasCi: true, hasLicense: true, externalReview: true }, new Date('2026-08-28T00:00:00Z'));
  assert.ok(result.score >= 90);
  assert.match(result.reasons[1], /active/);
});

test('classifies focused issues as easy wins', () => {
  const result = classifyIssue({ clearScope: true, hasAcceptanceCriteria: true, hasTests: true, lowSurfaceArea: true, activeContributor: false, estimatedHours: 4 });
  assert.deepEqual(result, { classification: 'easy-win', confidence: 100, signals: 5 });
});

test('routes ambiguous issues to long-term challenges', () => {
  assert.equal(classifyIssue({ clearScope: true, hasAcceptanceCriteria: false, hasTests: false, lowSurfaceArea: false, activeContributor: true, estimatedHours: 12 }).classification, 'long-term-challenge');
});

test('enforces campaign transitions and terminal states', () => {
  assert.equal(canTransition('discovery', 'policy-review'), true);
  assert.equal(canTransition('merged', 'repair'), false);
  assert.equal(canTransition('implementation', 'merged'), false);
});

test('approval is single-use, action-scoped, and expires', () => {
  const approval = { action: 'create-pr', expiresAt: '2026-08-29T00:00:00Z', used: false };
  assert.equal(isApprovalValid(approval, 'create-pr', new Date('2026-08-28T00:00:00Z')), true);
  assert.equal(isApprovalValid({ ...approval, used: true }, 'create-pr', new Date('2026-08-28T00:00:00Z')), false);
  assert.equal(isApprovalValid(approval, 'push-branch', new Date('2026-08-28T00:00:00Z')), false);
});

test('quality gate fails on unresolved findings or fourth iteration', () => {
  assert.equal(qualityGate({ testsPassed: true, lintPassed: true, securityPassed: true, actionableFindings: 0, iterations: 3 }).passed, true);
  assert.equal(qualityGate({ testsPassed: true, lintPassed: true, securityPassed: true, actionableFindings: 1, iterations: 1 }).passed, false);
  assert.equal(qualityGate({ testsPassed: true, lintPassed: true, securityPassed: true, actionableFindings: 0, iterations: 4 }).passed, false);
});

test('briefs reject incomplete evidence and preserve AI disclosure', () => {
  const evidence = [{ source: 'https://github.com/fastapi/fastapi/pull/16252', retrievedAt: '2026-08-28T00:00:00Z', observation: 'Dependency update merged.', kind: 'direct' }];
  assert.equal(validateEvidence(evidence), true);
  const brief = buildContributionBrief({ repo: { fullName: 'fastapi/fastapi' }, issue: { number: 1, title: 'Improve docs' }, diff: 'Add a focused example.', evidence, checks: ['npm test'] });
  assert.match(brief.aiDisclosure, /AI assistance/);
  assert.throws(() => buildContributionBrief({ repo: { fullName: 'fastapi/fastapi' }, issue: { number: 1, title: 'x' }, diff: 'x', evidence: [{}], checks: [] }), /complete/);
});
