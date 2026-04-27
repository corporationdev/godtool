import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import {
  Scope,
  ScopeId,
  collectSchemas,
  createExecutor,
  makeInMemoryBlobStore,
} from "@executor/sdk";
import { makeMemoryAdapter } from "@executor/storage-core/testing/memory";

import {
  computerUsePlugin,
  type ComputerCommandResult,
  type ComputerUseBackend,
} from "./computer-use-plugin";

const ok = (stdout = ""): ComputerCommandResult => ({
  exitCode: 0,
  logs: stdout,
  status: "completed",
  stderr: "",
  stdout,
});

const makeExecutor = (backend: ComputerUseBackend) =>
  Effect.gen(function* () {
    const plugins = [computerUsePlugin({ backend })] as const;
    const schema = collectSchemas(plugins);
    const adapter = makeMemoryAdapter({ schema });
    const blobs = makeInMemoryBlobStore();
    const scope = new Scope({
      id: ScopeId.make("org_test"),
      name: "Test Org",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    return yield* createExecutor({ scopes: [scope], adapter, blobs, plugins });
  });

describe("computerUsePlugin", () => {
  it.effect("exposes desktop and browser tools as a static computer source", () =>
    Effect.gen(function* () {
      const executor = yield* makeExecutor({
        runAgentBrowser: async () => ok(),
        runDesktopCommand: async () => ok(),
      });

      const sources = yield* executor.sources.list();
      const tools = yield* executor.tools.list();

      expect(sources).toEqual([
        expect.objectContaining({ id: "computer", runtime: true }),
      ]);
      expect(tools.map((tool) => tool.id)).toEqual(
        expect.arrayContaining([
          "computer.desktop.screenshot",
          "computer.desktop.xdotool",
          "computer.desktop.clipboard.get",
          "computer.browser.run",
          "computer.browser.snapshot",
        ]),
      );
    }),
  );

  it.effect("converts browser.run into agent-browser argv without shell access", () =>
    Effect.gen(function* () {
      const mutableBrowserCalls: string[][] = [];
      const executor = yield* makeExecutor({
        runAgentBrowser: async ({ args }) => {
          mutableBrowserCalls.push([...args]);
          return ok(JSON.stringify({ ok: true }));
        },
        runDesktopCommand: async () => ok(),
      });

      const result = yield* executor.tools.invoke("computer.browser.run", {
        command: "snapshot",
        args: ["-i"],
      });

      expect(mutableBrowserCalls).toEqual([["--json", "snapshot", "-i"]]);
      expect(result).toMatchObject({ parsed: { ok: true } });
    }),
  );

  it.effect("runs desktop.xdotool through the desktop command backend", () =>
    Effect.gen(function* () {
      const commands: string[] = [];
      const executor = yield* makeExecutor({
        runAgentBrowser: async () => ok(),
        runDesktopCommand: async ({ command }) => {
          commands.push(command);
          return ok("123\n");
        },
      });

      const result = yield* executor.tools.invoke("computer.desktop.xdotool", {
        args: ["getactivewindow"],
      });

      expect(commands).toEqual(["xdotool 'getactivewindow'"]);
      expect(result).toMatchObject({ stdout: "123\n", exitCode: 0 });
    }),
  );
});
