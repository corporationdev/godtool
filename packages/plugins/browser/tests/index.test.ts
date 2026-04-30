import { describe, expect, it } from "vitest";

import { createExecutor } from "@executor/sdk/promise";

import { browserPlugin } from "../src";

describe("browserPlugin", () => {
  it("exposes the built-in source as browser_use", async () => {
    const executor = await createExecutor({ plugins: [browserPlugin()] as const });

    const sources = await executor.sources.list();
    expect(sources.find((source) => source.id === "browser_use")).toMatchObject({
      id: "browser_use",
      kind: "browser_use",
      name: "browser_use",
      canRemove: false,
      runtime: true,
    });

    await executor.close();
  });

  it("exposes browser actions instead of session lifecycle plumbing", async () => {
    const executor = await createExecutor({ plugins: [browserPlugin()] as const });

    const tools = await executor.tools.list();
    const names = tools
      .filter((tool) => tool.id.startsWith("browser_use."))
      .map((tool) => tool.id.replace("browser_use.", ""))
      .sort();

    expect(names).toContain("open");
    expect(names).toContain("click");
    expect(names).toContain("snapshot");
    expect(names).toContain("getUrl");
    expect(names).toContain("listSessions");
    expect(names).toContain("archiveSession");
    expect(names).not.toContain("ensureSession");
    expect(names).not.toContain("touchSession");
    expect(names).not.toContain("runAgentBrowser");

    await executor.close();
  });

  it("describes screenshot output for direct SDK and executor MCP callers", async () => {
    const executor = await createExecutor({ plugins: [browserPlugin()] as const });

    const tools = await executor.tools.list();
    const screenshot = tools.find((tool) => tool.id === "browser_use.screenshot");

    expect(screenshot?.description).toContain("Direct SDK calls return base64 data");
    expect(screenshot?.description).toContain("executor MCP emits inline image content");

    await executor.close();
  });

  it("uses optional sessionName instead of required agentId", async () => {
    const executor = await createExecutor({ plugins: [browserPlugin()] as const });

    const tools = await executor.tools.list();
    const open = tools.find((tool) => tool.id === "browser_use.open");
    const schema = open?.inputSchema as {
      readonly required?: readonly string[];
      readonly properties?: Record<string, unknown>;
    };

    expect(schema.required).toEqual(["url"]);
    expect(schema.properties).toHaveProperty("sessionName");
    expect(schema.properties).not.toHaveProperty("agentId");

    await executor.close();
  });

  it("describes sessionName as create-or-reuse and default-switching", async () => {
    const executor = await createExecutor({ plugins: [browserPlugin()] as const });

    const tools = await executor.tools.list();
    const open = tools.find((tool) => tool.id === "browser_use.open");
    const listSessions = tools.find((tool) => tool.id === "browser_use.listSessions");
    const schema = open?.inputSchema as {
      readonly properties?: {
        readonly sessionName?: { readonly description?: string };
      };
    };

    expect(open?.description).toContain("Creates the default session when omitted");
    expect(open?.description).toContain("creates/reuses sessionName when provided");
    expect(open?.description).toContain("makes it the caller's default");
    expect(listSessions?.description).toContain("create/reuse and switch their default session");
    expect(schema.properties?.sessionName?.description).toContain(
      "If it does not exist, it is created",
    );
    expect(schema.properties?.sessionName?.description).toContain(
      "makes it the caller's default for later browser calls",
    );

    await executor.close();
  });
});
