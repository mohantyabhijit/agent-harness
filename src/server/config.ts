import { z } from "zod";

const capabilityTokenSchema = z.string().min(32).max(512).refine((value) => new Set(value).size >= 12, "Capability token lacks entropy");

const ConfigSchema = z
  .object({
    PORT: z.coerce.number().int().positive().max(65_535).default(8788),
    DATABASE_PATH: z.string().trim().min(1).max(4_096).default("openquest.sqlite"),
    TRUEFORGE_BASE_URL: z.url().default("http://localhost:8790"),
    QODO_POLL_INTERVAL_MS: z.coerce.number().int().min(10_000).max(86_400_000).default(60_000),
    QODO_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(10).max(30_000).default(5_000),
    OPERATOR_BEARER_TOKEN: capabilityTokenSchema,
    REVIEW_PROVIDER_BEARER_TOKEN: capabilityTokenSchema,
  })
  .strict().superRefine((value, context) => {
    if (value.OPERATOR_BEARER_TOKEN === value.REVIEW_PROVIDER_BEARER_TOKEN) context.addIssue({ code: "custom", message: "Capability tokens must be distinct" });
  });

export type ServerConfig = z.infer<typeof ConfigSchema>;

export function parseConfig(environment: NodeJS.ProcessEnv): ServerConfig {
  return ConfigSchema.parse({
    PORT: environment.PORT,
    DATABASE_PATH: environment.DATABASE_PATH,
    TRUEFORGE_BASE_URL: environment.TRUEFORGE_BASE_URL,
    QODO_POLL_INTERVAL_MS: environment.QODO_POLL_INTERVAL_MS,
    QODO_SHUTDOWN_TIMEOUT_MS: environment.QODO_SHUTDOWN_TIMEOUT_MS,
    OPERATOR_BEARER_TOKEN: environment.OPERATOR_BEARER_TOKEN,
    REVIEW_PROVIDER_BEARER_TOKEN: environment.REVIEW_PROVIDER_BEARER_TOKEN,
  });
}
