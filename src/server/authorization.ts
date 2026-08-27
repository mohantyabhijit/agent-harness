import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import { ApiProblem } from "./routes/support.js";

export type Capability = "operator" | "review_provider";
export interface AuthorizationPolicy { require(request: FastifyRequest, capability: Capability): void; }

export function bearerAuthorizationPolicy(tokens: { operator: string; reviewProvider?: string }): AuthorizationPolicy {
  return {
    require(request, capability) {
      const authorization = request.headers.authorization;
      if (authorization === undefined) throw new ApiProblem(401, "unauthorized", "Bearer authorization is required");
      const expected = capability === "operator" ? tokens.operator : tokens.reviewProvider;
      if (expected === undefined) throw new ApiProblem(403, "forbidden", "Capability is not available");
      const prefix = "Bearer ";
      const supplied = authorization.startsWith(prefix) ? authorization.slice(prefix.length) : "";
      const actualBytes = createHash("sha256").update(supplied).digest();
      const expectedBytes = createHash("sha256").update(expected).digest();
      const valid = timingSafeEqual(actualBytes, expectedBytes);
      if (!valid) throw new ApiProblem(403, "forbidden", "Capability is not permitted");
    },
  };
}
