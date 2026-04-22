import { describe, expect, it } from "vitest";

import { buildExecutorModule } from "./blaxel-code-executor";

describe("buildExecutorModule", () => {
  it("prebinds Bun shell syntax for generated sandbox modules", () => {
    const moduleSource = buildExecutorModule({
      callbackToken: "token",
      callbackUrl: "https://example.com/callback",
      code: 'return await $`pwd`.text();',
      runId: "run_123",
      timeoutMs: 5_000,
    });

    expect(moduleSource).toContain('import { $ } from "bun";');
    expect(moduleSource).toContain("return await $`pwd`.text();");
  });
});
