import { describe, expect, it } from "vitest";
import { evaluateQualityGate } from "../../../src/domain/quality-gate.js";

describe("evaluateQualityGate", () => {
  it("passes only with tests and no actionable high/medium findings", () => {
    expect(evaluateQualityGate({ testsPassed: true, iteration: 1, findings: [] })).toEqual({ outcome: "pass" });
  });

  it("escalates after the third failed repair iteration", () => {
    const findings = [{ id: "q1", severity: "high" as const, status: "open" as const, summary: "unsafe retry" }];
    expect(evaluateQualityGate({ testsPassed: true, iteration: 3, findings })).toEqual({ outcome: "escalate", reason: "maximum_qodo_iterations" });
  });
});
