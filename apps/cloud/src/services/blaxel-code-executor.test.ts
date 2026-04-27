import { describe, expect, it } from "vitest";

import { buildExecutorModule } from "./blaxel-code-executor";

describe("buildExecutorModule", () => {
  it("prebinds Bun shell syntax for generated sandbox modules", () => {
    const moduleSource = buildExecutorModule({
      callbackToken: "token",
      callbackUrl: "https://example.com/callback",
      code: 'return await $`pwd`.text();',
      returnDirectory: "/tmp/godtool-execution-returns/run_123",
      runId: "run_123",
      timeoutMs: 5_000,
    });

    expect(moduleSource).toContain('import { $ } from "bun";');
    expect(moduleSource).toContain("return await $`pwd`.text();");
  });

  it("bootstraps scaffold files into the sandbox workspace", () => {
    const moduleSource = buildExecutorModule({
      callbackToken: "token",
      callbackUrl: "https://example.com/callback",
      code: "return 'ok';",
      returnDirectory: "/tmp/godtool-execution-returns/run_123",
      runId: "run_123",
      timeoutMs: 5_000,
    });

    expect(moduleSource).toContain('const __workspaceRoot = "/workspace";');
    expect(moduleSource).toContain('await __ensureScaffold();');
    expect(moduleSource).toContain('"path":"MEMORY.md"');
    expect(moduleSource).toContain('"path":"SYSTEM.md"');
  });
});
