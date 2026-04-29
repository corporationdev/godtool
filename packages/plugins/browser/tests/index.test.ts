import { describe, expect, it } from "vitest";

import { createExecutor } from "@executor/sdk/promise";

import { browserPlugin } from "../src";

describe("browserPlugin", () => {
  it("exposes browser actions instead of session lifecycle plumbing", async () => {
    const executor = await createExecutor({ plugins: [browserPlugin()] as const });

    const tools = await executor.tools.list();
    const names = tools
      .filter((tool) => tool.id.startsWith("browser."))
      .map((tool) => tool.id.replace("browser.", ""))
      .sort();

    expect(names).toContain("open");
    expect(names).toContain("click");
    expect(names).toContain("snapshot");
    expect(names).toContain("getUrl");
    expect(names).not.toContain("ensureSession");
    expect(names).not.toContain("touchSession");
    expect(names).not.toContain("listSessions");
    expect(names).not.toContain("runAgentBrowser");

    await executor.close();
  });

  it("describes screenshot output for direct SDK and executor MCP callers", async () => {
    const executor = await createExecutor({ plugins: [browserPlugin()] as const });

    const tools = await executor.tools.list();
    const screenshot = tools.find((tool) => tool.id === "browser.screenshot");

    expect(screenshot?.description).toContain("Direct SDK calls return base64 data");
    expect(screenshot?.description).toContain("executor MCP emits inline image content");

    await executor.close();
  });
});
