import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/sdk/index.ts",
    promise: "src/promise.ts",
    api: "src/api/index.ts",
    react: "src/react/index.ts",
    presets: "src/sdk/presets.ts",
  },
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: [/^@executor\//, /^effect/, /^@effect\//],
});
