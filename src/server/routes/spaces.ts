import type { FastifyInstance } from "fastify";

import { spaces } from "../../domain/discovery.js";

export function registerSpaceRoutes(app: FastifyInstance): void {
  app.get("/api/spaces", async () => ({ spaces }));
}
