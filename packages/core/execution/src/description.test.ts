import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { createExecutor, definePlugin, makeTestConfig } from "@executor/sdk";

import { buildExecuteDescription } from "./description";

const EmptyInputSchema = {
  type: "object",
  properties: {},
  additionalProperties: false,
} as const;

// Two plugins registering static sources whose ids are distinct from their
// pluginIds/names. If `buildExecuteDescription` ever renders the wrong field
// (e.g. pluginId, an internal UUID, or the source name), these assertions
// fail — which is the class of bug a hand-rolled fake `Executor` would miss.
const githubPlugin = definePlugin(() => ({
  id: "github-plugin" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "github",
      kind: "in-memory",
      name: "GitHub",
      tools: [
        {
          name: "noop",
          description: "noop",
          inputSchema: EmptyInputSchema,
          handler: () => Effect.succeed(null),
        },
      ],
    },
  ],
}));

const slackPlugin = definePlugin(() => ({
  id: "slack-plugin" as const,
  storage: () => ({}),
  staticSources: () => [
    {
      id: "slack",
      kind: "in-memory",
      name: "Slack Workspace",
      tools: [
        {
          name: "noop",
          description: "noop",
          inputSchema: EmptyInputSchema,
          handler: () => Effect.succeed(null),
        },
      ],
    },
  ],
}));

describe("buildExecuteDescription", () => {
  it.effect(
    "renders the shared workflow plus the persistent workspace addendum and lists namespaces",
    () =>
      Effect.gen(function* () {
        // Intentionally register in non-alphabetical order — the formatter
        // is expected to sort by source id.
        const executor = yield* createExecutor(
          makeTestConfig({ plugins: [slackPlugin(), githubPlugin()] as const }),
        );

        const description = yield* buildExecuteDescription(executor, {
          runtimeKind: "blaxel-sandbox",
        });

        expect(description).toContain(
          "Execute TypeScript in a sandboxed runtime with access to configured API tools.",
        );
        expect(description).toContain("## Workflow");
        expect(description).toContain(
          '1. `const matches = await tools.search({ query: "<intent + key nouns>", limit: 12 });`',
        );
        expect(description).toContain("## Rules");
        expect(description).toContain(
          "- `tools.search()` returns ranked matches, best-first. Use short intent phrases like `github issues`, `repo details`, or `create calendar event`.",
        );
        expect(description).toContain("## Persistent workspace");
        expect(description).toContain(
          "Before any task-specific work, your first execution must read both `/workspace/SYSTEM.md` and `/workspace/MEMORY.md`.",
        );
        expect(description).toContain(
          'const systemMd = await Bun.file("/workspace/SYSTEM.md").text();',
        );
        expect(description).toContain(
          'const memoryMd = await Bun.file("/workspace/MEMORY.md").text();',
        );
        expect(description).toContain(
          "Do not call `tools.search()`, `tools.describe.tool()`, or any task tool until you have read both files.",
        );
        expect(description).toContain(
          "Bun shell `$` is already available in scope, so do not import it.",
        );
        expect(description).toContain(
          "`/workspace` persists across executions for this organization. Use it for durable notes or reusable files when helpful.",
        );
        const workflowIdx = description.indexOf("## Workflow");
        const rulesIdx = description.indexOf("## Rules");
        const workspaceIdx = description.indexOf("## Persistent workspace");
        expect(workflowIdx).toBeGreaterThan(-1);
        expect(rulesIdx).toBeGreaterThan(-1);
        expect(workspaceIdx).toBeGreaterThan(-1);
        expect(workflowIdx).toBeLessThan(rulesIdx);
        expect(rulesIdx).toBeLessThan(workspaceIdx);
        // The namespaces section header.
        expect(description).toContain("## Available namespaces");
        // Each source renders with its ACTUAL id (not pluginId / name / UUID).
        expect(description).toContain("`github` — GitHub");
        expect(description).toContain("`slack` — Slack Workspace");
        // And the plugin ids must NOT leak into the namespace list.
        expect(description).not.toContain("`github-plugin`");
        expect(description).not.toContain("`slack-plugin`");

        // Sort order: `github` before `slack`.
        const githubIdx = description.indexOf("`github`");
        const slackIdx = description.indexOf("`slack`");
        expect(githubIdx).toBeGreaterThan(-1);
        expect(slackIdx).toBeGreaterThan(-1);
        expect(githubIdx).toBeLessThan(slackIdx);
      }),
  );

  it.effect(
    "renders only the shared instructions for the stateless worker runtime",
    () =>
      Effect.gen(function* () {
        const executor = yield* createExecutor(
          makeTestConfig({ plugins: [githubPlugin()] as const }),
        );

        const description = yield* buildExecuteDescription(executor, {
          runtimeKind: "dynamic-worker",
        });

        expect(description).toContain(
          "Execute TypeScript in a sandboxed runtime with access to configured API tools.",
        );
        expect(description).toContain(
          '1. `const matches = await tools.search({ query: "<intent + key nouns>", limit: 12 });`',
        );
        expect(description).toContain("## Rules");
        expect(description).not.toContain("## Persistent workspace");
        expect(description).not.toContain(
          'const systemMd = await Bun.file("/workspace/SYSTEM.md").text();',
        );
        expect(description).not.toContain(
          'const memoryMd = await Bun.file("/workspace/MEMORY.md").text();',
        );
        expect(description).not.toContain(
          "Do not call `tools.search()`, `tools.describe.tool()`, or any task tool until you have read both files.",
        );
        expect(description).not.toContain("Bun shell `$` is already available in scope");
        expect(description).not.toContain("`/workspace` persists across executions");
      }),
  );

  it.effect(
    "omits the Available namespaces section when no plugins register sources",
    () =>
      Effect.gen(function* () {
        const executor = yield* createExecutor(
          makeTestConfig({ plugins: [] as const }),
        );

        const description = yield* buildExecuteDescription(executor, {
          runtimeKind: "blaxel-sandbox",
        });

        expect(description).toContain("## Persistent workspace");
        expect(description).toContain(
          "Before any task-specific work, your first execution must read both `/workspace/SYSTEM.md` and `/workspace/MEMORY.md`.",
        );
        expect(description).not.toContain("## Available namespaces");
      }),
  );
});
