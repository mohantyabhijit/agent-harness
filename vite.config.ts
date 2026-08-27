import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  base: process.env.NODE_ENV === "production" ? "/openquest/" : "/",
  server: { proxy: { "/api": "http://localhost:8788" } },
  build: { emptyOutDir: false },
});
