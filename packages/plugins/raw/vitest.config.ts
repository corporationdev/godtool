import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@executor/config/runtime": new URL(
        "../../core/config/src/runtime.ts",
        import.meta.url,
      ).pathname,
      "@executor/config/stage": new URL(
        "../../core/config/src/stage.ts",
        import.meta.url,
      ).pathname,
      "@executor/config/stage-kind": new URL(
        "../../core/config/src/stage-kind.ts",
        import.meta.url,
      ).pathname,
      "@executor/config": new URL("../../core/config/src/index.ts", import.meta.url).pathname,
      "@executor/sdk": new URL("../../core/sdk/src/index.ts", import.meta.url).pathname,
    },
  },
  test: {
    include: ["src/**/*.test.ts"],
  },
});
