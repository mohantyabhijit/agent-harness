#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { classifyIssue, rankRepository, qualityGate } from './domain.js';

const fixture = JSON.parse(await readFile(new URL('../data/fastapi-recent-mrs.json', import.meta.url)));
const repo = rankRepository(fixture.repository);
const issues = fixture.candidateIssues.map(issue => ({ ...issue, ...classifyIssue(issue) }));
const gate = qualityGate({ testsPassed: true, lintPassed: true, securityPassed: true, actionableFindings: 0, iterations: 1 });
console.log(JSON.stringify({ repository: repo, mergedPullRequests: fixture.mergedPullRequests, candidateIssues: issues, qualityGate: gate }, null, 2));
