import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@executor/config": new URL("../../core/config/src/index.ts", import.meta.url).pathname,
      "@executor/sdk": new URL("../../core/sdk/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
