import { describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";

import { createExecutor } from "@executor/sdk/promise";

import { computerUsePlugin } from "../src";

const listen = (server: Server): Promise<string> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        resolve(`http://127.0.0.1:${address.port}`);
      } else {
        reject(new Error("test server did not bind to a TCP port"));
      }
    });
  });

const close = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });

describe("computerUsePlugin", () => {
  it("does not expose computer use actions until the source is connected", async () => {
    const executor = await createExecutor({ plugins: [computerUsePlugin()] as const });

    const tools = await executor.tools.list();
    const names = tools
      .filter((tool) => tool.id.startsWith("computer_use."))
      .map((tool) => tool.id.replace("computer_use.", ""))
      .sort();

    expect(names).toEqual([]);

    await executor.close();
  });

  it("connects the source when permissions are granted", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/permissions/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ accessibility: true, screenRecording: true }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    const hostUrl = await listen(server);
    const executor = await createExecutor({
      plugins: [computerUsePlugin({ hostUrl })] as const,
    });

    try {
      await executor.computer_use.addSource({ scope: "default-scope" });

      const sources = await executor.sources.list();
      expect(sources.find((source) => source.id === "computer_use")).toMatchObject({
        id: "computer_use",
        kind: "computer_use",
        name: "Computer Use",
        canRemove: true,
        runtime: false,
      });

      const tools = await executor.tools.list();
      const names = tools
        .filter((tool) => tool.id.startsWith("computer_use."))
        .map((tool) => tool.id.replace("computer_use.", ""))
        .sort();

      expect(names).toEqual([
        "click",
        "drag",
        "get_app_state",
        "list_apps",
        "perform_secondary_action",
        "press_key",
        "scroll",
        "set_value",
        "type_text",
      ]);
    } finally {
      await executor.close();
      await close(server);
    }
  });

  it("does not connect the source when permissions are missing", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ accessibility: true, screenRecording: false }));
    });
    const hostUrl = await listen(server);
    const executor = await createExecutor({
      plugins: [computerUsePlugin({ hostUrl })] as const,
    });

    try {
      await expect(executor.computer_use.addSource({ scope: "default-scope" })).rejects.toThrow(
        "Computer Use needs Accessibility and Screen Recording permissions.",
      );

      const sources = await executor.sources.list();
      expect(sources.some((source) => source.id === "computer_use")).toBe(false);
    } finally {
      await executor.close();
      await close(server);
    }
  });

  it("preserves host error messages when invocation fails", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/permissions/status") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ accessibility: true, screenRecording: true }));
        return;
      }
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "accessibility_permission_required" }));
    });
    const hostUrl = await listen(server);
    const executor = await createExecutor({
      plugins: [computerUsePlugin({ hostUrl })] as const,
    });

    try {
      await executor.computer_use.addSource({ scope: "default-scope" });

      await expect(
        executor.tools.invoke("computer_use.press_key", {
          app: "Spotify",
          key: "space",
        }),
      ).rejects.toThrow("accessibility_permission_required");
    } finally {
      await executor.close();
      await close(server);
    }
  });
});
