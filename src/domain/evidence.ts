export interface Evidence {
  id: string;
  sourceUrl: string;
  retrievedAt: string;
  observation: string;
  kind: "direct" | "inference";
}
