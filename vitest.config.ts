import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    clearMocks: true,
    coverage: { reporter: ["text", "html"], include: ["src/**/*.{ts,tsx}"] },
  },
});
