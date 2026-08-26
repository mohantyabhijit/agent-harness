import Fastify from "fastify";

const port = Number(process.env.PORT ?? 8788);
const app = Fastify({ logger: true });

app.get("/api/healthz", async () => ({ status: "ok" }));

await app.listen({ host: "127.0.0.1", port });
