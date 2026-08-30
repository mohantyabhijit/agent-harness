import { buildApp } from "./app.js";
import { parseConfig } from "./config.js";
import { createContainer } from "./container.js";

const config = parseConfig(process.env);
const container = createContainer(config);
const app = buildApp(container.dependencies);
let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  await container.reviewJob.stop();
  await app.close();
  await container.close();
}

process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });

try {
  await app.listen({ host: "127.0.0.1", port: config.PORT });
  container.reviewJob.start();
  void container.warmDiscoverySnapshots();
} catch (error) {
  await shutdown();
  throw error;
}
