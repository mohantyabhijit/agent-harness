export interface QodoFinding {
  id: string;
  severity: "high" | "medium" | "low" | "suggestion";
  status: "open" | "fixed" | "dismissed";
  summary: string;
  sourceUrl?: string;
  disposition?: string;
}

export type QualityGateResult =
  | { outcome: "pass" }
  | { outcome: "repair"; nextIteration: number }
  | { outcome: "escalate"; reason: "maximum_qodo_iterations" | "tests_failed" };

export function evaluateQualityGate(input: {
  testsPassed: boolean;
  iteration: number;
  findings: readonly QodoFinding[];
}): QualityGateResult {
  if (!input.testsPassed && input.iteration >= 3) {
    return { outcome: "escalate", reason: "tests_failed" };
  }

  const actionable = input.findings.some(
    (finding) =>
      finding.status === "open" &&
      (finding.severity === "high" || finding.severity === "medium"),
  );
  const dismissedFindingsHaveDispositions = input.findings.every(
    (finding) => finding.status !== "dismissed" || Boolean(finding.disposition),
  );

  if (input.testsPassed && !actionable && dismissedFindingsHaveDispositions) {
    return { outcome: "pass" };
  }
  if (input.iteration >= 3) {
    return { outcome: "escalate", reason: "maximum_qodo_iterations" };
  }

  return { outcome: "repair", nextIteration: input.iteration + 1 };
}
