import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const operatorCapability = process.env.OPERATOR_BEARER_TOKEN;
const trueForgeToken = process.env.TRUEFORGE_TOKEN;

function applyBearer(request: { setHeader(name: string, value: string): void }, token: string | undefined): void {
  if (token === undefined || token.length === 0) return;
  request.setHeader("authorization", `Bearer ${token}`);
}

export default defineConfig({
  plugins: [react()],
  base: process.env.NODE_ENV === "production" ? "/openquest/" : "/",
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8788",
        configure(proxy) {
          if (operatorCapability === undefined || operatorCapability.length === 0) return;
          proxy.on("proxyReq", (request) => {
            request.setHeader("authorization", `Bearer ${operatorCapability}`);
          });
        },
      },
      "/trueforge": {
        target: "http://localhost:8790",
        changeOrigin: true,
        ws: true,
        rewrite: (path) => path.replace(/^\/trueforge/u, ""),
        configure(proxy) {
          proxy.on("proxyReq", (request) => { applyBearer(request, trueForgeToken); });
          proxy.on("proxyReqWs", (request) => { applyBearer(request, trueForgeToken); });
        },
      },
    },
  },
  build: { emptyOutDir: false },
});
