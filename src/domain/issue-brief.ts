export interface IssueBrief {
  readonly problem: string;
  readonly likelyCause: string;
  readonly smallestFix: string;
  readonly affectedAreas: readonly string[];
  readonly tests: readonly string[];
  readonly risks: readonly string[];
  readonly uncertainty: string;
  readonly evidence: readonly { readonly sourceUrl: string; readonly observation: string }[];
}

export function isSourceBackedIssueBrief(value: unknown): value is IssueBrief {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const brief = value as Record<string, unknown>;
  const allowed = new Set(["problem", "likelyCause", "smallestFix", "affectedAreas", "tests", "risks", "uncertainty", "evidence"]);
  if (Object.keys(brief).some((key) => !allowed.has(key))) return false;
  const textFields = ["problem", "likelyCause", "smallestFix", "uncertainty"];
  if (textFields.some((key) => !boundedText(brief[key]))) return false;
  if (!["affectedAreas", "tests", "risks", "evidence"].every((key) => Array.isArray(brief[key]))) return false;
  if (![brief.affectedAreas, brief.tests, brief.risks].every((items) => {
    const values = items as unknown[];
    return values.length > 0 && values.length <= 50 && values.every(boundedText);
  })) return false;
  const evidence = brief.evidence as unknown[];
  return evidence.length > 0 && evidence.length <= 50 && evidence.every((item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const record = item as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== "sourceUrl" && key !== "observation") || !boundedText(record.observation)) return false;
    try { const url = new URL(String(record.sourceUrl)); return url.protocol === "https:" && url.hostname === "github.com" && url.username === "" && url.password === "" && url.port === ""; } catch { return false; }
  });
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length >= 3 && value.length <= 2_000;
}
