import { randomUUID } from "node:crypto";

import { TrueForge } from "@truefoundry/trueforge-sdk";
import Database from "better-sqlite3";

import { SqliteCampaignStore } from "../adapters/sqlite/campaign-store.js";
import { TrueForgeGithubCatalog } from "../adapters/trueforge/github-catalog.js";
import { TrueForgeHarness } from "../adapters/trueforge/harness.js";
import type { AppDependencies } from "./app.js";
import type { ServerConfig } from "./config.js";

export interface ServerContainer {
  readonly dependencies: AppDependencies;
  close(): Promise<void>;
}

export function createContainer(config: ServerConfig): ServerContainer {
  const database = new Database(config.DATABASE_PATH);
  const store = new SqliteCampaignStore(database);
  const client = new TrueForge({ baseUrl: config.TRUEFORGE_BASE_URL });
  const harness = new TrueForgeHarness(client);
  const clock = { now: () => new Date().toISOString() };
  const ids = { next: () => randomUUID() };
  const dependencies: AppDependencies = {
    store,
    harness,
    catalog: new TrueForgeGithubCatalog(harness),
    clock,
    ids,
  };
  return {
    dependencies,
    async close() {
      if (database.open) database.close();
    },
  };
}
