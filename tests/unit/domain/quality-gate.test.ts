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

  it("requires a non-blank disposition for every remaining low or suggestion finding", () => {
    const lowFinding = [{ id: "q1", severity: "low" as const, status: "open" as const, summary: "clarify retry" }];
    const suggestion = [{ id: "q2", severity: "suggestion" as const, status: "open" as const, summary: "rename method", disposition: "  " }];

    expect(evaluateQualityGate({ testsPassed: true, iteration: 1, findings: lowFinding })).toEqual({ outcome: "repair", nextIteration: 2 });
    expect(evaluateQualityGate({ testsPassed: true, iteration: 1, findings: suggestion })).toEqual({ outcome: "repair", nextIteration: 2 });
  });

  it("keeps open high findings actionable even with a disposition", () => {
    const findings = [{ id: "q1", severity: "high" as const, status: "open" as const, summary: "unsafe retry", disposition: "Will fix" }];

    expect(evaluateQualityGate({ testsPassed: true, iteration: 1, findings })).toEqual({ outcome: "repair", nextIteration: 2 });
  });

  it.each([-1, Number.NaN, 1.5, 4])("rejects invalid iteration %s", (iteration) => {
    expect(() => evaluateQualityGate({ testsPassed: true, iteration, findings: [] })).toThrow(/invalid quality iteration/i);
  });
});
