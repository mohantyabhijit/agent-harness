import { z } from "zod";

const ConfigSchema = z
  .object({
    PORT: z.coerce.number().int().positive().max(65_535).default(8788),
    DATABASE_PATH: z.string().trim().min(1).max(4_096).default("openquest.sqlite"),
    TRUEFORGE_BASE_URL: z.url().default("http://localhost:8790"),
  })
  .strict();

export type ServerConfig = z.infer<typeof ConfigSchema>;

export function parseConfig(environment: NodeJS.ProcessEnv): ServerConfig {
  return ConfigSchema.parse({
    PORT: environment.PORT,
    DATABASE_PATH: environment.DATABASE_PATH,
    TRUEFORGE_BASE_URL: environment.TRUEFORGE_BASE_URL,
  });
}
